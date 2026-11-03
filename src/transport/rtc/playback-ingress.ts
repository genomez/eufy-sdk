import { parsePortalHeader, PortalLinkType } from "./portal-packet.js";
import { parsePtcsHeader, PtcsReassembler } from "./ptcs-framer.js";
import { PORTAL_KEEPALIVE } from "./portal-keepalive.js";
import { performance } from "node:perf_hooks";

export const PLAYBACK_BYTES = 2 * 1024 * 1024;
export const PLAYBACK_FRAME_BYTES = 256 * 1024;
export const PLAYBACK_EXPIRY_SWEEP_MS = 250;
const PLAYBACK_PARTIAL_AGE_MS = 2000 - PLAYBACK_EXPIRY_SWEEP_MS;

/** Header-first native admission and post-inflation classification, before downstream parsers. */
export interface RtcIngressGuard {
  native(message: unknown): boolean;
  decoded(frame: Buffer, link: number): boolean;
  stale(): void;
  received?(outcome: "accepted" | "rejected" | "unknown" | void): void;
}

/** Fixed numeric/boolean evidence; packet identities and payloads never enter this ledger. */
export interface PlaybackIngressEvidence {
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
  private reservedOutput = 0;
  private reservedFrames = 0;
  private readonly assemblies = new Map<number, { bytes: number }>();
  private readonly assembler: PtcsReassembler;
  private expiryTimer?: NodeJS.Timeout;
  private selectors = new Set<number>();
  private tombstone = false;
  private completingId = 0;
  private readonly controlPartials = new Map<string, number>();
  private currentControlKey?: string;
  readonly observedSinceMs = performance.now();
  ordinaryFrames = 0;
  keepalives = 0;
  private nonControlTraffic = false;

  /** Resolved ordinary fragments are safe before start; media, unknowns and outstanding work are not. */
  prestartSafe(): boolean {
    return !this.nonControlTraffic && this.evidence.wrongRouteFrames === 0 && this.observationComplete();
  }

  stale(): void {
    this.plausible(true);
    this.opts.end("invalid_media");
  }

  /** Rejected or unclassified baseline work cannot prove the absence of incoming media. */
  received(outcome: "accepted" | "rejected" | "unknown" | void): void {
    if (outcome !== "accepted") this.reject("invalid_media", true);
  }

  constructor(
    private readonly opts: {
      now?: () => number;
      end: (reason: "capped" | "capped_wrong_route" | "transport_mismatch" | "invalid_media") => void;
      media: (frame: Buffer) => void;
      control?: (frame: Buffer, link: number) => boolean;
      late?: () => void;
      observeOnly?: boolean;
      liveAllowed?: () => boolean;
    },
  ) {
    this.assembler = new PtcsReassembler(
      (frame) => {
        this.assemblies.delete(this.completingId);
        this.complete(frame);
      },
      {
        maxFrameBytes: PLAYBACK_FRAME_BYTES,
        maxPendingFrames: 8,
        maxBufferedBytes: 1024 * 1024,
        maxFragmentsPerFrame: 1024,
        maxAgeMs: PLAYBACK_PARTIAL_AGE_MS,
        staleMs: PLAYBACK_PARTIAL_AGE_MS,
        now: () => this.now(),
      },
    );
  }

  private now(): number {
    return this.opts.now?.() ?? performance.now();
  }

  /** Independent invocation sweep: 1,750 ms age plus at most 250 ms scheduling granularity. */
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
      this.reject("invalid_media", true);
      this.finishCapture();
    }
  }

  reserve(start: number, stop: number): void {
    this.selectors = new Set([start, stop]);
  }

  private plausible(unknown = false): void {
    this.lastPlausibleMs = this.now();
    if (unknown) this.evidence.unknown = true;
  }

  private reject(reason: "capped" | "transport_mismatch" | "invalid_media", unknown = false): false {
    this.nonControlTraffic = true;
    this.plausible(unknown);
    this.evidence.rejected = add(this.evidence.rejected, 1);
    this.opts.end(reason);
    return false;
  }

  /** No payload work remains after capture; reservations persist for this owner's lifetime. */
  finishCapture(): void {
    this.capturing = false;
    if (this.assemblies.size) this.plausible(true);
    this.assemblies.clear();
    this.assembler.clear();
  }

  /** Selector-specific isolation after qualified release; unrelated live selector 1 may pass. */
  quarantine(): void {
    this.finishCapture();
    this.tombstone = true;
  }

  /** Incomplete assemblies or expired/rejected traffic cannot manufacture cessation. */
  observationComplete(): boolean {
    const now = this.now();
    this.expire();
    for (const [key, at] of this.controlPartials) {
      if (now - at >= 15000) {
        this.plausible(true);
        this.controlPartials.delete(key);
      }
    }
    return !this.evidence.unknown && this.assemblies.size === 0 && this.controlPartials.size === 0;
  }

  native(message: unknown): boolean {
    this.expire();
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
    if (!binary) return this.reject("invalid_media", true);
    if (this.evidence.nativeBytes >= 4 * 1024 * 1024 || this.evidence.nativeMessages >= 16384) {
      this.evidence.cutoff = true;
      this.opts.end("capped");
    }
    if (binary.equals(PORTAL_KEEPALIVE)) {
      this.keepalives = add(this.keepalives, 1);
      return true;
    }
    const h = parsePtcsHeader(binary);
    if (this.opts.observeOnly && h?.channel === 4) {
      this.nonControlTraffic = true;
      this.plausible();
      return true;
    }
    if (!h) {
      const inner = parsePortalHeader(binary);
      if (inner) {
        if (this.opts.observeOnly) {
          if (inner.commandId === 1300 || inner.commandId === 1301 || inner.commandId === 1303) {
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
      return this.reject("invalid_media", true);
    }
    if (h.channel !== 4) {
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
    if (!this.capturing || this.evidence.cutoff) return false;
    if (
      binary[4] !== 3 ||
      (binary.readUInt16LE(18) & 0xb000) !== 0 ||
      !(binary.readUInt16LE(18) & 0x4000) ||
      h.frameLength > PLAYBACK_FRAME_BYTES ||
      h.index >= 1024 ||
      h.payloadLength > binary.length - 28
    )
      return this.reject("invalid_media", true);
    let reservation = this.assemblies.get(h.frameId);
    if (!reservation) {
      const allowance = binary.readUInt16LE(18) & 0x0800 ? PLAYBACK_FRAME_BYTES : h.frameLength;
      if (
        this.reservedOutput + this.evidence.wrongRouteBytes + allowance > PLAYBACK_BYTES ||
        this.reservedFrames + this.evidence.wrongRouteFrames >= 256 ||
        this.evidence.decodedWorkBytes + allowance > 4 * 1024 * 1024
      )
        return this.reject("capped");
      if (this.assemblies.size >= 8) return this.reject("invalid_media", true);
      this.reservedOutput += allowance;
      this.reservedFrames++;
      this.evidence.decodedWorkBytes += allowance;
      reservation = { bytes: allowance };
      this.assemblies.set(h.frameId, reservation);
    }
    this.completingId = h.frameId;
    if (!this.assembler.push(binary)) {
      this.assemblies.delete(h.frameId);
      return this.reject("invalid_media", true);
    }
    if (!this.assembler.pending) this.assemblies.clear();
    return false;
  }

  private wrong(frame: Buffer): false {
    this.nonControlTraffic = true;
    this.plausible();
    const h = parsePortalHeader(frame);
    if (
      this.tombstone &&
      h &&
      h.paramLength + 16 === frame.length &&
      (h.commandId === 1300 || h.commandId === 1301) &&
      this.selectors.has(h.isResponse)
    )
      this.opts.late?.();
    this.evidence.wrongRouteFrames = add(this.evidence.wrongRouteFrames, 1);
    this.evidence.wrongRouteBytes = add(this.evidence.wrongRouteBytes, frame.length);
    this.evidence.mediaBytes = add(this.evidence.mediaBytes, frame.length);
    this.evidence.mediaFrames = add(this.evidence.mediaFrames, 1);
    if (this.evidence.wrongRouteBytes >= PLAYBACK_BYTES || this.evidence.wrongRouteFrames >= 64)
      this.opts.end("capped_wrong_route");
    else this.opts.end("transport_mismatch");
    return false;
  }

  decoded(frame: Buffer, link: number): boolean {
    if (link !== PortalLinkType.PLAYBACK && this.currentControlKey) this.controlPartials.delete(this.currentControlKey);
    const h = parsePortalHeader(frame);
    if (!h) return this.reject("invalid_media", true);
    if (this.opts.observeOnly) {
      if (h.commandId === 1300 || h.commandId === 1301 || h.commandId === 1303) {
        this.nonControlTraffic = true;
        this.plausible();
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
        h.isResponse === 1 &&
        !this.selectors.has(1)
      )
        return true;
      return this.wrong(frame);
    }
    return this.opts.control?.(frame, link) ?? true;
  }

  private complete(frame: Buffer): void {
    this.plausible();
    if (!this.capturing || this.evidence.cutoff) return;
    const h = parsePortalHeader(frame);
    if (
      !h ||
      h.paramLength + 16 !== frame.length ||
      h.channel !== 101 ||
      !this.selectors.has(h.isResponse) ||
      (h.commandId !== 1300 && h.commandId !== 1301)
    ) {
      this.reject("invalid_media", true);
      return;
    }
    if (
      this.evidence.mediaBytes + frame.length > PLAYBACK_BYTES ||
      this.evidence.mediaFrames >= 256 ||
      this.evidence.collectorAttempts >= 256
    ) {
      this.reject("capped");
      return;
    }
    this.evidence.mediaBytes += frame.length;
    this.evidence.mediaFrames++;
    this.evidence.collectorAttempts++;
    this.opts.media(frame);
    if (this.evidence.mediaBytes >= PLAYBACK_BYTES || this.evidence.mediaFrames >= 256) this.opts.end("capped");
  }
}
