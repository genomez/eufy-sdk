import { mediaFailureTag, type MediaFailureReason } from "./media-failure.js";
import { thumbnailEventTime } from "./push/thumbnail-time.js";
import type { PushEvent } from "./push/types.js";

const stages = [
  "envelope",
  "nested_event",
  "nested_create",
  "nested_trigger",
  "candidate",
  "cache_input",
  "cache_retained",
  "cache_read",
] as const;
const decisions = [
  "no_candidate",
  "disabled",
  "non_device",
  "no_account",
  "account_changed",
  "unsupported",
  "admitted",
  "admission_error",
  "older_rejected",
  "duplicate",
  "queued",
  "queue_replaced",
  "download_started",
  "download_failed",
  "invalid_image",
  "lifecycle_error",
  "generation_discarded",
] as const;
const transfers = ["normalization", "retention"] as const;
const outcomes = ["absent", "preserved", "lost", "changed", "gained"] as const;

/** Timestamp shape only; no source value survives this classification. */
function timeState(value: unknown, source: boolean): "missing" | "invalid" | "valid" {
  if (value === undefined || value === null) return "missing";
  return (
    source
      ? thumbnailEventTime(value).eventTime !== undefined
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 1e12 && value < 1e13
  )
    ? "valid"
    : "invalid";
}

/** Fixed-size process counters with no identifiers, source values, URLs or image content. */
export class ThumbnailDiagnostics {
  private counts: Record<string, number> = {};
  private recentFailures: Array<{ observedAtMs: number; cause: MediaFailureReason | null; status: number | null }> = [];

  constructor() {
    this.clear();
  }

  /** Reset the diagnostic interval alongside the owning image cache lifecycle. */
  clear(): void {
    this.recentFailures = [];
    this.counts = Object.fromEntries([
      ...stages.flatMap((stage) => ["missing", "invalid", "valid"].map((state) => [`${stage}_${state}`, 0])),
      ...decisions.map((decision) => [decision, 0]),
      ...transfers.flatMap((stage) => outcomes.map((outcome) => [`${stage}_${outcome}`, 0])),
    ]);
  }

  /** Observe existing normalized pushes without changing timestamp selection or triggering work. */
  push(event: PushEvent): void {
    if (!event.thumbnailCandidate) {
      this.decision("no_candidate");
      return;
    }
    const envelope = event.raw.payload?.event_time;
    this.time("envelope", envelope, true);
    this.time("nested_event", event.payload.event_time, true);
    this.time("nested_create", event.payload.create_time, true);
    this.time("nested_trigger", event.payload.trigger_time, true);
    this.time("candidate", event.thumbnailCandidate.eventTime);
    this.transfer("normalization", thumbnailEventTime(envelope).eventTime, event.thumbnailCandidate.eventTime);
  }

  /** Observe every current-generation failed download, independently of log rate limits. */
  downloadFailure(error: unknown): void {
    const tag = mediaFailureTag(error);
    this.recentFailures.push({
      observedAtMs: Date.now(),
      cause: tag.cause ?? null,
      status: tag.cause === "http-status" ? (tag.status ?? null) : null,
    });
    if (this.recentFailures.length > 32) this.recentFailures.shift();
  }

  /** Detached bounded failure evidence; no exception text or candidate identity. */
  failures(): Array<{ observedAtMs: number; cause: MediaFailureReason | null; status: number | null }> {
    return this.recentFailures.map((row) => ({ ...row }));
  }

  /** Record only one of the fixed stage and validity combinations. */
  time(stage: (typeof stages)[number], value: unknown, source = false): void {
    this.increment(`${stage}_${timeState(value, source)}`);
  }

  /** Compare input and output within the same operation, never across unrelated events. */
  transfer(stage: (typeof transfers)[number], input: unknown, output: unknown): void {
    const before = timeState(input, false) === "valid";
    const after = timeState(output, false) === "valid";
    const outcome = before
      ? after
        ? input === output
          ? "preserved"
          : "changed"
        : "lost"
      : after
        ? "gained"
        : "absent";
    this.increment(`${stage}_${outcome}`);
  }

  /** Retain a finite control-flow outcome, not an exception or arbitrary message. */
  decision(value: (typeof decisions)[number]): void {
    this.increment(value);
  }

  /** Return a detached snapshot; reading diagnostics performs no network or disk operation. */
  diagnostics(): Record<string, number> {
    return { ...this.counts };
  }

  /** Ignore unknown keys even when called by untyped consumers. */
  private increment(key: string): void {
    if (Object.hasOwn(this.counts, key)) this.counts[key] = Math.min(Number.MAX_SAFE_INTEGER, this.counts[key]! + 1);
  }
}
