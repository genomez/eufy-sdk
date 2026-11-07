import { expect, it } from "vitest";
import { PlaybackFrameTiming, PlaybackNativeFrameTiming, playbackExperiment } from "../playback-telemetry.js";
import { PtcsReassembler, packetize } from "../ptcs-framer.js";

it("extracts synthetic PTCS header timing after fragmented reassembly, including wrap", () => {
  const timing = new PlaybackFrameTiming();
  let now = 0;
  const parser = new PtcsReassembler((_frame, _channel, h) => timing.add(now, h));
  for (const [arrival, frameId, sequence] of [
    [0, 0xfffffff0, 65535],
    [10, 34, 0],
    [2010, 84, 1],
  ]) {
    now = arrival!;
    for (const p of packetize(Buffer.alloc(2000), {
      channel: 4,
      frameId: frameId!,
      sequence: sequence!,
      payloadBytes: 50,
    }))
      parser.push(p);
  }
  expect(timing.snapshot()).toEqual({
    arrivalFps: { buckets: 3, min: 0, median: 1, max: 2 },
    frameTiming: {
      source: "ptcs_sender_clock_unverified",
      frames: 3,
      timestampDeltaMs: 100,
      maxTimestampGapMs: 50,
      sequenceDelta: 2,
      maxSpacingDifferenceMs: 1950,
      spacingDiffers: true,
      mediaTimestampValidated: false,
    },
  });
});

it("does not manufacture a media timestamp from a decoded portal frame", () => {
  const timing = new PlaybackFrameTiming();
  timing.add(0);
  timing.add(20);
  expect(timing.snapshot().frameTiming).toMatchObject({
    frames: 0,
    mediaTimestampValidated: false,
    timestampDeltaMs: 0,
  });
});

it.each([1, 2, 4, 8])("validates bounded speed %s", (playSpeed) => {
  const v = { playSpeed, playType: 1, clientType: "WEB", maxClips: 5, icePolicy: "all" };
  expect(playbackExperiment(v)).toEqual(v);
});
it.each([6, 100, Number.MAX_SAFE_INTEGER])("accepts a positive safe clip budget %s", (maxClips) => {
  const value = { playSpeed: 1, playType: 1, clientType: "WEB", maxClips };
  expect(playbackExperiment(value)).toEqual(value);
});
it.each([0, -1, 1.5, NaN, Infinity, "6", null, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid clip budget %s",
  (maxClips) => {
    expect(() => playbackExperiment({ playSpeed: 1, playType: 1, clientType: "WEB", maxClips })).toThrow(RangeError);
  },
);
it.each([
  null,
  {},
  { playSpeed: 3 },
  { playSpeed: 1, playType: 1, clientType: "WEB", maxClips: 1, icePolicy: "host-only" },
])("rejects malformed transport overrides %j", (value) => {
  expect(() => playbackExperiment(value)).toThrow(RangeError);
});

it("extracts native video timestamp and sequence words independently of PTCS", () => {
  const timing = new PlaybackNativeFrameTiming();
  for (const [ts, seq, arrival] of [
    [1000, 50, 0],
    [1050, 51, 10],
    [1100, 52, 20],
  ]) {
    const body = Buffer.alloc(29);
    body.writeUInt32LE(7, 0);
    body[5] = 1;
    body.writeUInt16LE(seq!, 6);
    body.writeUInt32LE(ts!, 14);
    timing.add(body, arrival!);
  }
  expect(timing.snapshot()).toEqual({
    source: "native_video_header_unverified",
    frames: 3,
    timestampDeltaTicks: 100,
    maxTimestampGapTicks: 50,
    sequenceDelta: 2,
    maxSpacingDifferenceAssumingMs: 40,
    spacingDiffersAssumingMs: true,
    mediaTimestampValidated: false,
  });
});
it("short native headers do not manufacture timing fields", () => {
  const timing = new PlaybackNativeFrameTiming();
  timing.add(Buffer.alloc(21), 0);
  expect(timing.snapshot()).toMatchObject({ frames: 0, timestampDeltaTicks: 0 });
});

it.each(["constant", "backwards", "large-gap", "catalog-mismatch"])(
  "refuses native duration inference for %s",
  (mode) => {
    const timing = new PlaybackNativeFrameTiming();
    const stamps =
      mode === "constant"
        ? [0, 0, 0]
        : mode === "backwards"
          ? [100, 50, 150]
          : mode === "large-gap"
            ? [0, 2000, 4000]
            : [0, 50, 100];
    for (const timestamp of stamps) {
      const body = Buffer.alloc(22);
      body.writeUInt32LE(timestamp, 14);
      timing.add(body, 0);
    }
    expect(timing.durationMs(10000)).toBeUndefined();
  },
);

it.each([
  [4933, false],
  [4934, true],
  [7000, true],
  [7001, false],
] as const)("native coverage honors the catalog window at span %s ms", (span, accepted) => {
  const timing = new PlaybackNativeFrameTiming();
  for (const [i, timestamp] of [0, 67, 133, span].entries()) {
    const body = Buffer.alloc(22);
    body.writeUInt32LE(timestamp, 14);
    body.writeUInt16LE(i, 6);
    timing.add(body, i);
  }
  expect(timing.completeDurationMs(6000)).toBe(accepted ? Math.round(span + 1000 / 15) : undefined);
});

it.each([10, 11])("native coverage unwraps timestamps and tolerates at most %s ms regression", (regression) => {
  const timing = new PlaybackNativeFrameTiming();
  for (const [i, timestamp] of [0, 67, 133, 133 - regression, 59815].entries()) {
    const body = Buffer.alloc(22);
    body.writeUInt32LE((0xfffff000 + timestamp) >>> 0, 14);
    body.writeUInt16LE((65534 + i) & 0xffff, 6);
    timing.add(body, i);
  }
  expect(timing.completeDurationMs(60000)).toBe(regression === 10 ? 59882 : undefined);
});

it.each([false, true])(
  "90 kHz early EOF cannot prove completeness, including an isolated ms-sized delta: %s",
  (smallStep) => {
    const timing = new PlaybackNativeFrameTiming();
    for (let i = 0; i < 11; i++) {
      const body = Buffer.alloc(22);
      body.writeUInt32LE(smallStep && i > 0 ? 67 + Math.round(((i - 1) * (60000 - 67)) / 9) : i * 6000, 14);
      body.writeUInt16LE(i, 6);
      timing.add(body, i * 67);
    }
    expect(timing.completeDurationMs(60000)).toBeUndefined();
    expect(timing.shortOf(60000)).toBe(false);
  },
);

it("steady 15fps retains the legacy short-duration tolerance", () => {
  const timing = new PlaybackNativeFrameTiming();
  for (let i = 0; i < 870; i++) {
    const body = Buffer.alloc(22);
    body.writeUInt32LE(Math.round((i * 1000) / 15), 14);
    body.writeUInt16LE(i, 6);
    timing.add(body, i * 67);
  }
  expect(timing.shortOf(60000)).toBe(false);
});
