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
  constructor(private readonly event: (receipt: GuardReceipt) => void) {}

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
    if (this.current(op)) op.receipt.attempts = 1;
  }

  dispatched(op: GuardOperation, session?: number): void {
    if (!this.current(op)) return;
    op.dispatchAt = performance.now();
    op.session = session;
    op.receipt.reason = "waiting_report";
    clearTimeout(op.timer);
    op.timer = setTimeout(
      () => this.finish(op, "not_reported", performance.now() >= op.deadline ? "budget_expired" : "window_expired"),
      Math.min(20_000, op.deadline - op.dispatchAt),
    );
    op.timer.unref?.();
    this.event({ ...op.receipt });
  }

  observe(
    station: string,
    deviceSn: string,
    params: Record<number, string>,
    session?: number,
    receivedAt = performance.now(),
  ): void {
    for (const op of this.active.values()) {
      if (op.station !== station || op.receipt.deviceSn !== deviceSn || op.dispatchAt === undefined) continue;
      if (op.session !== session) {
        this.finish(op, "not_reported", "session_changed");
        continue;
      }
      if (!this.current(op)) continue;
      if (performance.now() >= op.dispatchAt + 20_000) {
        this.finish(op, "not_reported", "window_expired");
        continue;
      }
      const raw = params[op.param];
      if (receivedAt <= op.dispatchAt || typeof raw !== "string" || !/^[0-9]+$/.test(raw) || !guardModeRequest(raw))
        continue;
      this.finish(
        op,
        Number(raw) === op.receipt.requestedMode ? "reported" : "contradicted",
        Number(raw) === op.receipt.requestedMode ? "reported_after_command" : "different_mode_reported",
      );
    }
  }

  finish(op: GuardOperation, outcome: Exclude<GuardReceipt["outcome"], "pending">, reason: GuardReason): void {
    if (op.receipt.outcome !== "pending") return;
    clearTimeout(op.timer);
    op.abortCleanup?.();
    op.receipt = { ...op.receipt, outcome, reason, outcomeAtMs: Date.now() };
    op.terminalAt = performance.now();
    if (this.active.get(`${op.station}:${op.param}`) === op) this.active.delete(`${op.station}:${op.param}`);
    this.totals[outcome] = Math.min(Number.MAX_SAFE_INTEGER, this.totals[outcome] + 1);
    if (!["dispatch_rejected", "transport_uncertain"].includes(reason)) op.release?.();
    this.prune();
    this.event({ ...op.receipt });
  }

  closeStation(station: string): void {
    for (const op of this.active.values())
      if (op.station === station) this.finish(op, "not_reported", "session_changed");
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
