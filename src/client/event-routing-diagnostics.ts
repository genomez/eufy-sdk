import { thumbnailEventTime } from "../transport/push/thumbnail-time.js";
import type { RtcPushDecision } from "./rtc-push.js";

/** Source of a push-shaped routing observation. */
export type EventRoutingSource = "rtc" | "cloud_push";
/** Routing outcome, never an exception message or input string. */
export type EventRoutingDecision = RtcPushDecision | "mapped" | "unmapped";
/** Bounded timing and presence evidence; no names, identifiers, URLs or raw payloads. */
export interface EventRoutingEvidence {
  observedAtMs: number;
  source: EventRoutingSource;
  decision: EventRoutingDecision;
  model: string | null;
  eventCode: number | null;
  envelopeCode: 1317 | 1318 | 2037 | null;
  namePresent: boolean;
  nicknamePresent: boolean;
  personIdPresent: boolean;
  derivedNamePresent: boolean;
  semanticEvents: number;
  /** Candidate source clocks only; none is selected as an image event time by this diagnostic. */
  envelopeTimeMs: number | null;
  eventTimeMs: number | null;
  createTimeMs: number | null;
  triggerTimeMs: number | null;
  thumbnailPresent: boolean;
  objectsNamesPresent: boolean;
  picContentPresent: boolean;
  eventIdentityPresent: boolean;
}
/** Bounded, process-local evidence; message counts do not establish unique detections. */
export interface EventRoutingDiagnostics {
  total: number;
  evicted: number;
  recent: EventRoutingEvidence[];
}

/** Presence test only; values are neither copied into records nor logged. */
const present = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

/** Inspect only the declared name-list shape; retain no names or arbitrary nested values. */
function objectNamesPresent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const names = (value as { names?: unknown }).names;
  return Array.isArray(names) && names.slice(0, 16).some(present);
}

/** Retain at most 96 projections without raw payloads, identity maps, timers or network work. */
export class EventRoutingRecorder {
  private total = 0;
  private recent: EventRoutingEvidence[] = [];

  record(
    source: EventRoutingSource,
    decision: EventRoutingDecision,
    model: unknown,
    payload: Record<string, unknown> | undefined,
    outputs: readonly { payload: Record<string, unknown> }[] = [],
    envelopeCode?: number,
    eventCode: unknown = payload?.event_type,
    envelopeTime?: unknown,
  ): void {
    if (decision === "ignored") return;
    this.total = Math.min(Number.MAX_SAFE_INTEGER, this.total + 1);
    this.recent.push({
      observedAtMs: Date.now(),
      source,
      decision,
      model: typeof model === "string" && /^T[0-9]{4}$/.test(model) ? model : null,
      eventCode:
        typeof eventCode === "number" && Number.isSafeInteger(eventCode) && eventCode >= 0 && eventCode <= 65535
          ? eventCode
          : null,
      envelopeCode: envelopeCode === 1317 || envelopeCode === 1318 || envelopeCode === 2037 ? envelopeCode : null,
      namePresent: present(payload?.person_name),
      nicknamePresent: present(payload?.nick_name),
      personIdPresent:
        typeof payload?.person_id === "number"
          ? Number.isFinite(payload.person_id) && payload.person_id > 0
          : typeof payload?.person_id === "string" && /^[1-9][0-9]*$/.test(payload.person_id),
      derivedNamePresent: outputs.some((out) => present(out.payload.person_name)),
      semanticEvents: outputs.length,
      envelopeTimeMs: thumbnailEventTime(envelopeTime).eventTime ?? null,
      eventTimeMs: thumbnailEventTime(payload?.event_time).eventTime ?? null,
      createTimeMs: thumbnailEventTime(payload?.create_time).eventTime ?? null,
      triggerTimeMs: thumbnailEventTime(payload?.trigger_time).eventTime ?? null,
      thumbnailPresent: present(payload?.pic_url) || present(payload?.thumbnail),
      objectsNamesPresent: objectNamesPresent(payload?.objects),
      picContentPresent: payload?.pic_content !== undefined && payload?.pic_content !== null,
      eventIdentityPresent: present(payload?.session_id) || present(payload?.unique_id),
    });
    if (this.recent.length > 96) this.recent.shift();
  }

  /** Detached snapshot; mutating it cannot change the recorder. */
  diagnostics(): EventRoutingDiagnostics {
    return {
      total: this.total,
      evicted: this.total - this.recent.length,
      recent: this.recent.map((row) => ({ ...row })),
    };
  }
}
