export const stateEvidenceCapability = Object.freeze({ version: 1, mode: "shadow" } as const);
export type EvidenceSource =
  "rtc_push" | "rtc_readback" | "cloud_poll" | "command_echo" | "snapshot" | "legacy_unknown";
export type EvidenceReason =
  | "qualified_sample"
  | "post_dispatch_read"
  | "no_sample_order"
  | "incomparable_conflict"
  | "older_sample"
  | "duplicate"
  | "producer_conflict"
  | "retired_session"
  | "old_runtime"
  | "echo_not_proof"
  | "unverified_read"
  | "no_post_dispatch_anchor"
  | "invalid_value"
  | "sample_expired";
export interface StateEvidence {
  version: 1;
  runtimeGeneration: string;
  sessionGeneration: number | null;
  source: EvidenceSource;
  receivedAtMs: number | null;
  receiveSequence: number | null;
  producerTimeMs: number | null;
  producerSequence: string | null;
  producerDomain: string | null;
  readGeneration: number | null;
  correlation: "none" | "temporal_only" | "verified";
  intentGeneration: number | null;
  dispatchRevision: number | null;
  revision: number;
  status: "current" | "uncertain" | "retained" | "stale";
  decision: "current" | "confirmation-of-command" | "retained" | "uncertain";
  reason: EvidenceReason;
  confirmationEligible: boolean;
  readIssuedAfterDispatch: boolean;
  offProof: { eligible: boolean; reason: EvidenceReason } | null;
}
