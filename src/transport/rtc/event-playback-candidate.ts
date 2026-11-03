import { buildPortalPacket, parsePortalHeader, PortalLinkType } from "./portal-packet.js";
import { PlaybackIngress, type PlaybackIngressEvidence } from "./playback-ingress.js";
import { isHevcKeyframe } from "./live.js";
import { performance } from "node:perf_hooks";

export type CaptureOutcome =
  | "not_admitted"
  | "time_refused"
  | "start_refused"
  | "begin_time_refused"
  | "eof"
  | "capped"
  | "capped_wrong_route"
  | "no_media"
  | "invalid_media"
  | "transport_mismatch"
  | "preempted"
  | "owner_changed"
  | "timeout";
export interface PlaybackReceipt extends PlaybackIngressEvidence {
  admissionGate: number;
  captureOutcome: CaptureOutcome;
  cessationOutcome: "not_started" | "ceased" | "media_continues" | "cessation_unknown";
  releaseOutcome: "not_started" | "release_confirmed" | "stop_unconfirmed" | "release_unknown";
  healthOutcome: "degraded";
  accepted: false;
  boundedMediaObserved: boolean;
  timeBasis: "owner_accepted_America_Chicago";
  timeUnique: boolean;
  beginTimeAcceptance: "unknown" | "accepted" | "refused";
  startAttempted: boolean;
  pauseAttempted: boolean;
  stopAttempted: boolean;
  pauseSent: boolean;
  stopSent: boolean;
  startAcknowledged: boolean;
  directStartMatched: boolean;
  directPauseMatched: boolean;
  directStopMatched: boolean;
  stopStatusCount: number;
  stopSegmentMatchCount: number;
  segmenComparable: boolean;
  segmenMatchesRequest: boolean;
  correlationBasis: "segment_match_and_exclusive" | "exclusive_timing" | "ambiguous";
  ownerContinuous: boolean;
  selectorsReserved: boolean;
  latchPersisted: boolean;
  latchRetained: boolean;
  latchCleared: boolean;
  videoFrames: number;
  audioFrames: number;
  randomAccess: boolean;
  codec: "unknown" | "h265";
  elapsedMs: number;
  silenceMs: number;
}

/** ICU's pinned IANA database supplies Chicago rules; exact round trips reject gaps and folds. */
export function chicagoInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)) return;
  const [y, m, d, h, minute, s] = value.split(/[- :]/).map(Number) as [number, number, number, number, number, number];
  if (y < 2000 || y > 2099) return;
  const nominal = Date.UTC(y, m - 1, d, h, minute, s);
  if (new Date(nominal).toISOString().slice(0, 19).replace("T", " ") !== value) return;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const matches: number[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = nominal + offset * 60_000;
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((p) => [p.type, p.value]));
    if (`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` === value)
      matches.push(candidate / 1000);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Largest eligible numeric selector is policy only; there is no fallback after time validation. */
export function selectPlayback(
  rows: unknown[],
  cameras: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
  now = Date.now(),
): { record: number; begin: number } | undefined {
  const seen = new Set<number>();
  const eligible: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    const r = row as Record<string, unknown>;
    if (!Number.isSafeInteger(r.record_id) || (r.record_id as number) <= 0 || seen.has(r.record_id as number)) return;
    seen.add(r.record_id as number);
    if (typeof r.device_sn === "string" && cameras.has(r.device_sn) && !excluded.has(r.device_sn)) eligible.push(r);
  }
  const row = eligible.sort((a, b) => (b.record_id as number) - (a.record_id as number))[0];
  if (!row) return;
  const begin = chicagoInstant(row.start_time),
    end = chicagoInstant(row.end_time);
  if (begin === undefined || end === undefined || end < begin || end * 1000 > now) return;
  return { record: row.record_id as number, begin };
}

/** Both adjacent selectors remain reserved until owner retirement, including refused invocations. */
export function reservePlaybackSelectors(used: Set<number>): [number, number] | undefined {
  for (let start = 6; start <= 248; start++) {
    if (used.has(start) || used.has(start + 1)) continue;
    used.add(start);
    used.add(start + 1);
    return [start, start + 1];
  }
  return;
}

/** Portal-observed event mode: pause retains the tuple; stop advances only the play/header selector. */
export function playbackRequest(
  account: string,
  record: number,
  start: number,
  sub: 0 | 1 | 3,
  segment: number,
  begin: number,
): Buffer {
  const selector = sub === 3 ? start + 1 : start;
  return buildPortalPacket({
    commandId: 1700,
    channel: 255,
    segment,
    isResponse: selector,
    devType: 2,
    payload: {
      account_id: account,
      cmd: 6001,
      commandType: 6001,
      dev_type: 2,
      segmen: segment,
      data: {
        cmd: sub,
        play_type: 1,
        play_speed: 1,
        client_type: "WEB",
        device_sn: "",
        record_id: record,
        play_id: selector,
        ...(sub === 0 ? { begin_time: begin } : {}),
      },
    },
  });
}

/** One capture and one idempotent cleanup sequence, followed by passive original-owner cessation. */
export class EventPlaybackCandidate {
  readonly ingress: PlaybackIngress;
  readonly receipt: PlaybackReceipt;
  private readonly started = performance.now();
  private readonly segments: Partial<Record<0 | 1 | 3, number>> = {};
  private finish?: () => void;
  private finalized = false;
  private stoppedAt?: number;
  private releaseSeen = false;
  private eofSeen = false;
  private absentSeen = false;
  private conflict = false;
  private lateLatched = false;
  private selection?: { record: number; begin: number };
  private startSelector?: number;

  constructor(
    private readonly opts: {
      deadlineMs: number;
      continuous: () => boolean;
      startAllowed: () => boolean;
      send: (packet: Buffer) => boolean;
      segment: () => number;
      account: string;
      marker: (unresolved: boolean) => void;
      latch: (unresolved: boolean) => void;
      signal: AbortSignal;
      liveAllowed?: () => boolean;
    },
  ) {
    this.ingress = new PlaybackIngress({
      end: (reason) => this.end(reason),
      media: (frame) => this.media(frame),
      control: (frame, link) => this.control(frame, link),
      liveAllowed: opts.liveAllowed,
      late: () => {
        if (this.lateLatched) return;
        this.lateLatched = true;
        this.opts.latch(true);
        try {
          this.opts.marker(true);
        } catch {}
      },
    });
    this.receipt = {
      admissionGate: 0,
      ...this.ingress.evidence,
      captureOutcome: "not_admitted",
      cessationOutcome: "not_started",
      releaseOutcome: "not_started",
      healthOutcome: "degraded",
      accepted: false,
      boundedMediaObserved: false,
      timeBasis: "owner_accepted_America_Chicago",
      timeUnique: false,
      beginTimeAcceptance: "unknown",
      startAttempted: false,
      pauseAttempted: false,
      stopAttempted: false,
      pauseSent: false,
      stopSent: false,
      startAcknowledged: false,
      directStartMatched: false,
      directPauseMatched: false,
      directStopMatched: false,
      stopStatusCount: 0,
      stopSegmentMatchCount: 0,
      segmenComparable: false,
      segmenMatchesRequest: false,
      correlationBasis: "ambiguous",
      ownerContinuous: false,
      selectorsReserved: false,
      latchPersisted: false,
      latchRetained: false,
      latchCleared: false,
      videoFrames: 0,
      audioFrames: 0,
      randomAccess: false,
      codec: "unknown",
      elapsedMs: 0,
      silenceMs: 0,
    };
  }

  end(reason: CaptureOutcome): void {
    if (this.finalized) {
      if (reason === "capped_wrong_route") this.receipt.captureOutcome = reason;
      return;
    }
    this.receipt.captureOutcome = reason;
    this.ingress.finishCapture();
    this.finish?.();
  }

  async capture(selection: { record: number; begin: number }, selectors: [number, number]): Promise<void> {
    this.selection = selection;
    this.startSelector = selectors[0];
    this.ingress.reserve(...selectors);
    this.receipt.timeUnique = true;
    this.receipt.selectorsReserved = true;
    if (
      this.conflict ||
      !this.opts.startAllowed() ||
      !this.opts.continuous() ||
      this.opts.signal.aborted ||
      !this.ingress.prestartSafe() ||
      this.opts.deadlineMs - performance.now() < 15000
    )
      return;
    this.ingress.startExpiry();
    let timer: NodeJS.Timeout | undefined, noMedia: NodeJS.Timeout | undefined;
    const abort = () => this.end("preempted");
    const owner = setInterval(() => {
      if (!this.opts.continuous()) this.end("owner_changed");
      else if (!this.opts.startAllowed()) this.end("preempted");
    }, 10);
    try {
      await new Promise<void>((resolve) => {
        this.finish = resolve;
        this.opts.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
          () => this.end("capped"),
          Math.max(0, Math.min(8000, this.opts.deadlineMs - performance.now() - 7000)),
        );
        noMedia = setTimeout(() => {
          if (!this.receipt.videoFrames) this.end("no_media");
        }, 5000);
        try {
          this.opts.marker(true);
          this.opts.latch(true);
          this.receipt.latchPersisted = true;
          this.receipt.latchRetained = true;
          if (
            !this.opts.startAllowed() ||
            !this.opts.continuous() ||
            this.opts.signal.aborted ||
            performance.now() >= this.opts.deadlineMs - 7000
          ) {
            this.opts.marker(false);
            this.opts.latch(false);
            this.receipt.latchRetained = false;
            resolve();
            return;
          }
          const segment = this.opts.segment();
          this.segments[0] = segment;
          this.ingress.capturing = true;
          this.receipt.startAttempted = true;
          this.receipt.releaseOutcome = "release_unknown";
          this.receipt.cessationOutcome = "cessation_unknown";
          if (
            !this.opts.send(
              playbackRequest(this.opts.account, selection.record, selectors[0], 0, segment, selection.begin),
            )
          )
            this.end("start_refused");
        } catch {
          this.end("start_refused");
        }
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(noMedia);
      clearInterval(owner);
      this.opts.signal.removeEventListener("abort", abort);
      this.finalize();
    }
  }

  /** Demand and socket cancellation do not enter these cleanup authority checks. */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.ingress.finishCapture();
    if (!this.receipt.startAttempted || !this.selection || this.startSelector === undefined) return;
    for (const sub of [1, 3] as const) {
      if (!this.opts.continuous() || performance.now() >= this.opts.deadlineMs) continue;
      if (sub === 1) this.receipt.pauseAttempted = true;
      else {
        this.receipt.stopAttempted = true;
        this.stoppedAt = performance.now();
      }
      try {
        const segment = this.opts.segment();
        this.segments[sub] = segment;
        const sent = this.opts.send(
          playbackRequest(
            this.opts.account,
            this.selection.record,
            this.startSelector,
            sub,
            segment,
            this.selection.begin,
          ),
        );
        if (sub === 1) this.receipt.pauseSent = sent;
        else this.receipt.stopSent = sent;
      } catch {}
    }
  }

  async observe(): Promise<PlaybackReceipt> {
    try {
      this.finalize();
      const deadline = Math.min(this.opts.deadlineMs, (this.stoppedAt ?? performance.now()) + 6000);
      if (this.stoppedAt !== undefined) {
        while (performance.now() < deadline && this.opts.continuous()) {
          const complete = this.ingress.observationComplete();
          const quiet = performance.now() - Math.max(this.stoppedAt, this.ingress.lastPlausibleMs);
          this.receipt.silenceMs = Math.max(0, Math.floor(quiet));
          if (complete && quiet >= 5000) {
            this.receipt.cessationOutcome = "ceased";
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(0, deadline - performance.now()))));
        }
        if (this.receipt.cessationOutcome !== "ceased")
          this.receipt.cessationOutcome =
            this.opts.continuous() && this.ingress.observationComplete() ? "media_continues" : "cessation_unknown";
      }
      this.receipt.ownerContinuous = this.opts.continuous();
      if (this.receipt.startAttempted) {
        if (
          this.receipt.ownerContinuous &&
          this.receipt.cessationOutcome === "ceased" &&
          !this.conflict &&
          (this.releaseSeen || (this.absentSeen && this.eofSeen))
        ) {
          try {
            this.opts.marker(false);
            this.opts.latch(false);
            this.receipt.releaseOutcome = "release_confirmed";
            this.receipt.latchRetained = false;
            this.receipt.latchCleared = true;
          } catch {
            this.receipt.releaseOutcome = "release_unknown";
          }
        } else
          this.receipt.releaseOutcome =
            this.conflict || !this.receipt.ownerContinuous ? "release_unknown" : "stop_unconfirmed";
      }
      Object.assign(this.receipt, this.ingress.evidence);
      this.receipt.elapsedMs = Math.max(0, Math.round(performance.now() - this.started));
      this.receipt.boundedMediaObserved =
        ["eof", "capped"].includes(this.receipt.captureOutcome) &&
        this.receipt.startAcknowledged &&
        this.receipt.randomAccess &&
        this.receipt.ownerContinuous &&
        this.receipt.cessationOutcome === "ceased" &&
        this.receipt.pauseAttempted &&
        this.receipt.stopAttempted &&
        !this.receipt.unknown &&
        this.receipt.wrongRouteFrames === 0;
      this.ingress.quarantine();
      return { ...this.receipt };
    } finally {
      this.ingress.stopExpiry();
    }
  }

  private media(frame: Buffer): void {
    const h = parsePortalHeader(frame)!;
    if (h.isResponse !== this.startSelector) {
      this.end("invalid_media");
      return;
    }
    if (h.commandId === 1301) {
      this.receipt.audioFrames++;
      return;
    }
    const body = frame.subarray(16);
    if (body.length < 22 || body.readUInt32LE(0) !== body.length - 22 || body[5] !== 1) {
      this.end("invalid_media");
      return;
    }
    const data = body.subarray(22);
    if (!(data.length >= 6 && (data.readUInt32BE(0) === 1 || data.readUIntBE(0, 3) === 1))) {
      this.end("invalid_media");
      return;
    }
    this.receipt.videoFrames++;
    this.receipt.codec = "h265";
    this.receipt.randomAccess ||= isHevcKeyframe(data);
    if (this.receipt.startAcknowledged) this.receipt.beginTimeAcceptance = "accepted";
  }

  private control(frame: Buffer, link: number): boolean {
    const h = parsePortalHeader(frame);
    if (!h || !this.opts.continuous()) return true;
    if (h.commandId === 1700 && link === PortalLinkType.COMMAND && h.channel === 255 && h.isResponse === 1) {
      const sub = ([0, 1, 3] as const).find((sub) => this.segments[sub] === h.segment);
      if (sub === undefined) {
        this.conflict = true;
        this.end("transport_mismatch");
        return true;
      }
      if (h.paramLength === 132 && frame.length === 148)
        this.receipt[sub === 0 ? "directStartMatched" : sub === 1 ? "directPauseMatched" : "directStopMatched"] = true;
      return false;
    }
    if (link !== PortalLinkType.NOTIFY || h.commandId !== 1351 || h.channel !== 0) return true;
    if (h.paramLength + 16 !== frame.length || frame.length > 16384) {
      this.conflict = true;
      return true;
    }
    let value: { cmd?: unknown; payload?: { state?: unknown; code?: unknown; segmen?: unknown } };
    try {
      value = JSON.parse(frame.subarray(16).toString("utf8")) as typeof value;
    } catch {
      return true;
    }
    if (value?.cmd !== 6001) return true;
    if (!this.receipt.startAttempted) {
      this.conflict = true;
      this.end("transport_mismatch");
      return true;
    }
    const p = value.payload;
    if (!p || Array.isArray(p) || !Number.isSafeInteger(p.state) || !Number.isSafeInteger(p.code)) {
      this.conflict = true;
      return false;
    }
    if (p.state === 1 && p.code === 0) {
      if (!this.finalized) {
        this.receipt.startAcknowledged = true;
        if (this.receipt.videoFrames) this.receipt.beginTimeAcceptance = "accepted";
      }
    } else if (p.state === 2 && p.code === 14 && this.stoppedAt === undefined) {
      this.eofSeen = true;
      this.end("eof");
    } else if (p.state === 2 && p.code === 15 && this.stoppedAt !== undefined) {
      this.releaseSeen = true;
      this.receipt.stopStatusCount = Math.min(Number.MAX_SAFE_INTEGER, this.receipt.stopStatusCount + 1);
      this.receipt.segmenComparable = typeof p.segmen === "number" && Number.isFinite(p.segmen);
      this.receipt.segmenMatchesRequest = this.receipt.segmenComparable && p.segmen === this.segments[3];
      if (this.receipt.segmenMatchesRequest)
        this.receipt.stopSegmentMatchCount = Math.min(Number.MAX_SAFE_INTEGER, this.receipt.stopSegmentMatchCount + 1);
      this.receipt.correlationBasis = this.receipt.segmenMatchesRequest
        ? "segment_match_and_exclusive"
        : "exclusive_timing";
    } else if (p.state === 0 && p.code === 7 && this.stoppedAt !== undefined) {
      this.absentSeen = true;
      this.receipt.correlationBasis = "exclusive_timing";
    } else {
      this.conflict = true;
      this.end("start_refused");
    }
    return false;
  }
}
