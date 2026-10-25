import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CommandReceipt } from "../core/contracts.js";

export const CAMERA_CONTACT_TTL_MS = 300_000;
export const CAMERA_SUSPECT_TTL_MS = 600_000;
export const CAMERA_HEALTH_CAPACITY = 1_024;
export const CAMERA_CONTACT_PUBLISH_MS = 60_000;

export type CameraConnectivity = "unknown" | "online" | "suspect" | "offline";
export type CameraPower = "mains" | "battery" | "unknown";
export type CameraParentTransport = "connected" | "disconnected" | "unknown";
export type CameraOutcomeStatus = "acknowledged" | "rejected" | "timeout" | "other";
export type CameraStatusSource = "hub_report" | "cloud_params";
type OutcomeCounts = Record<CameraOutcomeStatus, number>;

/** Versioned observation-only camera assessment, independent of command permission. */
export interface CameraHealth {
  version: 1;
  incarnation: string;
  revision: number;
  connectivity: CameraConnectivity;
  basis:
    | "startup"
    | "child_contact"
    | "media"
    | "hub_reported_offline"
    | "vendor_status"
    | "contact_expired"
    | "suspect_expired"
    | "parent_unassessable";
  evidence: "vendor_verified" | "hub_reported" | "unqualified" | "none";
  sinceMs: number | null;
  /** Published contact may lag exact internal contact by up to 60 s; expiry uses exact contact. */
  lastContactMs: number | null;
  lastContactSource: "push" | "media" | null;
  lastHubOfflineMs: number | null;
  hubOfflineCount: number;
  lastHubReportMs: number | null;
  lastCloudParamMs: number | null;
  rssi: { value: number | null; valid: boolean; lastValidMs: number | null };
  rawStatus: {
    p1131: number | boolean | null;
    p1182: number | boolean | null;
    observedMs: number | null;
    /** Source of the latest raw-update batch, including an 1182-only update; not per-parameter freshness. */
    source?: CameraStatusSource | null;
  };
  parentTransport: CameraParentTransport;
  enforcement: "observe_only";
  commandsBlocked: false;
  outcomes: Record<CameraConnectivity, OutcomeCounts>;
  lastOutcome: {
    atMs: number;
    connectivity: CameraConnectivity;
    status: CameraOutcomeStatus;
    code: number | null;
  } | null;
}

export interface CameraHealthEvent extends CameraHealth {
  device: string;
}

/** Identity and local receipt time are required even for diagnostic-only evidence. */
interface EvidenceIdentity {
  accountId: string;
  device: string;
  receivedAtMs: number;
}

/** Qualification flags describe independently established source provenance, never a status-name guess. */
export type CameraHealthEvidence = EvidenceIdentity &
  (
    | { kind: "push"; qualified: boolean; childOrigin: boolean; observedAtMs: number }
    | { kind: "media"; qualified: boolean; live: boolean; cached: boolean; prebuffered: boolean }
    | { kind: "hub_offline"; correlated: boolean; code: number }
    | { kind: "vendor_offline"; qualified: boolean; observedAtMs: number }
    | { kind: "hub_report" }
    | { kind: "cloud_params" }
    | { kind: "rssi"; value: unknown }
    | {
        kind: "raw_status";
        p1131?: number | boolean | null;
        p1182?: number | boolean | null;
        source?: CameraStatusSource;
      }
  );

export interface CameraHealthClock {
  nowMs: number;
  monotonicMs: number;
}

/** Fixed-size ordering metadata and one monotonic expiry accompany each camera. */
export interface CameraHealthState {
  readonly accountId: string;
  readonly device: string;
  readonly power: CameraPower;
  readonly hubStatusQualified: boolean;
  readonly health: CameraHealth;
  assessmentAtMs: number;
  expiresAtMonotonicMs: number | null;
  lastMonotonicMs: number;
  lastContactAtMs: number | null;
  lastContactSource: "push" | "media" | null;
  readonly received: Partial<Record<CameraHealthEvidence["kind"] | "parent" | "outcome", number>>;
}

export type CameraHealthInput =
  | CameraHealthEvidence
  | { kind: "tick" }
  | (EvidenceIdentity & { kind: "parent"; transport: CameraParentTransport })
  | (EvidenceIdentity & {
      kind: "outcome";
      connectivity: CameraConnectivity;
      status: CameraOutcomeStatus;
      code: number | null;
    });

const CONNECTIVITY = ["online", "suspect", "offline", "unknown"] as const;
const OUTCOMES = ["acknowledged", "rejected", "timeout", "other"] as const;

function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function clockValid(clock: CameraHealthClock): boolean {
  return epoch(clock.nowMs) && Number.isFinite(clock.monotonicMs) && clock.monotonicMs >= 0;
}

function rawValid(value: unknown): value is number | boolean | null {
  return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function counts(): OutcomeCounts {
  return { acknowledged: 0, rejected: 0, timeout: 0, other: 0 };
}

/** Creates unknown state without any child, parent or command inference. */
export function createCameraHealthState(
  accountId: string,
  device: string,
  power: CameraPower,
  incarnation: string,
  clock: CameraHealthClock,
  hubStatusQualified = false,
): CameraHealthState {
  if (
    !accountId ||
    !device ||
    !["mains", "battery", "unknown"].includes(power) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(incarnation) ||
    !clockValid(clock)
  )
    throw new TypeError("Invalid camera health identity or clock");
  return {
    accountId,
    device,
    power,
    hubStatusQualified,
    assessmentAtMs: -1,
    expiresAtMonotonicMs: null,
    lastMonotonicMs: clock.monotonicMs,
    lastContactAtMs: null,
    lastContactSource: null,
    received: {},
    health: {
      version: 1,
      incarnation,
      revision: 0,
      connectivity: "unknown",
      basis: "startup",
      evidence: "none",
      sinceMs: clock.nowMs,
      lastContactMs: null,
      lastContactSource: null,
      lastHubOfflineMs: null,
      hubOfflineCount: 0,
      lastHubReportMs: null,
      lastCloudParamMs: null,
      rssi: { value: null, valid: false, lastValidMs: null },
      rawStatus: { p1131: null, p1182: null, observedMs: null },
      parentTransport: "unknown",
      enforcement: "observe_only",
      commandsBlocked: false,
      outcomes: { online: counts(), suspect: counts(), offline: counts(), unknown: counts() },
      lastOutcome: null,
    },
  };
}

/** Pure transition; malformed, future, misattributed and older evidence returns the original state. */
export function reduceCameraHealth(
  state: CameraHealthState,
  input: CameraHealthInput,
  clock: CameraHealthClock,
): CameraHealthState {
  if (!clockValid(clock) || clock.monotonicMs < state.lastMonotonicMs || !input || typeof input !== "object")
    return state;
  if (input.kind !== "tick") {
    if (
      input.accountId !== state.accountId ||
      input.device !== state.device ||
      !epoch(input.receivedAtMs) ||
      input.receivedAtMs > clock.nowMs ||
      input.receivedAtMs < (state.received[input.kind] ?? -1)
    )
      return state;
  }
  const next = structuredClone(state);
  let assessmentAtMs = state.assessmentAtMs;
  let expiresAtMonotonicMs = state.expiresAtMonotonicMs;
  const health = next.health;
  const assess = (
    connectivity: CameraConnectivity,
    basis: CameraHealth["basis"],
    evidence: CameraHealth["evidence"],
    atMs: number,
    ttlMs: number | null,
  ): void => {
    if (atMs < assessmentAtMs) return;
    if (health.connectivity !== connectivity || health.basis !== basis || health.evidence !== evidence)
      health.sinceMs = clock.nowMs;
    health.connectivity = connectivity;
    health.basis = basis;
    health.evidence = evidence;
    assessmentAtMs = atMs;
    expiresAtMonotonicMs = ttlMs === null ? null : clock.monotonicMs + Math.max(0, ttlMs - (clock.nowMs - atMs));
  };
  const producerTimeValid = (atMs: number): boolean =>
    epoch(atMs) && atMs <= inputReceipt(input) && atMs <= clock.nowMs;
  switch (input.kind) {
    case "tick":
      break;
    case "push":
    case "media": {
      const atMs = input.kind === "push" ? input.observedAtMs : input.receivedAtMs;
      if (
        input.qualified !== true ||
        (input.kind === "push" && (input.childOrigin !== true || !producerTimeValid(atMs))) ||
        (input.kind === "media" && (input.live !== true || input.cached !== false || input.prebuffered !== false)) ||
        clock.nowMs - atMs >= CAMERA_CONTACT_TTL_MS ||
        atMs <= Math.max(state.lastContactAtMs ?? -1, state.assessmentAtMs)
      )
        return state;
      next.lastContactAtMs = atMs;
      next.lastContactSource = input.kind;
      if (state.power === "mains" && health.parentTransport !== "disconnected")
        assess(
          "online",
          input.kind === "push" ? "child_contact" : "media",
          "vendor_verified",
          atMs,
          CAMERA_CONTACT_TTL_MS,
        );
      break;
    }
    case "hub_offline":
      if (input.correlated !== true || input.code !== -109 || input.receivedAtMs < state.assessmentAtMs) return state;
      health.lastHubOfflineMs = input.receivedAtMs;
      health.hubOfflineCount = Math.min(Number.MAX_SAFE_INTEGER, health.hubOfflineCount + 1);
      if (health.parentTransport !== "disconnected" && health.connectivity !== "offline")
        assess("suspect", "hub_reported_offline", "hub_reported", input.receivedAtMs, CAMERA_SUSPECT_TTL_MS);
      break;
    case "vendor_offline":
      if (
        input.qualified !== true ||
        !producerTimeValid(input.observedAtMs) ||
        input.observedAtMs <= state.assessmentAtMs
      )
        return state;
      if (health.parentTransport !== "disconnected")
        assess("offline", "vendor_status", "vendor_verified", input.observedAtMs, null);
      break;
    case "parent":
      if (!["connected", "disconnected", "unknown"].includes(input.transport)) return state;
      if (input.receivedAtMs < state.assessmentAtMs) return state;
      health.parentTransport = input.transport;
      if (input.transport !== "connected") {
        if (health.connectivity !== "unknown" || health.basis !== "parent_unassessable") health.sinceMs = clock.nowMs;
        health.connectivity = "unknown";
        health.basis = "parent_unassessable";
        health.evidence = "none";
        assessmentAtMs = input.receivedAtMs;
        expiresAtMonotonicMs = null;
      }
      break;
    case "hub_report":
      health.lastHubReportMs = input.receivedAtMs;
      break;
    case "cloud_params":
      health.lastCloudParamMs = input.receivedAtMs;
      break;
    case "rssi": {
      const valid = typeof input.value === "number" && Number.isSafeInteger(input.value) && input.value !== -100;
      health.rssi = {
        value: valid ? (input.value as number) : null,
        valid,
        lastValidMs: valid ? input.receivedAtMs : health.rssi.lastValidMs,
      };
      break;
    }
    case "raw_status": {
      if (
        (input.p1131 === undefined && input.p1182 === undefined) ||
        (input.p1131 !== undefined && !rawValid(input.p1131)) ||
        (input.p1182 !== undefined && !rawValid(input.p1182)) ||
        (input.source !== undefined && !["hub_report", "cloud_params"].includes(input.source))
      )
        return state;
      health.rawStatus = {
        p1131: input.p1131 === undefined ? health.rawStatus.p1131 : input.p1131,
        p1182: input.p1182 === undefined ? health.rawStatus.p1182 : input.p1182,
        observedMs: input.receivedAtMs,
        source: input.source ?? null,
      };
      if (
        state.hubStatusQualified &&
        state.power === "mains" &&
        input.source === "hub_report" &&
        (input.p1131 === 0 || input.p1131 === 1 || typeof input.p1131 === "boolean") &&
        input.receivedAtMs > state.assessmentAtMs
      ) {
        if (health.parentTransport !== "connected")
          assess("unknown", "parent_unassessable", "none", input.receivedAtMs, null);
        else {
          const online = input.p1131 === 1 || input.p1131 === true;
          assess(
            online ? "online" : "offline",
            "vendor_status",
            "hub_reported",
            input.receivedAtMs,
            online ? CAMERA_CONTACT_TTL_MS : null,
          );
        }
      }
      break;
    }
    case "outcome":
      if (
        !CONNECTIVITY.includes(input.connectivity) ||
        !OUTCOMES.includes(input.status) ||
        (input.code !== null && !Number.isSafeInteger(input.code))
      )
        return state;
      health.outcomes[input.connectivity][input.status] = Math.min(
        Number.MAX_SAFE_INTEGER,
        health.outcomes[input.connectivity][input.status] + 1,
      );
      health.lastOutcome = {
        atMs: input.receivedAtMs,
        connectivity: input.connectivity,
        status: input.status,
        code: input.code,
      };
      break;
    default:
      return state;
  }
  if (expiresAtMonotonicMs !== null && clock.monotonicMs >= expiresAtMonotonicMs) {
    health.basis = health.connectivity === "suspect" ? "suspect_expired" : "contact_expired";
    health.connectivity = "unknown";
    health.evidence = "none";
    health.sinceMs = clock.nowMs;
    expiresAtMonotonicMs = null;
  }
  if (input.kind !== "tick") next.received[input.kind] = input.receivedAtMs;
  const changed = JSON.stringify(health) !== JSON.stringify(state.health);
  if (
    changed ||
    (next.lastContactAtMs !== null &&
      (health.lastContactMs === null || next.lastContactAtMs - health.lastContactMs >= CAMERA_CONTACT_PUBLISH_MS))
  ) {
    health.lastContactMs = next.lastContactAtMs;
    health.lastContactSource = next.lastContactSource;
    health.revision++;
  }
  if (health.revision === state.health.revision && input.kind === "tick") return state;
  return { ...next, assessmentAtMs, expiresAtMonotonicMs, lastMonotonicMs: clock.monotonicMs };
}

function inputReceipt(input: CameraHealthInput): number {
  return input.kind === "tick" ? -1 : input.receivedAtMs;
}

export interface CameraHealthStoreOptions {
  accountId: string;
  event?: (event: CameraHealthEvent) => void;
  now?: () => number;
  monotonicNow?: () => number;
  maxCameras?: number;
}

interface Entry {
  state: CameraHealthState;
  timer?: ReturnType<typeof setTimeout>;
}

/** Bounded per-account state, a random client incarnation and at most one unreferenced timer per camera. */
export class CameraHealthStore {
  readonly incarnation = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private revision = 0;
  private closed = false;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;

  constructor(private readonly options: CameraHealthStoreOptions) {
    this.capacity = options.maxCameras ?? CAMERA_HEALTH_CAPACITY;
    if (
      !options.accountId ||
      !Number.isSafeInteger(this.capacity) ||
      this.capacity < 1 ||
      this.capacity > CAMERA_HEALTH_CAPACITY
    )
      throw new TypeError("Invalid camera health account or capacity");
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  register(device: string, power: CameraPower, hubStatusQualified = false): CameraHealth | undefined {
    if (this.closed || !device || !["mains", "battery", "unknown"].includes(power)) return undefined;
    if (!this.entries.has(device)) {
      if (this.entries.size >= this.capacity) return undefined;
      const state = createCameraHealthState(
        this.options.accountId,
        device,
        power,
        this.incarnation,
        this.clock(),
        hubStatusQualified,
      );
      state.health.revision = ++this.revision;
      this.entries.set(device, { state });
      this.emit(device, state.health);
    }
    const entry = this.entries.get(device)!;
    if (entry.state.power !== power || entry.state.hubStatusQualified !== hubStatusQualified)
      entry.state = { ...entry.state, power, hubStatusQualified };
    return this.status(device);
  }

  status(device: string): CameraHealth | undefined {
    return this.apply(device, { kind: "tick" });
  }

  observe(device: string, evidence: CameraHealthEvidence): CameraHealth | undefined {
    return this.apply(device, evidence);
  }

  /** Qualified source contact updates exact expiry in place, allocating only for publication. */
  media(device: string): void {
    const entry = this.entries.get(device);
    if (!entry || this.closed) return;
    const state = entry.state;
    const health = state.health;
    const nowMs = this.now();
    const monotonicMs = this.monotonicNow();
    if (
      !epoch(nowMs) ||
      !Number.isFinite(monotonicMs) ||
      monotonicMs < state.lastMonotonicMs ||
      nowMs <= Math.max(state.lastContactAtMs ?? -1, state.assessmentAtMs) ||
      nowMs < (state.received.media ?? -1)
    )
      return;
    if (
      health.lastContactMs !== null &&
      nowMs - health.lastContactMs < CAMERA_CONTACT_PUBLISH_MS &&
      (state.expiresAtMonotonicMs === null || monotonicMs < state.expiresAtMonotonicMs) &&
      (state.power !== "mains" ||
        health.parentTransport === "disconnected" ||
        (health.connectivity === "online" && health.basis === "media" && health.evidence === "vendor_verified"))
    ) {
      state.lastContactAtMs = nowMs;
      state.lastContactSource = "media";
      state.lastMonotonicMs = monotonicMs;
      state.received.media = nowMs;
      if (state.power === "mains" && health.parentTransport !== "disconnected") {
        state.assessmentAtMs = nowMs;
        state.expiresAtMonotonicMs = monotonicMs + CAMERA_CONTACT_TTL_MS;
      }
      return;
    }
    this.apply(device, {
      kind: "media",
      accountId: this.options.accountId,
      device,
      receivedAtMs: nowMs,
      qualified: true,
      live: true,
      cached: false,
      prebuffered: false,
    });
  }

  parent(device: string, transport: CameraParentTransport): CameraHealth | undefined {
    return this.apply(device, {
      kind: "parent",
      accountId: this.options.accountId,
      device,
      receivedAtMs: this.now(),
      transport,
    });
  }

  /** Finalized receipts retain admission connectivity; ACK and refusal codes never imply child contact. */
  outcome(device: string, connectivity: CameraConnectivity, receipt: CommandReceipt): CameraHealth | undefined {
    const status =
      receipt.status === "acknowledged" || receipt.status === "rejected"
        ? receipt.status
        : ["ack_timeout", "connect_timeout", "expired_after_send"].includes(receipt.status)
          ? "timeout"
          : "other";
    return this.apply(device, {
      kind: "outcome",
      accountId: this.options.accountId,
      device,
      receivedAtMs: this.now(),
      connectivity,
      status,
      code: receipt.rejectionCode ?? null,
    });
  }

  remove(device: string): void {
    clearTimeout(this.entries.get(device)?.timer);
    this.entries.delete(device);
  }

  /** Complete roster replacement releases removed-camera state and its expiry timer. */
  retain(devices: readonly string[]): void {
    const retained = new Set(devices);
    for (const device of this.entries.keys()) if (!retained.has(device)) this.remove(device);
  }

  diagnostics(): { entries: number; timers: number; capacity: number } {
    return {
      entries: this.entries.size,
      timers: [...this.entries.values()].filter((entry) => entry.timer !== undefined).length,
      capacity: this.capacity,
    };
  }

  close(): void {
    for (const device of this.entries.keys()) this.remove(device);
    this.closed = true;
  }

  private clock(): CameraHealthClock {
    return { nowMs: this.now(), monotonicMs: this.monotonicNow() };
  }

  private apply(device: string, input: CameraHealthInput): CameraHealth | undefined {
    const entry = this.entries.get(device);
    if (!entry || this.closed) return undefined;
    const previous = entry.state;
    entry.state = reduceCameraHealth(previous, input, this.clock());
    if (entry.state.health.revision !== previous.health.revision) {
      entry.state.health.revision = ++this.revision;
      this.schedule(device, entry);
      this.emit(device, entry.state.health);
    }
    return structuredClone(entry.state.health);
  }

  private schedule(device: string, entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.state.expiresAtMonotonicMs === null) return;
    const remaining = Math.max(1, entry.state.expiresAtMonotonicMs - this.monotonicNow());
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.entries.get(device) !== entry) return;
      this.status(device);
      if (this.entries.get(device) === entry && entry.timer === undefined && entry.state.expiresAtMonotonicMs !== null)
        this.schedule(device, entry);
    }, remaining);
    entry.timer.unref?.();
  }

  private emit(device: string, health: CameraHealth): void {
    this.options.event?.({ device, ...structuredClone(health) });
  }
}
