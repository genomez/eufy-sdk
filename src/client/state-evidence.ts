import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import {
  stateEvidenceCapability,
  type EvidenceSource,
  type EvidenceReason,
  type StateEvidence,
} from "../core/state-evidence.js";

/** Wire facts are unqualified unless their ordering or fresh-sample contract is established. */
export interface EvidenceIngress {
  source: EvidenceSource;
  receivedAtMs: number | null;
  receivedAtMonotonicMs?: number;
  sessionGeneration?: number;
  receiveSequence?: number;
  station?: string;
  runtimeGeneration?: string;
  producerTimeMs?: number;
  producerSequence?: string;
  producerDomain?: string;
  producerOrderQualified?: boolean;
  producerAfterDispatch?: boolean;
  readGeneration?: number;
  readIssuedAtMonotonicMs?: number;
  freshSampleContract?: boolean;
}
type Sample = { value: string; evidence: StateEvidence; ordered: boolean; receivedAtMonotonicMs?: number };
type Row = {
  cloud?: { value: string; ingress: EvidenceIngress };
  latest?: Sample;
  accepted?: Sample;
  lastKnown?: Sample;
  conflict?: Sample;
  projected?: number;
  station?: string;
  observationFenceMs?: number;
  intent?: {
    generation: number;
    expected: string;
    sentAtMonotonicMs: number;
    revision: number;
    station?: string;
    sessionGeneration: number | null;
    off: boolean;
    proof: boolean;
    invalidated: boolean;
  };
  target: number;
};
const LIMIT = 2048;
const SESSION_LIMIT = 256;
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const ordinal = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Bounded, detached shadow decisions; no state mutation, I/O, timers or reconciliation work. */
export class StateEvidenceOwner {
  readonly runtimeGeneration = randomUUID();
  private rows = new Map<string, Row>();
  private sessions = new Map<string, number>();
  private readonly diagnosticSalt = randomBytes(32);
  private nextIntent = 0;
  private revision = 0;
  private total = 0;
  private evicted = 0;
  private offCommands = 0;
  private offCommandsWithProof = 0;
  private offAfterCommand = 0;
  private offProofEligible = 0;
  private reasons: Partial<Record<EvidenceReason, number>> = {};
  private recent: {
    target: number;
    property: string;
    revision: number;
    source: EvidenceSource;
    receivedAtMs: number | null;
    correlation: StateEvidence["correlation"];
    readIssuedAfterDispatch: boolean;
    status: StateEvidence["status"];
    decision: StateEvidence["decision"];
    reason: EvidenceReason;
    offProof: StateEvidence["offProof"];
  }[] = [];

  private row(target: string, param: number): Row {
    const key = JSON.stringify([target, param]);
    let row = this.rows.get(key);
    if (!row) {
      if (this.rows.size >= LIMIT) {
        this.rows.delete(this.rows.keys().next().value!);
        this.evicted = increment(this.evicted);
      }
      row = {
        target: createHmac("sha256", this.diagnosticSalt).update(target).digest().readUIntBE(0, 6),
      };
      this.rows.set(key, row);
    }
    return row;
  }

  /** Actual dispatch uses a monotonic fence and station ownership; an ACK or matching cache is no sample. */
  dispatched(
    target: string,
    param: number,
    expected: boolean | number | string,
    sentAtMonotonicMs: number,
    property?: string,
    scope?: { station: string; sessionGeneration: number },
  ): void {
    const row = this.row(target, param);
    const station = scope?.station ?? row.station;
    row.intent = {
      generation: (this.nextIntent = increment(this.nextIntent)),
      expected: this.boundedValue(String(typeof expected === "boolean" ? Number(expected) : expected)),
      sentAtMonotonicMs,
      station,
      sessionGeneration: scope?.sessionGeneration ?? (station ? this.sessions.get(station) : undefined) ?? null,
      revision: this.revision,
      off: property === "light" && (expected === false || expected === 0 || expected === "0"),
      proof: false,
      invalidated: false,
    };
    if (row.intent.off) this.offCommands = increment(this.offCommands);
  }

  private boundedValue(value: string): string {
    return value.length > 256 ? createHash("sha256").update(value).digest("hex") : value;
  }

  /** Capture actual cloud ingress separately from any later cached adoption or model projection. */
  captureCloud(
    target: string,
    params: Readonly<Record<number, string>>,
    times: Readonly<Record<number, number>>,
    receivedAtMs: number,
  ): void {
    for (const [id, value] of Object.entries(params))
      this.row(target, Number(id)).cloud = {
        value: this.boundedValue(value),
        ingress: {
          source: "cloud_poll",
          receivedAtMs,
          producerTimeMs: times[Number(id)] === undefined ? undefined : times[Number(id)] * 1000,
          producerDomain: times[Number(id)] === undefined ? undefined : "cloud_update_time",
        },
      };
  }

  matches(target: string, param: number, value: string): boolean {
    return this.rows.get(JSON.stringify([target, param]))?.latest?.value === this.boundedValue(value);
  }

  cachedIngress(target: string, param: number, value: string): EvidenceIngress | undefined {
    const cloud = this.rows.get(JSON.stringify([target, param]))?.cloud;
    return cloud?.value === this.boundedValue(value) ? cloud.ingress : undefined;
  }

  record(target: string, param: number, value: string, input: EvidenceIngress): void {
    if (!Number.isSafeInteger(param) || param < 0) return;
    value = this.boundedValue(value);
    const row = this.row(target, param);
    const previous = row.accepted ?? row.lastKnown;
    const ownedIntent = row.intent;
    const session = ordinal(input.sessionGeneration) ? input.sessionGeneration : null;
    const priorSession = input.station ? this.sessions.get(input.station) : undefined;
    if (
      (!input.runtimeGeneration || input.runtimeGeneration === this.runtimeGeneration) &&
      input.station &&
      session !== null &&
      (priorSession === undefined || session > priorSession)
    ) {
      if (this.sessions.size >= SESSION_LIMIT && !this.sessions.has(input.station))
        this.sessions.delete(this.sessions.keys().next().value!);
      this.sessions.set(input.station, session);
      for (const retained of this.rows.values())
        if (retained.intent?.station === input.station && retained.intent.sessionGeneration !== session)
          retained.intent.invalidated = true;
    }
    const sameIntentScope =
      !!ownedIntent &&
      !ownedIntent.invalidated &&
      ownedIntent.sessionGeneration !== null &&
      session === ownedIntent.sessionGeneration &&
      input.station === ownedIntent.station &&
      (!input.station || this.sessions.get(input.station) === session) &&
      (!input.runtimeGeneration || input.runtimeGeneration === this.runtimeGeneration);
    const intent = sameIntentScope ? ownedIntent : undefined;
    const sequence =
      typeof input.producerSequence === "string" && /^(0|[1-9][0-9]{0,39})$/.test(input.producerSequence)
        ? input.producerSequence
        : null;
    const domain =
      input.producerDomain &&
      ["cloud_update_time", "device_sequence", "device_sample_time"].includes(input.producerDomain)
        ? input.producerDomain
        : null;
    const producerTime = ordinal(input.producerTimeMs) ? input.producerTimeMs : null;
    const ordered =
      input.producerOrderQualified === true && domain !== null && (sequence !== null || producerTime !== null);
    const readAfter =
      !!ownedIntent &&
      ordinal(input.readGeneration) &&
      input.readIssuedAtMonotonicMs !== undefined &&
      input.readIssuedAtMonotonicMs > ownedIntent.sentAtMonotonicMs;
    const verified =
      input.source === "rtc_readback" &&
      ordinal(input.readGeneration) &&
      input.freshSampleContract === true &&
      session !== null &&
      input.readIssuedAtMonotonicMs !== undefined &&
      input.receivedAtMonotonicMs !== undefined &&
      input.receivedAtMonotonicMs >= input.readIssuedAtMonotonicMs &&
      (row.observationFenceMs === undefined || input.readIssuedAtMonotonicMs > row.observationFenceMs) &&
      (!ownedIntent || (sameIntentScope && readAfter));
    const e: StateEvidence = {
      version: 1,
      runtimeGeneration: this.runtimeGeneration,
      sessionGeneration: session,
      source: input.source,
      receivedAtMs: input.receivedAtMs,
      receiveSequence: ordinal(input.receiveSequence) ? input.receiveSequence : null,
      producerTimeMs: producerTime,
      producerSequence: sequence,
      producerDomain: domain,
      readGeneration: ordinal(input.readGeneration) ? input.readGeneration : null,
      correlation: verified ? "verified" : ordinal(input.readGeneration) ? "temporal_only" : "none",
      intentGeneration: intent?.generation ?? null,
      dispatchRevision: intent?.revision ?? null,
      revision: (this.revision = increment(this.revision)),
      status: ordered || verified ? "current" : "uncertain",
      decision: ordered || verified ? "current" : "uncertain",
      reason: ordered ? "qualified_sample" : verified ? "post_dispatch_read" : "no_sample_order",
      confirmationEligible: false,
      readIssuedAfterDispatch: readAfter,
      offProof: null,
    };
    if (input.source === "command_echo") {
      e.status = "uncertain";
      e.decision = "uncertain";
      e.reason = "echo_not_proof";
    } else if (input.source === "rtc_readback" && !verified) e.reason = "unverified_read";
    const reject = (reason: EvidenceReason) => {
      e.status = "stale";
      e.decision = "retained";
      e.reason = reason;
    };
    if (input.runtimeGeneration && input.runtimeGeneration !== this.runtimeGeneration) reject("old_runtime");
    else if (session !== null && priorSession !== undefined && session < priorSession) reject("retired_session");
    else if (
      row.latest &&
      session !== null &&
      row.latest.evidence.sessionGeneration === session &&
      e.receiveSequence !== null &&
      row.latest.evidence.receiveSequence === e.receiveSequence
    )
      reject("duplicate");
    else if (ordered && previous?.ordered && previous.evidence.producerDomain === domain) {
      const before = previous.evidence;
      const cmp =
        sequence !== null && before.producerSequence !== null
          ? BigInt(sequence) < BigInt(before.producerSequence)
            ? -1
            : BigInt(sequence) > BigInt(before.producerSequence)
              ? 1
              : 0
          : producerTime !== null && before.producerTimeMs !== null
            ? Math.sign(producerTime - before.producerTimeMs)
            : null;
      if (cmp !== null && cmp < 0) reject("older_sample");
      else if (cmp === 0) {
        if (value === previous.value) reject("duplicate");
        else {
          e.status = "uncertain";
          e.decision = "uncertain";
          e.reason = "producer_conflict";
        }
      }
    } else if (previous && previous.value !== value && !verified && input.source !== "command_echo") {
      e.status = "uncertain";
      e.decision = "uncertain";
      e.reason = "incomparable_conflict";
    }
    if (
      producerTime !== null &&
      (input.receivedAtMs === null ||
        producerTime > input.receivedAtMs + 30_000 ||
        input.receivedAtMs - producerTime > 120_000) &&
      e.status === "current"
    ) {
      e.status = "uncertain";
      e.decision = "uncertain";
      e.reason = "sample_expired";
    }
    e.confirmationEligible =
      e.status === "current" &&
      ["rtc_push", "rtc_readback"].includes(input.source) &&
      session !== null &&
      !!intent &&
      value === intent.expected &&
      ((verified && readAfter) || (ordered && input.producerAfterDispatch === true));
    if (e.confirmationEligible) e.decision = "confirmation-of-command";
    const sample = { value, evidence: e, ordered, receivedAtMonotonicMs: input.receivedAtMonotonicMs };
    if (e.status !== "stale" && input.source !== "command_echo") {
      if (input.station && session !== null) row.station = input.station;
      row.observationFenceMs = Math.max(row.observationFenceMs ?? 0, input.receivedAtMonotonicMs ?? performance.now());
    }
    row.latest = sample;
    if (e.status === "current") {
      row.accepted = sample;
      row.lastKnown = sample;
      row.conflict = undefined;
    } else if (!row.lastKnown) row.lastKnown = sample;
    else if (row.lastKnown.value !== value) row.conflict = sample;
    this.total = increment(this.total);
    this.reasons[e.reason] = increment(this.reasons[e.reason] ?? 0);
  }

  /** Typed projection uses the model's scalar decoder and preserves original ingress identity. */
  project(target: string, param: number, property: string, value: unknown): StateEvidence | undefined {
    const row = this.rows.get(JSON.stringify([target, param]));
    if (!row?.latest) return undefined;
    const e = structuredClone(row.latest.evidence);
    if (
      value === undefined ||
      value === null ||
      !["boolean", "number", "string"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      e.status = "uncertain";
      e.decision = "uncertain";
      e.reason = "invalid_value";
      e.confirmationEligible = false;
    }
    if (property === "light" && value === false && row.intent?.expected === "0") {
      e.offProof = {
        eligible: e.confirmationEligible,
        reason: e.confirmationEligible ? e.reason : e.status === "current" ? "no_post_dispatch_anchor" : e.reason,
      };
    }
    if (row.projected !== e.revision) {
      row.projected = e.revision;
      if (e.offProof) {
        this.offAfterCommand = increment(this.offAfterCommand);
        if (e.offProof.eligible) {
          this.offProofEligible = increment(this.offProofEligible);
          if (row.intent?.off && !row.intent.proof) {
            row.intent.proof = true;
            this.offCommandsWithProof = increment(this.offCommandsWithProof);
          }
        }
      }
      if (this.recent.length === 32) this.recent.shift();
      this.recent.push({
        target: row.target,
        property: ["light", "armingMode", "currentMode"].includes(property) ? property : "other",
        revision: e.revision,
        source: e.source,
        receivedAtMs: e.receivedAtMs,
        correlation: e.correlation,
        readIssuedAfterDispatch: e.readIssuedAfterDispatch,
        status: e.status,
        decision: e.decision,
        reason: e.reason,
        offProof: structuredClone(e.offProof),
      });
    }
    return e;
  }

  diagnostics() {
    return structuredClone({
      ...stateEvidenceCapability,
      total: this.total,
      evicted: this.evicted,
      retainedParameters: this.rows.size,
      offCommands: this.offCommands,
      offCommandsWithProof: this.offCommandsWithProof,
      offCommandsWithoutProof: this.offCommands - this.offCommandsWithProof,
      offAfterCommand: this.offAfterCommand,
      offProofEligible: this.offProofEligible,
      offUnresolved: this.offAfterCommand - this.offProofEligible,
      reasons: this.reasons,
      recent: this.recent,
    });
  }
}
