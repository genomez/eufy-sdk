/** Counts and original arrival times for reports associated with a previously commanded target. */
export interface RtcObservationEvidence {
  attempt: number;
  target: number;
  observedAtMs: number;
  properties: number;
}

/** Bounded observations; association with the latest command is temporal, not causal. */
export interface RtcObservationDiagnostics {
  lifecycle: number;
  total: number;
  evicted: number;
  recent: RtcObservationEvidence[];
}

/** Detached numeric report observations without property names, values or device identities. */
export class RtcObservationRecorder {
  private total = 0;
  private recent: RtcObservationEvidence[] = [];

  record(value: RtcObservationEvidence): void {
    if (
      !Number.isSafeInteger(value.attempt) ||
      value.attempt <= 0 ||
      !Number.isSafeInteger(value.target) ||
      value.target <= 0 ||
      !Number.isSafeInteger(value.observedAtMs) ||
      value.observedAtMs < 0 ||
      !Number.isSafeInteger(value.properties) ||
      value.properties <= 0
    )
      return;
    this.recent.push({
      attempt: value.attempt,
      target: value.target,
      observedAtMs: value.observedAtMs,
      properties: value.properties,
    });
    this.total++;
    if (this.recent.length > 128) this.recent.shift();
  }

  diagnostics(): Omit<RtcObservationDiagnostics, "lifecycle"> {
    return {
      total: this.total,
      evicted: this.total - this.recent.length,
      recent: this.recent.map((row) => ({ ...row })),
    };
  }
}
