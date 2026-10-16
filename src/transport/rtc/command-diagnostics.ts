import { performance } from "node:perf_hooks";
import { copyRtcTransportDiagnostics, type RtcTransportDiagnostics } from "./transport-diagnostics.js";
import type { PortalResponse } from "./portal-packet.js";

/** Finite outcomes of a validated control operation; acknowledgement is not device-state confirmation. */
export type CommandOutcome =
  | "success"
  | "ack_timeout"
  | "expired_before_send"
  | "expired_after_send"
  | "rejected"
  | "closed"
  | "not_sent"
  | "connect_timeout"
  | "other";

/** Parsed numeric headers and independent comparisons; no payload or connection identity is retained. */
export interface CommandHeaderSample {
  receivedAtMs: number;
  linkType: number;
  envelope: number;
  segment: number;
  channel: number;
  response: number;
  innerCommand: number | null;
  errorCode: number | null;
  matchesSegment: boolean;
  matchesChannel: boolean;
  matchesLink: boolean;
  matchesEnvelope: boolean;
  matchesResponse: boolean;
  matchesInnerCommand: boolean;
}

/** Anonymous association with the most recently begun command; lookup never allocates a target. */
export interface CommandTargetContext {
  target: number;
  latestCommandAttempt: number;
}

/** Terminal reasons for a passive observation window on its original session generation. */
export type PostTimeoutStatus =
  "observing" | "expired" | "session_closed" | "retired" | "shutdown" | "evicted" | "transport_replaced";

/** A finite passive window whose headers cannot change the completed command outcome. */
export interface PostTimeoutEvidence {
  startedAtMs: number;
  deadlineAtMs: number;
  finishedAtMs: number | null;
  status: PostTimeoutStatus;
  receivedFrames: number;
  invalidFrames: number;
  headerSamples: CommandHeaderSample[];
  headerSamplesOmitted: number;
  transportAtFinish: RtcTransportDiagnostics | null;
}

/** Process-local stage observations; exchange elapsed includes terminal cleanup and finalization. */
export interface CommandStageTiming {
  clock: "process-monotonic-microseconds";
  startedAtMicros: number;
  acquiredAtMicros: number | null;
  queuedAtMicros: number | null;
  exchangeStartedAtMicros: number | null;
  sendAttemptedAtMicros: number | null;
  finishedAtMicros: number | null;
  acquisitionElapsedMicros: number | null;
  queueElapsedMicros: number | null;
  exchangeElapsedMicros: number | null;
}

type CommandTimingStage =
  "acquiredAtMicros" | "queuedAtMicros" | "exchangeStartedAtMicros" | "sendAttemptedAtMicros" | "finishedAtMicros";

/** Numeric timings and first-mismatch counts, without packets or connection identities. */
export interface CommandEvidence {
  attempt: number;
  target: number;
  scope: "station" | "attached";
  command: number | null;
  envelope: 1350 | 1700;
  startedAtMs: number;
  finishedAtMs: number | null;
  elapsedMs: number | null;
  sendAttemptedAtMs: number | null;
  stageTiming: CommandStageTiming | null;
  /** Wall-clock observation of the capped command deadline; never controls a protocol timer. */
  remainingBudgetAtSendMs: number | null;
  sessionAgeMs: number | null;
  sessionGeneration: number | null;
  expectedSegment: number | null;
  expectedChannel: number | null;
  transportBeforeSend: RtcTransportDiagnostics | null;
  transportAtFinish: RtcTransportDiagnostics | null;
  postTimeout: PostTimeoutEvidence | null;
  headerSamples: CommandHeaderSample[];
  headerSamplesEvicted: number;
  phase: "acquisition" | "queue" | "exchange";
  outcome: CommandOutcome | null;
  rejectionCode: number | null;
  receivedFrames: number;
  invalidFrames: number;
  otherSegments: number;
  otherChannels: number;
  otherLinks: number;
  otherEnvelopes: number;
  otherResponseFlags: number;
  otherParameters: number;
  invalidResultPayloads: number;
  matchedAcks: number;
  matchedResults: number;
  readbackAttempts: number;
  confirmedByReadback: number;
}

/** Copy only the declared numeric header fields and comparisons. */
function copyHeader(sample: CommandHeaderSample): CommandHeaderSample {
  return {
    receivedAtMs: sample.receivedAtMs,
    linkType: sample.linkType,
    envelope: sample.envelope,
    segment: sample.segment,
    channel: sample.channel,
    response: sample.response,
    innerCommand: sample.innerCommand,
    errorCode: sample.errorCode,
    matchesSegment: sample.matchesSegment,
    matchesChannel: sample.matchesChannel,
    matchesLink: sample.matchesLink,
    matchesEnvelope: sample.matchesEnvelope,
    matchesResponse: sample.matchesResponse,
    matchesInnerCommand: sample.matchesInnerCommand,
  };
}

/** Detach the bounded header collection along with the operation's scalar evidence. */
function copyEvidence(row: CommandEvidence): CommandEvidence {
  return {
    ...row,
    stageTiming: row.stageTiming ? { ...row.stageTiming } : null,
    headerSamples: row.headerSamples.map(copyHeader),
    transportBeforeSend: row.transportBeforeSend ? copyRtcTransportDiagnostics(row.transportBeforeSend) : null,
    transportAtFinish: row.transportAtFinish ? copyRtcTransportDiagnostics(row.transportAtFinish) : null,
    postTimeout: row.postTimeout
      ? {
          ...row.postTimeout,
          headerSamples: row.postTimeout.headerSamples.map(copyHeader),
          transportAtFinish: row.postTimeout.transportAtFinish
            ? copyRtcTransportDiagnostics(row.postTimeout.transportAtFinish)
            : null,
        }
      : null,
  };
}

/** Independent numeric header comparisons used by both active and passive observations. */
export function commandHeaderSample(
  p: PortalResponse,
  linkType: number,
  outerCmd: number,
  innerCmd: number,
  channel: number,
  segment: number,
): CommandHeaderSample {
  return {
    receivedAtMs: Date.now(),
    linkType: Number.isSafeInteger(linkType) ? linkType : 0,
    envelope: p.commandId,
    segment: p.segment,
    channel: p.channel,
    response: p.isResponse,
    innerCommand: Number.isSafeInteger(p.cmd) ? p.cmd! : null,
    errorCode: Number.isSafeInteger(p.errCode) ? p.errCode! : null,
    matchesSegment: p.segment === segment,
    matchesChannel: p.channel === channel,
    matchesLink: linkType === 1 || linkType === 3,
    matchesEnvelope: p.commandId === outerCmd || (outerCmd === 1700 && p.commandId === 1351),
    matchesResponse: (linkType === 1 && p.isResponse === 1) || (linkType === 3 && p.isResponse === 0),
    matchesInnerCommand: p.cmd === innerCmd,
  };
}

/** Completed control observations since the recorder lifecycle began. */
export interface RtcCommandDiagnostics {
  attempts: number;
  completed: number;
  failures: number;
  evicted: number;
  recent: CommandEvidence[];
  lastFailure: CommandEvidence | null;
}

/** Thirty-two completed operations and thirty-two private target associations, with detached snapshots. */
export class CommandEvidenceRecorder {
  private targets = new Map<string, CommandTargetContext>();
  private nextTarget = 0;
  private attempts = 0;
  private completed = 0;
  private failures = 0;
  private recent: CommandEvidence[] = [];
  private lastFailure: CommandEvidence | null = null;
  private observationCleanup = new Map<number, (reason: PostTimeoutStatus) => void>();

  constructor(private readonly timingNow: () => number = () => performance.now()) {}

  private micros(): number | null {
    try {
      const value = this.timingNow();
      const micros = Math.floor(value * 1000);
      return typeof value === "number" && value >= 0 && Number.isSafeInteger(micros) ? micros : null;
    } catch {
      return null;
    }
  }

  /** Failed or backward clock evidence stays unknown without changing command control flow. */
  markTiming(row: CommandEvidence, stage: CommandTimingStage): void {
    const timing = row.stageTiming;
    if (!timing || row.finishedAtMs !== null || timing[stage] !== null) return;
    const current = this.micros();
    const latest = Math.max(
      timing.startedAtMicros,
      timing.acquiredAtMicros ?? 0,
      timing.queuedAtMicros ?? 0,
      timing.exchangeStartedAtMicros ?? 0,
      timing.sendAttemptedAtMicros ?? 0,
    );
    if (current === null || current < latest) {
      row.stageTiming = null;
      return;
    }
    timing[stage] = current;
  }

  begin(target: string, scope: CommandEvidence["scope"], command: number, envelope: 1350 | 1700): CommandEvidence {
    const ordinal = this.targets.get(target)?.target ?? ++this.nextTarget;
    const attempt = ++this.attempts;
    this.targets.delete(target);
    this.targets.set(target, { target: ordinal, latestCommandAttempt: attempt });
    if (this.targets.size > 32) this.targets.delete(this.targets.keys().next().value!);
    const startedAtMicros = this.micros();
    return {
      attempt,
      target: ordinal,
      scope,
      command: Number.isSafeInteger(command) && command >= 0 && command <= 0x7fffffff ? command : null,
      envelope,
      startedAtMs: Date.now(),
      finishedAtMs: null,
      elapsedMs: null,
      sendAttemptedAtMs: null,
      stageTiming:
        startedAtMicros === null
          ? null
          : {
              clock: "process-monotonic-microseconds",
              startedAtMicros,
              acquiredAtMicros: null,
              queuedAtMicros: null,
              exchangeStartedAtMicros: null,
              sendAttemptedAtMicros: null,
              finishedAtMicros: null,
              acquisitionElapsedMicros: null,
              queueElapsedMicros: null,
              exchangeElapsedMicros: null,
            },
      remainingBudgetAtSendMs: null,
      sessionAgeMs: null,
      sessionGeneration: null,
      expectedSegment: null,
      expectedChannel: null,
      transportBeforeSend: null,
      transportAtFinish: null,
      postTimeout: null,
      headerSamples: [],
      headerSamplesEvicted: 0,
      phase: "acquisition",
      outcome: null,
      rejectionCode: null,
      receivedFrames: 0,
      invalidFrames: 0,
      otherSegments: 0,
      otherChannels: 0,
      otherLinks: 0,
      otherEnvelopes: 0,
      otherResponseFlags: 0,
      otherParameters: 0,
      invalidResultPayloads: 0,
      matchedAcks: 0,
      matchedResults: 0,
      readbackAttempts: 0,
      confirmedByReadback: 0,
    };
  }

  /** Read an existing anonymous target association without changing retention order or allocating one. */
  lookupTarget(target: string): CommandTargetContext | undefined {
    const context = this.targets.get(target);
    return context ? { ...context } : undefined;
  }

  /** Retain at most sixteen detached parsed headers for one command attempt. */
  recordHeader(row: CommandEvidence, sample: CommandHeaderSample): void {
    row.headerSamples.push(copyHeader(sample));
    if (row.headerSamples.length > 16) {
      row.headerSamples.shift();
      row.headerSamplesEvicted++;
    }
  }

  /** Register cleanup without retaining the session in any detached evidence row. */
  observe(row: CommandEvidence, stop: (reason: PostTimeoutStatus) => void): void {
    this.observationCleanup.set(row.attempt, stop);
  }

  /** End cleanup ownership when a finite window has stopped. */
  stopObserving(row: CommandEvidence): void {
    this.observationCleanup.delete(row.attempt);
  }

  /** Replace retained copies so subsequent snapshots see late evidence and earlier snapshots stay detached. */
  updatePostTimeout(row: CommandEvidence): void {
    const index = this.recent.findIndex((entry) => entry.attempt === row.attempt);
    if (index !== -1) this.recent[index] = copyEvidence({ ...this.recent[index]!, postTimeout: row.postTimeout });
    if (this.lastFailure?.attempt === row.attempt)
      this.lastFailure = copyEvidence({ ...this.lastFailure, postTimeout: row.postTimeout });
  }

  /** Stop every passive window before the recorder's lifecycle is discarded. */
  close(): void {
    for (const stop of [...this.observationCleanup.values()]) stop("shutdown");
    this.observationCleanup.clear();
  }

  finish(row: CommandEvidence, outcome: CommandOutcome): void {
    this.markTiming(row, "finishedAtMicros");
    if (row.stageTiming) {
      const t = row.stageTiming;
      const duration = (start: number | null, end: number | null) =>
        start === null || end === null ? null : end - start;
      t.acquisitionElapsedMicros = duration(t.startedAtMicros, t.acquiredAtMicros ?? t.finishedAtMicros);
      t.queueElapsedMicros = duration(t.queuedAtMicros, t.exchangeStartedAtMicros ?? t.finishedAtMicros);
      t.exchangeElapsedMicros = duration(t.exchangeStartedAtMicros, t.finishedAtMicros);
    }
    row.finishedAtMs = Date.now();
    row.elapsedMs = Math.max(0, row.finishedAtMs - row.startedAtMs);
    row.outcome = outcome;
    this.completed++;
    if (outcome !== "success") {
      this.failures++;
      this.lastFailure = copyEvidence(row);
    }
    this.recent.push(copyEvidence(row));
    if (this.recent.length > 32) {
      const evicted = this.recent.shift()!;
      this.observationCleanup.get(evicted.attempt)?.("evicted");
      this.observationCleanup.delete(evicted.attempt);
    }
  }

  snapshot(): RtcCommandDiagnostics {
    return {
      attempts: this.attempts,
      completed: this.completed,
      failures: this.failures,
      evicted: this.completed - this.recent.length,
      recent: this.recent.map(copyEvidence),
      lastFailure: this.lastFailure ? copyEvidence(this.lastFailure) : null,
    };
  }
}

/** Known transport errors mapped to fixed categories; exception text is never retained. */
export function commandOutcome(error: unknown): CommandOutcome {
  const message = error instanceof Error ? error.message : "";
  if (message === "RTC command ACK timed out; outcome unknown") return "ack_timeout";
  if (message === "RTC command timed out before send") return "expired_before_send";
  if (message === "RTC command timed out after send; outcome unknown") return "expired_after_send";
  if (/^rtc: .+ rejected cmd \d+ \(err -?\d+\)$/.test(message)) return "rejected";
  if (/^rtc: .+ command channel not open, cmd \d+ not sent$/.test(message)) return "not_sent";
  if (/^rtc: .+ session closed (before command send|while waiting for cmd \d+ ACK)$/.test(message)) return "closed";
  if (/^rtc: .+ did not come up within \d+ms$/.test(message)) return "connect_timeout";
  return "other";
}
