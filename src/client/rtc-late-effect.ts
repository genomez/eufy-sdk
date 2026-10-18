/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import { commandObservation, type Command } from "../core/contracts.js";

export type LateEffectEvent = "scheduled" | "confirmed" | "expired" | "superseded" | "read_failed" | "pending_accepted";

interface Intent {
  station: string;
  device: string;
  channel: number;
  param: number;
  desired: string;
  generation: number;
  sentAt?: number;
  active: boolean;
  next: number;
}

interface StationJob {
  timer?: ReturnType<typeof setTimeout>;
  read?: AbortController;
}

/** Three coalesced authoritative reads cover delayed effects without replaying the write. */
export class RtcLateEffectReconciler {
  private readonly intents = new Map<string, Intent>();
  private readonly stations = new Map<string, StationJob>();
  private generation = 0;
  private epoch = 0;
  private stats = { scheduled: 0, confirmed: 0, expired: 0, superseded: 0, readFailures: 0, pendingAccepted: 0 };
  private readonly offsets = [15_000, 25_000, 40_000];

  constructor(
    private readonly deps: {
      canRead: (station: string) => boolean;
      read: (station: string, signal: AbortSignal, timeoutMs: number) => Promise<unknown>;
      event: (event: LateEffectEvent) => void;
    },
  ) {}

  /** Reserve the next target generation before queueing; even equal-value commands supersede. */
  begin(station: string, device: string, command: Command): Intent | undefined {
    const observation = commandObservation(command);
    if (!observation?.lateEffectReadback || command.kind !== "set-json") return undefined;
    const previous = this.intents.get(device);
    if (previous) this.remove(previous, previous.active ? "superseded" : undefined);
    const intent: Intent = {
      station,
      device,
      channel: command.channel,
      param: observation.param,
      desired: String(observation.expected),
      generation: ++this.generation,
      active: false,
      next: 0,
    };
    this.intents.set(device, intent);
    return intent;
  }

  sent(intent: Intent | undefined, sentAt: number): void {
    if (intent && this.intents.get(intent.device) === intent) intent.sentAt = sentAt;
  }

  /** An ambiguous result enables observation only for a transmitted, still-current operation. */
  finish(intent: Intent | undefined, ambiguous: boolean, pendingAccepted = false): boolean {
    if (!intent || this.intents.get(intent.device) !== intent) return false;
    if (!ambiguous || intent.sentAt === undefined || Date.now() >= intent.sentAt + 45_000) {
      this.remove(intent);
      return false;
    }
    intent.active = true;
    this.stats.scheduled++;
    this.deps.event("scheduled");
    this.arm(intent.station);
    if (pendingAccepted) {
      this.stats.pendingAccepted++;
      this.deps.event("pending_accepted");
    }
    return true;
  }

  /** Only qualified information parameters from the existing state decoder enter this method. */
  observe(device: string, params: Record<number, string>): void {
    const intent = this.intents.get(device);
    if (intent?.active && params[intent.param] === intent.desired) this.remove(intent, "confirmed");
  }

  has(station: string): boolean {
    return [...this.intents.values()].some((intent) => intent.station === station && intent.active);
  }

  diagnostics() {
    return { ...this.stats };
  }

  closeStation(station: string): void {
    this.stations.get(station)?.read?.abort();
    for (const intent of [...this.intents.values()]) if (intent.station === station) this.remove(intent);
  }

  close(): void {
    this.epoch++;
    for (const job of this.stations.values()) job.read?.abort();
    for (const station of [...this.stations.keys()]) this.closeStation(station);
    this.intents.clear();
    this.stats = { scheduled: 0, confirmed: 0, expired: 0, superseded: 0, readFailures: 0, pendingAccepted: 0 };
  }

  private remove(intent: Intent, event?: "confirmed" | "expired" | "superseded"): void {
    if (this.intents.get(intent.device) !== intent) return;
    this.intents.delete(intent.device);
    if (event) {
      this.stats[event]++;
      this.deps.event(event);
    }
    const job = this.stations.get(intent.station);
    if (!this.has(intent.station)) {
      clearTimeout(job?.timer);
      if (event === "expired") job?.read?.abort();
      this.stations.delete(intent.station);
    } else this.arm(intent.station);
  }

  /** Each station has one timer and at most one read; missed opportunities are consumed, never replayed. */
  private arm(station: string): void {
    const intents = [...this.intents.values()].filter((intent) => intent.station === station && intent.active);
    if (!intents.length) return;
    const job = this.stations.get(station) ?? {};
    this.stations.set(station, job);
    clearTimeout(job.timer);
    const due = Math.min(...intents.map((intent) => intent.sentAt! + (this.offsets[intent.next] ?? 45_000)));
    job.timer = setTimeout(() => void this.tick(station, job), Math.max(0, due - Date.now()));
    job.timer.unref?.();
  }

  private async tick(station: string, job: StationJob): Promise<void> {
    if (this.stations.get(station) !== job) return;
    job.timer = undefined;
    const now = Date.now();
    let read = false;
    for (const intent of [...this.intents.values()]) {
      if (intent.station !== station || !intent.active) continue;
      if (now >= intent.sentAt! + 45_000) this.remove(intent, "expired");
      else if (now + 1_000 >= intent.sentAt! + (this.offsets[intent.next] ?? Infinity)) {
        while (now + 1_000 >= intent.sentAt! + (this.offsets[intent.next] ?? Infinity)) intent.next++;
        read = true;
      }
    }
    if (this.stations.get(station) !== job) return;
    this.arm(station);
    if (!read || job.read || !this.deps.canRead(station)) return;
    const controller = new AbortController();
    const epoch = this.epoch;
    job.read = controller;
    const expiry = Math.min(
      ...[...this.intents.values()]
        .filter((intent) => intent.station === station && intent.active)
        .map((intent) => intent.sentAt! + 45_000),
    );
    try {
      await this.deps.read(station, controller.signal, Math.min(8_000, expiry - now));
    } catch (error) {
      if (epoch === this.epoch && (!controller.signal.aborted || error !== controller.signal.reason)) {
        this.stats.readFailures++;
        this.deps.event("read_failed");
      }
    } finally {
      if (job.read === controller) job.read = undefined;
    }
  }
}
