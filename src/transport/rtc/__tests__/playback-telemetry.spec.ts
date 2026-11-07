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
it.each([
  null,
  {},
  { playSpeed: 3 },
  { playSpeed: 1, playType: 1, clientType: "WEB", maxClips: 6 },
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
  for (const [i, timestamp] of [0, 400, 1000, span].entries()) {
    const body = Buffer.alloc(22);
    body.writeUInt32LE(timestamp, 14);
    body.writeUInt16LE(i, 6);
    timing.add(body, i);
  }
  expect(timing.completeDurationMs(6000)).toBe(accepted ? Math.round(span + 1000 / 15) : undefined);
});

it.each([10, 11])("native coverage unwraps timestamps and tolerates at most %s ms regression", (regression) => {
  const timing = new PlaybackNativeFrameTiming();
  for (const [i, timestamp] of [0, 400, 1000, 1000 - regression, 59815].entries()) {
    const body = Buffer.alloc(22);
    body.writeUInt32LE((0xfffff000 + timestamp) >>> 0, 14);
    body.writeUInt16LE((65534 + i) & 0xffff, 6);
    timing.add(body, i);
  }
  expect(timing.completeDurationMs(60000)).toBe(regression === 10 ? 59882 : undefined);
});
