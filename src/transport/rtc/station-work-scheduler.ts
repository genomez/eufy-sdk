import { performance } from "node:perf_hooks";

/** Finite admission failures without retained target identifiers. */
export class StationWorkError extends Error {
  constructor(
    readonly reason:
      "queue_full" | "expired_before_send" | "superseded_before_send" | "cancelled_before_send" | "closed_before_send",
  ) {
    super(reason);
  }
}

/** Anonymous counters scoped to one station owner. */
export interface StationWorkDiagnostics {
  queued: number;
  active: number;
  highWater: number;
  coalesced: number;
  queueFull: number;
  expiredBeforeSend: number;
  cancelledBeforeSend: number;
  cancelledAfterSend: number;
  supersededBeforeSend: number;
  closedBeforeSend: number;
  closedAfterSend: number;
  readTurns: number;
  readDeferrals: number;
  readExpired: number;
  retryDeferrals: number;
  invariantViolations: number;
  oldestWaitMs: number | null;
}

/** One removable exchange, optionally shared by independent information subscribers. */
export interface StationWorkOptions<T> {
  target: string;
  kind: "write" | "read";
  origin?: "caller" | "retry" | "correction";
  replacementKey?: string;
  replaceUnsent?: boolean;
  priority?: "late-check" | "report" | "routine";
  mergeKey?: string;
  notBeforeMs?: number;
  sendByMs: number;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  sendAttempted?: () => boolean;
  onQueued?: (depth: number, targetsAhead: number) => void;
  run: (signal: AbortSignal) => Promise<T>;
}

interface Subscriber {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}
interface Job {
  options: StationWorkOptions<unknown>;
  queuedAtMs: number;
  controller: AbortController;
  subscribers: Set<Subscriber>;
  active: boolean;
}

/** Bounded target rotation and information turns over exactly one active exchange. */
export class StationWorkScheduler {
  onIdle?: () => void;
  onChange?: (snapshot: StationWorkDiagnostics) => void;
  private jobs: Job[] = [];
  private active?: Job;
  private targets: string[] = [];
  private lastServedTarget?: string;
  private closed = false;
  private writesSinceRead = 0;
  private wake?: ReturnType<typeof setTimeout>;
  private readonly stats: StationWorkDiagnostics = {
    queued: 0,
    active: 0,
    highWater: 0,
    coalesced: 0,
    queueFull: 0,
    expiredBeforeSend: 0,
    cancelledBeforeSend: 0,
    cancelledAfterSend: 0,
    supersededBeforeSend: 0,
    closedBeforeSend: 0,
    closedAfterSend: 0,
    readTurns: 0,
    readDeferrals: 0,
    readExpired: 0,
    retryDeferrals: 0,
    invariantViolations: 0,
    oldestWaitMs: null,
  };

  constructor(private readonly now: () => number = () => performance.now()) {}

  private changed(): void {
    this.onChange?.(this.snapshot());
  }

  get idle(): boolean {
    return !this.active && this.jobs.length === 0;
  }

  snapshot(): StationWorkDiagnostics {
    return {
      ...this.stats,
      queued: this.jobs.length,
      active: this.active ? 1 : 0,
      oldestWaitMs: this.jobs.length ? Math.max(0, this.now() - Math.min(...this.jobs.map((j) => j.queuedAtMs))) : null,
    };
  }

  enqueue<T>(options: StationWorkOptions<T>): Promise<T> {
    if (this.closed) return Promise.reject(new StationWorkError("closed_before_send"));
    if (options.signal?.aborted) return Promise.reject(new StationWorkError("cancelled_before_send"));
    if (this.now() >= options.sendByMs) return Promise.reject(new StationWorkError("expired_before_send"));
    if (options.isCurrent?.() === false) return Promise.reject(new StationWorkError("superseded_before_send"));
    if (options.replacementKey) {
      for (const job of [...this.jobs]) {
        if (
          job.options.replacementKey === options.replacementKey &&
          (options.replaceUnsent !== false || job.options.replaceUnsent !== false)
        ) {
          this.stats.coalesced++;
          this.remove(job, "superseded_before_send");
        }
      }
    }
    let job =
      options.kind === "read" && options.mergeKey
        ? this.jobs.find((j) => j.options.kind === "read" && j.options.mergeKey === options.mergeKey)
        : undefined;
    if (job && job.subscribers.size >= 32) return Promise.reject(new StationWorkError("queue_full"));
    if (!job) {
      if (this.jobs.length >= 32) {
        this.stats.queueFull++;
        this.changed();
        return Promise.reject(new StationWorkError("queue_full"));
      }
      job = {
        options: options as StationWorkOptions<unknown>,
        queuedAtMs: this.now(),
        controller: new AbortController(),
        subscribers: new Set(),
        active: false,
      };
      this.jobs.push(job);
      if (options.kind === "write" && !this.targets.includes(options.target)) this.targets.push(options.target);
      this.stats.highWater = Math.max(this.stats.highWater, this.jobs.length);
    } else {
      this.stats.coalesced++;
      const rank = { "late-check": 0, report: 1, routine: 2 };
      if (rank[options.priority ?? "routine"] < rank[job.options.priority ?? "routine"])
        job.options.priority = options.priority;
      job.options.notBeforeMs = Math.max(job.options.notBeforeMs ?? 0, options.notBeforeMs ?? 0);
    }
    const current = job;
    options.onQueued?.(
      this.jobs.length,
      new Set(this.jobs.filter((j) => j !== job && j.options.kind === "write").map((j) => j.options.target)).size,
    );
    const promise = new Promise<T>((resolve, reject) => {
      const done = (requestedReason: "cancelled_before_send" | "expired_before_send") => {
        const reason =
          options.signal?.reason instanceof StationWorkError && options.signal.reason.reason === "expired_before_send"
            ? "expired_before_send"
            : requestedReason;
        if (current.active && reason === "expired_before_send") return;
        if (!current.subscribers.delete(subscriber)) return;
        subscriber.detach();
        reject(
          current.active
            ? (options.signal?.reason ?? new Error("RTC operation aborted"))
            : new StationWorkError(reason),
        );
        if (!current.active || current.options.sendAttempted?.() === false) {
          if (reason === "cancelled_before_send") this.stats.cancelledBeforeSend++;
          else {
            this.stats.expiredBeforeSend++;
            if (current.options.kind === "read") this.stats.readExpired++;
          }
        } else if (reason === "cancelled_before_send") this.stats.cancelledAfterSend++;
        if (current.subscribers.size === 0) {
          if (current.active) current.controller.abort(options.signal?.reason ?? new Error("RTC operation aborted"));
          else this.delete(current);
        }
        this.pump();
        this.changed();
      };
      const aborted = () => done("cancelled_before_send");
      const timer = setTimeout(() => done("expired_before_send"), Math.max(0, options.sendByMs - this.now()));
      const subscriber: Subscriber = {
        resolve: (value) => resolve(value as T),
        reject,
        detach: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", aborted);
        },
      };
      current.subscribers.add(subscriber);
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
    });
    this.changed();
    queueMicrotask(() => this.pump());
    return promise;
  }

  close(): void {
    this.closed = true;
    if (this.wake) clearTimeout(this.wake);
    for (const job of [...this.jobs]) this.remove(job, "closed_before_send");
    if (this.active) {
      if (this.active.options.sendAttempted?.() === false) this.stats.closedBeforeSend++;
      else this.stats.closedAfterSend++;
      this.active.controller.abort(new StationWorkError("closed_before_send"));
    }
    this.changed();
  }

  private delete(job: Job): void {
    this.jobs = this.jobs.filter((j) => j !== job);
    this.targets = this.targets.filter(
      (target) =>
        target === this.lastServedTarget ||
        this.jobs.some((j) => j.options.kind === "write" && j.options.target === target),
    );
  }

  private remove(job: Job, reason: "superseded_before_send" | "closed_before_send"): void {
    this.delete(job);
    this.stats[reason === "superseded_before_send" ? "supersededBeforeSend" : "closedBeforeSend"] +=
      job.subscribers.size;
    for (const subscriber of job.subscribers) {
      subscriber.detach();
      subscriber.reject(new StationWorkError(reason));
    }
    job.subscribers.clear();
    this.changed();
  }

  private pump(): void {
    if (this.closed || this.active || this.jobs.length === 0) return;
    const now = this.now();
    for (const job of [...this.jobs])
      if (job.options.isCurrent?.() === false) this.remove(job, "superseded_before_send");
    const eligible = this.jobs.filter((j) => (j.options.notBeforeMs ?? 0) <= now);
    const writes = eligible.filter((j) => j.options.kind === "write");
    const fresh = writes.filter((j) => j.options.origin !== "retry");
    const candidates = fresh.length ? fresh : writes;
    const rank = { "late-check": 0, report: 1, routine: 2 };
    const read = eligible
      .filter((j) => j.options.kind === "read")
      .sort((a, b) => rank[a.options.priority ?? "routine"] - rank[b.options.priority ?? "routine"])[0];
    let job: Job | undefined;
    if (read && (candidates.length === 0 || this.writesSinceRead >= 4)) job = read;
    else {
      const last = this.targets.indexOf(this.lastServedTarget ?? "");
      const rotation = last < 0 ? this.targets : [...this.targets.slice(last + 1), ...this.targets.slice(0, last + 1)];
      const target = rotation.find((t) => candidates.some((j) => j.options.target === t));
      job = candidates.find((j) => j.options.target === target);
      if (read && job) this.stats.readDeferrals++;
      if (fresh.length && writes.some((j) => j.options.origin === "retry")) this.stats.retryDeferrals++;
    }
    if (!job) {
      const next = Math.min(...this.jobs.map((j) => j.options.notBeforeMs ?? now));
      if (Number.isFinite(next) && next > now) {
        clearTimeout(this.wake);
        this.wake = setTimeout(() => this.pump(), next - now);
      }
      return;
    }
    if (job.options.kind === "write") this.lastServedTarget = job.options.target;
    this.delete(job);
    job.active = true;
    this.active = job;
    this.changed();
    const current = job;
    Promise.resolve()
      .then(() => current.options.run(current.controller.signal))
      .then(
        (value) => {
          for (const sub of current.subscribers) {
            sub.detach();
            sub.resolve(value);
          }
        },
        (error) => {
          for (const sub of current.subscribers) {
            sub.detach();
            sub.reject(error);
          }
        },
      )
      .finally(() => {
        current.subscribers.clear();
        if (current.options.kind === "read") {
          this.stats.readTurns++;
          this.writesSinceRead = 0;
        } else this.writesSinceRead++;
        this.active = undefined;
        this.pump();
        this.changed();
        if (this.idle) this.onIdle?.();
      });
  }
}
