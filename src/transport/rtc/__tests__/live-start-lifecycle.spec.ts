import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveVideoFrame } from "../../../core/contracts.js";
import { RtcLive, T9000Live } from "../live.js";
import type { RtcSession } from "../session.js";
import { buildPortalHeader, parsePortalHeader, PortalLinkType, SegmentCounter } from "../portal-packet.js";

const unit = (type: number, three = false) => Buffer.from([...(three ? [0, 0, 1] : [0, 0, 0, 1]), type << 1, 1, 0]);
const media = (bytes: Buffer, channel = 101) => {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(bytes.length, 0);
  header[5] = 1;
  const body = Buffer.concat([header, bytes]);
  return Buffer.concat([buildPortalHeader(T9000Live.MEDIA, body.length, channel, 0, 0), body]);
};
function fixture() {
  const sent: Buffer[] = [];
  const session = Object.assign(new EventEmitter(), {
    sendCommand: vi.fn((packet: Buffer) => {
      sent.push(packet);
      return true;
    }),
    sendRaw: vi.fn(() => true),
  });
  const idle = vi.fn();
  const live = new RtcLive({
    session: session as unknown as RtcSession,
    stationSn: "station",
    channel: 2,
    seg: new SegmentCounter(),
    accountId: "account",
    onIdle: idle,
    keepaliveMs: 1000,
  });
  const ack = (
    code: number,
    overrides: Partial<{
      command: number;
      channel: number;
      segment: number;
      response: number;
      link: number;
      length: number;
    }> = {},
  ) => {
    const request = parsePortalHeader(sent[0]!)!;
    const body = Buffer.alloc(4);
    body.writeInt32LE(code);
    session.emit(
      "commandData",
      Buffer.concat([
        buildPortalHeader(
          overrides.command ?? request.commandId,
          overrides.length ?? 4,
          overrides.channel ?? request.channel,
          overrides.segment ?? request.segment,
          overrides.response ?? 1,
        ),
        body,
      ]),
      overrides.link ?? PortalLinkType.COMMAND,
    );
  };
  return { session, sent, idle, live, ack };
}
describe("RTC live startup ownership", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("preserves a three-byte IDR before a later four-byte unit", () => {
    const f = fixture(),
      c = f.live.attach(),
      frames: LiveVideoFrame[] = [];
    c.onMedia(({ frame }) => frames.push(frame));
    const bytes = Buffer.concat([unit(19, true), unit(1)]);
    f.session.emit("mediaData", media(bytes), PortalLinkType.LIVE);
    expect(frames[0]!.data.equals(bytes)).toBe(true);
    expect(frames[0]!.keyframe).toBe(true);
    c.detach();
  });
  it("ignores duplicate ACKs and late rejections after the first IDR", () => {
    const f = fixture();
    const c = f.live.attach();
    c.on("error", () => {});
    f.ack(0);
    f.ack(-108);
    expect(f.live.active).toBe(true);
    f.session.emit("mediaData", media(unit(19)), PortalLinkType.LIVE);
    f.ack(-108);
    expect(f.live.active).toBe(true);
    c.detach();
  });
  it("fails all readers on a correlated rejected start and clears timers/listeners", () => {
    const f = fixture();
    const first = f.live.attach();
    const second = f.live.attach();
    const errors: Error[] = [];
    first.on("error", (e) => errors.push(e));
    second.on("error", (e) => errors.push(e));
    f.ack(-108);
    expect(f.live.active).toBe(false);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.message).toContain("-108");
    expect(f.idle).toHaveBeenCalledTimes(1);
    expect(f.session.listenerCount("commandData")).toBe(0);
    expect(f.session.listenerCount("mediaData")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { command: 1700 },
    { channel: 2 },
    { segment: 90 },
    { response: 0 },
    { link: PortalLinkType.NOTIFY },
    { length: 40 },
  ])("ignores a rejection that does not correlate to this start: %j", (overrides) => {
    const f = fixture();
    const c = f.live.attach();
    const error = vi.fn();
    c.on("error", error);
    f.ack(-108, overrides);
    expect(error).not.toHaveBeenCalled();
    expect(f.live.active).toBe(true);
    c.detach();
  });
  it("a successful ACK without a decodable first frame expires the original deadline", () => {
    const f = fixture();
    const first = f.live.attach();
    const errors: Error[] = [];
    first.on("error", (e) => errors.push(e));
    f.ack(0);
    vi.advanceTimersByTime(14000);
    const second = f.live.attach();
    second.on("error", (e) => errors.push(e));
    vi.advanceTimersByTime(1000);
    expect(f.live.active).toBe(false);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.message).toMatch(/first.*frame|keyframe/i);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("VPS and CRA alone neither prime consumers nor cancel the startup deadline", () => {
    const f = fixture();
    const c = f.live.attach();
    const frames: LiveVideoFrame[] = [];
    c.onMedia(({ frame }) => frames.push(frame));
    c.on("error", () => {});
    f.session.emit("mediaData", media(unit(32)), PortalLinkType.LIVE);
    f.session.emit("mediaData", media(unit(21)), PortalLinkType.LIVE);
    expect(frames).toHaveLength(0);
    expect(c.primed).toBe(false);
    vi.advanceTimersByTime(15000);
    expect(f.live.active).toBe(false);
  });
  it.each([false, true])(
    "an IDR with three-byte start code=%s emits typed h265 and survives the startup deadline",
    (three) => {
      const f = fixture();
      const c = f.live.attach();
      const frames: LiveVideoFrame[] = [];
      c.onMedia(({ frame }) => frames.push(frame));
      f.session.emit("mediaData", media(unit(19, three)), PortalLinkType.LIVE);
      expect(frames[0]).toMatchObject({ codec: "h265", keyframe: true });
      vi.advanceTimersByTime(15000);
      expect(f.live.active).toBe(true);
      expect(f.session.sendRaw).toHaveBeenCalled();
      c.detach();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("ignores a truncated IDR packet rather than accepting a partial first frame", () => {
    const f = fixture();
    const c = f.live.attach();
    const frames: LiveVideoFrame[] = [];
    c.onMedia(({ frame }) => frames.push(frame));
    c.on("error", () => {});
    const full = media(unit(19));
    f.session.emit("mediaData", full.subarray(0, full.length - 1), PortalLinkType.LIVE);
    expect(frames).toHaveLength(0);
    vi.advanceTimersByTime(15000);
    expect(f.live.active).toBe(false);
  });
  it("detaching one reader preserves its sibling and detaching the last clears every timer", () => {
    const f = fixture();
    const first = f.live.attach();
    const second = f.live.attach();
    first.detach();
    expect(f.live.active).toBe(true);
    second.detach();
    expect(f.live.active).toBe(false);
    expect(f.idle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains separate parameter sets for the first IDR and a late reader", () => {
    const f = fixture();
    const first = f.live.attach();
    const frames: LiveVideoFrame[] = [];
    first.onMedia(({ frame }) => frames.push(frame));
    for (const type of [32, 33, 34]) f.session.emit("mediaData", media(unit(type)), PortalLinkType.LIVE);
    f.session.emit("mediaData", media(unit(19)), PortalLinkType.LIVE);
    expect(frames[0]!.data.equals(Buffer.concat([unit(32), unit(33), unit(34), unit(19)]))).toBe(true);
    const second = f.live.attach();
    const late: LiveVideoFrame[] = [];
    second.onMedia(({ frame }) => late.push(frame));
    f.session.emit("mediaData", media(unit(20)), PortalLinkType.LIVE);
    expect(late[0]!.data.equals(Buffer.concat([unit(32), unit(33), unit(34), unit(20)]))).toBe(true);
    expect(frames[1]!.data.equals(unit(20))).toBe(true);
    first.detach();
    second.detach();
  });
  it("retains parameter bytes independently of a large inbound packet", () => {
    const f = fixture();
    const first = f.live.attach();
    const packet = media(Buffer.concat([unit(32), unit(1), Buffer.alloc(1024 * 1024, 8)]));
    f.session.emit("mediaData", packet, PortalLinkType.LIVE);
    packet.fill(9);
    const second = f.live.attach();
    const frames: LiveVideoFrame[] = [];
    second.onMedia(({ frame }) => frames.push(frame));
    f.session.emit("mediaData", media(unit(19)), PortalLinkType.LIVE);
    expect(frames[0]!.data.equals(Buffer.concat([unit(32), unit(19)]))).toBe(true);
    first.detach();
    second.detach();
  });
  it("enforces bounded parameter retention and releases a malformed source", () => {
    const f = fixture();
    const c = f.live.attach();
    c.on("error", () => {});
    f.session.emit("mediaData", media(Buffer.concat([unit(33), Buffer.alloc(65536, 8)])), PortalLinkType.LIVE);
    expect(f.live.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
