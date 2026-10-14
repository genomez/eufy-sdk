import { renewalFailure, type RenewalFailure } from "./renewal-diagnostics.js";
import type { RtcSessionCloseOrigin } from "./session.js";

/** Finite outcomes for one transmitted information exchange. */
export type InformationExchangeOutcome =
  "success" | "timeout" | "rejected" | "closed" | "aborted" | "send_failed" | "error";

/** Counts and timings only; no frame contents, connection identifiers or identity material. */
export interface InformationExchangeEvidence {
  purpose?: "current" | "replacement";
  startedAtMs: number;
  finishedAtMs: number;
  elapsedMs: number;
  sessionAgeMs: number;
  sessionGeneration: number;
  informationReceivedAtMs: number | null;
  currentAtArrival: boolean | null;
  otherLeases: number;
  outcome: InformationExchangeOutcome;
  attempted: boolean;
  acknowledged: boolean;
  informationReceived: boolean;
  ackElapsedMs: number | null;
  informationElapsedMs: number | null;
  receivedFrames: number;
  invalidPortalFrames: number;
  otherCommandFrames: number;
  matchedAcknowledgments: number;
  informationFrames: number;
  otherInformationFrames: number;
  unmatchedAcknowledgments: number;
  invalidInformation: number;
}

/** Detached, bounded observations since the router was last closed. */
export interface RtcReadDiagnostics {
  operations: InformationOperationEvidence[];
  lastOperationFailure: InformationOperationEvidence | null;
  exchanges: number;
  successes: number;
  failures: number;
  recent: InformationExchangeEvidence[];
  lastFailure: InformationExchangeEvidence | null;
}

/** A twenty-exchange ring with a separately retained last failure. */
export class InformationReadEvidence {
  private entries: InformationExchangeEvidence[] = [];
  private lastFailure: InformationExchangeEvidence | null = null;
  private operations: InformationOperationEvidence[] = [];
  private lastOperationFailure: InformationOperationEvidence | null = null;
  private exchanges = 0;
  private successes = 0;

  record(value: InformationExchangeEvidence): void {
    this.exchanges++;
    if (value.outcome === "success") this.successes++;
    else this.lastFailure = { ...value };
    this.entries.push({ ...value });
    if (this.entries.length > 20) this.entries.shift();
  }

  recordOperation(value: InformationOperationEvidence): void {
    this.operations.push({ ...value });
    if (this.operations.length > 20) this.operations.shift();
    if (value.outcome === "failed") this.lastOperationFailure = { ...value };
  }

  snapshot(): RtcReadDiagnostics {
    return {
      operations: this.operations.map((entry) => ({ ...entry })),
      lastOperationFailure: this.lastOperationFailure ? { ...this.lastOperationFailure } : null,
      exchanges: this.exchanges,
      successes: this.successes,
      failures: this.exchanges - this.successes,
      recent: this.entries.map((entry) => ({ ...entry })),
      lastFailure: this.lastFailure ? { ...this.lastFailure } : null,
    };
  }

  clear(): void {
    this.entries = [];
    this.operations = [];
    this.lastOperationFailure = null;
    this.lastFailure = null;
    this.exchanges = 0;
    this.successes = 0;
  }
}

/** Complete public read operation, including failures before an exchange exists. */
export interface InformationOperationEvidence {
  startedAtMs: number;
  finishedAtMs: number;
  elapsedMs: number;
  phase: "acquisition" | "queue" | "exchange";
  outcome: "success" | "failed";
  attempted: boolean;
  failure: InformationReadFailure | null;
  sessionError: RenewalFailure | null;
  closeOriginAtFinish: RtcSessionCloseOrigin | null;
}

/** Fixed categories shared by transport and client read diagnostics. */
export type InformationReadFailure =
  | "connect_timeout"
  | "information_read_timeout"
  | "information_response_timeout"
  | "session_closed"
  | "session_tainted"
  | "request_rejected"
  | "send_failed"
  | "account_unavailable"
  | "other";

/** Classify known failures without retaining identifying exception text. */
export function informationReadFailure(error: unknown): InformationReadFailure {
  const message = error instanceof Error ? error.message : "";
  const connection = renewalFailure(error);
  if (connection === "connect_timeout" || connection === "session_closed") return connection;
  switch (message) {
    case "RTC information read timed out":
      return "information_read_timeout";
    case "RTC information response timed out":
      return "information_response_timeout";
    case "RTC information read unavailable until the session retires":
      return "session_tainted";
    case "RTC information request rejected":
      return "request_rejected";
    case "RTC information send failed":
      return "send_failed";
    case "RTC information account unavailable":
      return "account_unavailable";
    default:
      return "other";
  }
}
