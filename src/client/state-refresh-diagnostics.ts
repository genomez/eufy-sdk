import { informationReadFailure, type InformationReadFailure } from "../transport/rtc/read-diagnostics.js";

/** Finite failure reasons without exception text or connection identifiers. */
export type StateRefreshFailure = InformationReadFailure | "empty_response";

/** Initiator of a coalesced background sweep. */
export type StateRefreshTrigger = "startup" | "scheduled" | "cloud_poll";

/** One completed sweep, retaining initiator and joined caller counts. */
export interface StateRefreshSweepEvidence {
  startedAtMs: number;
  finishedAtMs: number;
  trigger: StateRefreshTrigger;
  startupJoins: number;
  scheduledJoins: number;
  cloudPollJoins: number;
  outcome: "success" | "failed";
  failure: StateRefreshFailure | null;
  parameters: number;
}

/** A client operation can fail after a successful transport exchange. */
export interface StateRefreshOperationEvidence {
  startedAtMs: number;
  finishedAtMs: number;
  phase: "validation" | "transport" | "processing";
  outcome: "success" | "failed";
  failure: StateRefreshFailure | null;
}

/** Actual timer decisions, kept separately because multiple callers can rearm one sweep. */
export interface StateRefreshScheduleEvidence {
  scheduledAtMs: number;
  delayMs: number | null;
  consecutiveFailures: number;
  reset: boolean;
}

/** Aggregate background station-read evidence for one realtime generation. Times are Unix milliseconds. */
export interface StateRefreshDiagnostics {
  recent: StateRefreshSweepEvidence[];
  operations: StateRefreshOperationEvidence[];
  lastOperationFailure: StateRefreshOperationEvidence | null;
  schedules: StateRefreshScheduleEvidence[];
  active: boolean;
  inFlight: boolean;
  scheduledPaused: boolean;
  intervalMs: number;
  targetStations: number;
  attempts: number;
  successes: number;
  failures: number;
  lastAttemptMs: number | null;
  lastSuccessMs: number | null;
  lastFailureMs: number | null;
  lastFailureKind: StateRefreshFailure | null;
  lastResponseParameters: number;
}

/** Classify existing information-read failures without retaining their messages. */
export function stateRefreshFailure(error: unknown): StateRefreshFailure {
  return informationReadFailure(error);
}

/** Empty generation evidence; an absent response is never a successful read. */
export function emptyStateRefreshEvidence() {
  return {
    recent: [] as StateRefreshSweepEvidence[],
    operations: [] as StateRefreshOperationEvidence[],
    lastOperationFailure: null as StateRefreshOperationEvidence | null,
    schedules: [] as StateRefreshScheduleEvidence[],
    attempts: 0,
    successes: 0,
    failures: 0,
    lastAttemptMs: null as number | null,
    lastSuccessMs: null as number | null,
    lastFailureMs: null as number | null,
    lastFailureKind: null as StateRefreshFailure | null,
    lastResponseParameters: 0,
  };
}
