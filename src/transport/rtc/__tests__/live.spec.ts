/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
