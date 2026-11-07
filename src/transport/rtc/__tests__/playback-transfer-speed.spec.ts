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

function frame(candidate: EventPlaybackCandidate, index: number) {
  const data = Buffer.from([0, 0, 0, 1, 0x26, 1, 9]);
  const body = Buffer.alloc(22);
  body.writeUInt32LE(data.length);
  body[5] = 1;
  body.writeUInt16LE(index, 6);
  body.writeUInt32LE(index * 100, 14);
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
