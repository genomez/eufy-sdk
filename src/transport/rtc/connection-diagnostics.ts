import type { RtcSessionCloseOrigin } from "./session.js";

/** Finite execution phases; no protocol payload or exception is retained. */
export type RtcConnectionStage =
  | "sign"
  | "signaling_transport"
  | "signaling_auth"
  | "call"
  | "grant"
  | "peer_init"
  | "offer"
  | "answer"
  | "command_channel"
  | "signaling"
  | "peer"
  | "call_retry";
export interface RtcConnectionStageEvent {
  stage: RtcConnectionStage;
  status: "started" | "succeeded" | "failed" | "observed";
  atMs: number | null;
}
export interface RtcConnectionStageEvidence {
  events: RtcConnectionStageEvent[];
  evicted: number;
  lastFailure: RtcConnectionStageEvent | null;
}

const STAGES: readonly RtcConnectionStage[] = [
  "sign",
  "signaling_transport",
  "signaling_auth",
  "call",
  "grant",
  "peer_init",
  "offer",
  "answer",
  "command_channel",
  "signaling",
  "peer",
  "call_retry",
];
const STATUSES: readonly RtcConnectionStageEvent["status"][] = ["started", "succeeded", "failed", "observed"];

/** Only the declared close-origin vocabulary survives an adapter read. */
export function connectionCloseOrigin(session: { readonly closeOrigin?: unknown }): RtcSessionCloseOrigin | null {
  try {
    const value = session.closeOrigin;
    return value === "local" ||
      value === "signaling_closed" ||
      value === "remote_hangup" ||
      value === "command_channel_closed" ||
      value === "peer_failed" ||
      value === "peer_closed"
      ? value
      : null;
  } catch {
    return null;
  }
}
export interface RtcConnectionRow {
  epoch: number;
  generation: number;
  role: "current" | "candidate";
  startedAtMs: number | null;
  endedAtMs: number | null;
  outcome: "opening" | "connected" | "connect_failed" | "connect_timeout" | "closed_before_open";
  retirement: "closed" | "retired" | "router_reset" | null;
  closeOrigin: RtcSessionCloseOrigin | null;
  stages: RtcConnectionStageEvidence | null;
}
export interface RtcConnectionDiagnostics {
  version: 1;
  incarnation: number;
  epoch: number;
  activeCap: 64;
  terminalCap: 32;
  eventCap: 32;
  activeCount: number;
  activeEvicted: number;
  terminalEvicted: number;
  active: RtcConnectionRow[];
  terminal: RtcConnectionRow[];
}

/** Invalid clocks remain unknown and never affect operational execution. */
export function connectionDiagnosticTime(): number | null {
  try {
    const value = Date.now();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Fixed-storage stage evidence shared privately by a session and its router row. */
export class ConnectionStageRecorder {
  private readonly evidence: RtcConnectionStageEvidence = { events: [], evicted: 0, lastFailure: null };

  record(stage: RtcConnectionStage, status: RtcConnectionStageEvent["status"]): void {
    try {
      if (!STAGES.includes(stage) || !STATUSES.includes(status)) return;
      const event = { stage, status, atMs: connectionDiagnosticTime() };
      this.evidence.events.push(event);
      if (status === "failed") this.evidence.lastFailure = event;
      if (this.evidence.events.length > 32) {
        this.evidence.events.shift();
        this.evidence.evicted = Math.min(Number.MAX_SAFE_INTEGER, this.evidence.evicted + 1);
      }
    } catch {}
  }

  snapshot(): RtcConnectionStageEvidence {
    return {
      events: this.evidence.events.map((event) => ({ ...event })),
      evicted: this.evidence.evicted,
      lastFailure: this.evidence.lastFailure ? { ...this.evidence.lastFailure } : null,
    };
  }
}

/** Internal row holds only finite evidence, never a session, identifier, callback or error. */
export interface ConnectionRecord extends Omit<RtcConnectionRow, "stages"> {
  stages: ConnectionStageRecorder | null;
}

/** Bounded current and retired evidence; reset boundaries do not erase prior failures. */
export class ConnectionEvidenceRecorder {
  private readonly active = new Set<ConnectionRecord>();
  private readonly terminal: ConnectionRecord[] = [];
  private activeCount = 0;
  private activeEvicted = 0;
  private terminalEvicted = 0;

  start(
    epoch: number,
    generation: number,
    candidate: boolean,
    stages: ConnectionStageRecorder | null,
  ): ConnectionRecord {
    const row: ConnectionRecord = {
      epoch,
      generation,
      role: candidate ? "candidate" : "current",
      startedAtMs: connectionDiagnosticTime(),
      endedAtMs: null,
      outcome: "opening",
      retirement: null,
      closeOrigin: null,
      stages,
    };
    try {
      this.activeCount = Math.min(Number.MAX_SAFE_INTEGER, this.activeCount + 1);
      this.active.add(row);
      if (this.active.size > 64) {
        this.active.delete(this.active.values().next().value!);
        this.activeEvicted = Math.min(Number.MAX_SAFE_INTEGER, this.activeEvicted + 1);
      }
    } catch {}
    return row;
  }

  retire(row: ConnectionRecord, retirement: NonNullable<RtcConnectionRow["retirement"]>): void {
    try {
      if (row.retirement !== null) return;
      row.retirement = retirement;
      row.endedAtMs = connectionDiagnosticTime();
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.active.delete(row);
      this.terminal.push(row);
      if (this.terminal.length > 32) {
        this.terminal.shift();
        this.terminalEvicted = Math.min(Number.MAX_SAFE_INTEGER, this.terminalEvicted + 1);
      }
    } catch {}
  }

  snapshot(incarnation: number, epoch: number): RtcConnectionDiagnostics {
    const copy = (row: ConnectionRecord): RtcConnectionRow => ({ ...row, stages: row.stages?.snapshot() ?? null });
    return {
      version: 1,
      incarnation,
      epoch,
      activeCap: 64,
      terminalCap: 32,
      eventCap: 32,
      activeCount: this.activeCount,
      activeEvicted: this.activeEvicted,
      terminalEvicted: this.terminalEvicted,
      active: [...this.active].map(copy),
      terminal: this.terminal.map(copy),
    };
  }
}
