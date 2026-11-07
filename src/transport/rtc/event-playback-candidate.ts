import {
  PlaybackFrameTiming,
  PlaybackNativeFrameTiming,
  playbackExperiment,
  type PlaybackExperiment,
} from "./playback-telemetry.js";
import { chicagoInstant, recordingTimeZone } from "./event-time.js";
import { buildPortalPacket, parsePortalHeader, PortalLinkType } from "./portal-packet.js";
import { PlaybackIngress, type PlaybackIngressEvidence } from "./playback-ingress.js";
import { isHevcKeyframe } from "./live.js";
import { parseVideoFrameHeader } from "../p2p/video.js";
import { performance } from "node:perf_hooks";
import {
  DownloadEvidence,
  downloadRequest,
  nextDownloadId,
  DOWNLOAD_EXPERIMENT_BYTES,
  downloadCaptureMs,
} from "./event-download-experiment.js";

export type CaptureOutcome =
  | "not_admitted"
  | "time_refused"
  | "start_refused"
  | "storage_failed"
  | "begin_time_refused"
  | "eof"
  | "complete"
  | "capped"
  | "capped_wrong_route"
  | "no_media"
  | "invalid_media"
  | "transport_mismatch"
  | "preempted"
  | "owner_changed"
  | "timeout";
export type PlaybackSelectionOutcome = "selected" | "no_rows" | "no_camera_rows" | "time_invalid" | "end_not_past";
/** Stable admission vocabulary; numeric positions retain their existing diagnostic meaning. */
export const PLAYBACK_ADMISSION_GATES = [
  "none",
  "disabled",
  "no_marker",
  "no_cameras",
  "no_exclusions",
  "unresolved",
  "no_owner",
  "owner_changed",
  "aborted",
  "no_observation",
  "observation_window",
  "no_ordinary_frames",
  "no_keepalives",
  "unsafe_observation",
  "no_information",
  "owner_not_connected",
  "information_tainted",
  "leases",
  "pending_exchanges",
  "scheduler_busy",
  "replacement",
  "refresh_pending",
  "live_entry",
  "playback_busy",
  "table_busy",
  "renewal_soon",
  "start_not_allowed",
  "scope_invalid",
  "store_unavailable",
  "reconnect_hold",
  "recording_busy",
  "reply_capacity",
  "recordings_unavailable",
  "model",
  "realtime_disabled",
  "inventory_conflict",
] as const;
export type PlaybackAdmissionGate = (typeof PLAYBACK_ADMISSION_GATES)[number];
export type PlaybackCompletenessFailure =
  "none" | "random_access" | "frames" | "span" | "gap" | "density" | "truncated";
export interface PlaybackReceipt extends PlaybackIngressEvidence {
  transferSpeed?: 1 | 2 | 4 | 8;
  mode?: "playback" | "download";
  download?: DownloadEvidence["value"];
  timeline?: Partial<
    Record<
      | "admissionGrantedMs"
      | "startSentMs"
      | "startAcknowledgedMs"
      | "firstVideoFrameMs"
      | "eofStatusMs"
      | "mediaReadyMs"
      | "releaseSettledMs",
      number
    >
  >;
  experiment?: PlaybackExperiment;
  arrivalFps?: ReturnType<PlaybackFrameTiming["snapshot"]>["arrivalFps"];
  frameTiming?: ReturnType<PlaybackFrameTiming["snapshot"]>["frameTiming"];
  nativeFrameTiming?: ReturnType<PlaybackNativeFrameTiming["snapshot"]>;
  selectedIceCandidateType?: "relay" | "srflx" | "host" | "prflx";
  selectedRemoteIceCandidateType?: "relay" | "srflx" | "host" | "prflx";
  durationBasis?: "arrival" | "catalog_experiment" | "native_header_experiment" | "catalog" | "native_header";
  reconnectOutcome?: "not_needed" | "connected" | "failed" | "timed_out";
  reconnectDurationMs?: number;
  playbackObservation?: ReturnType<PlaybackIngress["observationEvidence"]>;
  stationStatusCounts: { state: number; code: number; count: number }[];
  stationStatusOverflow: number;
  stationRefusalConfirmed: boolean;
  admissionGate: number;
  admissionGateName: PlaybackAdmissionGate;
  selectionOutcome: PlaybackSelectionOutcome;
  captureOutcome: CaptureOutcome;
  cessationOutcome: "not_started" | "ceased" | "media_continues" | "cessation_unknown";
  releaseOutcome: "not_started" | "release_confirmed" | "stop_unconfirmed" | "release_unknown";
  healthOutcome: "clean" | "degraded";
  accepted: false;
  boundedMediaObserved: boolean;
  timeBasis: "owner_accepted_station_timezone";
  timeZone: string;
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
  latchPersistenceFailed: boolean;
  latchRetained: boolean;
  latchCleared: boolean;
  retainedVideoSpanMs: number;
  maxVideoGapMs: number;
  retainedVideoFrames: number;
  droppedAfterCutoff: number;
  completenessFailure: PlaybackCompletenessFailure;
  videoFrames: number;
  audioFrames: number;
  randomAccess: boolean;
  codec: "unknown" | "h265";
  elapsedMs: number;
  silenceMs: number;
  /** Media duration; accelerated captures prefer a catalog-consistent native clock, then catalog duration. */
  mediaDurationMs?: number;
}

export { chicagoInstant } from "./event-time.js";

/**
 * Descending record selectors define recency; clips must have unique times and end at least 10 seconds ago.
 * Malformed rows and invalid or duplicate selectors refuse the entire table as time_invalid.
 * A time-valid but recent clip takes precedence over invalid times when no clip is selectable.
 */
export function selectPlayback(
  rows: unknown[],
  cameras: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
  now = Date.now(),
  timeZone = "America/Chicago",
):
  | { selectionOutcome: "selected"; record: number; begin: number }
  | { selectionOutcome: Exclude<PlaybackSelectionOutcome, "selected"> } {
  if (!rows.length) return { selectionOutcome: "no_rows" };
  const seen = new Set<number>();
  const eligible: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { selectionOutcome: "time_invalid" };
    const r = row as Record<string, unknown>;
    if (!Number.isSafeInteger(r.record_id) || (r.record_id as number) <= 0 || seen.has(r.record_id as number))
      return { selectionOutcome: "time_invalid" };
    seen.add(r.record_id as number);
    if (typeof r.device_sn === "string" && cameras.has(r.device_sn) && !excluded.has(r.device_sn)) eligible.push(r);
  }
  if (!eligible.length) return { selectionOutcome: "no_camera_rows" };
  let selectionOutcome: PlaybackSelectionOutcome = "time_invalid";
  for (const row of eligible.sort((a, b) => (b.record_id as number) - (a.record_id as number))) {
    const begin = chicagoInstant(row.start_time, timeZone),
      end = chicagoInstant(row.end_time, timeZone);
    if (begin === undefined || end === undefined || end < begin) continue;
    if (end * 1000 > now - 10000) {
      selectionOutcome = "end_not_past";
      continue;
    }
    return { selectionOutcome: "selected", record: row.record_id as number, begin };
  }
  return { selectionOutcome };
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
  experiment?: PlaybackExperiment,
  transferSpeed: 1 | 2 | 4 | 8 = 1,
): Buffer {
  const active = playbackExperiment(experiment);
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
        play_type: active?.playType ?? 1,
        play_speed: active?.playSpeed ?? transferSpeed,
        client_type: active?.clientType ?? "WEB",
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
  /** Duration-bound streaming sink is installed for this capture. */
  get fullClip(): boolean {
    return !!this.opts.video;
  }
  readonly ingress: PlaybackIngress;
  readonly receipt: PlaybackReceipt;
  private readonly started = performance.now();
  private readonly frameTiming = new PlaybackFrameTiming();
  private readonly nativeFrameTiming = new PlaybackNativeFrameTiming();
  private readonly download = new DownloadEvidence();
  private downloadId?: number;
  private downloadDeadline = Number.POSITIVE_INFINITY;

  /** Only an explicit validated experiment selects the FILE evidence path. */
  get downloadMode(): boolean {
    return this.receipt.experiment?.mode === "download";
  }

  /** Monotonic offsets only; an event is retained once. */
  mark(event: keyof NonNullable<PlaybackReceipt["timeline"]>): void {
    (this.receipt.timeline ??= {})[event] ??= Math.max(
      0,
      Math.round(performance.now() - (this.opts.timelineOriginMs ?? this.started)),
    );
  }
  private readonly segments: Partial<Record<0 | 1 | 3, number>> = {};
  private finish?: () => void;
  private finalized = false;
  private stoppedAt?: number;
  private releaseSeen = false;
  private releaseAt?: number;
  private eofSeen = false;
  private absentSeen = false;
  private conflict = false;
  private refusalAt?: number;
  private lateLatched = false;
  private selection?: { record: number; begin: number };
  private startSelector?: number;
  /** Coverage uses monotonic video arrival time scaled by the requested transfer speed. */
  private firstVideoAt?: number;
  private lastVideoAt?: number;
  private maxVideoGapMs = 0;
  /** Non-streaming cutoff count; the receipt carries a bounded projection. */
  private droppedAfterCutoff = 0;

  constructor(
    private readonly opts: {
      timelineOriginMs?: number;
      experiment?: PlaybackExperiment;
      transferSpeed?: 1 | 2;
      deadlineMs: number;
      timeZone?: string;
      captureMs?: number;
      expectedMs?: number;
      transient?: boolean;
      video?: (data: Buffer, timing?: { nativeTimestamp: number }) => void;
      file?: (data: Buffer) => void;
      camera?: string;
      continuous: () => boolean;
      startAllowed: () => boolean;
      send: (packet: Buffer) => boolean;
      segment: () => number;
      account: string;
      marker: (unresolved: boolean) => void;
      latch: (unresolved: boolean) => void;
      signal: AbortSignal;
      liveAllowed?: () => boolean;
      nativeMessage?: (direction: "in" | "out", message: unknown) => void;
    },
  ) {
    const experiment = playbackExperiment(opts.experiment);
    if (opts.transferSpeed !== undefined && opts.transferSpeed !== 1 && opts.transferSpeed !== 2)
      throw new RangeError("Playback transfer speed invalid");
    if (experiment?.mode === "download" && (!opts.transient || !opts.file || !opts.camera))
      throw new RangeError("Download experiment requires a clip evidence sink");
    this.ingress = new PlaybackIngress({
      streaming: opts.video
        ? { durationMs: opts.captureMs ?? 8000, frameLimit: Math.ceil(((opts.captureMs ?? 8000) * 256) / 1000) }
        : undefined,
      nativeMessage: opts.nativeMessage,
      end: (reason) => this.end(reason),
      media: (frame, timing) => this.media(frame, timing),
      control: (frame, link) => this.control(frame, link),
      ...(experiment?.mode === "download" && {
        packet: (channel: number, bytes: number) => this.download.packet(channel, bytes),
        file: (frame: Buffer) => this.file(frame),
        frame: (frame: Buffer, link: number) =>
          this.download.add(frame, link, Math.max(0, Math.round(performance.now() - this.started))),
      }),
      liveAllowed: opts.liveAllowed,
      late: () => {
        if (this.lateLatched) return;
        this.lateLatched = true;
        try {
          this.persistLatch(true);
        } catch {}
      },
    });
    this.receipt = {
      mode: experiment?.mode ?? "playback",
      transferSpeed: experiment?.playSpeed ?? opts.transferSpeed ?? (opts.video ? 2 : 1),
      ...(experiment?.mode === "download" && { download: this.download.value }),
      ...(experiment && { experiment }),
      timeline: {},
      stationStatusCounts: [],
      stationStatusOverflow: 0,
      stationRefusalConfirmed: false,
      admissionGate: 0,
      admissionGateName: "none",
      selectionOutcome: "no_rows",
      ...this.ingress.evidence,
      captureOutcome: "not_admitted",
      cessationOutcome: "not_started",
      releaseOutcome: "not_started",
      healthOutcome: "degraded",
      accepted: false,
      boundedMediaObserved: false,
      timeBasis: "owner_accepted_station_timezone",
      timeZone: recordingTimeZone(opts.timeZone),
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
      latchPersistenceFailed: false,
      latchRetained: false,
      latchCleared: false,
      retainedVideoSpanMs: 0,
      maxVideoGapMs: 0,
      retainedVideoFrames: 0,
      droppedAfterCutoff: 0,
      completenessFailure: "none",
      videoFrames: 0,
      audioFrames: 0,
      randomAccess: false,
      codec: "unknown",
      elapsedMs: 0,
      silenceMs: 0,
    };
  }

  /** Persistence failures retain memory safety only after dispatch or late media makes station state uncertain. */
  private persistLatch(unresolved: boolean): void {
    const uncertain = this.receipt.startAttempted || this.lateLatched;
    this.opts.latch(uncertain);
    this.receipt.latchRetained = uncertain;
    this.receipt.latchCleared = false;
    try {
      if (!this.opts.transient) this.opts.marker(unresolved);
      this.opts.latch(unresolved);
      this.receipt.latchRetained = unresolved;
    } catch (error) {
      this.receipt.latchPersistenceFailed = true;
      this.receipt.latchPersisted = false;
      if (uncertain) this.receipt.releaseOutcome = "release_unknown";
      else {
        try {
          this.opts.marker(false);
        } catch {}
      }
      throw error;
    }
  }

  end(reason: CaptureOutcome): void {
    if (this.finalized) {
      if (reason === "capped_wrong_route" || reason === "invalid_media") this.receipt.captureOutcome = reason;
      return;
    }
    if (this.receipt.captureOutcome === "invalid_media" && reason !== "invalid_media") return;
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
          Math.max(
            0,
            Math.min(
              this.downloadMode ? downloadCaptureMs(this.opts.expectedMs) : (this.opts.captureMs ?? 8000),
              this.opts.deadlineMs - performance.now() - 7000,
            ),
          ),
        );
        noMedia = setTimeout(() => {
          if (!this.downloadMode && !this.receipt.videoFrames) this.end("no_media");
        }, 5000);
        try {
          this.persistLatch(true);
          this.receipt.latchPersisted = !this.opts.transient;
          this.receipt.latchRetained = true;
          if (
            !this.opts.startAllowed() ||
            !this.opts.continuous() ||
            this.opts.signal.aborted ||
            performance.now() >= this.opts.deadlineMs - 7000
          ) {
            this.persistLatch(false);
            this.receipt.latchRetained = false;
            this.receipt.latchCleared = true;
            resolve();
            return;
          }
          const segment = this.opts.segment();
          this.segments[0] = segment;
          if (this.downloadMode) {
            this.downloadId = nextDownloadId();
            this.downloadDeadline = performance.now() + downloadCaptureMs(this.opts.expectedMs);
          }
          this.ingress.capturing = true;
          this.receipt.startAttempted = true;
          this.mark("startSentMs");
          this.receipt.releaseOutcome = "release_unknown";
          this.receipt.cessationOutcome = "cessation_unknown";
          if (
            !this.opts.send(
              this.downloadMode
                ? downloadRequest(
                    this.opts.account,
                    selection.record,
                    this.opts.camera!,
                    selectors[0],
                    this.downloadId!,
                    segment,
                  )
                : playbackRequest(
                    this.opts.account,
                    selection.record,
                    selectors[0],
                    0,
                    segment,
                    selection.begin,
                    this.receipt.experiment,
                    this.receipt.transferSpeed,
                  ),
            )
          ) {
            delete this.receipt.timeline?.startSentMs;
            this.end("start_refused");
          }
        } catch {
          delete this.receipt.timeline?.startSentMs;
          this.end(
            !this.receipt.startAttempted && this.receipt.latchPersistenceFailed ? "storage_failed" : "start_refused",
          );
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
    if (this.downloadMode) {
      this.download.value.cancelAttempted = true;
      this.receipt.stopAttempted = true;
      if (this.opts.continuous() && performance.now() < this.opts.deadlineMs) {
        try {
          const segment = this.opts.segment();
          this.segments[3] = segment;
          this.receipt.stopSent = this.download.value.cancelSent = this.opts.send(
            downloadRequest(
              this.opts.account,
              this.selection.record,
              this.opts.camera!,
              this.startSelector,
              this.downloadId!,
              segment,
              true,
            ),
          );
        } catch {}
      }
      this.ingress.quarantine();
      return;
    }
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
            this.receipt.experiment,
            this.receipt.transferSpeed,
          ),
        );
        if (sub === 1) this.receipt.pauseSent = sent;
        else this.receipt.stopSent = sent;
      } catch {}
    }
  }

  async observe(retireAtEof = false): Promise<PlaybackReceipt> {
    try {
      this.finalize();
      if (this.downloadMode) {
        this.download.value.mediaDurationMs = this.download.durationMs(this.opts.expectedMs);
        Object.assign(this.receipt, this.ingress.evidence);
        this.receipt.ownerContinuous = this.opts.continuous();
        this.receipt.elapsedMs = Math.max(0, Math.round(performance.now() - this.started));
        this.ingress.quarantine();
        return { ...this.receipt };
      }
      const deadline = this.opts.video
        ? Math.min(this.opts.deadlineMs, performance.now() + 16000)
        : this.opts.deadlineMs;
      const retiringEof =
        retireAtEof &&
        this.fullClip &&
        this.eofSeen &&
        this.receipt.captureOutcome === "eof" &&
        this.retainedMediaComplete();
      if (this.stoppedAt !== undefined && !retiringEof) {
        while (performance.now() < deadline && this.opts.continuous()) {
          const complete = this.ingress.observationComplete();
          const quiet =
            performance.now() -
            Math.max(this.stoppedAt, this.releaseAt ?? this.stoppedAt, this.ingress.lastPlausibleMs);
          this.receipt.silenceMs = Math.max(0, Math.floor(quiet));
          if (complete && quiet >= 5000 && this.stopConfirmed()) {
            this.receipt.cessationOutcome = "ceased";
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(0, deadline - performance.now()))));
        }
        if (this.receipt.cessationOutcome !== "ceased")
          this.receipt.cessationOutcome =
            this.opts.continuous() && this.ingress.observationComplete() && this.stopConfirmed()
              ? "media_continues"
              : "cessation_unknown";
      }
      this.receipt.ownerContinuous = this.opts.continuous();
      if (
        !this.receipt.startAttempted &&
        this.receipt.ownerContinuous &&
        !this.receipt.latchPersistenceFailed &&
        !this.lateLatched
      ) {
        try {
          if (this.receipt.latchRetained) {
            this.persistLatch(false);
            this.receipt.latchRetained = false;
            this.receipt.latchCleared = true;
          }
          this.receipt.healthOutcome = "clean";
        } catch {}
      }
      if (this.receipt.startAttempted) {
        this.receipt.stationRefusalConfirmed =
          this.receipt.ownerContinuous &&
          this.receipt.stopSent &&
          this.receipt.cessationOutcome === "ceased" &&
          this.refusalSafe();
        if (
          !this.receipt.stationRefusalConfirmed &&
          this.refusalAt === undefined &&
          this.receipt.ownerContinuous &&
          this.receipt.stopSent &&
          this.receipt.cessationOutcome === "ceased" &&
          !this.conflict &&
          (this.releaseSeen || (this.absentSeen && this.eofSeen))
        ) {
          try {
            this.persistLatch(false);
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
      const span = (this.lastVideoAt ?? 0) - (this.firstVideoAt ?? 0);
      if (this.fullClip && this.receipt.videoFrames >= 2 && span > 0)
        this.receipt.mediaDurationMs = Math.max(
          1,
          Math.round((span + span / (this.receipt.videoFrames - 1)) * (this.receipt.transferSpeed ?? 1)),
        );
      Object.assign(this.receipt, this.frameTiming.snapshot());
      this.receipt.nativeFrameTiming = this.nativeFrameTiming.snapshot();
      this.receipt.durationBasis = "arrival";
      if (
        this.fullClip &&
        (this.retainedMediaComplete() || (this.receipt.experiment && this.eofSeen)) &&
        this.opts.expectedMs &&
        this.receipt.videoFrames >= 2
      ) {
        const nativeDuration =
          this.nativeFrameTiming.durationMs(this.opts.expectedMs) ??
          (this.eofSeen && this.receipt.captureOutcome === "eof" && !this.receipt.experiment
            ? this.nativeFrameTiming.completeDurationMs(this.opts.expectedMs)
            : undefined);
        this.receipt.mediaDurationMs = nativeDuration ?? this.opts.expectedMs;
        this.receipt.durationBasis = this.receipt.experiment
          ? nativeDuration === undefined
            ? "catalog_experiment"
            : "native_header_experiment"
          : nativeDuration === undefined
            ? "catalog"
            : "native_header";
      }
      this.receipt.retainedVideoSpanMs = Math.max(0, Math.round(span));
      this.receipt.maxVideoGapMs = Math.max(0, Math.round(this.maxVideoGapMs));
      this.receipt.retainedVideoFrames = this.receipt.videoFrames;
      this.receipt.completenessFailure = this.retainedMediaFailure();
      this.receipt.boundedMediaObserved =
        ["eof", "complete", "capped"].includes(this.receipt.captureOutcome) &&
        this.retainedMediaComplete() &&
        this.receipt.startAcknowledged &&
        this.receipt.randomAccess &&
        this.receipt.ownerContinuous &&
        (this.fullClip || this.receipt.cessationOutcome === "ceased") &&
        this.receipt.pauseAttempted &&
        this.receipt.stopAttempted &&
        !this.receipt.unknown &&
        this.receipt.rejected === 0 &&
        this.receipt.wrongRouteFrames === 0;
      this.ingress.quarantine();
      return { ...this.receipt };
    } finally {
      this.ingress.stopExpiry();
    }
  }

  /** Cessation evidence counts only after a stop that was actually sent and confirmed without conflict. */
  private stopConfirmed(): boolean {
    return (
      this.receipt.stopSent &&
      !this.conflict &&
      (this.releaseSeen || (this.absentSeen && this.eofSeen) || this.refusalSafe())
    );
  }

  /**
   * Terminal absence (0/7) or no stored video (2/18) before acknowledgement or ingress
   * identifies a no-stream refusal only with an exact numeric start-segment match.
   * Missing or non-comparable segments cannot establish refusal correlation.
   */
  private refusalSafe(): boolean {
    return (
      this.refusalAt !== undefined &&
      !this.conflict &&
      !this.receipt.startAcknowledged &&
      !this.receipt.videoFrames &&
      !this.receipt.audioFrames &&
      !this.ingress.evidence.ingressVideoFrames &&
      !this.ingress.evidence.ingressAudioFrames &&
      !this.ingress.evidence.rejected &&
      !this.ingress.evidence.unknown &&
      !this.ingress.mediaTrafficObserved
    );
  }

  /**
   * EOF coverage allows 15% missing arrival span (at least 1 s tolerance), but
   * requires five frame intervals per second of both catalog and scaled arrival
   * time unless contiguous native headers prove coverage within the catalog window.
   * Individual delivery gaps have no EOF limit. Experiments keep their
   * independent timing policy; non-EOF captures require strict span and gaps.
   */
  private retainedMediaFailure(): PlaybackCompletenessFailure {
    if (this.opts.expectedMs === undefined) return "none";
    const speed = this.receipt.transferSpeed ?? 1;
    const span = ((this.lastVideoAt ?? 0) - (this.firstVideoAt ?? 0)) * speed;
    const eof = this.eofSeen && this.receipt.captureOutcome === "eof";
    if (eof && !this.receipt.randomAccess) return "random_access";
    if (this.receipt.videoFrames < 2) return "frames";
    if (eof) {
      if (this.receipt.experiment) return "none";
      if (this.nativeFrameTiming.completeDurationMs(this.opts.expectedMs) !== undefined) return "none";
      if (span <= 0 || span < this.opts.expectedMs - Math.max(1000, this.opts.expectedMs * 0.15)) return "span";
      if ((this.receipt.videoFrames - 1) * 1000 < Math.max(span, this.opts.expectedMs) * 5) return "density";
      if (this.nativeFrameTiming.shortOf(this.opts.expectedMs)) return "truncated";
      return "none";
    }
    if (span <= 0 || span < this.opts.expectedMs - 250) return "span";
    if (this.maxVideoGapMs * speed > 1000) return "gap";
    if ((this.receipt.videoFrames - 1) * 1000 < span * 5) return "density";
    return "none";
  }

  /** Completeness requires arrival coverage and density or contiguous native coverage, with random access at EOF. */
  private retainedMediaComplete(): boolean {
    return this.retainedMediaFailure() === "none";
  }

  /** Retains at most the remaining FILE budget, before mandatory cancel and owner retirement. */
  private file(frame: Buffer): void {
    if (this.finalized || !this.ingress.capturing) return;
    if (performance.now() >= this.downloadDeadline) {
      this.end("capped");
      return;
    }
    const remaining = DOWNLOAD_EXPERIMENT_BYTES - this.download.value.fileBytes;
    const bytes = frame.subarray(0, remaining);
    try {
      if (bytes.length) this.opts.file!(bytes);
      this.download.value.fileBytes += bytes.length;
      if (bytes.length) this.download.file(bytes, Math.max(0, Math.round(performance.now() - this.started)));
      if (this.download.value.fileBytes >= DOWNLOAD_EXPERIMENT_BYTES) this.end("capped");
    } catch {
      this.end("storage_failed");
    }
  }

  private media(frame: Buffer, timing?: { frameId: number; sequence: number }): void {
    if (this.downloadMode) {
      this.end("transport_mismatch");
      return;
    }
    const h = parsePortalHeader(frame)!;
    if (h.isResponse !== this.startSelector) {
      this.ingress.invalidMedia("selector");
      return;
    }
    if (h.commandId === 1301) {
      this.receipt.audioFrames++;
      return;
    }
    const body = frame.subarray(16);
    if (body.length < 22 || body.readUInt32LE(0) !== body.length - 22 || body[5] !== 1) {
      this.ingress.invalidMedia("metadata");
      return;
    }
    const data = body.subarray(22);
    if (!(data.length >= 6 && (data.readUInt32BE(0) === 1 || data.readUIntBE(0, 3) === 1))) {
      this.ingress.invalidMedia("metadata");
      return;
    }
    if (this.opts.video && !this.receipt.videoFrames && !isHevcKeyframe(data)) {
      this.ingress.invalidMedia("metadata");
      return;
    }
    const now = performance.now();
    this.firstVideoAt ??= now;
    const coverageMs = (now - this.firstVideoAt) * (this.receipt.transferSpeed ?? 1);
    if (!this.fullClip && this.opts.expectedMs !== undefined && coverageMs > this.opts.expectedMs) {
      this.droppedAfterCutoff++;
      this.receipt.droppedAfterCutoff = Math.min(65535, this.droppedAfterCutoff);
      if (coverageMs >= this.opts.expectedMs + 750 && this.retainedMediaComplete() && this.receipt.randomAccess)
        this.end("complete");
      return;
    }
    try {
      const header = parseVideoFrameHeader(body);
      this.opts.video?.(data, header ? { nativeTimestamp: header.timestamp } : undefined);
    } catch {
      this.end("invalid_media");
      return;
    }
    if (this.lastVideoAt !== undefined) this.maxVideoGapMs = Math.max(this.maxVideoGapMs, now - this.lastVideoAt);
    this.lastVideoAt = now;
    this.frameTiming.add(now, timing);
    this.nativeFrameTiming.add(body, now);
    this.mark("firstVideoFrameMs");
    this.receipt.videoFrames++;
    this.receipt.codec = "h265";
    this.receipt.randomAccess ||= isHevcKeyframe(data);
    if (this.receipt.startAcknowledged) this.receipt.beginTimeAcceptance = "accepted";
  }

  private control(frame: Buffer, link: number): boolean {
    const h = parsePortalHeader(frame);
    if (!h || !this.opts.continuous()) return true;
    if (this.downloadMode) {
      if (
        link === PortalLinkType.COMMAND &&
        h.commandId === 1350 &&
        h.channel === 255 &&
        h.isResponse === 1 &&
        h.paramLength + 16 === frame.length &&
        h.paramLength >= 4
      ) {
        if (h.segment === this.segments[0]) {
          this.download.value.ackReceived = true;
          this.download.value.ackStatus = frame.readInt32LE(16);
          this.receipt.startAcknowledged = this.download.value.ackStatus === 0;
          this.mark("startAcknowledgedMs");
          if (!this.receipt.startAcknowledged) this.end("start_refused");
        } else if (h.segment === this.segments[3]) {
          this.download.value.cancelAckReceived = true;
          this.download.value.cancelAckStatus = frame.readInt32LE(16);
        }
      }
      if (!this.finalized && this.download.value.terminalStatus) {
        this.mark("eofStatusMs");
        this.end("eof");
      }
      return false;
    }
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
    const p = value.payload;
    if (!p || Array.isArray(p) || !Number.isSafeInteger(p.state) || !Number.isSafeInteger(p.code)) {
      this.conflict = true;
      return false;
    }
    const status = this.receipt.stationStatusCounts.find((row) => row.state === p.state && row.code === p.code);
    if (status) status.count = Math.min(65535, status.count + 1);
    else if (this.receipt.stationStatusCounts.length < 32)
      this.receipt.stationStatusCounts.push({ state: p.state as number, code: p.code as number, count: 1 });
    else this.receipt.stationStatusOverflow = Math.min(65535, this.receipt.stationStatusOverflow + 1);
    if (!this.receipt.startAttempted) {
      this.conflict = true;
      this.end("transport_mismatch");
      return true;
    }
    if (p.state === 1 && p.code === 0) {
      if (this.refusalAt !== undefined) this.conflict = true;
      if (!this.finalized) {
        this.receipt.startAcknowledged = true;
        this.mark("startAcknowledgedMs");
        if (this.receipt.videoFrames) this.receipt.beginTimeAcceptance = "accepted";
      }
    } else if (p.state === 2 && p.code === 14 && this.stoppedAt === undefined) {
      if (typeof p.segmen === "number" && Number.isFinite(p.segmen) && p.segmen !== this.segments[0]) {
        this.conflict = true;
        this.end("transport_mismatch");
        return false;
      }
      this.eofSeen = true;
      this.mark("eofStatusMs");
      this.end("eof");
    } else if (p.state === 2 && p.code === 15 && this.stoppedAt !== undefined) {
      this.releaseSeen = true;
      this.releaseAt = performance.now();
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
      this.releaseAt = performance.now();
      this.receipt.correlationBasis = "exclusive_timing";
    } else {
      if (
        ((p.state === 0 && p.code === 7) || (p.state === 2 && p.code === 18)) &&
        typeof p.segmen === "number" &&
        p.segmen === this.segments[0] &&
        !this.receipt.startAcknowledged &&
        !this.ingress.evidence.ingressVideoFrames &&
        !this.ingress.evidence.ingressAudioFrames
      ) {
        this.refusalAt = performance.now();
        this.receipt.correlationBasis = "segment_match_and_exclusive";
      } else this.conflict = true;
      this.end("start_refused");
    }
    return false;
  }
}
