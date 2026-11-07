import { isPortalPacket, parsePortalHeader, PortalLinkType } from "./portal-packet.js";
import { parsePtcsHeader, PtcsReassembler, type PtcsInspection, type PtcsRejectionReason } from "./ptcs-framer.js";
import { PORTAL_KEEPALIVE } from "./portal-keepalive.js";
import { T9000Live } from "./live.js";
import { performance } from "node:perf_hooks";

export const PLAYBACK_BYTES = 2 * 1024 * 1024;
export const PLAYBACK_FRAME_BYTES = 8 * 1024 * 1024;
export const PLAYBACK_EXPIRY_SWEEP_MS = 250;
export const PLAYBACK_LATE_WINDOW_MS = 1000;
export const PLAYBACK_LATE_WINDOW_BYTES = 64 * 1024 * 1024;
export const PLAYBACK_LATE_WINDOW_FRAMES = 1024;
const PLAYBACK_PARTIAL_AGE_MS = 15000;
const PLAYBACK_RESERVED_BYTES = 16 * 1024 * 1024;
export const PLAYBACK_WORK_BYTES = 32 * 1024 * 1024;
const PLAYBACK_LATE_FRAME_BYTES = 256 * 1024;
/** Bits 0x8000 and 0x1000 are never seen on playback. 0x2000 marks the frames of a video keyframe. */
const PLAYBACK_FORBIDDEN_FLAGS = 0x9000;
export type PlaybackSizeBucket = "unknown" | "zero" | "le8KiB" | "le256KiB" | "le8MiB" | "gt8MiB";
export type PlaybackRejectedClass =
  "none" | "nonbinary" | "unknown" | "bare" | "control" | "playback" | "live" | "other";
export const playbackSizeBucket = (bytes?: number): PlaybackSizeBucket =>
  bytes === undefined
    ? "unknown"
    : bytes === 0
      ? "zero"
      : bytes <= 8192
        ? "le8KiB"
        : bytes <= 262144
          ? "le256KiB"
          : bytes <= 8388608
            ? "le8MiB"
            : "gt8MiB";

/** Header-first native admission and post-inflation classification, before downstream parsers. */
export interface RtcIngressGuard {
  native(message: unknown): boolean;
  sent?(message: Buffer): void;
  decoded(frame: Buffer, link: number): boolean;
  stale(): void;
  received?(outcome: "accepted" | "rejected" | "unknown" | void): void;
}

/**
 * Closed diagnostic enums and bounded counters, without packet identities or payloads. Declared size
 * is the PTCS extent, assembled size is retained input, output size is measured decoded output.
 * Diagnostic values freeze at the first rejection; counters continue during drain.
 */
export interface PlaybackIngressEvidence {
  firstRejectionReason: "none" | PtcsRejectionReason;
  firstRejectedClass: PlaybackRejectedClass;
  compressionState: NonNullable<PtcsInspection["compressionState"]>;
  declaredSizeBucket: PlaybackSizeBucket;
  assembledSizeBucket: PlaybackSizeBucket;
  outputSizeBucket: PlaybackSizeBucket;
  zstdWindowBucket: PlaybackSizeBucket;
  ingressVideoFrames: number;
  ingressAudioFrames: number;
  rejectedByReason: Partial<Record<PtcsRejectionReason | "wrong_route", number>>;
  rejectionCount: number;
  assemblerDecompression: number;
  assemblerInvalidMetadata: number;
  nativeBytes: number;
  nativeMessages: number;
  mediaBytes: number;
  mediaFrames: number;
  wrongRouteBytes: number;
  wrongRouteFrames: number;
  rejected: number;
  decodedWorkBytes: number;
  collectorAttempts: number;
  unknown: boolean;
  cutoff: boolean;
}

const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

/**
 * Strict playback assembly is separate from the unchanged ordinary-control assembler. Control
 * inflation retains baseline limits. Decoded wrong-route media never reaches a parser or consumer.
 * A compressed playback assembly reserves a full output allowance before retaining any fragments.
 */
export class PlaybackIngress implements RtcIngressGuard {
  readonly evidence: PlaybackIngressEvidence = {
    firstRejectionReason: "none",
    firstRejectedClass: "none",
    compressionState: "unknown",
    declaredSizeBucket: "unknown",
    assembledSizeBucket: "unknown",
    outputSizeBucket: "unknown",
    zstdWindowBucket: "unknown",
    ingressVideoFrames: 0,
    ingressAudioFrames: 0,
    rejectedByReason: {},
    rejectionCount: 0,
    assemblerDecompression: 0,
    assemblerInvalidMetadata: 0,
    nativeBytes: 0,
    nativeMessages: 0,
    mediaBytes: 0,
    mediaFrames: 0,
    wrongRouteBytes: 0,
    wrongRouteFrames: 0,
    rejected: 0,
    decodedWorkBytes: 0,
    collectorAttempts: 0,
    unknown: false,
    cutoff: false,
  };
  lastPlausibleMs = Number.NEGATIVE_INFINITY;
  capturing = false;
  /** Any playback-link packet or decoded media disqualifies a terminal no-stream refusal. */
  mediaTrafficObserved = false;
  private rejectedAt = Number.NEGATIVE_INFINITY;
  private packetClass: PlaybackRejectedClass = "unknown";
  private inspection: PtcsInspection = {};
  private reservedOutput = 0;
  private reservedFrames = 0;
  private readonly assemblies = new Map<string, { bytes: number }>();
  private readonly assembler: PtcsReassembler;
  private readonly lateAssembler = new PtcsReassembler(
    (frame) => {
      this.chargeLate(frame.length);
      this.lateFrame(frame, true);
    },
    { maxFrameBytes: PLAYBACK_LATE_FRAME_BYTES },
  );
  private expiryTimer?: NodeJS.Timeout;
  private selectors = new Set<number>();
  private tombstone = false;
  private lateWindow = { since: 0, bytes: 0, frames: 0 };
  private completingId = "";
  private readonly controlPartials = new Map<string, number>();
  private currentControlKey?: string;
  readonly observedSinceMs = performance.now();
  ordinaryFrames = 0;
  keepalives = 0;
  private nonControlTraffic = false;
  private lastLiveStart?: number;
  private lastLiveStop?: number;
  private readonly poisonCounts = new Map<
    string,
    {
      cause: string;
      link: number | null;
      cmd: number | null;
      channel: number | null;
      selector: string;
      liveTargetAmbiguous: boolean;
      sinceLiveStart: string;
      sinceLiveStop: string;
      count: number;
    }
  >();
  private poisonOverflow = 0;

  /** Record live-start age independently of target attribution. */
  liveStarted(): void {
    this.lastLiveStart = this.now();
  }

  /** At most 32 count-only poison classes plus a saturating overflow count; no payloads or identities. */
  observationEvidence() {
    return {
      observerAgeMs: Math.max(0, Math.floor(this.now() - this.observedSinceMs)),
      poisonCounts: [...this.poisonCounts.values()].map((row) => ({ ...row })),
      poisonOverflow: this.poisonOverflow,
    };
  }

  private poison(
    cause: PtcsRejectionReason | "playback_link" | "bare" | "link",
    link: number | null = null,
    frame?: Buffer,
  ): void {
    if (!this.opts.observeOnly) return;
    const h = frame && parsePortalHeader(frame);
    const bucket = (at?: number) =>
      at === undefined
        ? "unknown"
        : this.now() - at < 1000
          ? "lt1s"
          : this.now() - at < 10000
            ? "lt10s"
            : this.now() - at < 60000
              ? "lt60s"
              : "ge60s";
    const row = {
      cause,
      link,
      cmd: h?.commandId ?? null,
      channel: h?.channel ?? null,
      selector: !h
        ? "unknown"
        : h.isResponse === 1
          ? "1"
          : h.isResponse >= 6 && h.isResponse <= 249
            ? "playback"
            : "other",
      liveTargetAmbiguous: this.opts.liveTargetAmbiguous?.() === true,
      sinceLiveStart: bucket(this.lastLiveStart),
      sinceLiveStop: bucket(this.lastLiveStop),
      count: 0,
    };
    const key = JSON.stringify(row);
    const current = this.poisonCounts.get(key);
    if (current) current.count = Math.min(65535, current.count + 1);
    else if (this.poisonCounts.size < 32) this.poisonCounts.set(key, { ...row, count: 1 });
    else this.poisonOverflow = Math.min(65535, this.poisonOverflow + 1);
  }

  /** Record the current owner's live-stop time without imposing a playback admission delay. */
  liveEnded(): void {
    this.lastLiveStop = this.now();
  }

  /** Resolved ordinary fragments are safe before start; media, unknowns and outstanding work are not. */
  prestartSafe(): boolean {
    return !this.nonControlTraffic && this.evidence.wrongRouteFrames === 0 && this.observationComplete();
  }

  stale(): void {
    this.inspection = {};
    this.packetClass = "unknown";
    this.evidence.unknown = true;
    this.reject("invalid_media", true, "baseline");
  }

  /** Rejected or unclassified baseline work cannot prove the absence of incoming media. */
  received(outcome: "accepted" | "rejected" | "unknown" | void): void {
    if (outcome !== "accepted") {
      if (outcome !== "rejected") this.evidence.unknown = true;
      this.reject("invalid_media", true, "baseline");
    }
  }

  constructor(
    private readonly opts: {
      now?: () => number;
      streaming?: { durationMs: number; frameLimit: number };
      nativeMessage?: (direction: "in" | "out", message: unknown) => void;
      end: (reason: "capped" | "capped_wrong_route" | "transport_mismatch" | "invalid_media") => void;
      media: (frame: Buffer, timing?: { frameId: number; sequence: number }) => void;
      control?: (frame: Buffer, link: number) => boolean;
      file?: (frame: Buffer) => void;
      frame?: (frame: Buffer, link: number) => void;
      packet?: (channel: number, bytes: number) => void;
      late?: () => void;
      observeOnly?: boolean;
      liveAllowed?: () => boolean;
      liveTargetAmbiguous?: () => boolean;
    },
  ) {
    this.assembler = new PtcsReassembler(
      (frame, channel, timing) => {
        this.releaseReservation(this.completingId);
        if (channel === 3 && this.opts.file) {
          if (this.capturing && !this.evidence.cutoff) {
            this.opts.frame?.(frame, PortalLinkType.FILE);
            this.opts.file(frame);
          }
        } else this.complete(frame, timing);
      },
      {
        plainFileFrames: !!opts.file,
        maxFrameBytes: PLAYBACK_FRAME_BYTES,
        maxPendingFrames: 8,
        maxBufferedBytes: 16 * 1024 * 1024,
        maxFragmentsPerFrame: 16384,
        maxAgeMs: PLAYBACK_PARTIAL_AGE_MS,
        staleMs: PLAYBACK_PARTIAL_AGE_MS,
        now: () => this.now(),
        inspect: (value) => {
          Object.assign(this.inspection, value);
        },
      },
    );
  }

  private now(): number {
    return this.opts.now?.() ?? performance.now();
  }

  /** Independent 15-second expiry, with at most 250 ms scheduling granularity. */
  startExpiry(): void {
    this.expiryTimer ??= setInterval(() => this.expire(), PLAYBACK_EXPIRY_SWEEP_MS);
    this.expiryTimer.unref();
  }

  /** Invocation teardown releases the timer and any remaining payload; quarantine stays header-only. */
  stopExpiry(): void {
    clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
    this.finishCapture();
  }

  /** The assembler owns progress timestamps; duplicate fragments never renew the idle deadline. */
  private expire(): void {
    if (this.assembler.expire()) {
      this.packetClass = "playback";
      this.reject("invalid_media", true, "expiry");
      this.finishCapture();
    }
  }

  invalidMedia(reason: PtcsRejectionReason): void {
    this.reject("invalid_media", true, reason);
  }

  reserve(start: number, stop: number): void {
    this.selectors = new Set([start, stop]);
  }

  private plausible(unknown = false): void {
    this.lastPlausibleMs = this.now();
    if (unknown) this.rejectedAt = this.now();
    if (unknown && (this.tombstone || this.opts.observeOnly)) this.evidence.unknown = true;
  }

  private reject(
    reason: "capped" | "transport_mismatch" | "invalid_media",
    unknown = false,
    diagnostic: PtcsRejectionReason = "metadata",
    packet?: { link: number; frame: Buffer },
  ): false {
    const rejection = this.inspection.reason ?? diagnostic;
    this.poison(rejection, packet?.link, packet?.frame);
    this.evidence.rejectedByReason[rejection] = add(this.evidence.rejectedByReason[rejection] ?? 0, 1);
    const counters = this.assembler.getDiagnostics();
    this.evidence.assemblerDecompression = counters.decompression;
    this.evidence.assemblerInvalidMetadata = counters.invalidMetadata;
    if (this.evidence.firstRejectionReason === "none") {
      this.evidence.firstRejectionReason = this.inspection.reason ?? diagnostic;
      this.evidence.firstRejectedClass = this.packetClass;
      this.evidence.compressionState = this.inspection.compressionState ?? "unknown";
      this.evidence.declaredSizeBucket = playbackSizeBucket(this.inspection.declaredSize);
      this.evidence.assembledSizeBucket = playbackSizeBucket(this.inspection.assembledSize);
      this.evidence.outputSizeBucket = playbackSizeBucket(this.inspection.outputSize);
      this.evidence.zstdWindowBucket = playbackSizeBucket(this.inspection.zstdWindow);
    }
    this.evidence.rejectionCount = Math.min(255, this.evidence.rejectionCount + 1);
    this.nonControlTraffic = true;
    this.plausible(unknown);
    this.evidence.rejected = add(this.evidence.rejected, 1);
    this.opts.end(reason === "capped" ? "invalid_media" : reason);
    return false;
  }

  /** Discard partial payload and release concurrent output reservations; cumulative work remains charged. */
  finishCapture(): void {
    this.capturing = false;
    if (this.assemblies.size) this.plausible();
    this.assemblies.clear();
    this.reservedOutput = 0;
    this.assembler.clear();
  }

  /** Selector-specific isolation after qualified release; unrelated live selector 1 may pass. */
  quarantine(): void {
    this.finishCapture();
    this.tombstone = true;
    this.lateWindow = { since: this.now(), bytes: 0, frames: 0 };
  }

  /** Capture errors require a fresh quiet interval; observation loss remains permanently uncertain. */
  observationComplete(): boolean {
    const now = this.now();
    this.expire();
    for (const [key, at] of this.controlPartials) {
      if (now - at >= 15000) {
        this.poison("expiry");
        this.plausible(true);
        this.controlPartials.delete(key);
      }
    }
    return (
      !this.evidence.unknown &&
      now - this.rejectedAt >= 5000 &&
      this.assemblies.size === 0 &&
      this.controlPartials.size === 0
    );
  }

  sent(message: Buffer): void {
    try {
      this.opts.nativeMessage?.("out", message);
    } catch {}
  }

  private releaseReservation(id: string): void {
    this.reservedOutput -= this.assemblies.get(id)?.bytes ?? 0;
    this.assemblies.delete(id);
  }

  native(message: unknown): boolean {
    try {
      this.opts.nativeMessage?.("in", message);
    } catch {}
    this.expire();
    this.inspection = {};
    this.packetClass = "unknown";
    this.currentControlKey = undefined;
    const binary = Buffer.isBuffer(message)
      ? message
      : ArrayBuffer.isView(message)
        ? Buffer.from(message.buffer, message.byteOffset, message.byteLength)
        : message instanceof ArrayBuffer
          ? Buffer.from(message)
          : undefined;
    this.evidence.nativeMessages = add(this.evidence.nativeMessages, 1);
    this.evidence.nativeBytes = add(this.evidence.nativeBytes, binary?.length ?? 0);
    if (!binary) {
      this.packetClass = "nonbinary";
      return this.reject("invalid_media", true, "native");
    }
    const seconds = this.opts.streaming ? Math.ceil(this.opts.streaming.durationMs / 1000) : 0;
    const byteLimit = this.opts.streaming
      ? Math.min(2 * 1024 ** 3, Math.max(16 * 1024 ** 2, seconds * 8 * 1024 ** 2))
      : 4 * 1024 * 1024;
    const messageLimit = this.opts.streaming ? Math.max(32768, seconds * 8192) : 16384;
    if (!this.tombstone && (this.evidence.nativeBytes >= byteLimit || this.evidence.nativeMessages >= messageLimit)) {
      this.evidence.cutoff = true;
      this.opts.end("capped");
    }
    if (binary.equals(PORTAL_KEEPALIVE)) {
      this.keepalives = add(this.keepalives, 1);
      return true;
    }
    const h = parsePtcsHeader(binary);
    if (h && this.capturing) this.opts.packet?.(h.channel, binary.length);
    if (h?.channel === 4) this.mediaTrafficObserved = true;
    if (this.opts.observeOnly && h?.channel === 4) {
      this.poison("playback_link", PortalLinkType.PLAYBACK, h.index === 0 && h.last ? binary.subarray(28) : undefined);
      this.nonControlTraffic = true;
      this.plausible();
      return true;
    }
    if (!h) {
      const inner = parsePortalHeader(binary);
      if (inner) {
        this.packetClass = "bare";
        if (this.opts.observeOnly) {
          if (inner.paramLength + 16 !== binary.length) return this.reject("invalid_media", true, "extent");
          if (inner.commandId === 1300 || inner.commandId === 1301 || inner.commandId === 1303) {
            this.poison("bare", null, binary);
            this.nonControlTraffic = true;
            this.plausible();
          }
          return true;
        }
        if (
          inner.commandId === 1300 ||
          inner.commandId === 1301 ||
          inner.commandId === 1303 ||
          this.selectors.has(inner.isResponse)
        )
          return this.wrong(binary);
        if (inner.paramLength + 16 !== binary.length) return this.reject("invalid_media", true);
        return true;
      }
      return this.reject("invalid_media", true, "header");
    }
    this.packetClass =
      h.channel === 4
        ? "playback"
        : h.channel === 5 || h.channel === 1
          ? "live"
          : h.channel === 0 || h.channel === 2
            ? "control"
            : "other";
    this.inspection = {
      declaredSize: h.frameLength,
      compressionState: binary.readUInt16LE(18) & 0x0800 ? "flagged" : "uncompressed",
    };
    if (h.channel !== 4 && !(h.channel === 3 && this.opts.file)) {
      this.currentControlKey = `${h.channel}:${h.frameId}`;
      if (h.index !== 0 || !h.last) {
        this.plausible();
        const key = `${h.channel}:${h.frameId}`;
        if (this.controlPartials.size < 32 || this.controlPartials.has(key)) this.controlPartials.set(key, this.now());
        else this.evidence.unknown = true;
      }
      return true;
    }
    this.plausible();
    this.nonControlTraffic = true;
    if (h.channel === 3 && this.opts.file && !this.capturing) return false;
    if (!this.capturing) {
      if (!this.tombstone) return false;
      if (h.index !== 0 || !h.last) return this.lateUnknown("invalid_media");
      if (
        binary[4] !== 3 ||
        (binary.readUInt16LE(18) & PLAYBACK_FORBIDDEN_FLAGS) !== 0 ||
        !(binary.readUInt16LE(18) & 0x4000) ||
        h.frameLength > PLAYBACK_LATE_FRAME_BYTES ||
        h.payloadLength !== h.frameLength ||
        h.payloadLength > binary.length - 28
      )
        return this.lateUnknown("invalid_media");
      const compressed = !!(binary.readUInt16LE(18) & 0x0800);
      const now = this.now();
      if (now - this.lateWindow.since >= PLAYBACK_LATE_WINDOW_MS) this.lateWindow = { since: now, bytes: 0, frames: 0 };
      const allowance = compressed ? PLAYBACK_LATE_FRAME_BYTES : h.payloadLength;
      if (
        this.lateWindow.frames >= PLAYBACK_LATE_WINDOW_FRAMES ||
        this.lateWindow.bytes + allowance > PLAYBACK_LATE_WINDOW_BYTES
      )
        return this.lateUnknown("capped");
      this.lateWindow.frames++;
      if (!compressed) {
        this.chargeLate(h.payloadLength);
        this.lateFrame(binary.subarray(28, 28 + h.payloadLength), true);
        return false;
      }
      const inspected = this.lateAssembler.push(binary);
      this.lateAssembler.clear();
      if (!inspected) {
        this.chargeLate(PLAYBACK_LATE_FRAME_BYTES);
        return this.lateUnknown("invalid_media");
      }
      return false;
    }
    if (this.evidence.cutoff) return false;
    if (
      binary[4] !== 3 ||
      (binary.readUInt16LE(18) & PLAYBACK_FORBIDDEN_FLAGS) !== 0 ||
      !(binary.readUInt16LE(18) & 0x4000) ||
      h.frameLength > PLAYBACK_FRAME_BYTES ||
      h.index >= 16384 ||
      h.payloadLength > binary.length - 28
    )
      return this.reject(
        "invalid_media",
        true,
        binary[4] !== 3
          ? "header"
          : (binary.readUInt16LE(18) & PLAYBACK_FORBIDDEN_FLAGS) !== 0 || !(binary.readUInt16LE(18) & 0x4000)
            ? "flags"
            : h.frameLength > PLAYBACK_FRAME_BYTES || h.index >= 16384
              ? "limits"
              : "extent",
      );
    const frameKey = h.channel === 3 ? `${h.channel}:${h.frameId}` : `${h.channel}:${h.frameId}:${h.sequence}`;
    let reservation = this.assemblies.get(frameKey);
    if (!reservation) {
      // The station sets 0x0800 on plain portal frames here too. A first fragment that starts with the
      // portal magic cannot be Zstandard, so it reserves its declared size, not the inflation ceiling.
      const plain = h.index === 0 && h.payloadLength >= 4 && isPortalPacket(binary.subarray(28, 28 + h.payloadLength));
      const allowance = binary.readUInt16LE(18) & 0x0800 && !plain ? PLAYBACK_FRAME_BYTES : h.frameLength;
      if (
        this.reservedOutput + allowance > PLAYBACK_RESERVED_BYTES ||
        this.reservedFrames + this.evidence.wrongRouteFrames >= (this.opts.streaming?.frameLimit ?? 256) ||
        this.evidence.decodedWorkBytes + allowance >
          (this.opts.streaming ? this.opts.streaming.frameLimit * PLAYBACK_FRAME_BYTES : PLAYBACK_WORK_BYTES)
      )
        return this.reject("capped", false, "limits");
      if (this.assemblies.size >= 8) return this.reject("invalid_media", true);
      this.reservedOutput += allowance;
      this.reservedFrames++;
      this.evidence.decodedWorkBytes += allowance;
      reservation = { bytes: allowance };
      this.assemblies.set(frameKey, reservation);
    }
    this.completingId = frameKey;
    if (!this.assembler.push(binary)) {
      this.releaseReservation(frameKey);
      return this.reject("invalid_media", true);
    }
    if (!this.assembler.pending) {
      this.assemblies.clear();
      this.reservedOutput = 0;
    }
    if (this.evidence.firstRejectionReason === "none") {
      this.evidence.compressionState = this.inspection.compressionState ?? this.evidence.compressionState;
      this.evidence.declaredSizeBucket = playbackSizeBucket(this.inspection.declaredSize);
      this.evidence.assembledSizeBucket = playbackSizeBucket(this.inspection.assembledSize);
      this.evidence.outputSizeBucket = playbackSizeBucket(this.inspection.outputSize);
      this.evidence.zstdWindowBucket = playbackSizeBucket(this.inspection.zstdWindow);
    }
    return false;
  }

  /**
   * Uninspectable tombstone traffic, including fragments, requires the durable late latch.
   * Fragment payloads are never retained after quarantine.
   */
  private lateUnknown(reason: "capped" | "invalid_media"): false {
    this.opts.late?.();
    return this.reject(reason, true);
  }

  /**
   * Post-release inspection keeps its 256 KiB ceiling. One-second windows admit 64 MiB
   * and 1,024 complete packets. At 30 fps and the 256 KiB
   * per-frame ceiling, a stream uses at most 7.5 MiB/s; byte headroom exceeds eight streams.
   * Successful inflation charges actual output; failed inflation consumes its full bounded allowance.
   */
  private chargeLate(bytes: number): void {
    this.lateWindow.bytes += bytes;
    this.evidence.decodedWorkBytes = add(this.evidence.decodedWorkBytes, bytes);
  }

  private wrong(frame: Buffer): false {
    this.nonControlTraffic = true;
    this.plausible();
    this.lateFrame(frame);
    this.evidence.rejectedByReason.wrong_route = add(this.evidence.rejectedByReason.wrong_route ?? 0, 1);
    this.evidence.wrongRouteFrames = add(this.evidence.wrongRouteFrames, 1);
    this.evidence.wrongRouteBytes = add(this.evidence.wrongRouteBytes, frame.length);
    this.evidence.mediaBytes = add(this.evidence.mediaBytes, frame.length);
    this.evidence.mediaFrames = add(this.evidence.mediaFrames, 1);
    if (this.evidence.wrongRouteBytes >= PLAYBACK_BYTES || this.evidence.wrongRouteFrames >= 64)
      this.opts.end("capped_wrong_route");
    else this.opts.end("transport_mismatch");
    return false;
  }

  private lateFrame(frame: Buffer, playbackRoute = false): void {
    if (!this.tombstone) return;
    const h = parsePortalHeader(frame);
    const reservedMedia = h && (h.commandId === 1300 || h.commandId === 1301) && this.selectors.has(h.isResponse);
    if (!h || h.paramLength + 16 !== frame.length || frame.length > PLAYBACK_LATE_FRAME_BYTES) {
      if (playbackRoute || reservedMedia) this.lateUnknown("invalid_media");
      return;
    }
    if (reservedMedia) this.opts.late?.();
    else if (playbackRoute && this.selectors.has(h.isResponse)) this.lateUnknown("invalid_media");
  }

  /** Well-formed LIVE media uses a distinct link from playback, independent of live target attribution. */
  decoded(frame: Buffer, link: number): boolean {
    if (link !== PortalLinkType.PLAYBACK && this.currentControlKey) this.controlPartials.delete(this.currentControlKey);
    if (this.capturing) this.opts.frame?.(frame, link);
    if (link === PortalLinkType.FILE && this.opts.file) {
      if (this.capturing) this.opts.file(frame);
      return false;
    }
    if (this.tombstone && link === PortalLinkType.PLAYBACK) {
      this.lateFrame(frame, true);
      return false;
    }
    const h = parsePortalHeader(frame);
    if (!h) return this.reject("invalid_media", true, "portal-header", { link, frame });
    this.countIngress(h.commandId);
    if (this.opts.observeOnly) {
      if (h.paramLength + 16 !== frame.length) {
        return this.reject("invalid_media", true, "extent", { link, frame });
      }
      if (link === PortalLinkType.PLAYBACK) {
        this.poison("playback_link", link, frame);
        this.nonControlTraffic = true;
        this.plausible();
      } else if (h.commandId === 1300 || h.commandId === 1301 || h.commandId === 1303) {
        if (!(
          link === PortalLinkType.LIVE &&
          h.channel === T9000Live.MEDIA_CHANNEL_BASE + T9000Live.PLAY_ID &&
          h.isResponse === 1 &&
          h.paramLength + 16 === frame.length
        )) {
          this.poison(link !== PortalLinkType.LIVE ? "link" : h.channel !== 101 ? "channel" : "selector", link, frame);
          this.nonControlTraffic = true;
          this.plausible();
        }
      } else this.ordinaryFrames = add(this.ordinaryFrames, 1);
      return true;
    }
    if (
      link !== PortalLinkType.PLAYBACK &&
      (h.commandId === 1300 || h.commandId === 1301 || h.commandId === 1303 || this.selectors.has(h.isResponse))
    ) {
      if (
        this.tombstone &&
        this.opts.liveAllowed?.() &&
        link === PortalLinkType.LIVE &&
        h.channel === T9000Live.MEDIA_CHANNEL_BASE + T9000Live.PLAY_ID &&
        h.paramLength + 16 === frame.length &&
        h.isResponse === 1 &&
        !this.selectors.has(1)
      )
        return true;
      return this.wrong(frame);
    }
    return this.opts.control?.(frame, link) ?? true;
  }

  /** Count complete media headers before route, selector and content admission. */
  private countIngress(command: number): void {
    if (command === 1300 || command === 1301 || command === 1303) this.mediaTrafficObserved = true;
    if (command === 1300) this.evidence.ingressVideoFrames = add(this.evidence.ingressVideoFrames, 1);
    if (command === 1301) this.evidence.ingressAudioFrames = add(this.evidence.ingressAudioFrames, 1);
  }

  private complete(frame: Buffer, timing?: { frameId: number; sequence: number }): void {
    this.plausible();
    if (this.tombstone && !this.capturing) {
      this.chargeLate(frame.length);
      this.lateFrame(frame, true);
      return;
    }
    if (!this.capturing || this.evidence.cutoff) return;
    this.opts.frame?.(frame, PortalLinkType.PLAYBACK);
    const h = parsePortalHeader(frame);
    if (h) this.countIngress(h.commandId);
    if (
      !h ||
      h.paramLength + 16 !== frame.length ||
      h.channel !== 101 ||
      !this.selectors.has(h.isResponse) ||
      (h.commandId !== 1300 && h.commandId !== 1301)
    ) {
      this.reject(
        "invalid_media",
        true,
        !h
          ? "portal-header"
          : h.paramLength + 16 !== frame.length
            ? "extent"
            : h.channel !== 101
              ? "channel"
              : !this.selectors.has(h.isResponse)
                ? "selector"
                : "command",
      );
      return;
    }
    if (
      this.evidence.mediaBytes + frame.length > (this.opts.streaming ? 2 * 1024 ** 3 : PLAYBACK_BYTES) ||
      this.evidence.mediaFrames >= (this.opts.streaming?.frameLimit ?? 256) ||
      this.evidence.collectorAttempts >= (this.opts.streaming?.frameLimit ?? 256)
    ) {
      this.reject("capped");
      return;
    }
    this.evidence.mediaBytes += frame.length;
    this.evidence.mediaFrames++;
    this.evidence.collectorAttempts++;
    this.opts.media(frame, timing);
    if (
      this.evidence.mediaBytes >= (this.opts.streaming ? 2 * 1024 ** 3 : PLAYBACK_BYTES) ||
      this.evidence.mediaFrames >= (this.opts.streaming?.frameLimit ?? 256)
    )
      this.opts.end("capped");
  }
}
