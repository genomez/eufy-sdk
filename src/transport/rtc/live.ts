/** Modified for genomez S1 experimental source preview, 2026-10-14. */
/**
 * Live video from a **HomeBase Professional S1 (T9000)** over the portal control channel.
 *
 * Control/session behavior was observed in portal data-channel traffic on 2026-09-26 and replayed
 * through the SDK. The media-body layout also follows the public portal demuxer:
 *
 *  - The portal opens **hub sessions only** (`channelId 0`, no `subSn`); video rides the station session.
 *  - Start is `1003` inside a `1350` SET_PAYLOAD on the station channel, but two header/body details
 *    decide whether the encoder starts at all: the portal packet header byte the codec calls `isResponse`
 *    carries the portal's **`streamId` = 1** for a live view, and `chn_list` is an **array of objects**
 *    `{index, chn, sensor, isUps, isClicked}` — sent as `[chn]` with `isResponse 0` the hub ACKs and never
 *    encodes (`1366 currentEncLoadRatio: 0`); sent this way it reports `currentEncLoadRatio: 16` within a second.
 *  - The video arrives on the **`idr`** data channel, PTCS channel 5 (LIVE), 800-byte payloads, reassembled
 *    into portal packets `cmd 1300` on the single-camera play slot **101**. Each body is
 *    `[22-byte media header][declared video bytes]` in the public portal demuxer. The header carries
 *    the video length, codec and picture size; start codes within it are not video. This source accepts
 *    exactly bounded HEVC bodies on this framed ingress.
 *  - Every ~29 s the portal sends a raw, unframed 36-byte keepalive (20-byte prefix + bare `XZYH 1139`);
 *    the hub echoes it. It is sent with {@link RtcSession.sendRaw}, not through the PTCS framer.
 *  - **One RTC session per account.** A second session on the same account connects and receives nothing,
 *    not even ACKs — which is why this rides the command router's per-station session instead of its own.
 */
import { EventEmitter } from "node:events";
import type { LiveVideoFrame, LiveStreamConsumer } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import type { RtcSession } from "./session.js";
import { PORTAL_KEEPALIVE, PORTAL_KEEPALIVE_MS } from "./portal-keepalive.js";
import { hasIdr, prefixParamSets, splitAnnexbNals, type ParamSets } from "../p2p/annexb.js";
import {
  buildPortalPacket,
  parsePortalHeader,
  parsePortalPacket,
  PORTAL_HEADER_LENGTH,
  PortalLinkType,
  type SegmentCounter,
} from "./portal-packet.js";
import { PORTAL_CMD_SET_PAYLOAD, PORTAL_STATION_CHANNEL } from "./commands.js";

export const T9000Live = {
  /** Inner `cmd` that starts a live view (portal `lw`/`Ew`). */
  START: 1003,
  /** Inner `cmd` that stops it. */
  STOP: 1004,
  /** Portal packet id the reassembled video frames carry. */
  MEDIA: 1300,
  /** Media packet channel = this + the camera's `device_channel`. */
  MEDIA_CHANNEL_BASE: 100,
  /** The play slot a single-camera live streams on: the hub answers on MEDIA_CHANNEL_BASE + PLAY_ID
   * regardless of the camera's own device channel (verified: a camera on device_channel 5 streams on 101). */
  PLAY_ID: 1,
  /** Portal packet id of the raw keepalive. */
  KEEPALIVE: 1139,
  KEEPALIVE_MS: PORTAL_KEEPALIVE_MS,
  FIRST_FRAME_TIMEOUT_MS: 25_000,
  /** The portal's `streamId` for a live view, carried in the header byte the codec names `isResponse`. */
  STREAM_ID: 1,
} as const;

/** The portal's 36-byte data-channel keepalive, byte for byte (20-byte prefix + bare `XZYH 1139`). */
export const T9000_KEEPALIVE = PORTAL_KEEPALIVE;

/** The start-live frame for ONE camera, exactly as the portal builds it for a single-camera view. */
export function buildT9000StartLive(opts: { accountId: string; channel: number; segment: number }): Buffer {
  return buildPortalPacket({
    commandId: PORTAL_CMD_SET_PAYLOAD,
    channel: PORTAL_STATION_CHANNEL,
    segment: opts.segment,
    isResponse: T9000Live.STREAM_ID,
    payload: {
      account_id: opts.accountId,
      cmd: T9000Live.START,
      payload: {
        ClientOS: "WEB",
        entrytype: 0,
        camera_type: 0,
        key: "",
        msg_id: 116,
        audio_chn: -1,
        streamtype: 2,
        stitch_mode: 1,
        chn_list: [{ index: 0, chn: opts.channel, sensor: 0, isUps: 0, isClicked: true }],
        pip_cord: { x1: 0, y1: 0, x2: 0, y2: 0 },
        station_video_type: 6,
        play_id: 1,
      },
    },
  });
}

export function buildT9000StopLive(opts: { accountId: string; segment: number }): Buffer {
  return buildPortalPacket({
    commandId: PORTAL_CMD_SET_PAYLOAD,
    channel: PORTAL_STATION_CHANNEL,
    segment: opts.segment,
    isResponse: T9000Live.STREAM_ID,
    payload: { account_id: opts.accountId, cmd: T9000Live.STOP, payload: {} },
  });
}

const ANNEX_B_START = Buffer.from([0, 0, 0, 1]);
const ANNEX_B_SHORT_START = Buffer.from([0, 0, 1]);

/** Locate the hub's four-byte payload prefix or a prefix-free three-byte access unit. */
function frameStart(body: Buffer): number {
  return body.subarray(0, 3).equals(ANNEX_B_SHORT_START) ? 0 : body.indexOf(ANNEX_B_START);
}

/** The Annex B payload of a `1300` body: everything from the first start code (the hub prefix dropped). */
export function stripT9000FramePrefix(body: Buffer): Buffer {
  const at = frameStart(body);
  return at > 0 ? body.subarray(at) : body;
}

/** A prefix-free Annex B unit with at least the two-byte HEVC NAL header. */
function startsAnnexB(data: Buffer): boolean {
  if (data.subarray(0, 4).equals(ANNEX_B_START)) return data.length >= 6;
  return data.subarray(0, 3).equals(ANNEX_B_SHORT_START) && data.length >= 5;
}

/**
 * An exactly bounded portal video body. This command-1300 ingress is framed: video starts at byte 22,
 * the declared extent must exhaust the body and stream type 1 denotes HEVC. A leading Annex B code
 * does not bypass framing validation; prefix-free input is outside this ingress contract.
 */
function parseT9000VideoBody(body: Buffer): { data: Buffer; width: number; height: number } | undefined {
  if (body.length < 22 || body.readUInt32LE(0) !== body.length - 22 || body[5] !== 1) return undefined;
  const data = body.subarray(22);
  if (!startsAnnexB(data)) return undefined;
  return { data, width: body.readUInt16LE(10), height: body.readUInt16LE(12) };
}

/** True when the Annex-B access unit carries an HEVC IDR slice. */
export function isHevcKeyframe(annexB: Buffer): boolean {
  return hasIdr(annexB, "h265");
}

/**
 * One consumer of a {@link RtcLive}: the shape `openReadableFromConsumer` and `MediaProvider.live` want.
 * Frames are HEVC Annex B; a consumer starts on the first keyframe and, after a pause, resumes on the next.
 */
export class RtcLiveConsumer extends EventEmitter implements LiveStreamConsumer {
  awaitingKeyframe = true;
  private paused = false;
  private detached = false;

  constructor(private readonly owner: RtcLive) {
    super();
  }

  get primed(): boolean {
    return !this.awaitingKeyframe;
  }

  start(): this {
    return this;
  }

  stop(): void {
    this.detach();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.awaitingKeyframe = true; // pick up cleanly on the next keyframe
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.owner.release(this);
    this.emit("stop");
  }

  onMedia(listener: (item: { kind: "video"; frame: LiveVideoFrame }) => void): this {
    this.on("video", (frame: LiveVideoFrame) => listener({ kind: "video", frame }));
    return this;
  }

  /** @internal */
  deliver(frame: LiveVideoFrame): void {
    if (this.detached || this.paused) return;
    if (this.awaitingKeyframe) {
      if (!frame.keyframe) return;
      this.awaitingKeyframe = false;
      this.emit("start");
    }
    this.emit("video", frame);
  }

  /** @internal */
  fail(err: Error): void {
    if (this.detached) return;
    try {
      if (this.listenerCount("error") > 0) this.emit("error", err);
    } finally {
      this.detach();
    }
  }
}

export interface RtcLiveOptions {
  session: RtcSession;
  /** The session's segment counter — shared with the command router so segments never collide. */
  seg: SegmentCounter;
  stationSn: string;
  /** The camera's `device_channel` on the station. */
  channel: number;
  /** The member id commands attribute themselves to. */
  accountId: string;
  /** Called when the last consumer leaves and the live has been stopped. */
  onIdle?: () => void;
  logger?: Logger;
  keepaliveMs?: number;
}

/**
 * The live view of ONE camera on a T9000: started on the first consumer, stopped after the last one, one
 * per station play slot. Frames are emitted as {@link LiveVideoFrame}s (`codec: "h265"`, Annex B).
 */
export class RtcLive {
  private readonly consumers = new Set<RtcLiveConsumer>();
  private started = false;
  private keepalive?: ReturnType<typeof setInterval>;
  private firstFrame?: ReturnType<typeof setTimeout>;
  private parameterSets: ParamSets = { codec: "h265", vps: [], sps: [], pps: [] };
  private readonly onMedia = (frame: Buffer, linkType: number) => this.onMediaFrame(frame, linkType);
  private readonly onCmd = (frame: Buffer, linkType: number) => this.onCommandFrame(frame, linkType);
  private startSegment = -1;
  private startAcked = false;
  private strayLogged = 0;
  private width = 0;
  private height = 0;
  private readonly onClose = () =>
    this.fail(new Error(`rtc live ${this.opts.stationSn}#${this.opts.channel}: session closed`));

  constructor(private readonly opts: RtcLiveOptions) {}

  get mediaChannel(): number {
    // The hub streams a single-camera live on the play slot (100 + PLAY_ID), NOT on 100 + the camera's
    // device channel — those coincide only for a camera on device_channel 1.
    return T9000Live.MEDIA_CHANNEL_BASE + T9000Live.PLAY_ID;
  }

  get active(): boolean {
    return this.started;
  }

  /** End all consumers and dispose the shared source before its session is closed. */
  close(reason = new Error("RTC live source closed")): void {
    this.fail(reason);
  }

  attach(): RtcLiveConsumer {
    const c = new RtcLiveConsumer(this);
    this.consumers.add(c);
    try {
      if (!this.started) this.start();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("RTC live start failed"));
      throw error;
    }
    return c;
  }

  /** @internal */
  release(c: RtcLiveConsumer): void {
    if (!this.consumers.delete(c)) return;
    if (this.consumers.size === 0) this.stop();
  }

  private start(): void {
    const { session, seg, accountId, logger } = this.opts;
    this.started = true;
    session.on("mediaData", this.onMedia);
    session.on("commandData", this.onCmd);
    session.on("close", this.onClose);
    this.startSegment = seg.next();
    this.startAcked = false;
    this.strayLogged = 0;
    this.parameterSets = { codec: "h265", vps: [], sps: [], pps: [] };
    this.firstFrame = setTimeout(() => {
      this.fail(new Error(`rtc live ${this.opts.stationSn}#${this.opts.channel}: first IDR frame timed out`));
    }, T9000Live.FIRST_FRAME_TIMEOUT_MS);
    this.firstFrame.unref?.();
    const sent = session.sendCommand(
      buildT9000StartLive({ accountId, channel: this.opts.channel, segment: this.startSegment }),
    );
    logger?.info?.(`[rtc] ${this.opts.stationSn}#${this.opts.channel} live start sent=${sent}`);
    if (!sent) throw new Error(`rtc live ${this.opts.stationSn}#${this.opts.channel}: command channel not open`);
    if (!this.started) throw new Error("RTC live session closed during start");
    this.keepalive = setInterval(() => {
      if (!session.sendRaw(T9000_KEEPALIVE)) logger?.warn?.(`[rtc] ${this.opts.stationSn} keepalive not sent`);
    }, this.opts.keepaliveMs ?? T9000Live.KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  private stop(): void {
    if (!this.started) return;
    this.started = false;
    const { session, seg, accountId, logger } = this.opts;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
    if (this.firstFrame) clearTimeout(this.firstFrame);
    this.firstFrame = undefined;
    this.parameterSets = { codec: "h265", vps: [], sps: [], pps: [] };
    session.off("mediaData", this.onMedia);
    session.off("commandData", this.onCmd);
    session.off("close", this.onClose);
    try {
      session.sendCommand(buildT9000StopLive({ accountId, segment: seg.next() }));
    } catch {
      /* the session may already be gone */
    }
    try {
      logger?.info?.(`[rtc] ${this.opts.stationSn}#${this.opts.channel} live stopped`);
    } finally {
      this.opts.onIdle?.();
    }
  }

  private fail(err: Error): void {
    let failure: unknown;
    try {
      for (const c of [...this.consumers]) {
        try {
          c.fail(err);
        } catch (error) {
          failure ??= error;
        }
      }
    } finally {
      this.stop();
    }
    if (failure !== undefined) throw failure;
  }

  /** What the hub says back while a live is up: the start's ACK (with its error code) and the encoder notifies. */
  private onCommandFrame(frame: Buffer, linkType: number): void {
    const header = parsePortalHeader(frame);
    if (!header || header.paramLength > frame.length - PORTAL_HEADER_LENGTH) return;
    const p = parsePortalPacket(frame, linkType);
    if (!p) return;
    const tag = `[rtc] ${this.opts.stationSn}#${this.opts.channel}`;
    if (
      linkType === PortalLinkType.COMMAND &&
      p.isResponse === 1 &&
      p.commandId === PORTAL_CMD_SET_PAYLOAD &&
      p.channel === PORTAL_STATION_CHANNEL &&
      p.segment === this.startSegment &&
      frame.length >= PORTAL_HEADER_LENGTH + 4 &&
      header.paramLength >= 4
    ) {
      if (this.startAcked || !this.firstFrame) return;
      this.startAcked = true;
      this.opts.logger?.info?.(`${tag} live start acked err=${p.errCode ?? 0}`);
      if (p.errCode !== 0) this.fail(new Error(`${tag} live start rejected: ${p.errCode}`));
      return;
    }
    const inner = (p.data ?? {}) as { cmd?: number; payload?: unknown };
    if (inner.cmd === 1366 || inner.cmd === 6246) {
      this.opts.logger?.info?.(`${tag} hub notify ${inner.cmd} ${JSON.stringify(inner.payload ?? "").slice(0, 160)}`);
    }
  }

  private onMediaFrame(frame: Buffer, linkType: number): void {
    if (linkType !== PortalLinkType.LIVE) return;
    const h = parsePortalHeader(frame);
    if (!h) return;
    if (h.commandId !== T9000Live.MEDIA || h.channel !== this.mediaChannel) {
      if (this.strayLogged < 3) {
        this.strayLogged++;
        this.opts.logger?.info?.(
          `[rtc] ${this.opts.stationSn}#${this.opts.channel} media frame on cmd ${h.commandId} channel ${h.channel} (expected ${T9000Live.MEDIA} on ${this.mediaChannel}), ${h.paramLength}B`,
        );
      }
      return;
    }
    if (h.paramLength > frame.length - PORTAL_HEADER_LENGTH) return;
    const body = frame.subarray(PORTAL_HEADER_LENGTH, PORTAL_HEADER_LENGTH + h.paramLength);
    const video = parseT9000VideoBody(body);
    if (!video) return;
    if (video.width > 0 && video.height > 0) {
      this.width = video.width;
      this.height = video.height;
    }
    const data = video.data;
    const sets = this.retainParameterSets(data);
    if (!sets) return;
    const keyframe = isHevcKeyframe(data);
    if (keyframe && this.firstFrame) {
      clearTimeout(this.firstFrame);
      this.firstFrame = undefined;
    }
    const out: LiveVideoFrame = {
      codec: "h265",
      data,
      keyframe,
      width: this.width,
      height: this.height,
    };
    for (const c of this.consumers)
      c.deliver(c.awaitingKeyframe && keyframe ? { ...out, data: prefixParamSets(data, sets) } : out);
  }

  /** Retain bounded parameter sets and answer only sets missing from the current access unit. */
  private retainParameterSets(data: Buffer): ParamSets | undefined {
    const nals = splitAnnexbNals(data);
    const supplied = {
      vps: nals.filter((n) => n.length >= 2 && ((n[0]! >> 1) & 63) === 32),
      sps: nals.filter((n) => n.length >= 2 && ((n[0]! >> 1) & 63) === 33),
      pps: nals.filter((n) => n.length >= 2 && ((n[0]! >> 1) & 63) === 34),
    };
    const next: ParamSets = {
      codec: "h265",
      vps: supplied.vps.length ? supplied.vps : this.parameterSets.vps,
      sps: supplied.sps.length ? supplied.sps : this.parameterSets.sps,
      pps: supplied.pps.length ? supplied.pps : this.parameterSets.pps,
    };
    const all = [...next.vps, ...next.sps, ...next.pps];
    if (all.length > 48 || all.reduce((size, nal) => size + nal.length, 0) > 65536) {
      this.fail(new Error("RTC live parameter sets exceed retention limit"));
      return undefined;
    }
    this.parameterSets = {
      codec: "h265",
      vps: supplied.vps.length ? next.vps.map((nal) => Buffer.from(nal)) : next.vps,
      sps: supplied.sps.length ? next.sps.map((nal) => Buffer.from(nal)) : next.sps,
      pps: supplied.pps.length ? next.pps.map((nal) => Buffer.from(nal)) : next.pps,
    };
    return {
      codec: "h265",
      vps: supplied.vps.length ? [] : next.vps,
      sps: supplied.sps.length ? [] : next.sps,
      pps: supplied.pps.length ? [] : next.pps,
    };
  }
}
