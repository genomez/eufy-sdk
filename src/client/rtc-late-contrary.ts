import { performance } from "node:perf_hooks";
import { commandObservation, type Command, type CommandReceipt } from "../core/contracts.js";
import { CommandIntentRegistry, type CommandIntent } from "./command-intents.js";
import type { LateEffectRead } from "./rtc-late-effect.js";

/** Receive identity shared by the report and read-completion paths for one RTC message. */
export interface RtcReportIdentity {
  sessionGeneration: number;
  sequence: number;
  receivedAtMonotonicMs: number;
}

/** Target identity is routing data; diagnostic projections omit it. */
export interface LateContraryEffect {
  deviceSn: string;
  property: "light";
  intent: number;
  desiredValue: boolean;
  observedValue?: boolean;
  ageMs: number;
  state:
    | "contrary"
    | "matched"
    | "expired"
    | "superseded"
    | "closed"
    | "recovery_settled"
    | "suspended"
    | "detection_exhausted"
    | "verification_exhausted";
  recoveryBusy: boolean;
}

/** Confirmation is a new qualified read, never a cached observation. */
export interface LateContraryConfirmation {
  intent: number;
  desiredValue: boolean;
  observedValue?: boolean;
  confirmed: boolean;
  reason?: "read_budget_exhausted";
  recoveryBusy: boolean;
  ageMs: number;
}

interface Watch {
  station: string;
  device: string;
  owner: CommandIntent;
  param: number;
  desired: boolean;
  rawDesired: string;
  sentAt?: number;
  sessionGeneration?: number;
  active: boolean;
  matched: boolean;
  contrary: boolean;
  last?: RtcReportIdentity & { value: boolean };
  candidate?: RtcReportIdentity;
  detectionReads: number;
  confirmationReads: number;
  detectionExhausted: boolean;
  verificationExhausted: boolean;
  sessionEpoch: number;
  detached: boolean;
  lastReadAt: number;
  read?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

/** Ten-minute observation grants no write authority and never changes a command deadline. */
export class RtcLateContraryObserver {
  private readonly watches = new Map<string, Watch>();
  private readonly corrections = new Map<string, number>();
  private readonly now: () => number;
  private readonly stats = {
    watched: 0,
    candidates: 0,
    contrary: 0,
    matched: 0,
    expired: 0,
    superseded: 0,
    closed: 0,
    reads: 0,
    readFailed: 0,
    readLimited: 0,
    recovery_settled: 0,
    suspended: 0,
    detection_exhausted: 0,
    verification_exhausted: 0,
  };

  constructor(
    private readonly deps: {
      intents: CommandIntentRegistry;
      now?: () => number;
      canRead: (station: string, resumeSession?: boolean) => boolean;
      read: (
        station: string,
        signal: AbortSignal,
        timeoutMs: number,
        options: { priority: "late-check"; notBeforeMonotonicMs: number },
      ) => Promise<unknown>;
      recoveryBusy: (device: string, intent: number) => boolean;
      event: (event: LateContraryEffect) => void;
    },
  ) {
    this.now = deps.now ?? (() => performance.now());
    deps.intents.subscribe((previous, current) => {
      const device = current?.device ?? previous?.device;
      const watch = device === undefined ? undefined : this.watches.get(device);
      if (!watch || watch.owner === current) return;
      if (!current && watch.owner === previous && watch.active && watch.sessionGeneration === undefined) {
        watch.detached = true;
        return;
      }
      if (current && this.corrections.get(watch.device) === current.ordinal) {
        this.corrections.delete(watch.device);
        watch.owner = current;
        watch.detached = false;
      } else this.remove(watch, "superseded");
    });
  }

  /** A same-value correction transfers observation ownership without renewing its evidence or bounds. */
  prepareCorrection(device: string, ordinal: number, value: boolean | number | string): void {
    const watch = this.watches.get(device);
    if (watch?.active && watch.desired === value && this.current(watch)) this.corrections.set(device, ordinal);
  }

  /** Original monotonic send authority is never renewed by a correction invocation. */
  correctionDeadline(device: string, value: boolean | number | string): number | undefined {
    const watch = this.watches.get(device);
    if (watch?.active && watch.desired === value && this.current(watch)) return watch.sentAt! + 600_000;
    return undefined;
  }

  finishCorrection(device: string, ordinal: number): void {
    if (this.corrections.get(device) === ordinal) this.corrections.delete(device);
  }

  /** Validated bounded explicit writes alone establish provisional observation ownership. */
  begin(station: string, device: string, command: Command, owner: CommandIntent, allowNew = true): Watch | undefined {
    const observation = commandObservation(command);
    if (
      !observation?.lateEffectReadback ||
      !observation.replaceableState ||
      observation.property !== "light" ||
      !["0", "1"].includes(String(observation.expected)) ||
      !this.deps.intents.isCurrent(owner)
    )
      return undefined;
    const previous = this.watches.get(device);
    if (previous?.owner === owner && previous.rawDesired === String(observation.expected)) return previous;
    if (!allowNew) return undefined;
    if (previous) this.remove(previous, "superseded");
    const watch: Watch = {
      station,
      device,
      owner,
      param: observation.param,
      desired:
        observation.observed === undefined ? String(observation.expected) === "1" : observation.observed === true,
      rawDesired: String(observation.expected),
      active: false,
      matched: false,
      contrary: false,
      detectionReads: 0,
      confirmationReads: 0,
      detectionExhausted: false,
      verificationExhausted: false,
      sessionEpoch: 0,
      detached: false,
      lastReadAt: -Infinity,
    };
    this.watches.set(device, watch);
    return watch;
  }

  /** Immutable real-send evidence is required; generic attempted flags are insufficient. */
  finish(watch: Watch | undefined, receipt: CommandReceipt): void {
    if (!watch || !this.current(watch)) return;
    if (watch.active) {
      if (
        receipt.status.startsWith("closed") ||
        (receipt.sessionGeneration !== undefined && receipt.sessionGeneration !== watch.sessionGeneration)
      )
        this.suspend(watch);
      return;
    }
    if (
      !receipt.sendAttempted ||
      !["acknowledged", "pending_accepted", "ack_timeout"].includes(receipt.status) ||
      !Number.isFinite(receipt.sentAtMonotonicMs) ||
      !Number.isSafeInteger(receipt.sessionGeneration) ||
      receipt.sessionGeneration! <= 0 ||
      this.now() >= receipt.sentAtMonotonicMs! + 600_000
    ) {
      this.remove(watch, "closed");
      return;
    }
    watch.sentAt = receipt.sentAtMonotonicMs!;
    watch.sessionGeneration = receipt.sessionGeneration!;
    watch.active = true;
    this.stats.watched++;
    watch.timer = setTimeout(() => this.remove(watch, "expired"), Math.max(0, watch.sentAt + 600_000 - this.now()));
    watch.timer.unref?.();
    if (watch.last?.sessionGeneration === watch.sessionGeneration && watch.last.receivedAtMonotonicMs >= watch.sentAt)
      this.accept(watch, watch.last);
  }

  /** The exact decoded target and raw boolean must belong to the original current session. */
  observe(device: string, params: Record<number, string>, identity: RtcReportIdentity): void {
    const watch = this.watches.get(device);
    if (!watch || !this.current(watch)) return;
    const raw = params[watch.param];
    if (
      (raw !== "0" && raw !== "1") ||
      !Number.isSafeInteger(identity.sequence) ||
      identity.sequence <= (watch.last?.sequence ?? 0) ||
      !Number.isFinite(identity.receivedAtMonotonicMs) ||
      (watch.active && identity.sessionGeneration !== watch.sessionGeneration)
    )
      return;
    const report = { ...identity, value: raw === watch.rawDesired ? watch.desired : !watch.desired };
    watch.last = report;
    if (watch.active) this.accept(watch, report);
  }

  /** Read-only confirmation reserves sixteen attempts independently of eight detection reads. */
  async confirm(
    device: string,
    intent: number,
    signal?: AbortSignal,
    resumeSession = false,
  ): Promise<LateContraryConfirmation> {
    const watch = this.watches.get(device);
    if (!watch || !watch.active || watch.owner.ordinal !== intent || !this.current(watch))
      throw new Error("Contrary observation unavailable");
    const baseline = watch.last?.sequence ?? 0;
    const busy = this.deps.recoveryBusy(device, intent);
    const result = busy ? undefined : await this.verify(watch, this.now(), baseline, signal, true, resumeSession);
    if (result === watch.desired && this.current(watch)) {
      watch.candidate = undefined;
      watch.contrary = false;
      watch.detectionExhausted = false;
    }
    return {
      intent,
      desiredValue: watch.desired,
      ...(result === undefined ? {} : { observedValue: result }),
      ...(watch.verificationExhausted ? { reason: "read_budget_exhausted" as const } : {}),
      confirmed:
        result !== undefined &&
        this.current(watch) &&
        watch.owner.ordinal === intent &&
        !this.deps.recoveryBusy(device, intent),
      recoveryBusy: this.deps.recoveryBusy(device, intent),
      ageMs: this.age(watch),
    };
  }

  cancel(device: string, intent: number): void {
    const watch = this.watches.get(device);
    if (watch?.owner.ordinal === intent) this.remove(watch, "closed");
  }

  recoverySettled(device: string, intent: number): void {
    const watch = this.watches.get(device);
    if (watch?.active && watch.owner.ordinal === intent && this.current(watch)) this.emit(watch, "recovery_settled");
  }

  closeStation(station: string): void {
    for (const watch of [...this.watches.values()]) if (watch.station === station) this.suspend(watch);
  }

  /** Session retirement invalidates evidence while preserving original ownership, expiry and read budgets. */
  private suspend(watch: Watch): void {
    if (!watch.active) {
      this.remove(watch, "closed");
      return;
    }
    if (watch.sessionGeneration === undefined) return;
    watch.sessionGeneration = undefined;
    watch.sessionEpoch++;
    watch.last = undefined;
    watch.candidate = undefined;
    watch.matched = false;
    watch.contrary = false;
    watch.detectionExhausted = false;
    watch.read?.abort();
    this.emit(watch, "suspended");
  }

  close(): void {
    for (const watch of [...this.watches.values()]) this.remove(watch, "closed");
  }

  diagnostics() {
    return { ...this.stats, active: this.watches.size };
  }

  private current(watch: Watch): boolean {
    return this.watches.get(watch.device) === watch && (watch.detached || this.deps.intents.isCurrent(watch.owner));
  }

  private age(watch: Watch): number {
    return Math.min(600_000, Math.max(0, Math.floor(this.now() - (watch.sentAt ?? this.now()))));
  }

  private accept(watch: Watch, report: RtcReportIdentity & { value: boolean }): void {
    if (this.now() >= watch.sentAt! + 600_000) {
      this.remove(watch, "expired");
      return;
    }
    if (report.value === watch.desired) {
      watch.candidate = undefined;
      watch.contrary = false;
      watch.detectionExhausted = false;
      if (!watch.matched) this.emit(watch, "matched");
      watch.matched = true;
      return;
    }
    watch.matched = false;
    if (report.receivedAtMonotonicMs < watch.sentAt! + 15_000 || watch.candidate || watch.contrary) return;
    watch.candidate = report;
    this.stats.candidates++;
    if (!watch.read) void this.confirmCandidate(watch, report);
  }

  private async confirmCandidate(watch: Watch, candidate: RtcReportIdentity): Promise<void> {
    const value = await this.verify(watch, candidate.receivedAtMonotonicMs, candidate.sequence);
    if (!this.current(watch) || watch.candidate !== candidate) return;
    watch.candidate = undefined;
    if (value === !watch.desired) {
      watch.contrary = true;
      this.emit(watch, "contrary");
    }
  }

  private async verify(
    watch: Watch,
    after: number,
    sequence: number,
    signal?: AbortSignal,
    explicit = false,
    resumeSession = false,
  ): Promise<boolean | undefined> {
    if (
      !this.current(watch) ||
      watch.read ||
      signal?.aborted ||
      (!resumeSession && watch.sessionGeneration === undefined) ||
      !this.deps.canRead(watch.station, resumeSession)
    )
      return undefined;
    if (explicit ? watch.confirmationReads >= 16 : watch.detectionReads >= 8) {
      this.stats.readLimited++;
      if (explicit && !watch.verificationExhausted) {
        watch.verificationExhausted = true;
        this.emit(watch, "verification_exhausted");
      } else if (!explicit && !watch.detectionExhausted) {
        watch.detectionExhausted = true;
        this.emit(watch, "detection_exhausted");
      }
      return undefined;
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    watch.read = controller;
    const started = this.now();
    const notBeforeMonotonicMs = Math.max(after + 0.001, watch.lastReadAt + 5_000);
    const timeoutMs = Math.floor(Math.min(8_000, watch.sentAt! + 600_000 - started));
    if (timeoutMs < 1 || notBeforeMonotonicMs >= started + timeoutMs) {
      watch.read = undefined;
      return undefined;
    }
    if (explicit) watch.confirmationReads++;
    else watch.detectionReads++;
    const sessionEpoch = watch.sessionEpoch;
    const sessionGeneration = watch.sessionGeneration;
    this.stats.reads++;
    watch.lastReadAt = Math.max(started, notBeforeMonotonicMs);
    try {
      const read = (await this.deps.read(watch.station, combined, timeoutMs, {
        priority: "late-check",
        notBeforeMonotonicMs,
      })) as (Partial<LateEffectRead> & { receivedSequence?: number }) | undefined;
      const raw = read?.deviceParams?.[watch.device]?.[watch.param];
      if (
        !this.current(watch) ||
        combined.aborted ||
        this.now() >= watch.sentAt! + 600_000 ||
        read?.currentAtArrival !== true ||
        watch.sessionEpoch !== sessionEpoch ||
        !Number.isSafeInteger(read.sessionGeneration) ||
        read.sessionGeneration! <= 0 ||
        (sessionGeneration !== undefined && read.sessionGeneration !== sessionGeneration) ||
        !Number.isSafeInteger(read.attempt) ||
        read.attempt! <= 0 ||
        !Number.isFinite(read.sentAtMonotonicMs) ||
        read.sentAtMonotonicMs! < notBeforeMonotonicMs ||
        !Number.isFinite(read.completedAtMonotonicMs) ||
        read.completedAtMonotonicMs! < read.sentAtMonotonicMs! ||
        read.completedAtMonotonicMs! > this.now() ||
        !Number.isSafeInteger(read.receivedSequence) ||
        read.receivedSequence! <= sequence ||
        (watch.last?.sequence ?? 0) > read.receivedSequence! ||
        (raw !== "0" && raw !== "1")
      )
        return undefined;
      if (sessionGeneration === undefined) watch.sessionGeneration = read.sessionGeneration;
      return raw === watch.rawDesired ? watch.desired : !watch.desired;
    } catch {
      if (!combined.aborted) this.stats.readFailed++;
      return undefined;
    } finally {
      watch.lastReadAt = Math.max(watch.lastReadAt, this.now());
      if (watch.read === controller) watch.read = undefined;
      if (
        this.current(watch) &&
        watch.sessionGeneration !== undefined &&
        watch.candidate &&
        watch.candidate.sequence !== sequence
      )
        void this.confirmCandidate(watch, watch.candidate);
    }
  }

  private emit(watch: Watch, state: LateContraryEffect["state"]): void {
    this.stats[state]++;
    this.deps.event({
      deviceSn: watch.device,
      property: "light",
      intent: watch.owner.ordinal,
      desiredValue: watch.desired,
      ...(watch.last ? { observedValue: watch.last.value } : {}),
      ageMs: this.age(watch),
      state,
      recoveryBusy: this.deps.recoveryBusy(watch.device, watch.owner.ordinal),
    });
  }

  private remove(watch: Watch, state: "expired" | "superseded" | "closed"): void {
    if (this.watches.get(watch.device) !== watch) return;
    this.watches.delete(watch.device);
    this.corrections.delete(watch.device);
    clearTimeout(watch.timer);
    watch.read?.abort();
    if (watch.active) this.emit(watch, state);
  }
}
