/** Modified for genomez S1 experimental source preview, 2026-10-18. */
import { commandObservation, observeCommand, type Command } from "../core/contracts.js";
import { performance } from "node:perf_hooks";
import { CommandIntentRegistry, type CommandIntent } from "./command-intents.js";
import { informationReadFailure } from "../transport/rtc/read-diagnostics.js";

export type RetrySkipReason =
  | "read_failed"
  | "no_qualified_first_read"
  | "deadline"
  | "disconnected"
  | "cancelled"
  | "already_used"
  | "already_matches"
  | "command_degraded";
export type LateEffectEvent =
  | "scheduled"
  | "confirmed"
  | "expired"
  | "superseded"
  | "read_failed"
  | "pending_accepted"
  | "retry_eligible"
  | "retry_queued"
  | "retry_sent"
  | "retry_confirmed"
  | "retry_superseded"
  | `retry_skipped_${RetrySkipReason}`;

/** Successful authoritative reads carry actual send and arrival ownership, never cache age. */
export interface LateEffectRead {
  sentAtMonotonicMs: number;
  completedAtMonotonicMs: number;
  sessionGeneration: number;
  currentAtArrival: boolean;
  attempt: number;
  deviceParams: Readonly<Record<string, Readonly<Record<number, string>>>>;
}

export interface LateEffectRetry {
  readonly station: string;
  readonly device: string;
  readonly command: Command;
  readonly intent: CommandIntent;
  readonly parentAttempt?: number;
  readonly authorizingRead: number;
  readonly originalSentAtMonotonicMs: number;
  readonly readStartedAgeMs: number;
  readonly readFinishedAgeMs: number;
  readonly sendByMonotonicMs: number;
  readonly totalByMonotonicMs: number;
  readonly wallExpiresAtMs?: number;
  readonly wallOffsetMs?: number;
  readonly clockUncertaintyMs?: number;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly onSent: () => void;
}

export interface LateEffectBeginOptions {
  intent?: CommandIntent;
  retry?: {
    totalByMonotonicMs: number;
    callerExpiryMonotonicMs?: number;
    signal?: AbortSignal;
    parentAttempt?: number;
    wallExpiresAtMs?: number;
    wallOffsetMs?: number;
    clockUncertaintyMs?: number;
  };
}

export interface LateEffectIntent {
  station: string;
  device: string;
  channel: number;
  param: number;
  desired: string;
  ownership: CommandIntent;
  command: Command;
  retry?: LateEffectBeginOptions["retry"];
  sentAt?: number;
  sessionGeneration?: number;
  active: boolean;
  next: number;
  retryEligible: boolean;
  pendingAccepted: boolean;
  retryDecided: boolean;
  retryUsed: boolean;
  retrySent: boolean;
  retryTerminal: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  recovery: AbortController;
  cancel?: () => void;
}

interface StationJob {
  timer?: ReturnType<typeof setTimeout>;
  read?: AbortController;
}

/** Original send-relative observation and one-use recovery share validated target ownership. */
export class RtcLateEffectReconciler {
  private readonly intents = new Map<string, LateEffectIntent>();
  private readonly stations = new Map<string, StationJob>();
  private readonly registry: CommandIntentRegistry;
  private readonly now: () => number;
  private epoch = 0;
  private readonly pendingRecovery = new Map<string, number>();
  private stats = this.emptyStats();
  private readonly offsets = [15_000, 25_000, 40_000];

  constructor(
    private readonly deps: {
      intents?: CommandIntentRegistry;
      now?: () => number;
      canRead: (station: string) => boolean;
      read: (
        station: string,
        signal: AbortSignal,
        timeoutMs: number,
        options?: { priority: "late-check"; notBeforeMonotonicMs?: number },
      ) => Promise<unknown>;
      retry?: (request: LateEffectRetry) => Promise<void | { sendAttempted: boolean; status?: string }>;
      event: (event: LateEffectEvent) => void;
      recoverySettled?: (device: string, intent: number) => void;
    },
  ) {
    this.registry = deps.intents ?? new CommandIntentRegistry();
    this.now = deps.now ?? (() => performance.now());
    this.registry.subscribe((previous) => {
      if (!previous) return;
      const intent = this.intents.get(previous.device);
      if (intent?.ownership === previous) this.remove(intent, "superseded");
    });
  }

  /** Validation precedes acceptance; an accepted token preserves public API ingress ordering. */
  begin(
    station: string,
    device: string,
    command: Command,
    options: LateEffectBeginOptions = {},
  ): LateEffectIntent | undefined {
    const observation = commandObservation(command);
    if (!observation?.lateEffectReadback || command.kind !== "set-json" || options.retry?.signal?.aborted)
      return undefined;
    const ownership =
      options.intent ??
      this.registry.acceptValidated(
        station,
        device,
        this.registry.allocate(),
        observation.replaceableState ? observation.property : undefined,
      );
    if (
      !ownership ||
      ownership.station !== station ||
      ownership.device !== device ||
      !this.registry.isCurrent(ownership)
    )
      return undefined;
    const previous = this.intents.get(device);
    if (previous) this.remove(previous, previous.active ? "superseded" : undefined);
    const intent: LateEffectIntent = {
      station,
      device,
      channel: command.channel,
      param: observation.param,
      desired: String(observation.expected),
      ownership,
      command: observeCommand({ ...command, data: structuredClone(command.data) }, { ...observation }),
      retry: options.retry ? { ...options.retry } : undefined,
      active: false,
      next: 0,
      retryEligible: false,
      pendingAccepted: false,
      retryDecided: false,
      retryUsed: false,
      retrySent: false,
      retryTerminal: false,
      recovery: new AbortController(),
    };
    this.intents.set(device, intent);
    const signal = options.retry?.signal;
    if (signal) {
      intent.cancel = () => this.remove(intent, undefined, "cancelled");
      signal.addEventListener("abort", intent.cancel, { once: true });
    }
    return intent;
  }

  sent(
    intent: LateEffectIntent | undefined,
    sent: number | { sentAtMs: number; sentAtMonotonicMs: number; sessionGeneration: number },
  ): void {
    if (!intent || !this.current(intent)) return;
    intent.sentAt = typeof sent === "number" ? this.now() + sent - Date.now() : sent.sentAtMonotonicMs;
    if (typeof sent !== "number") intent.sessionGeneration = sent.sessionGeneration;
  }

  /** Pending acceptance requires the original correlated -108; other ambiguity enables observation alone. */
  finish(intent: LateEffectIntent | undefined, ambiguous: boolean, pendingAccepted = false): boolean {
    if (!intent || !this.current(intent)) return false;
    if (!ambiguous || intent.sentAt === undefined || this.now() >= intent.sentAt + 45_000) {
      this.remove(intent);
      return false;
    }
    if (intent.active) return !pendingAccepted || intent.pendingAccepted;
    intent.active = true;
    this.stats.scheduled++;
    this.deps.event("scheduled");
    if (pendingAccepted) {
      intent.pendingAccepted = true;
      this.stats.pendingAccepted++;
      this.deps.event("pending_accepted");
      if (intent.retry && this.deps.retry && Number.isFinite(intent.retry.totalByMonotonicMs)) {
        intent.retryEligible = true;
        this.stats.retryEligible++;
        this.deps.event("retry_eligible");
      }
    }
    this.arm(intent.station);
    return true;
  }

  /** Only qualified information parameters from the existing state decoder enter this method. */
  observe(device: string, params: Record<number, string>): void {
    const intent = this.intents.get(device);
    if (intent?.active && this.current(intent) && params[intent.param] === intent.desired)
      this.remove(intent, "confirmed");
  }

  has(station: string): boolean {
    return [...this.intents.values()].some((intent) => intent.station === station && intent.active);
  }

  /** Reserved and active recovery exchanges remain visible until their transport promise settles. */
  recoveryBusy(device: string, intent: number): boolean {
    return this.pendingRecovery.get(device) === intent;
  }

  diagnostics() {
    return { ...this.stats, retrySkipped: { ...this.stats.retrySkipped }, epoch: this.epoch };
  }

  /** Retire automatic write permission while retaining passive late-effect reads and observations. */
  suppressAutomatic(device: string, property: string): void {
    const intent = this.intents.get(device);
    if (!intent || commandObservation(intent.command)?.property !== property || intent.retrySent) return;
    if (intent.retryUsed) this.skipQueued(intent, "command_degraded");
    else this.skip(intent, "command_degraded");
    clearTimeout(intent.retryTimer);
    intent.recovery.abort();
  }

  closeStation(station: string): void {
    this.stations.get(station)?.read?.abort();
    for (const intent of [...this.intents.values()])
      if (intent.station === station) this.remove(intent, undefined, "disconnected");
    this.registry.invalidateStation(station);
  }

  close(): void {
    this.epoch++;
    for (const station of [...this.stations.keys()]) this.closeStation(station);
    for (const intent of [...this.intents.values()]) this.remove(intent, undefined, "disconnected");
    this.registry.close();
    this.stats = this.emptyStats();
  }

  private emptyStats() {
    return {
      scheduled: 0,
      confirmed: 0,
      expired: 0,
      superseded: 0,
      readFailures: 0,
      pendingAccepted: 0,
      retryEligible: 0,
      retryQueued: 0,
      retrySent: 0,
      retryConfirmed: 0,
      retrySuperseded: 0,
      retrySkipped: {
        read_failed: 0,
        no_qualified_first_read: 0,
        deadline: 0,
        disconnected: 0,
        cancelled: 0,
        already_used: 0,
        already_matches: 0,
        command_degraded: 0,
      },
    };
  }

  private current(intent: LateEffectIntent): boolean {
    return this.intents.get(intent.device) === intent && this.registry.isCurrent(intent.ownership);
  }

  private skip(intent: LateEffectIntent, reason: RetrySkipReason): void {
    if (!intent.retryEligible || intent.retryDecided) return;
    intent.retryDecided = true;
    this.stats.retrySkipped[reason]++;
    this.deps.event(`retry_skipped_${reason}`);
  }

  private remove(
    intent: LateEffectIntent,
    event?: "confirmed" | "expired" | "superseded",
    reason?: RetrySkipReason,
  ): void {
    if (this.intents.get(intent.device) !== intent) return;
    if (intent.retryUsed && (reason || event === "expired" || event === "confirmed"))
      this.skipQueued(intent, reason ?? (event === "expired" ? "deadline" : "already_matches"));
    this.intents.delete(intent.device);
    clearTimeout(intent.retryTimer);
    if (event === "superseded" && intent.active && intent.retryEligible) {
      this.stats.retrySuperseded++;
      this.deps.event("retry_superseded");
    }
    if (event === "confirmed" && intent.retrySent) {
      this.stats.retryConfirmed++;
      this.deps.event("retry_confirmed");
    }
    if (reason || event === "expired" || event === "confirmed")
      this.skip(intent, reason ?? (event === "expired" ? "deadline" : "already_matches"));
    if (!intent.retrySent || reason || event === "expired") intent.recovery.abort();
    if (intent.cancel) intent.retry?.signal?.removeEventListener("abort", intent.cancel);
    if (event && intent.active) {
      this.stats[event]++;
      this.deps.event(event);
    }
    const job = this.stations.get(intent.station);
    if (!this.has(intent.station)) {
      clearTimeout(job?.timer);
      if (reason || event === "expired") job?.read?.abort();
      this.stations.delete(intent.station);
    } else this.arm(intent.station);
  }

  /** Each station has one timer and one subscriber read; missed opportunities never grant later write authority. */
  private arm(station: string): void {
    const intents = [...this.intents.values()].filter((intent) => intent.station === station && intent.active);
    if (!intents.length) return;
    const job = this.stations.get(station) ?? {};
    this.stations.set(station, job);
    clearTimeout(job.timer);
    const due = Math.min(...intents.map((intent) => intent.sentAt! + (this.offsets[intent.next] ?? 45_000)));
    job.timer = setTimeout(() => void this.tick(station, job), Math.max(0, due - this.now()));
    job.timer.unref?.();
  }

  private async tick(station: string, job: StationJob): Promise<void> {
    if (this.stations.get(station) !== job) return;
    job.timer = undefined;
    const now = this.now();
    const first: LateEffectIntent[] = [];
    let read = false;
    for (const intent of [...this.intents.values()]) {
      if (intent.station !== station || !intent.active) continue;
      if (now >= intent.sentAt! + 45_000) this.remove(intent, "expired");
      else if (now + 1_000 >= intent.sentAt! + (this.offsets[intent.next] ?? Infinity)) {
        if (intent.next === 0 && intent.retryEligible) first.push(intent);
        while (now + 1_000 >= intent.sentAt! + (this.offsets[intent.next] ?? Infinity)) intent.next++;
        read = true;
      }
    }
    if (this.stations.get(station) !== job) return;
    this.arm(station);
    const expiry = Math.min(
      ...[...this.intents.values()]
        .filter((intent) => intent.station === station && intent.active)
        .map((intent) => intent.sentAt! + 45_000),
    );
    // Monotonic clocks are fractional; the router accepts whole milliseconds and the horizon never extends.
    const timeoutMs = Math.floor(Math.min(8_000, expiry - now));
    if (!read || job.read || !this.deps.canRead(station) || !(timeoutMs >= 1)) {
      for (const intent of first) this.skip(intent, "no_qualified_first_read");
      return;
    }
    const controller = new AbortController();
    const epoch = this.epoch;
    job.read = controller;
    const notBeforeMonotonicMs = first.length ? Math.max(...first.map((intent) => intent.sentAt! + 15_000)) : undefined;
    try {
      const result = await this.deps.read(station, controller.signal, timeoutMs, {
        priority: "late-check",
        ...(notBeforeMonotonicMs === undefined ? {} : { notBeforeMonotonicMs }),
      });
      if (epoch !== this.epoch || controller.signal.aborted) return;
      for (const intent of first) this.authorize(intent, result);
    } catch (error) {
      if (
        epoch === this.epoch &&
        informationReadFailure(error) !== "session_closed" &&
        (!controller.signal.aborted || error !== controller.signal.reason)
      ) {
        this.stats.readFailures++;
        this.deps.event("read_failed");
        for (const intent of first) this.skip(intent, "read_failed");
      }
    } finally {
      if (job.read === controller) job.read = undefined;
    }
  }

  private authorize(intent: LateEffectIntent, result: unknown): void {
    if (!this.current(intent) || !intent.retryEligible || intent.retryDecided) return;
    const read = result as Partial<LateEffectRead> | undefined;
    const sentAt = intent.sentAt!;
    const params = read?.deviceParams?.[intent.device];
    if (
      !read ||
      read.currentAtArrival !== true ||
      !Number.isSafeInteger(read.attempt) ||
      read.attempt! <= 0 ||
      !Number.isFinite(read.sentAtMonotonicMs) ||
      read.sentAtMonotonicMs! < sentAt + 15_000 ||
      !Number.isFinite(read.completedAtMonotonicMs) ||
      read.completedAtMonotonicMs! < read.sentAtMonotonicMs! ||
      read.completedAtMonotonicMs! > this.now() ||
      intent.sessionGeneration === undefined ||
      read.sessionGeneration !== intent.sessionGeneration ||
      !params ||
      !Object.hasOwn(params, intent.param) ||
      typeof params[intent.param] !== "string"
    ) {
      this.skip(intent, "no_qualified_first_read");
      return;
    }
    if (params[intent.param] === intent.desired) {
      this.remove(intent, "confirmed");
      return;
    }
    const totalBy = Math.min(
      sentAt + 45_000,
      intent.retry!.totalByMonotonicMs,
      intent.retry!.callerExpiryMonotonicMs ?? Infinity,
    );
    const sendBy = Math.min(sentAt + 33_000, totalBy - 12_000);
    if (!Number.isFinite(totalBy) || this.now() >= sendBy || this.now() + 12_000 > totalBy) {
      this.skip(intent, "deadline");
      return;
    }
    intent.retryUsed = true;
    this.pendingRecovery.set(intent.device, intent.ownership.ordinal);
    intent.retryDecided = true;
    this.stats.retryQueued++;
    this.deps.event("retry_queued");
    const isCurrent = () =>
      this.current(intent) &&
      !intent.recovery.signal.aborted &&
      !intent.retry!.signal?.aborted &&
      (intent.retrySent ? this.now() < totalBy : this.now() < sendBy && this.now() + 12_000 <= totalBy);
    const request: LateEffectRetry = Object.freeze({
      station: intent.station,
      device: intent.device,
      command: intent.command,
      intent: intent.ownership,
      parentAttempt: intent.retry!.parentAttempt,
      authorizingRead: read.attempt!,
      originalSentAtMonotonicMs: sentAt,
      readStartedAgeMs: read.sentAtMonotonicMs! - sentAt,
      readFinishedAgeMs: read.completedAtMonotonicMs! - sentAt,
      sendByMonotonicMs: sendBy,
      totalByMonotonicMs: totalBy,
      signal: intent.retry!.signal
        ? AbortSignal.any([intent.recovery.signal, intent.retry!.signal])
        : intent.recovery.signal,
      isCurrent,
      wallExpiresAtMs: intent.retry!.wallExpiresAtMs,
      wallOffsetMs: intent.retry!.wallOffsetMs,
      clockUncertaintyMs: intent.retry!.clockUncertaintyMs,
      onSent: () => {
        if (intent.retrySent || !isCurrent()) return;
        intent.retrySent = true;
        clearTimeout(intent.retryTimer);
        this.stats.retrySent++;
        this.deps.event("retry_sent");
      },
    });
    intent.retryTimer = setTimeout(
      () => {
        this.skipQueued(intent, "deadline");
        intent.recovery.abort();
      },
      Math.max(0, sendBy - this.now()),
    );
    intent.retryTimer.unref?.();
    void Promise.resolve()
      .then(async () => {
        if (!isCurrent()) return;
        const outcome = await this.deps.retry!(request);
        if (outcome && !outcome.sendAttempted) {
          if (outcome.status?.startsWith("expired")) this.skipQueued(intent, "deadline");
          else if (outcome.status?.startsWith("cancelled")) this.skipQueued(intent, "cancelled");
          else if (outcome.status?.startsWith("closed")) this.skipQueued(intent, "disconnected");
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.pendingRecovery.get(intent.device) === intent.ownership.ordinal) {
          this.pendingRecovery.delete(intent.device);
          this.deps.recoverySettled?.(intent.device, intent.ownership.ordinal);
        }
        if (!intent.retrySent && this.current(intent) && this.now() >= sendBy) {
          this.skipQueued(intent, "deadline");
        }
      });
  }

  private skipQueued(intent: LateEffectIntent, reason: RetrySkipReason): void {
    if (!this.current(intent) || intent.retrySent || intent.retryTerminal) return;
    intent.retryTerminal = true;
    clearTimeout(intent.retryTimer);
    this.stats.retrySkipped[reason]++;
    this.deps.event(`retry_skipped_${reason}`);
  }
}
