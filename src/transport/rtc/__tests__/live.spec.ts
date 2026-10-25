/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveVideoFrame } from "../../../core/contracts.js";
import type { RtcSession } from "../session.js";
import {
  RtcLive,
  T9000Live,
  T9000_KEEPALIVE,
  buildT9000StartLive,
  isHevcKeyframe,
  stripT9000FramePrefix,
} from "../live.js";
import {
  buildPortalHeader,
  parsePortalHeader,
  PORTAL_HEADER_LENGTH,
  PortalLinkType,
  SegmentCounter,
} from "../portal-packet.js";
import { parsePtcsHeader } from "../ptcs-framer.js";

/** A session that records what is sent and lets the test push media frames in. */
class FakeSession extends EventEmitter {
  sent: Buffer[] = [];
  raw: Buffer[] = [];
  open = true;
  sendCommand(pkt: Buffer): boolean {
    if (!this.open) return false;
    this.sent.push(pkt);
    return true;
  }
  sendRaw(b: Buffer): boolean {
    if (!this.open) return false;
    this.raw.push(b);
    return true;
  }
}

const START = Buffer.from([0, 0, 0, 1]);
const vps = Buffer.concat([START, Buffer.from([0x40, 0x01, 0x0c])]);
const idr = Buffer.concat([START, Buffer.from([0x26, 0x01, 0xaf, 0x00])]);
const pslice = Buffer.concat([START, Buffer.from([0x02, 0x01, 0xd0, 0x11])]);
/** A synthetic 1300 media packet with an exactly bounded portal video body. */
const media = (channel: number, annexB: Buffer, key: boolean) => {
  const prefix = Buffer.alloc(22);
  prefix.writeUInt32LE(annexB.length, 0);
  prefix[4] = key ? 1 : 0;
  prefix[5] = 1;
  prefix.writeUInt16LE(1920, 10);
  prefix.writeUInt16LE(1080, 12);
  const body = Buffer.concat([prefix, annexB]);
  return Buffer.concat([buildPortalHeader(T9000Live.MEDIA, body.length, channel, 0, 0), body]);
};
const inner = (pkt: Buffer) => {
  const hd = parsePortalHeader(pkt)!;
  return {
    hd,
    json: JSON.parse(pkt.subarray(PORTAL_HEADER_LENGTH, PORTAL_HEADER_LENGTH + hd.paramLength).toString("utf8")),
  };
};

/** Correlated start acknowledgement for source-observation qualification. */
function acknowledgeStart(session: FakeSession): void {
  const header = parsePortalHeader(session.sent.at(-1)!)!;
  session.emit(
    "commandData",
    Buffer.concat([buildPortalHeader(header.commandId, 4, header.channel, header.segment, 1), Buffer.alloc(4)]),
    PortalLinkType.COMMAND,
  );
}

describe("T9000 live helpers", () => {
  it("builds the start-live frame the portal sends: streamId 1 in the header, chn_list as objects", () => {
    const { hd, json } = inner(buildT9000StartLive({ accountId: "acct", channel: 1, segment: 7 }));
    expect(hd.commandId).toBe(1350);
    expect(hd.channel).toBe(255);
    expect(hd.isResponse).toBe(1);
    expect(hd.segment).toBe(7);
    expect(json.cmd).toBe(1003);
    expect(json.payload).toMatchObject({
      ClientOS: "WEB",
      streamtype: 2,
      stitch_mode: 1,
      station_video_type: 6,
      play_id: 1,
      chn_list: [{ index: 0, chn: 1, sensor: 0, isUps: 0, isClicked: true }],
    });
  });
  it("strips the hub prefix to the first start code and recognises HEVC keyframes", () => {
    expect(stripT9000FramePrefix(Buffer.concat([Buffer.from("c502", "hex"), pslice])).equals(pslice)).toBe(true);
    expect(isHevcKeyframe(Buffer.concat([vps, idr]))).toBe(true);
    expect(isHevcKeyframe(pslice)).toBe(false);
  });
  it("keeps the portal's keepalive byte for byte", () => {
    expect(T9000_KEEPALIVE.length).toBe(36);
    expect(T9000_KEEPALIVE.subarray(20, 24).toString()).toBe("XZYH");
    expect(T9000_KEEPALIVE.readUInt16LE(24)).toBe(T9000Live.KEEPALIVE);
  });
});

describe("RtcLive", () => {
  let s: FakeSession;
  let seg: SegmentCounter;
  let idle: ReturnType<typeof vi.fn<() => void>>;
  let live: RtcLive;
  beforeEach(() => {
    vi.useFakeTimers();
    s = new FakeSession();
    seg = new SegmentCounter();
    idle = vi.fn<() => void>();
    live = new RtcLive({
      session: s as unknown as RtcSession,
      seg,
      stationSn: "T9000X",
      channel: 1,
      accountId: "acct",
      onIdle: idle,
      keepaliveMs: 1000,
    });
  });
  afterEach(() => vi.useRealTimers());

  it("delivers pre-ACK media normally while withholding camera-contact evidence", () => {
    const observe = vi.fn();
    const source = new RtcLive({
      session: s as unknown as RtcSession,
      seg,
      stationSn: "synthetic-station",
      channel: 2,
      accountId: "synthetic",
      onSourceMedia: observe,
    });
    const consumer = source.attach();
    const delivered = vi.fn();
    consumer.onMedia(delivered);
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
    acknowledgeStart(s);
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
    expect(observe).toHaveBeenCalledTimes(1);
    consumer.detach();
  });

  it("observes each decoded source frame once before consumer keyframe and pause filtering", () => {
    const onSourceMedia = vi.fn<() => void>();
    const source = new RtcLive({
      session: s as unknown as RtcSession,
      seg,
      stationSn: "T9000X",
      channel: 1,
      accountId: "acct",
      onSourceMedia,
    });
    const first = source.attach();
    const second = source.attach();
    acknowledgeStart(s);
    const received = vi.fn();
    first.onMedia(received);
    second.onMedia(received);

    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
    expect(onSourceMedia).toHaveBeenCalledTimes(1);
    expect(received).not.toHaveBeenCalled();
    s.emit("mediaData", media(101, Buffer.concat([vps, idr]), true), PortalLinkType.LIVE);
    expect(onSourceMedia).toHaveBeenCalledTimes(2);
    expect(received).toHaveBeenCalledTimes(2);
    first.pause();
    second.pause();
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
    expect(onSourceMedia).toHaveBeenCalledTimes(3);
    expect(received).toHaveBeenCalledTimes(2);
    first.resume();
    second.resume();
    expect(onSourceMedia).toHaveBeenCalledTimes(3);
    first.detach();
    second.detach();
  });

  it.each([
    "wrong link",
    "wrong channel",
    "wrong command",
    "short portal header",
    "invalid portal magic",
    "truncated portal body",
    "short media header",
    "wrong media length",
    "wrong codec",
    "missing Annex B header",
    "short NAL header",
  ])("ignores %s for source media observations", (invalid) => {
    const onSourceMedia = vi.fn<() => void>();
    const source = new RtcLive({
      session: s as unknown as RtcSession,
      seg,
      stationSn: "T9000X",
      channel: 1,
      accountId: "acct",
      onSourceMedia,
    });
    const consumer = source.attach();
    acknowledgeStart(s);
    let packet = media(101, Buffer.concat([vps, idr]), true);
    let link: number = PortalLinkType.LIVE;
    switch (invalid) {
      case "wrong link":
        link = PortalLinkType.PLAYBACK;
        break;
      case "wrong channel":
        packet[12] = 102;
        break;
      case "wrong command":
        packet.writeUInt16LE(T9000Live.KEEPALIVE, 4);
        break;
      case "short portal header":
        packet = packet.subarray(0, PORTAL_HEADER_LENGTH - 1);
        break;
      case "invalid portal magic":
        packet[0] = 0;
        break;
      case "truncated portal body":
        packet = packet.subarray(0, packet.length - 1);
        break;
      case "short media header":
        packet = Buffer.concat([buildPortalHeader(T9000Live.MEDIA, 21, 101, 0), Buffer.alloc(21)]);
        break;
      case "wrong media length":
        packet.writeUInt32LE(1, PORTAL_HEADER_LENGTH);
        break;
      case "wrong codec":
        packet[PORTAL_HEADER_LENGTH + 5] = 0;
        break;
      case "missing Annex B header":
        packet = media(101, Buffer.from([1, 2, 3, 4, 5, 6]), true);
        break;
      case "short NAL header":
        packet = media(101, Buffer.from([0, 0, 0, 1, 0x26]), true);
        break;
    }
    s.emit("mediaData", packet, link);
    expect(onSourceMedia).not.toHaveBeenCalled();
    s.emit("mediaData", media(101, Buffer.concat([vps, idr]), true), PortalLinkType.LIVE);
    expect(onSourceMedia).toHaveBeenCalledTimes(1);
    consumer.detach();
  });

  it("filters media on the play slot (101), not the device channel: a camera on channel 5 still streams", () => {
    const l5 = new RtcLive({
      session: s as unknown as RtcSession,
      seg,
      stationSn: "T9000X",
      channel: 5,
      accountId: "acct",
      onIdle: idle,
      keepaliveMs: 1000,
    });
    const frames: number[] = [];
    const c = l5.attach();
    c.onMedia(({ frame }) => frames.push(frame.data.length));
    s.emit("mediaData", media(105, Buffer.concat([vps, idr]), true), PortalLinkType.LIVE); // device channel: NOT where video comes
    s.emit("mediaData", media(101, Buffer.concat([vps, idr]), true), PortalLinkType.LIVE); // play slot: this is the stream
    expect(frames.length).toBe(1);
    c.detach();
  });

  it("sends only 1003 on the first consumer and 1004 after the last one", () => {
    const c = live.attach();
    expect(live.active).toBe(true);
    const cmds = s.sent.map((p) => {
      const hd = parsePortalHeader(p)!;
      return hd.commandId === 1350 ? inner(p).json.cmd : hd.commandId;
    });
    expect(cmds).toEqual([1003]);
    c.detach();
    expect(live.active).toBe(false);
    expect(inner(s.sent[s.sent.length - 1]!).json.cmd).toBe(1004);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it.each(["false", "throw", "close"])(
    "cleans a synchronous %s start failure before returning a consumer",
    (failure) => {
      const sends: number[] = [];
      s.sendCommand = (packet) => {
        const command = inner(packet).json.cmd as number;
        sends.push(command);
        if (command === 1003) {
          if (failure === "false") return false;
          if (failure === "throw") throw new Error("synthetic start failure");
          s.emit("close");
        }
        return true;
      };
      expect(() => live.attach()).toThrow();
      expect(sends).toEqual([1003, 1004]);
      expect(live.active).toBe(false);
      expect(idle).toHaveBeenCalledTimes(1);
      expect(s.listenerCount("commandData")).toBe(0);
      expect(s.listenerCount("mediaData")).toBe(0);
      expect(s.listenerCount("close")).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(s.raw).toHaveLength(0);
    },
  );

  it("closes consumers without error listeners and releases all resources", () => {
    const first = live.attach();
    const second = live.attach();
    expect(() => s.emit("close")).not.toThrow();
    expect(live.active).toBe(false);
    first.stop();
    second.stop();
    expect(idle).toHaveBeenCalledTimes(1);
    expect(s.sent.map((packet) => inner(packet).json.cmd)).toEqual([1003, 1004]);
    vi.advanceTimersByTime(5000);
    expect(s.raw).toHaveLength(0);
  });

  it("cleans every consumer even when an error handler throws", () => {
    const first = live.attach();
    const second = live.attach();
    first.on("error", () => {
      throw new Error("synthetic listener failure");
    });
    const stopped = vi.fn();
    second.on("stop", stopped);
    expect(() => s.emit("close")).toThrow("synthetic listener failure");
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(live.active).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(s.listenerCount("commandData")).toBe(0);
    expect(s.listenerCount("mediaData")).toBe(0);
    expect(s.listenerCount("close")).toBe(0);
  });

  it("releases the live lease even when the stop send throws", () => {
    const consumer = live.attach();
    s.sendCommand = () => {
      throw new Error("synthetic stop failure");
    };
    expect(() => consumer.stop()).not.toThrow();
    expect(live.active).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(s.listenerCount("close")).toBe(0);
  });

  it("delivers only this camera's 1300 frames, prefix stripped, starting from a keyframe, with the size from the prefix", () => {
    const c = live.attach();
    const got: Array<{ keyframe: boolean; data: Buffer; width: number; height: number }> = [];
    c.on("video", (f) => got.push(f as never));
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE); // P-frame before any keyframe: dropped
    s.emit("mediaData", media(102, Buffer.concat([vps, idr]), true), PortalLinkType.LIVE); // another camera: ignored
    s.emit("mediaData", media(101, Buffer.concat([vps, idr]), true), PortalLinkType.LIVE);
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
    expect(got.map((f) => f.keyframe)).toEqual([true, false]);
    expect(got[0]!.data.equals(Buffer.concat([vps, idr]))).toBe(true);
    expect(got[1]!.data.equals(pslice)).toBe(true);
    expect(got[0]).toMatchObject({ width: 1920, height: 1080 });
    expect(c.awaitingKeyframe).toBe(false);
  });

  it("sends the raw keepalive on its interval, unframed, and stops it with the live", () => {
    const c = live.attach();
    vi.advanceTimersByTime(2500);
    expect(s.raw).toHaveLength(2);
    expect(s.raw[0]!.equals(T9000_KEEPALIVE)).toBe(true);
    expect(parsePtcsHeader(s.raw[0]!)).toBeUndefined(); // not PTCS-framed
    c.detach();
    vi.advanceTimersByTime(5000);
    expect(s.raw).toHaveLength(2);
  });

  it.each(["on", "addListener", "once", "prependListener", "prependOnceListener", "onMedia"] as const)(
    "waits for a live IDR after an asynchronously delayed %s video subscription",
    async (method) => {
      const c = live.attach();
      const got: LiveVideoFrame[] = [];
      const started = vi.fn();
      c.on("start", started);
      s.emit("mediaData", media(101, Buffer.concat([vps, idr]), true), PortalLinkType.LIVE);
      expect(c.primed).toBe(false);
      expect(started).not.toHaveBeenCalled();
      const subscription = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (method === "onMedia") c.onMedia(({ frame }) => got.push(frame));
          else c[method]("video", (frame: LiveVideoFrame) => got.push(frame));
          resolve();
        }, 50);
      });
      s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
      await vi.advanceTimersByTimeAsync(50);
      await subscription;
      expect(got).toEqual([]);
      s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
      expect(got).toEqual([]);
      s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
      expect(got.map((frame) => frame.keyframe)).toEqual([true]);
      expect(got[0]!.data).toEqual(Buffer.concat([vps, idr]));
      expect(started).toHaveBeenCalledTimes(1);
      c.detach();
    },
  );

  it("rearms when the last video listener leaves and a new listener subscribes", () => {
    const c = live.attach();
    const first = vi.fn();
    c.on("video", first);
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    expect(first).toHaveBeenCalledTimes(1);
    c.off("video", first);
    const next = vi.fn();
    c.on("video", next);
    expect(c.primed).toBe(false);
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
    expect(next).not.toHaveBeenCalled();
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    expect(next).toHaveBeenCalledTimes(1);
    c.detach();
  });

  it.each(["on", "addListener", "once", "prependListener", "prependOnceListener", "onMedia"] as const)(
    "preserves the %s video subscription gate after all listeners are removed",
    (method) => {
      const c = live.attach();
      c.on("video", () => {});
      s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
      c.removeAllListeners();
      const got: LiveVideoFrame[] = [];
      if (method === "onMedia") c.onMedia(({ frame }) => got.push(frame));
      else c[method]("video", (frame: LiveVideoFrame) => got.push(frame));
      s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
      expect(got).toEqual([]);
      s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
      expect(got.map((frame) => frame.keyframe)).toEqual([true]);
      c.detach();
    },
  );

  it("keeps independently timed consumers on the shared source without stalling an existing reader", () => {
    const first = live.attach();
    const second = live.attach();
    const early: boolean[] = [];
    const late: boolean[] = [];
    first.onMedia(({ frame }) => early.push(frame.keyframe));
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    second.onMedia(({ frame }) => late.push(frame.keyframe));
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
    expect(early).toEqual([true, false]);
    expect(late).toEqual([]);
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
    expect(late).toEqual([true, false]);
    expect(s.sent.map((packet) => inner(packet).json.cmd)).toEqual([1003]);
    first.detach();
    expect(live.active).toBe(true);
    second.detach();
    expect(s.sent.map((packet) => inner(packet).json.cmd)).toEqual([1003, 1004]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not count audio subscriptions as video subscriptions or gate audio events", () => {
    const c = live.attach();
    const audio = vi.fn();
    const video = vi.fn();
    c.on("audio", audio);
    const frame = { codec: "aac-lc", data: Buffer.from([1, 2]) };
    c.emit("audio", frame);
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    expect(c.primed).toBe(false);
    expect(audio).toHaveBeenCalledExactlyOnceWith(frame);
    c.on("video", video);
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
    c.emit("audio", frame);
    expect(audio).toHaveBeenCalledTimes(2);
    expect(video).not.toHaveBeenCalled();
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    expect(video).toHaveBeenCalledTimes(1);
    c.detach();
  });

  it("keeps the source startup deadline separate from a delayed subscriber's IDR wait", () => {
    const c = live.attach();
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    vi.advanceTimersByTime(T9000Live.FIRST_FRAME_TIMEOUT_MS + 1);
    expect(live.active).toBe(true);
    const frames = vi.fn();
    c.on("video", frames);
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
    expect(frames).not.toHaveBeenCalled();
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    expect(frames).toHaveBeenCalledTimes(1);
    expect(s.sent).toHaveLength(1);
    c.detach();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cannot deliver or restart after detaching before a delayed video subscription", async () => {
    const c = live.attach();
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    c.detach();
    await Promise.resolve();
    const frames = vi.fn();
    c.on("video", frames);
    s.emit("mediaData", media(101, idr, true), PortalLinkType.LIVE);
    vi.advanceTimersByTime(T9000Live.FIRST_FRAME_TIMEOUT_MS + 1);
    expect(frames).not.toHaveBeenCalled();
    expect(live.active).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(s.sent.map((packet) => inner(packet).json.cmd)).toEqual([1003, 1004]);
    expect(s.listenerCount("mediaData")).toBe(0);
    expect(s.listenerCount("commandData")).toBe(0);
    expect(s.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes on the next keyframe after a pause and fails every consumer when the session closes", () => {
    const c = live.attach();
    const got: boolean[] = [];
    const errors: string[] = [];
    c.on("video", (f) => got.push((f as { keyframe: boolean }).keyframe));
    c.on("error", (e: Error) => errors.push(e.message));
    s.emit("mediaData", media(101, Buffer.concat([vps, idr]), true), PortalLinkType.LIVE);
    c.pause();
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE);
    c.resume();
    s.emit("mediaData", media(101, pslice, false), PortalLinkType.LIVE); // after resume: waits for a keyframe
    s.emit("mediaData", media(101, Buffer.concat([vps, idr]), true), PortalLinkType.LIVE);
    expect(got).toEqual([true, true]);
    s.emit("close");
    expect(errors[0]).toMatch(/session closed/);
    expect(live.active).toBe(false);
  });
});
