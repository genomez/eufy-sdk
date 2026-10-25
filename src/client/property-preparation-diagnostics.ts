import { performance } from "node:perf_hooks";
import { HttpObservationScope, type HttpObservationCounts } from "../core/http-observation-context.js";

export type PropertyPreparationPhase = "validation" | "command_context" | "command_build" | "dispatch_preparation";

/**
 * Fixed phases end at selected transport entry, before RTC acquisition, queueing or exchange.
 * startedAtMs is UTC epoch milliseconds; elapsedMs rounds monotonic duration up and phases truncate it.
 */
export interface PropertyPreparationEvidence {
  category: "guard_mode" | "other";
  startedAtMs: number;
  elapsedMs: number;
  outcome: "transport_handoff" | "failed";
  phase: PropertyPreparationPhase;
  phases: Record<PropertyPreparationPhase, number>;
  http: HttpObservationCounts;
}

/**
 * Invocation-owned preparation evidence. Success means transport handoff only, not command success.
 * Dispatch preparation includes any keyed transition wait before routing. HTTP counts identify work
 * initiated by this invocation, not shared work it merely awaits; concurrent durations can overlap.
 * A cancelled preparation closes its HTTP scope even if underlying work continues.
 */
export interface PropertyPreparationDiagnostics {
  invocations: number;
  prepared: number;
  slow: number;
  failures: number;
  slowThresholdMs: number;
  recentCapacity: number;
  retainedCapacity: number;
  recentEvicted: number;
  slowEvicted: number;
  failuresEvicted: number;
  recent: PropertyPreparationEvidence[];
  recentSlow: PropertyPreparationEvidence[];
  recentFailures: PropertyPreparationEvidence[];
}

/** Mutable state belongs only to the originating invocation, never the last command on a device. */
export class PropertyPreparationObservation {
  private readonly start = performance.now();
  private readonly startedAtMs = Date.now();
  private phase: PropertyPreparationPhase = "validation";
  private phaseStart = this.start;
  private readonly phases: Record<PropertyPreparationPhase, number> = {
    validation: 0,
    command_context: 0,
    command_build: 0,
    dispatch_preparation: 0,
  };
  private finished = false;
  private readonly http = new HttpObservationScope();

  constructor(
    private readonly category: "guard_mode" | "other",
    private readonly record: (row: PropertyPreparationEvidence) => void,
  ) {}

  run<T>(operation: () => T): T {
    return this.http.run(operation);
  }

  mark(phase: PropertyPreparationPhase): void {
    if (this.finished) return;
    const now = performance.now();
    this.phases[this.phase] += Math.max(0, Math.floor(now - this.phaseStart));
    this.phaseStart = now;
    this.phase = phase;
  }

  finish(outcome: PropertyPreparationEvidence["outcome"]): void {
    if (this.finished) return;
    this.mark(this.phase);
    this.finished = true;
    this.record({
      category: this.category,
      startedAtMs: this.startedAtMs,
      elapsedMs: Math.max(0, Math.ceil(performance.now() - this.start)),
      outcome,
      phase: this.phase,
      phases: { ...this.phases },
      http: this.http.finish(),
    });
  }
}

/** Detached snapshots and bounded retention independent of routine successful preparations. */
export class PropertyPreparationRecorder {
  private invocations = 0;
  private prepared = 0;
  private slow = 0;
  private failures = 0;
  private readonly recent: PropertyPreparationEvidence[] = [];
  private readonly recentSlow: PropertyPreparationEvidence[] = [];
  private readonly recentFailures: PropertyPreparationEvidence[] = [];

  begin(category: "guard_mode" | "other"): PropertyPreparationObservation {
    this.invocations++;
    return new PropertyPreparationObservation(category, (row) => {
      this.recent.push(row);
      if (this.recent.length > 5) this.recent.shift();
      if (row.outcome === "transport_handoff") this.prepared++;
      else {
        this.failures++;
        this.recentFailures.push(row);
        if (this.recentFailures.length > 20) this.recentFailures.shift();
      }
      if (row.elapsedMs > 5_000) {
        this.slow++;
        this.recentSlow.push(row);
        if (this.recentSlow.length > 20) this.recentSlow.shift();
      }
    });
  }

  diagnostics(): PropertyPreparationDiagnostics {
    const copy = (rows: PropertyPreparationEvidence[]) =>
      rows.map((row) => ({ ...row, phases: { ...row.phases }, http: { ...row.http } }));
    return {
      invocations: this.invocations,
      prepared: this.prepared,
      slow: this.slow,
      failures: this.failures,
      slowThresholdMs: 5_000,
      recentCapacity: 5,
      retainedCapacity: 20,
      recentEvicted: Math.max(0, this.prepared + this.failures - 5),
      slowEvicted: Math.max(0, this.slow - 20),
      failuresEvicted: Math.max(0, this.failures - 20),
      recent: copy(this.recent),
      recentSlow: copy(this.recentSlow),
      recentFailures: copy(this.recentFailures),
    };
  }
}
