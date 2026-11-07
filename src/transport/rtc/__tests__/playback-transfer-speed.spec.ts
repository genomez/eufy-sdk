import { afterEach, expect, it, vi } from "vitest";
import { performance as nativePerformance } from "node:perf_hooks";
import { EventPlaybackCandidate } from "../event-playback-candidate.js";
import { buildPortalHeader, buildPortalPacket } from "../portal-packet.js";
import { packetize } from "../ptcs-framer.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(options = {}) {
  vi.useFakeTimers();
  vi.spyOn(nativePerformance, "now").mockImplementation(() => performance.now());
  const sent: Buffer[] = [];
  const candidate = new EventPlaybackCandidate({
    deadlineMs: performance.now() + 40000,
    captureMs: 15000,
    expectedMs: 10000,
    transient: true,
    video: () => {},
    continuous: () => true,
    startAllowed: () => true,
    account: "synthetic",
    segment: () => 1,
    marker: () => {},
    latch: () => {},
    signal: new AbortController().signal,
    send: (b) => {
      sent.push(b);
      return true;
    },
    ...options,
  });
  const capture = candidate.capture({ record: 1, begin: 1 }, [6, 7]);
  return { candidate, capture, sent };
}

function frame(candidate: EventPlaybackCandidate, index: number, intervalMs = 100, timestampMs = index * intervalMs) {
  const data = Buffer.from([0, 0, 0, 1, 0x26, 1, 9]);
  const body = Buffer.alloc(22);
  body.writeUInt32LE(data.length);
  body[5] = 1;
  body.writeUInt16LE(index, 6);
  body.writeUInt32LE(Math.round(timestampMs), 14);
  for (const p of packetize(
    Buffer.concat([buildPortalHeader(1300, body.length + data.length, 101, 1, 6), body, data]),
    { channel: 4, frameId: index + 1 },
  ))
    candidate.ingress.native(p);
}

it.each([undefined, 1] as const)("ordinary clips default to 2x and accept an explicit %s override", async (speed) => {
  const s = fixture(speed === undefined ? {} : { transferSpeed: speed });
  expect(JSON.parse(s.sent[0]!.subarray(16).toString()).data.play_speed).toBe(speed ?? 2);
  s.candidate.end("preempted");
  await s.capture;
  expect(s.candidate.receipt).toHaveProperty("transferSpeed", speed ?? 2);
});

it("uses media time for 2x span, gap and density completeness and duration", async () => {
  const s = fixture();
  s.candidate.ingress.decoded(
    buildPortalPacket({
      commandId: 1351,
      channel: 0,
      segment: 1,
      payload: { cmd: 6001, payload: { state: 1, code: 0 } },
    }),
    3,
  );
  for (let i = 0; i <= 99; i++) {
    if (i) await vi.advanceTimersByTimeAsync(50);
    frame(s.candidate, i);
  }
  s.candidate.end("complete");
  await s.capture;
  const pending = s.candidate.observe(true);
  await vi.advanceTimersByTimeAsync(16000);
  const r = await pending;
  expect(r.completenessFailure).toBe("none");
  expect(r.mediaDurationMs).toBe(10000);
});

it.each([
  ["gap", [0, ...Array.from({ length: 89 }, (_, i) => 600 + i * 50)]],
  ["density", Array.from({ length: 26 }, (_, i) => i * 200)],
] as const)("checks %s against media time at 2x", async (failure, arrivals) => {
  const s = fixture();
  let previous = 0;
  for (const [index, at] of arrivals.entries()) {
    await vi.advanceTimersByTimeAsync(at - previous);
    frame(s.candidate, index);
    previous = at;
  }
  s.candidate.end("complete");
  await s.capture;
  const pending = s.candidate.observe();
  await vi.advanceTimersByTimeAsync(16000);
  expect((await pending).completenessFailure).toBe(failure);
});

it.each([
  ["premature 2x EOF", 2, 2, 1, 0, false, "arrival", 4],
  ["sparse 2x EOF at full span", 2, 2, 18500, 0, false, "arrival", 74000],
  ["partial 2x EOF with short native clock", 2, 100, 1000, 250, false, "arrival", 2020],
  ["full native coverage despite short 2x arrival", 2, 100, 1000, 370, true, "native_header", 37000],
  ["uniform slow clock lacks millisecond evidence", 2, 100, 1000, 370, false, "arrival", 2020],
  ["full 2x native clock", 2, 552, 18356.685, 36780 / 552, true, "native_header", 36780],
  ["full 1x with delivery pauses", 1, 555, 48250, 0, true, "catalog", 37000],
  ["full 1x native clock with delivery pauses", 1, 555, 48250, 36780 / 555, true, "native_header", 36780],
  ["night 2x with 3.5s pauses", 2, 370, 25450, 0, true, "catalog", 37000],
] as const)(
  "ordinary duration regression: %s",
  async (name, speed, frames, span, interval, complete, basis, duration) => {
    const s = fixture({ transferSpeed: speed, expectedMs: 37000, captureMs: 60000, deadlineMs: 91000 });
    s.candidate.ingress.decoded(
      buildPortalPacket({
        commandId: 1351,
        channel: 0,
        segment: 1,
        payload: { cmd: 6001, payload: { state: 1, code: 0 } },
      }),
      3,
    );
    let previous = 0;
    for (let i = 0; i < frames; i++) {
      const at = name.startsWith("night")
        ? (i * 18450) / (frames - 1) + (i >= 123 ? 3500 : 0) + (i >= 246 ? 3500 : 0)
        : (i * span) / (frames - 1);
      await vi.advanceTimersByTimeAsync(at - previous);
      frame(
        s.candidate,
        i,
        interval,
        name.startsWith("full native coverage") ? (i === 0 ? 0 : 100 + ((i - 1) * (36630 - 100)) / 98) : i * interval,
      );
      previous = at;
    }
    s.candidate.ingress.decoded(
      buildPortalPacket({
        commandId: 1351,
        channel: 0,
        segment: 1,
        payload: { cmd: 6001, payload: { state: 2, code: 14 } },
      }),
      3,
    );
    await s.capture;
    const pending = s.candidate.observe(true);
    await vi.advanceTimersByTimeAsync(16000);
    const receipt = await pending;
    expect(receipt).toMatchObject({
      captureOutcome: "eof",
      boundedMediaObserved: complete,
      durationBasis: basis,
      mediaDurationMs: duration,
      retainedVideoFrames: frames,
    });
    expect(receipt.completenessFailure).toBe(complete ? "none" : frames === 2 && span > 1 ? "density" : "span");
  },
);

it.each([
  ["1x truncated media hidden by a delivery pause", 1, 301, 33500, 100, "truncated", false],
  ["1x complete native clock with a delivery pause", 1, 370, 40500, 100, "none", true],
  ["2x truncated media hidden by delivery pauses", 2, 301, 16750, 100, "truncated", false],
  ["1x complete clip on a 100 Hz native clock", 1, 555, 40500, 37000 / 555 / 10, "none", true],
] as const)("native clock shortfall: %s", async (_name, speed, frames, span, interval, failure, complete) => {
  const s = fixture({ transferSpeed: speed, expectedMs: 37000, captureMs: 60000, deadlineMs: 91000 });
  const status = (state: number, code: number) =>
    s.candidate.ingress.decoded(
      buildPortalPacket({ commandId: 1351, channel: 0, segment: 1, payload: { cmd: 6001, payload: { state, code } } }),
      3,
    );
  status(1, 0);
  let previous = 0;
  for (let i = 0; i < frames; i++) {
    const pause = i >= Math.floor(frames / 2) ? 3500 / speed : 0;
    const at = (i * (span - 3500 / speed)) / (frames - 1) + pause;
    await vi.advanceTimersByTimeAsync(at - previous);
    frame(s.candidate, i, interval);
    previous = at;
  }
  status(2, 14);
  await s.capture;
  const pending = s.candidate.observe(true);
  await vi.advanceTimersByTimeAsync(16000);
  const receipt = await pending;
  expect(receipt.captureOutcome).toBe("eof");
  expect(receipt.completenessFailure).toBe(failure);
  expect(receipt.boundedMediaObserved).toBe(complete);
});
