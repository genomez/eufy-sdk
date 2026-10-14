import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveVideoFrame } from "../../../core/contracts.js";
import { isHevcKeyframe, RtcLive, stripT9000FramePrefix, T9000Live } from "../live.js";
import { buildPortalHeader, PortalLinkType, SegmentCounter } from "../portal-packet.js";
import type { RtcSession } from "../session.js";

class FakeSession extends EventEmitter {
  sent: Buffer[] = [];
  raw: Buffer[] = [];
  sendCommand(packet: Buffer): boolean {
    this.sent.push(packet);
    return true;
  }
  sendRaw(packet: Buffer): boolean {
    this.raw.push(packet);
    return true;
  }
}

const LONG = Buffer.from([0, 0, 0, 1]);
const SHORT = Buffer.from([0, 0, 1]);
/** Structural synthetic NAL units, not decoder-qualified bitstreams. */
const nal = (type: number, bytes = 8, start = LONG): Buffer =>
  Buffer.concat([start, Buffer.from([type << 1, 1]), Buffer.alloc(bytes - 2, 0xab)]);
const idr = nal(19);
const delta = nal(1);
const vps = nal(32);
const sps = nal(33);
const pps = nal(34);
const config = Buffer.concat([vps, sps, pps]);

interface BodyOptions {
  declared?: number;
  frameType?: number;
  streamType?: number;
  counter?: number;
  width?: number;
  height?: number;
}
function body(video: Buffer, options: BodyOptions = {}): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(options.declared ?? video.length, 0);
  header[4] = options.frameType ?? 0;
  header[5] = options.streamType ?? 1;
  header.writeUInt16LE(options.counter ?? 0x0167, 6);
  header[8] = 20;
  header.writeUInt16LE(options.width ?? 1920, 10);
  header.writeUInt16LE(options.height ?? 1080, 12);
  header.writeBigUInt64LE(123456789n, 14);
  return Buffer.concat([header, video]);
}
function packet(payload: Buffer, options: { length?: number; channel?: number; command?: number } = {}): Buffer {
  return Buffer.concat([
    buildPortalHeader(
      options.command ?? T9000Live.MEDIA,
      options.length ?? payload.length,
      options.channel ?? 101,
      0,
      0,
    ),
    payload,
  ]);
}

describe("RtcLive canonical media bodies", () => {
  let session: FakeSession;
  let live: RtcLive;
  let frames: LiveVideoFrame[];
  let idle: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new FakeSession();
    idle = vi.fn<() => void>();
    live = new RtcLive({
      session: session as unknown as RtcSession,
      seg: new SegmentCounter(),
      stationSn: "synthetic-station",
      accountId: "synthetic-account",
      channel: 5,
      onIdle: idle,
      keepaliveMs: 1000,
    });
    frames = [];
    live.attach().onMedia(({ frame }) => frames.push(frame));
  });
  afterEach(() => {
    live.close();
    vi.useRealTimers();
  });

  function emit(payload: Buffer, options: Parameters<typeof packet>[1] = {}, link: number = PortalLinkType.LIVE): void {
    session.emit("mediaData", packet(payload, options), link);
  }
  function prime(): void {
    emit(body(idr, { frameType: 1, width: 640, height: 480 }));
    frames.length = 0;
  }

  it("extracts a small keyframe at byte 22 even when the length and flags resemble a start code", () => {
    emit(body(idr, { frameType: 1 }));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ codec: "h265", keyframe: true, width: 1920, height: 1080 });
    expect(frames[0]!.data.equals(idr)).toBe(true);
  });

  it.each([0x0167, 0x0140, 0xffff, 0])("excludes counter %i from delta data and retained parameter sets", (counter) => {
    prime();
    emit(body(delta, { counter }));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data.equals(delta)).toBe(true);
    const late: LiveVideoFrame[] = [];
    live.attach().onMedia(({ frame }) => late.push(frame));
    emit(body(idr, { frameType: 1 }));
    expect(late).toHaveLength(1);
    expect(late[0]!.data.equals(idr)).toBe(true);
  });

  it("extracts a framed length of 65536 even when the length bytes resemble Annex B", () => {
    const video = nal(19, 65532);
    expect(video.length).toBe(65536);
    emit(body(video));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data.equals(video)).toBe(true);
  });

  it("drops a malformed length collision without canceling the first IDR deadline", () => {
    const ambiguous = body(nal(19, 65531), { declared: 65536 });
    emit(ambiguous);
    expect(frames).toHaveLength(0);
    vi.advanceTimersByTime(T9000Live.FIRST_FRAME_TIMEOUT_MS - 1);
    expect(live.active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(live.active).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  /** RTC command 1300 defines a framed body, regardless of start-code-looking header bytes. */
  it("interprets matching length and codec fields as framing under the RTC ingress contract", () => {
    const framed = nal(0, 65555, SHORT);
    framed[5] = 1;
    idr.copy(framed, 22);
    expect(framed.length).toBe(65558);
    expect(framed.readUInt32LE(0)).toBe(framed.length - 22);
    emit(framed);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data.equals(framed.subarray(22))).toBe(true);
    expect(frames[0]!.data.equals(framed)).toBe(false);
  });

  it("updates dimensions on delta frames, without requiring the header's keyframe flag", () => {
    prime();
    emit(body(delta, { width: 1280, height: 720 }));
    expect(frames[0]).toMatchObject({ width: 1280, height: 720, keyframe: false });
  });

  it.each([
    { width: 0, height: 0 },
    { width: 0, height: 720 },
    { width: 1280, height: 0 },
  ])("retains both prior dimensions when a new pair contains zero: %j", (dimensions) => {
    prime();
    emit(body(delta, dimensions));
    expect(frames[0]).toMatchObject({ width: 640, height: 480 });
  });

  it.each([
    ["zero video", () => body(Buffer.alloc(0))],
    ["inner overrun", () => body(idr, { declared: idr.length + 1 })],
    ["inner underrun", () => body(idr, { declared: idr.length - 1 })],
    ["trailing inner bytes", () => Buffer.concat([body(idr), Buffer.from([0xab])])],
    ["truncated header", () => body(idr).subarray(0, 21)],
    ["non Annex B video", () => body(Buffer.alloc(12, 0xab))],
    ["opaque prefix", () => Buffer.concat([Buffer.alloc(22, 0xab), idr])],
    [
      "historical truncated canonical fixture",
      () => Buffer.concat([Buffer.from("96850000010101000000800738040000000000000000", "hex"), idr]),
    ],
    ["two byte prefix", () => Buffer.concat([Buffer.from([0xc5, 2]), idr])],
  ] as const)("drops %s without priming a consumer", (_label, makeBody) => {
    emit(makeBody());
    expect(frames).toHaveLength(0);
    vi.advanceTimersByTime(T9000Live.FIRST_FRAME_TIMEOUT_MS);
    expect(live.active).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it.each([0, 2, 255])("refuses canonical stream type %i instead of labeling it HEVC", (streamType) => {
    emit(body(idr, { streamType }));
    expect(frames).toHaveLength(0);
  });

  it("refuses a canonical AVC IDR instead of labeling its bytes HEVC", () => {
    emit(body(Buffer.concat([LONG, Buffer.from([0x65, 0xab, 0xab])]), { streamType: 0, frameType: 1 }));
    expect(frames).toHaveLength(0);
  });

  it.each([LONG, SHORT, Buffer.concat([LONG, Buffer.from([0x26])]), Buffer.concat([SHORT, Buffer.from([0x26])])])(
    "refuses a raw start code with fewer than two NAL header bytes: %j",
    (video) => {
      emit(video);
      expect(frames).toHaveLength(0);
    },
  );

  it.each([
    ["outer overrun", { length: 22 + idr.length + 1 }],
    ["outer underrun", { length: 22 + idr.length - 1 }],
    ["wrong channel", { channel: 105 }],
    ["wrong command", { command: 1301 }],
  ] as const)("ignores %s", (_label, options) => {
    emit(body(idr), options);
    expect(frames).toHaveLength(0);
  });

  it("ignores invalid magic and a valid packet arriving on the command link", () => {
    const invalid = packet(body(idr));
    invalid[0] ^= 0xff;
    session.emit("mediaData", invalid, PortalLinkType.LIVE);
    emit(body(idr), {}, PortalLinkType.COMMAND);
    expect(frames).toHaveLength(0);
  });

  it("bounds extraction by outer length while ignoring bytes outside the portal packet", () => {
    const payload = body(idr);
    emit(Buffer.concat([payload, Buffer.from([0xab])]), { length: payload.length });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data.equals(idr)).toBe(true);
  });

  it.each([
    ["four byte start", idr],
    ["three byte start", nal(19, 8, SHORT)],
    ["mixed start codes", Buffer.concat([nal(19, 8, SHORT), delta])],
    ["real sixteen byte filler NAL", Buffer.concat([nal(38, 16), idr])],
    ["real sixteen byte VPS NAL", Buffer.concat([nal(32, 16), idr])],
  ] as const)("refuses unframed RTC bodies with %s", (_label, video) => {
    emit(video);
    expect(frames).toHaveLength(0);
    vi.advanceTimersByTime(T9000Live.FIRST_FRAME_TIMEOUT_MS);
    expect(live.active).toBe(false);
  });

  it.each([
    ["four byte start", idr],
    ["three byte start", nal(19, 8, SHORT)],
    ["mixed start codes", Buffer.concat([nal(19, 8, SHORT), delta])],
    ["real sixteen byte filler NAL", Buffer.concat([nal(38, 16), idr])],
    ["real sixteen byte VPS NAL", Buffer.concat([nal(32, 16), idr])],
  ] as const)("preserves framed Annex B payload with %s byte for byte", (_label, video) => {
    emit(body(video));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data.equals(video)).toBe(true);
  });

  it("keeps the first IDR deadline after malformed data and a keyframe flag without an IDR", () => {
    const errors: string[] = [];
    live.attach().on("error", (error: Error) => errors.push(error.message));
    vi.advanceTimersByTime(10000);
    emit(body(idr, { declared: idr.length + 1, frameType: 1 }));
    emit(body(delta, { frameType: 1 }));
    expect(frames).toHaveLength(0);
    vi.advanceTimersByTime(4999);
    expect(live.active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/first IDR frame timed out/);
    expect(live.active).toBe(false);
    expect(session.listenerCount("mediaData")).toBe(0);
    expect(session.listenerCount("commandData")).toBe(0);
    expect(session.listenerCount("close")).toBe(0);
    const sends = session.raw.length;
    vi.advanceTimersByTime(5000);
    expect(session.raw).toHaveLength(sends);
  });

  it("cancels the first IDR deadline only after an actual accepted IDR", () => {
    emit(body(idr, { frameType: 0 }));
    vi.advanceTimersByTime(T9000Live.FIRST_FRAME_TIMEOUT_MS + 1);
    expect(live.active).toBe(true);
    expect(frames[0]!.keyframe).toBe(true);
  });

  it("primes paused and late consumers with retained legitimate sets, never frame-counter bytes", () => {
    const pausedFrames: LiveVideoFrame[] = [];
    const paused = live.attach().onMedia(({ frame }) => pausedFrames.push(frame));
    emit(body(Buffer.concat([config, idr]), { frameType: 1 }));
    paused.pause();
    emit(body(delta, { counter: 0x0140 }));
    paused.resume();
    emit(body(delta, { counter: 0x0167 }));
    const lateFrames: LiveVideoFrame[] = [];
    live.attach().onMedia(({ frame }) => lateFrames.push(frame));
    emit(body(idr, { frameType: 1 }));
    expect(pausedFrames).toHaveLength(2);
    expect(lateFrames).toHaveLength(1);
    expect(pausedFrames[1]!.data.equals(Buffer.concat([config, idr]))).toBe(true);
    expect(lateFrames[0]!.data.equals(Buffer.concat([config, idr]))).toBe(true);
  });

  it.each([
    ["count", () => Buffer.concat(Array.from({ length: 49 }, () => vps))],
    ["bytes", () => nal(32, 65537)],
  ] as const)("releases every consumer and timer after parameter-set %s limit overflow", (_label, makeVideo) => {
    const errors: string[] = [];
    live.attach().on("error", (error: Error) => errors.push(error.message));
    emit(body(makeVideo()));
    expect(errors).toEqual(["RTC live parameter sets exceed retention limit"]);
    expect(frames).toHaveLength(0);
    expect(live.active).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(session.listenerCount("mediaData")).toBe(0);
    vi.advanceTimersByTime(T9000Live.FIRST_FRAME_TIMEOUT_MS * 2);
    expect(session.raw).toHaveLength(0);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("copies retained parameter sets and clears them when a source is stopped and restarted", () => {
    const mutable = body(config);
    emit(mutable);
    mutable.fill(0xab, 22);
    emit(body(idr));
    expect(frames[0]!.data.equals(Buffer.concat([config, idr]))).toBe(true);
    live.close();
    frames.length = 0;
    live.attach().onMedia(({ frame }) => frames.push(frame));
    emit(body(idr));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data.equals(idr)).toBe(true);
  });
});

describe("generic RTC Annex B helper controls", () => {
  it.each([idr, nal(19, 8, SHORT), Buffer.concat([nal(19, 8, SHORT), delta])])(
    "keeps raw access-unit helper input unchanged: %j",
    (video) => {
      expect(stripT9000FramePrefix(video).equals(video)).toBe(true);
      expect(isHevcKeyframe(video)).toBe(true);
    },
  );

  it("retains the exported legacy stripping helper without applying it to framed RTC ingress", () => {
    const opaque = Buffer.concat([Buffer.from([0xc5, 2]), delta]);
    expect(stripT9000FramePrefix(opaque).equals(delta)).toBe(true);
    expect(isHevcKeyframe(delta)).toBe(false);
  });
});
