import { guardModeRequest } from "../model/capabilities/arming.js";
import { randomUUID } from "node:crypto";

export const guardConfirmationCapability = Object.freeze({ version: 1, maxAttempts: 1, enabledRetry: false });
export type GuardReason =
  | "waiting_dispatch"
  | "waiting_report"
  | "reported_after_command"
  | "different_mode_reported"
  | "window_expired"
  | "budget_expired"
  | "ack_missing"
  | "transport_uncertain"
  | "cancelled"
  | "superseded"
  | "session_changed"
  | "runtime_closed"
  | "dispatch_rejected";
export interface GuardReceipt {
  version: 1;
  runtimeGeneration: string;
  handle: string;
  generation: number;
  deviceSn: string;
  requestedMode: number;
  outcome: "pending" | "reported" | "contradicted" | "not_reported";
  reason: GuardReason;
  attempts: number;
  outcomeAtMs: number | null;
}
export interface GuardOperation {
  receipt: GuardReceipt;
  station: string;
  param: number;
  caller?: string;
  deadline: number;
  dispatchAt?: number;
  session?: number;
  sessionChanged?: boolean;
  lastObservedMode?: number;
  confirmationRequested?: boolean;
  confirmationReadStarted?: boolean;
  confirmationAt?: number;
  confirmationTimer?: ReturnType<typeof setTimeout>;
  timer?: ReturnType<typeof setTimeout>;
  terminalAt?: number;
  promise?: Promise<GuardReceipt>;
  release?: () => void;
  abortCleanup?: () => void;
}

/** Owns one temporal-only report window per station/property; no command is replayed. */
export class GuardConfirmationOwner {
  readonly runtimeGeneration = randomUUID();
  private generation = 0;
  private active = new Map<string, GuardOperation>();
  private receipts = new Map<string, GuardOperation>();
  private totals = { reported: 0, contradicted: 0, not_reported: 0 };
  constructor(
    private readonly event: (receipt: GuardReceipt) => void,
    private readonly confirm?: (op: GuardOperation) => void,
  ) {}

  begin(deviceSn: string, station: string, param: number, requestedMode: number, caller?: string): GuardOperation {
    this.prune();
    if (caller !== undefined) {
      const duplicate = [...this.receipts.values()].find(
        (op) => op.station === station && op.param === param && op.caller === caller,
      );
      if (duplicate) {
        if (duplicate.receipt.requestedMode !== requestedMode)
          throw new Error("guard intent generation reused with another mode");
        return duplicate;
      }
    }
    const key = `${station}:${param}`;
    const previous = this.active.get(key);
    if (
      previous &&
      previous.receipt.requestedMode === requestedMode &&
      (caller === undefined || caller === previous.caller)
    )
      return previous;
    if (previous) this.finish(previous, "not_reported", "superseded");
    if (this.active.size >= 1024) throw new Error("guard confirmation capacity exhausted");
    const op: GuardOperation = {
      receipt: {
        version: 1,
        runtimeGeneration: this.runtimeGeneration,
        handle: randomUUID(),
        generation: ++this.generation,
        deviceSn,
        requestedMode,
        outcome: "pending",
        reason: "waiting_dispatch",
        attempts: 0,
        outcomeAtMs: null,
      },
      station,
      param,
      caller,
      deadline: performance.now() + 55_000,
    };
    this.active.set(key, op);
    this.receipts.set(op.receipt.handle, op);
    op.timer = setTimeout(() => this.finish(op, "not_reported", "budget_expired"), 55_000);
    op.timer.unref?.();
    return op;
  }

  current(op: GuardOperation): boolean {
    if (performance.now() >= op.deadline) this.finish(op, "not_reported", "budget_expired");
    return op.receipt.outcome === "pending" && this.active.get(`${op.station}:${op.param}`) === op;
  }

  /** Joins the original dispatch promise, including admission/preparation time in the budget. */
  run(op: GuardOperation, dispatch: () => Promise<unknown>, signal?: AbortSignal): Promise<GuardReceipt> {
    if (op.promise)
      return op.receipt.outcome === "pending" ||
        ["dispatch_rejected", "transport_uncertain"].includes(op.receipt.reason)
        ? op.promise
        : Promise.resolve({ ...op.receipt });
    if (signal) {
      const abort = () => this.finish(op, "not_reported", "cancelled");
      signal.addEventListener("abort", abort, { once: true });
      op.abortCleanup = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    }
    if (!this.current(op)) return Promise.resolve({ ...op.receipt });
    const ended = new Promise<void>((resolve) => {
      op.release = resolve;
    });
    const sent = Promise.resolve().then(dispatch);
    op.promise = Promise.race([sent, ended]).then(() => ({ ...op.receipt }));
    return op.promise;
  }

  sent(op: GuardOperation): void {
    if (!this.current(op) || op.dispatchAt !== undefined) return;
    op.receipt.attempts = 1;
    op.dispatchAt = performance.now();
    op.receipt.reason = "waiting_report";
    clearTimeout(op.timer);
    op.timer = setTimeout(() => this.expire(op), Math.min(20_000, op.deadline - op.dispatchAt));
    op.timer.unref?.();
    const confirmationDelay = Math.min(12_000, Math.max(0, op.deadline - op.dispatchAt - 8_000));
    op.confirmationAt = op.dispatchAt + confirmationDelay;
    op.confirmationTimer = setTimeout(() => this.confirmContradiction(op), confirmationDelay);
    op.confirmationTimer.unref?.();
    this.event({ ...op.receipt });
  }

  dispatched(op: GuardOperation, session?: number): void {
    if (!this.current(op)) return;
    this.sent(op);
    op.session ??= session;
  }

  /** Current-session reports correlate temporally across replacements; different modes remain provisional. */
  observe(
    station: string,
    deviceSn: string,
    params: Record<number, string>,
    session?: number,
    receivedAt = performance.now(),
  ): void {
    for (const op of this.active.values()) {
      if (op.station !== station || op.receipt.deviceSn !== deviceSn || op.dispatchAt === undefined) continue;
      if (receivedAt <= op.dispatchAt) continue;
      if (op.session !== undefined && session !== undefined && op.session !== session) {
        op.session = session;
        op.sessionChanged = true;
        op.lastObservedMode = undefined;
      }
      if (session !== undefined) op.session = session;
      if (!this.current(op)) continue;
      if (performance.now() >= op.dispatchAt + 20_000) {
        this.expire(op);
        continue;
      }
      const raw = params[op.param];
      if (typeof raw !== "string" || !/^[0-9]+$/.test(raw) || !guardModeRequest(raw)) continue;
      op.lastObservedMode = Number(raw);
      if (op.lastObservedMode === op.receipt.requestedMode) this.finish(op, "reported", "reported_after_command");
      else if (performance.now() >= op.confirmationAt!) this.confirmContradiction(op);
    }
  }

  private confirmContradiction(op: GuardOperation): void {
    if (
      !this.current(op) ||
      op.confirmationRequested ||
      op.lastObservedMode === undefined ||
      op.lastObservedMode === op.receipt.requestedMode ||
      performance.now() >= op.dispatchAt! + 20_000
    )
      return;
    op.confirmationRequested = true;
    this.confirm?.(op);
  }

  private expire(op: GuardOperation): void {
    if (
      op.lastObservedMode !== undefined &&
      op.lastObservedMode !== op.receipt.requestedMode &&
      (!this.confirm || op.confirmationReadStarted)
    )
      this.finish(op, "contradicted", "different_mode_reported");
    else if (op.sessionChanged) this.finish(op, "not_reported", "session_changed");
    else this.finish(op, "not_reported", performance.now() >= op.deadline ? "budget_expired" : "window_expired");
  }

  finish(op: GuardOperation, outcome: Exclude<GuardReceipt["outcome"], "pending">, reason: GuardReason): void {
    if (op.receipt.outcome !== "pending") return;
    clearTimeout(op.timer);
    clearTimeout(op.confirmationTimer);
    op.abortCleanup?.();
    op.receipt = { ...op.receipt, outcome, reason, outcomeAtMs: Date.now() };
    op.terminalAt = performance.now();
    if (this.active.get(`${op.station}:${op.param}`) === op) this.active.delete(`${op.station}:${op.param}`);
    this.totals[outcome] = Math.min(Number.MAX_SAFE_INTEGER, this.totals[outcome] + 1);
    if (!["dispatch_rejected", "transport_uncertain"].includes(reason)) op.release?.();
    this.prune();
    this.event({ ...op.receipt });
  }

  /** Session retirement preserves the original report window and never grants another send. */
  closeStation(station: string): void {
    for (const op of this.pendingStation(station)) {
      op.sessionChanged = true;
      op.lastObservedMode = undefined;
    }
  }

  pendingStation(station: string): GuardOperation[] {
    return [...this.active.values()].filter((op) => op.station === station && op.dispatchAt !== undefined);
  }
  close(): void {
    for (const op of this.active.values()) this.finish(op, "not_reported", "runtime_closed");
  }
  get(handle: string): GuardReceipt | null {
    this.prune();
    const op = this.receipts.get(handle);
    return op ? { ...op.receipt } : null;
  }
  diagnostics() {
    return { ...guardConfirmationCapability, ...this.totals, pending: this.active.size };
  }
  private prune(): void {
    const terminal = [...this.receipts.values()].filter((op) => op.terminalAt !== undefined);
    for (const [index, op] of terminal.entries())
      if (performance.now() - op.terminalAt! >= 600_000 || index < terminal.length - 32)
        this.receipts.delete(op.receipt.handle);
  }
}
