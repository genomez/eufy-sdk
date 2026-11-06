import { afterEach, expect, it, vi } from "vitest";
import { performance as nativePerformance } from "node:perf_hooks";
import { normalizeRecordingRows, projectRecordingRow, verifyPlaybackSelector } from "../recordings.js";
import { scope, row } from "./recordings-fixture.js";
import { EventPlaybackCandidate } from "../event-playback-candidate.js";
import { buildPortalHeader } from "../portal-packet.js";
import { packetize } from "../ptcs-framer.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("seals exact playback independently of the cover and never projects its private authority", () => {
  const result = normalizeRecordingRows([row({ thumb_path: null })], scope);
  if (result.status !== "ok") throw Error("fixture");
  const record = result.rows[0]!;
  expect(record.coverSelector).toBeNull();
  expect(verifyPlaybackSelector(scope, record.playbackSelector!)).toBe(true);
  for (const patch of [
    { record: 9 },
    { begin: 1 },
    { expectedMs: 999 },
    { cameraSn: "other" },
    { sourceKey: "0".repeat(64) },
  ])
    expect(verifyPlaybackSelector(scope, { ...record.playbackSelector!, ...patch })).toBe(false);
  expect(verifyPlaybackSelector({ ...scope, accountNamespace: "a_" + "0".repeat(64) }, record.playbackSelector!)).toBe(
    false,
  );
  expect(projectRecordingRow(record)).not.toHaveProperty("playbackSelector");
});

it.each(["eof", "sink_failure", "cancel"])(
  "full clip %s exceeds probe limits and retains mandatory cleanup",
  async (outcome) => {
    vi.useFakeTimers();
    vi.spyOn(nativePerformance, "now").mockImplementation(() => performance.now());
    const controller = new AbortController(),
      markers: boolean[] = [],
      delivered = vi.fn();
    let candidate: EventPlaybackCandidate,
      segment = 0;
    const notify = (payload: unknown) => {
      const body = Buffer.from(JSON.stringify({ cmd: 6001, payload }));
      candidate.ingress.decoded(Buffer.concat([buildPortalHeader(1351, body.length, 0, 0, 0), body]), 3);
    };
    candidate = new EventPlaybackCandidate({
      deadlineMs: performance.now() + 60000,
      captureMs: 45000,
      continuous: () => true,
      startAllowed: () => true,
      signal: controller.signal,
      account: "synthetic",
      marker: (value) => markers.push(value),
      latch: () => {},
      segment: () => ++segment,
      video(data) {
        delivered(data.length);
        if (outcome === "sink_failure") throw Error("disk full");
      },
      send(packet) {
        const value = JSON.parse(packet.subarray(16).toString());
        if (value.data.cmd === 0) notify({ state: 1, code: 0 });
        if (value.data.cmd === 3) notify({ state: 2, code: 15, segmen: value.segmen });
        return true;
      },
    });
    const capturing = candidate.capture({ record: 2, begin: 1700000000 }, [6, 7]);
    for (let n = 0; n < (outcome === "sink_failure" ? 1 : 320); n++) {
      const body = Buffer.alloc(8220);
      body.writeUInt32LE(body.length - 22);
      body[5] = 1;
      Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]).copy(body, 22);
      for (const p of packetize(Buffer.concat([buildPortalHeader(1300, body.length, 101, 0, 6), body]), {
        channel: 4,
        frameId: n + 1,
      }))
        candidate.ingress.native(p);
    }
    if (outcome !== "sink_failure") {
      await vi.advanceTimersByTimeAsync(9000);
      expect(candidate.receipt.stopAttempted).toBe(false);
      expect(delivered).toHaveBeenCalledTimes(320);
      if (outcome === "cancel") controller.abort();
      else notify({ state: 2, code: 14 });
    }
    await capturing;
    const observing = candidate.observe();
    await vi.advanceTimersByTimeAsync(5100);
    expect(await observing).toMatchObject({
      captureOutcome: outcome === "sink_failure" ? "invalid_media" : outcome === "cancel" ? "preempted" : "eof",
      pauseSent: true,
      stopSent: true,
      releaseOutcome: "release_confirmed",
      latchCleared: true,
    });
    expect(markers).toEqual([true, false]);
  },
);

it("an already cancelled full clip never writes a latch or sends a start", async () => {
  const controller = new AbortController();
  controller.abort();
  const marker = vi.fn(),
    send = vi.fn();
  const c = new EventPlaybackCandidate({
    deadlineMs: nativePerformance.now() + 60000,
    captureMs: 45000,
    continuous: () => true,
    startAllowed: () => true,
    signal: controller.signal,
    account: "synthetic",
    marker,
    latch: () => {},
    segment: () => 1,
    send,
    video: () => {},
  });
  await c.capture({ record: 2, begin: 1700000000 }, [6, 7]);
  await c.observe();
  expect(marker).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
