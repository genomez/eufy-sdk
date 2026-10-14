import type { RtcSessionCloseOrigin } from "./session.js";

/** The bounded operation active when a replacement completed or failed. */
export type RenewalPhase = "connect" | "information" | "idle" | "adoption";

/** Finite failure categories without exception text or signaling content. */
export type RenewalFailure =
  | "signaling_486"
  | "signaling_408"
  | "connect_timeout"
  | "information_timeout"
  | "request_rejected"
  | "session_closed"
  | "replacement_timeout"
  | "cancelled"
  | "superseded"
  | "other";

/** Detached timing and stage evidence for one replacement attempt. */
export interface RenewalEvidence {
  attemptOrdinal: number;
  retryProofStartedAtMs: number | null;
  retryProofFinishedAtMs: number | null;
  startedAtMs: number;
  finishedAtMs: number;
  elapsedMs: number;
  originalSessionAgeMs: number;
  originalSessionGeneration: number;
  candidateSessionGeneration: number | null;
  candidateInformationReceivedAtMs: number | null;
  adoptedAtMs: number | null;
  originalLeasesAtFinish: number;
  candidateConnected: boolean;
  informationVerified: boolean;
  phase: RenewalPhase;
  outcome: "success" | "failed" | "cancelled";
  failure: RenewalFailure | null;
  /** Most recent candidate error event, distinct from the terminating failure. */
  sessionError: RenewalFailure | null;
  /** Candidate closure observed before final replacement cleanup; null if still open. */
  candidateCloseOrigin: RtcSessionCloseOrigin | null;
}

/** Safe, detached failed-completion evidence; invalid numbers or phases remain unknown. */
export type RetainedRenewalFailure = {
  [K in keyof Omit<RenewalEvidence, "phase" | "outcome">]: RenewalEvidence[K] extends number
    ? number | null
    : RenewalEvidence[K];
} & { sequence: number; outcome: "failed"; phase: RenewalPhase | null };

/** Volatile failure-only history within one anonymous router incarnation and epoch. */
export interface RenewalFailureRetention {
  version: 1;
  ownerIncarnation: number;
  ownerEpoch: number;
  failedCompletions: number;
  cancelledCompletions: number;
  evictedFailures: number;
  recentFailures: RetainedRenewalFailure[];
}

/** Copies only finite failure evidence; no signaling, exception text or extra fields are retained. */
export function retainedRenewalFailure(evidence: RenewalEvidence, sequence: number): RetainedRenewalFailure {
  const numeric = (value: number | null): number | null =>
    Number.isSafeInteger(value) && value !== null && value >= 0 ? value : null;
  const category = (value: RenewalFailure | null): RenewalFailure | null => {
    if (value === null) return null;
    switch (value) {
      case "signaling_486":
      case "signaling_408":
      case "connect_timeout":
      case "information_timeout":
      case "request_rejected":
      case "session_closed":
      case "replacement_timeout":
      case "cancelled":
      case "superseded":
        return value;
      default:
        return "other";
    }
  };
  const origin = evidence.candidateCloseOrigin;
  return {
    sequence,
    attemptOrdinal: numeric(evidence.attemptOrdinal),
    retryProofStartedAtMs: numeric(evidence.retryProofStartedAtMs),
    retryProofFinishedAtMs: numeric(evidence.retryProofFinishedAtMs),
    startedAtMs: numeric(evidence.startedAtMs),
    finishedAtMs: numeric(evidence.finishedAtMs),
    elapsedMs: numeric(evidence.elapsedMs),
    originalSessionAgeMs: numeric(evidence.originalSessionAgeMs),
    originalSessionGeneration: numeric(evidence.originalSessionGeneration),
    candidateSessionGeneration: numeric(evidence.candidateSessionGeneration),
    candidateInformationReceivedAtMs: numeric(evidence.candidateInformationReceivedAtMs),
    adoptedAtMs: numeric(evidence.adoptedAtMs),
    originalLeasesAtFinish: numeric(evidence.originalLeasesAtFinish),
    candidateConnected: evidence.candidateConnected === true,
    informationVerified: evidence.informationVerified === true,
    phase: ["connect", "information", "idle", "adoption"].includes(evidence.phase) ? evidence.phase : null,
    outcome: "failed",
    failure: category(evidence.failure),
    sessionError: category(evidence.sessionError),
    candidateCloseOrigin:
      origin === "local" ||
      origin === "signaling_closed" ||
      origin === "remote_hangup" ||
      origin === "command_channel_closed" ||
      origin === "peer_failed" ||
      origin === "peer_closed"
        ? origin
        : null,
  };
}

/** Maps known errors to fixed categories; arbitrary details are never retained. */
export function renewalFailure(error: unknown): RenewalFailure {
  const message = error instanceof Error ? error.message : "";
  if (/^RTC scall 486 after \d+ retries$/.test(message)) return "signaling_486";
  if (/^RTC scall 408 after \d+ retries$/.test(message)) return "signaling_408";
  if (/^rtc: .+ did not come up within \d+ms$/.test(message)) return "connect_timeout";
  if (message === "RTC information response timed out") return "information_timeout";
  if (message === "RTC information request rejected") return "request_rejected";
  if (
    message === "RTC information session closed" ||
    message === "RTC session closed while opening" ||
    /^rtc: .+ session closed before the command channel opened$/.test(message)
  )
    return "session_closed";
  if (message === "RTC session replacement timed out") return "replacement_timeout";
  if (message === "RTC session replacement cancelled") return "cancelled";
  if (message === "RTC session replacement superseded") return "superseded";
  return "other";
}
