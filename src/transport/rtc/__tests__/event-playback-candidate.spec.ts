import { afterEach, describe, expect, it, vi } from "vitest";
import { zstdCompressSync } from "node:zlib";
import {
  EventPlaybackCandidate,
  chicagoInstant,
  playbackRequest,
  reservePlaybackSelectors,
  selectPlayback,
} from "../event-playback-candidate.js";
import { PlaybackIngress } from "../playback-ingress.js";
import { buildPortalHeader, parsePortalHeader, parsePortalPacket } from "../portal-packet.js";
import { packetize, PtcsFramer } from "../ptcs-framer.js";
import { PORTAL_KEEPALIVE } from "../portal-keepalive.js";
import { performance as nativePerformance } from "node:perf_hooks";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const binary = (command: number, body: Buffer, selector = 6, channel = 101, segment = 9) =>
  Buffer.concat([buildPortalHeader(command, body.length, channel, segment, selector), body]);
const json = (value: unknown, segment = 9) => binary(1351, Buffer.from(JSON.stringify(value)), 0, 0, segment);
const video = (size = 7) => {
  const body = Buffer.alloc(22 + size);
  body.writeUInt32LE(size);
  body[5] = 1;
  Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]).copy(body, 22);
  return binary(1300, body);
};
let frameId = 0;
function wrapped(frame: Buffer, channel = 4, compressed = false, payloadBytes = 1000) {
  const packets = packetize(compressed ? zstdCompressSync(frame) : frame, {
    channel,
    frameId: ++frameId,
    payloadBytes,
  });
  if (compressed) for (const p of packets) p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
  return packets;
}
const row = (start: string, end = start, id = 40) => ({
  record_id: id,
  device_sn: "camera-synthetic",
  start_time: start,
  end_time: end,
});

describe("database-backed Chicago conversion", () => {
  it.each([
    ["2026-01-15 12:00:00", "2026-01-15T18:00:00Z"],
    ["2026-07-15 12:00:00", "2026-07-15T17:00:00Z"],
    ["2026-03-08 01:59:59", "2026-03-08T07:59:59Z"],
    ["2026-03-08 03:00:00", "2026-03-08T08:00:00Z"],
    ["2026-11-01 00:59:59", "2026-11-01T05:59:59Z"],
    ["2026-11-01 02:00:00", "2026-11-01T08:00:00Z"],
  ])("uniquely maps %s", (local, utc) => expect(chicagoInstant(local)).toBe(Date.parse(utc) / 1000));
  it.each([
    "2026-03-08 02:00:00",
    "2026-03-08 02:59:59",
    "2026-11-01 01:00:00",
    "2026-11-01 01:59:59",
    "2026-02-30 12:00:00",
    "2026-01-01 24:00:00",
    "2026-07-01",
    "2026-07-01 12:00:60",
    "私密",
  ])("refuses %s", (local) => expect(chicagoInstant(local)).toBeUndefined());
  it.each(["2026-11-01 01:30:00", "2026-07-02 12:00:00", "2026-07-01 12:00:30"])(
    "selects an older valid clip when the newest time is %s",
    (newest) => {
      expect(
        selectPlayback(
          [row("2026-07-01 12:00:00", undefined, 39), row(newest)],
          new Set(["camera-synthetic"]),
          new Set(["excluded-synthetic"]),
          Date.parse("2026-07-01T17:01:00Z"),
        ),
      ).toEqual({ selectionOutcome: "selected", record: 39, begin: chicagoInstant("2026-07-01 12:00:00") });
    },
  );
  it("excludes private camera policy and duplicate selectors", () => {
    const r = row("2026-07-01 12:00:00");
    expect(selectPlayback([r], new Set(["camera-synthetic"]), new Set(["camera-synthetic"]))).toEqual({
      selectionOutcome: "no_camera_rows",
    });
    expect(selectPlayback([r, r], new Set(["camera-synthetic"]), new Set())).toEqual({
      selectionOutcome: "time_invalid",
    });
  });
  it.each([
    [[], "no_rows"],
    [[{ ...row("2026-07-01 12:00:00"), device_sn: "other-synthetic" }], "no_camera_rows"],
    [[row("invalid")], "time_invalid"],
    [[row("2026-07-01 12:00:00", "2026-06-30 12:00:00")], "time_invalid"],
    [[row("2026-07-01 12:00:00", "2026-07-01 12:00:01")], "end_not_past"],
    [[row("2026-07-02 12:00:00")], "end_not_past"],
  ])("reports selection outcome for %j", (rows, selectionOutcome) => {
    expect(
      selectPlayback(rows as unknown[], new Set(["camera-synthetic"]), new Set(), Date.parse("2026-07-01T17:01:00Z")),
    ).toEqual({ selectionOutcome });
  });
  it.each([null, [], "malformed", { record_id: 0 }, { record_id: 1.5 }, { record_id: "41" }])(
    "refuses the entire table for malformed row %j",
    (bad) =>
      expect(selectPlayback([row("2026-07-01 12:00:00"), bad], new Set(["camera-synthetic"]), new Set())).toEqual({
        selectionOutcome: "time_invalid",
      }),
  );
});

it("reserves both selectors without wrap or reuse", () => {
  const used = new Set([1]);
  expect(reservePlaybackSelectors(used)).toEqual([6, 7]);
  expect(reservePlaybackSelectors(used)).toEqual([8, 9]);
  for (let n = 6; n <= 249; n++) used.add(n);
  expect(reservePlaybackSelectors(used)).toBeUndefined();
});
it("uses the captured envelope and same-record next-selector stop", () => {
  for (const sub of [0, 1, 3] as const) {
    const packet = playbackRequest("synthetic", 40, 6, sub, sub + 10, 1000000);
    const h = parsePortalHeader(packet)!;
    const p = JSON.parse(packet.subarray(16).toString());
    expect(h).toMatchObject({
      commandId: 1700,
      channel: 255,
      devType: 2,
      isResponse: sub === 3 ? 7 : 6,
      segment: sub + 10,
    });
    expect(p).toMatchObject({
      cmd: 6001,
      commandType: 6001,
      segmen: sub + 10,
      data: { cmd: sub, record_id: 40, play_id: sub === 3 ? 7 : 6, device_sn: "" },
    });
    expect(Object.hasOwn(p.data, "begin_time")).toBe(sub === 0);
  }
});

describe("A1 real framing path", () => {
  it.each([
    [1350, 0],
    [1351, 2],
  ])("delivers compressed control %s on route %s during capture and cleanup", async (command, route) => {
    const end = vi.fn(),
      delivered: unknown[] = [];
    const guard = new PlaybackIngress({
      end,
      media: () => {
        throw Error("unexpected_media");
      },
    });
    guard.reserve(6, 7);
    guard.capturing = true;
    const framer = new PtcsFramer();
    await framer.init(
      () => {
        throw Error("network_disabled");
      },
      (bytes, link) => {
        if (guard.decoded(bytes, link)) delivered.push(parsePortalPacket(bytes, link));
      },
    );
    const bytes = command === 1350 ? binary(command, Buffer.alloc(4), 1, 0) : json({ cmd: 1400, payload: { code: 0 } });
    try {
      for (const capturing of [true, false]) {
        guard.capturing = capturing;
        for (const p of wrapped(bytes, route, true)) if (guard.native(p)) framer.recvPacket(p);
      }
      expect(delivered).toHaveLength(2);
      expect(end).not.toHaveBeenCalled();
      expect(guard.evidence.unknown).toBe(false);
    } finally {
      framer.destroy();
    }
  });
  it.each([0, 1, 2, 3, 5, 9])(
    "inflates then discards compressed wrong-route media on %s before the parser",
    async (route) => {
      const delivered = vi.fn(),
        media = vi.fn(),
        end = vi.fn();
      const guard = new PlaybackIngress({ end, media });
      guard.reserve(6, 7);
      guard.capturing = true;
      const framer = new PtcsFramer();
      await framer.init(
        () => {},
        (bytes, link) => {
          if (guard.decoded(bytes, link)) delivered(bytes);
        },
      );
      try {
        for (const p of wrapped(video(), route, true)) if (guard.native(p)) framer.recvPacket(p);
        expect(delivered).not.toHaveBeenCalled();
        expect(media).not.toHaveBeenCalled();
        expect(guard.evidence.wrongRouteFrames).toBe(1);
        expect(guard.evidence.wrongRouteBytes).toBe(video().length);
        expect(end).toHaveBeenCalledWith("transport_mismatch");
        expect(guard.lastPlausibleMs).toBeGreaterThan(0);
      } finally {
        framer.destroy();
      }
    },
  );
  it("caps wrong-route traffic at 64 frames while retaining ordinary delivery", () => {
    const end = vi.fn(),
      guard = new PlaybackIngress({ end, media: () => {} });
    guard.reserve(6, 7);
    for (let n = 0; n < 64; n++) guard.decoded(video(), 3);
    expect(end).toHaveBeenLastCalledWith("capped_wrong_route");
    expect(guard.decoded(json({ cmd: 1400 }), 3)).toBe(true);
  });
  it.each([1, 3, 5, 9])(
    "preserves baseline inflation and ordinary delivery on non-playback route %s",
    async (route) => {
      const media = vi.fn(),
        end = vi.fn(),
        guard = new PlaybackIngress({ end, media });
      guard.capturing = true;
      const delivered = vi.fn(),
        framer = new PtcsFramer();
      await framer.init(
        () => {},
        (frame, link) => {
          if (guard.decoded(frame, link)) delivered(frame);
        },
      );
      try {
        for (const p of wrapped(json({ cmd: 1400 }), route, true)) if (guard.native(p)) framer.recvPacket(p);
        expect(delivered).toHaveBeenCalledOnce();
        expect(media).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
      } finally {
        framer.destroy();
      }
    },
  );
  it("handles bare media without parsing and preserves bare control", () => {
    const guard = new PlaybackIngress({ end: () => {}, media: () => {} });
    guard.reserve(6, 7);
    expect(guard.native(video())).toBe(false);
    expect(guard.native(json({ cmd: 1400 }))).toBe(true);
    expect(guard.native(PORTAL_KEEPALIVE)).toBe(true);
    expect(guard.evidence.nativeMessages).toBe(3);
  });
  it("rejects preallocation and decompression bombs", () => {
    const end = vi.fn(),
      media = vi.fn(),
      guard = new PlaybackIngress({ end, media });
    guard.reserve(6, 7);
    guard.capturing = true;
    const oversized = wrapped(Buffer.alloc(8388609))[0]!;
    expect(guard.native(oversized)).toBe(false);
    for (const p of wrapped(binary(1300, Buffer.alloc(8388609)), 4, true)) guard.native(p);
    expect(media).not.toHaveBeenCalled();
    expect(guard.evidence.unknown).toBe(false);
  });
  it("collects compressed playback with bounded native output", () => {
    const media = vi.fn(),
      guard = new PlaybackIngress({ end: () => {}, media });
    guard.reserve(6, 7);
    guard.capturing = true;
    for (const p of wrapped(video(), 4, true)) guard.native(p);
    expect(media).toHaveBeenCalledOnce();
    expect(guard.evidence.decodedWorkBytes).toBe(8388608);
  });
  it("refuses decode after capture and resets cessation for duplicate fragments", () => {
    let now = 1;
    const media = vi.fn(),
      guard = new PlaybackIngress({ now: () => now, end: () => {}, media });
    guard.reserve(6, 7);
    guard.capturing = true;
    const p = wrapped(binary(1300, Buffer.alloc(2000)), 4, false)[0]!;
    guard.native(p);
    now = 1000;
    guard.native(p);
    guard.finishCapture();
    now = 2500;
    guard.native(p);
    expect(guard.lastPlausibleMs).toBe(2500);
    expect(guard.observationComplete()).toBe(true);
    expect(media).not.toHaveBeenCalled();
  });
  it("retains unresolved control partials when unrelated ACK completes", () => {
    const guard = new PlaybackIngress({ end: () => {}, media: () => {} });
    guard.native(wrapped(binary(1300, Buffer.alloc(2000)), 0)[0]!);
    expect(guard.observationComplete()).toBe(false);
    guard.native(wrapped(json({ cmd: 1400 }), 2)[0]!);
    guard.decoded(json({ cmd: 1400 }), 3);
    expect(guard.observationComplete()).toBe(false);
  });
});

function candidateSetup({
  pauseThrows = false,
  ownerChanged = false,
  matching = true,
  release = true,
  absent = false,
  eof = false,
  stopSend = "sent" as "sent" | "refused" | "throws",
  streaming = false,
  streamingFrames = 24,
} = {}) {
  vi.useFakeTimers();
  vi.spyOn(nativePerformance, "now").mockImplementation(() => performance.now());
  const controller = new AbortController(),
    sent: Buffer[] = [],
    markers: boolean[] = [];
  let segment = 0,
    continuous = true,
    markerFails = false,
    latched = false;
  const candidate = new EventPlaybackCandidate({
    deadlineMs: performance.now() + (streaming ? 91000 : 24000),
    captureMs: streaming ? 60000 : undefined,
    video: streaming ? () => {} : undefined,
    continuous: () => continuous,
    startAllowed: () => true,
    signal: controller.signal,
    account: "synthetic",
    segment: () => ++segment,
    marker: (value) => {
      if (markerFails) throw Error("synthetic_persistence_failure");
      markers.push(value);
    },
    latch: (value) => {
      latched = value;
    },
    send: (p) => {
      sent.push(p);
      const body = JSON.parse(p.subarray(16).toString());
      if (body.data.cmd === 0) {
        candidate.ingress.decoded(json({ cmd: 6001, payload: { state: 1, code: 0 } }), 3);
        for (let n = 0; n < (streaming ? streamingFrames : 1); n++)
          for (const packet of wrapped(video(streaming ? 256 * 1024 : 7))) candidate.ingress.native(packet);
        if (eof) candidate.ingress.decoded(json({ cmd: 6001, payload: { state: 2, code: 14 } }), 3);
        if (ownerChanged) continuous = false;
      }
      if (body.data.cmd === 1 && pauseThrows) throw new Error("synthetic");
      if (body.data.cmd === 3 && stopSend !== "sent") {
        // A status notification still arrives asynchronously even though this send failed.
        setTimeout(
          () => candidate.ingress.decoded(json({ cmd: 6001, payload: { state: 2, code: 15, segmen: body.segmen } }), 3),
          50,
        );
        if (stopSend === "throws") throw new Error("synthetic_stop");
        return false;
      }
      if (body.data.cmd === 3 && release)
        candidate.ingress.decoded(
          json({ cmd: 6001, payload: { state: 2, code: 15, segmen: matching ? body.segmen : 200 } }),
          3,
        );
      if (body.data.cmd === 3 && absent)
        candidate.ingress.decoded(json({ cmd: 6001, payload: { state: 0, code: 7 } }), 3);
      return true;
    },
  });
  return {
    candidate,
    controller,
    sent,
    markers,
    latch: () => latched,
    failMarker: () => {
      markerFails = true;
    },
  };
}

it.each(["time_refused", "timeout"] as const)(
  "no-start %s reports clean health without touching a latch",
  async (reason) => {
    const s = candidateSetup();
    s.candidate.end(reason);
    expect(await s.candidate.observe()).toMatchObject({
      captureOutcome: reason,
      startAttempted: false,
      ownerContinuous: true,
      healthOutcome: "clean",
      latchPersisted: false,
      latchRetained: false,
    });
    expect(s.sent).toHaveLength(0);
    expect(s.markers).toEqual([]);
    expect(s.latch()).toBe(false);
  },
);

it("clears a persisted prestart latch when admission changes before sending", async () => {
  let allowed = true,
    latched = false;
  const markers: boolean[] = [],
    send = vi.fn();
  const candidate = new EventPlaybackCandidate({
    deadlineMs: nativePerformance.now() + 24000,
    continuous: () => true,
    startAllowed: () => allowed,
    send,
    segment: () => 1,
    account: "synthetic",
    marker: (value) => {
      markers.push(value);
      if (value) allowed = false;
    },
    latch: (value) => {
      latched = value;
    },
    signal: new AbortController().signal,
  });
  await candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
  expect(await candidate.observe()).toMatchObject({
    startAttempted: false,
    healthOutcome: "clean",
    latchPersisted: true,
    latchRetained: false,
    latchCleared: true,
  });
  expect(markers).toEqual([true, false]);
  expect(latched).toBe(false);
  expect(send).not.toHaveBeenCalled();
});

it("reports a pre-dispatch storage failure without sending or retaining the live-view latch", async () => {
  const s = candidateSetup();
  s.failMarker();
  await s.candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
  expect(await s.candidate.observe()).toMatchObject({
    captureOutcome: "storage_failed",
    startAttempted: false,
    latchPersistenceFailed: true,
    latchRetained: false,
    releaseOutcome: "not_started",
    cessationOutcome: "not_started",
  });
  expect(s.sent).toHaveLength(0);
  expect(s.latch()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("streams a complete clip beyond the probe byte cutoff through EOF and qualified release", async () => {
  const s = candidateSetup({ streaming: true, eof: true });
  await s.candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
  const pending = s.candidate.observe();
  await vi.advanceTimersByTimeAsync(5010);
  expect(await pending).toMatchObject({
    captureOutcome: "eof",
    videoFrames: 24,
    boundedMediaObserved: true,
    cutoff: false,
    releaseOutcome: "release_confirmed",
    latchCleared: true,
  });
  expect(s.candidate.receipt.nativeBytes).toBeGreaterThan(4 * 1024 ** 2);
});

it("completes by received video duration, trims the margin and retains complete media through unconfirmed cleanup", async () => {
  vi.useFakeTimers();
  vi.spyOn(nativePerformance, "now").mockImplementation(() => performance.now());
  const output = vi.fn(),
    sent: number[] = [];
  const candidate = new EventPlaybackCandidate({
    deadlineMs: performance.now() + 34000,
    captureMs: 18000,
    expectedMs: 3000,
    video: output,
    continuous: () => true,
    startAllowed: () => true,
    signal: new AbortController().signal,
    account: "synthetic",
    segment: () => 1,
    marker: () => {},
    latch: () => {},
    send: (packet) => {
      sent.push(JSON.parse(packet.subarray(16).toString()).data.cmd);
      return true;
    },
  });
  const capture = candidate.capture({ record: 1, begin: 1 }, [6, 7]);
  candidate.ingress.decoded(json({ cmd: 6001, payload: { state: 1, code: 0 } }), 3);
  const inject = () => {
    for (const packet of wrapped(video())) candidate.ingress.native(packet);
  };
  inject();
  await vi.advanceTimersByTimeAsync(1000);
  inject();
  await vi.advanceTimersByTimeAsync(2000);
  inject();
  await vi.advanceTimersByTimeAsync(500);
  inject();
  expect(output).toHaveBeenCalledTimes(3);
  expect(candidate.receipt.captureOutcome).not.toBe("complete");
  await vi.advanceTimersByTimeAsync(250);
  inject();
  await capture;
  expect(sent).toEqual([0, 1, 3]);
  const observing = candidate.observe();
  for (let i = 0; i < 16; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    inject();
  }
  expect(await observing).toMatchObject({
    captureOutcome: "complete",
    videoFrames: 3,
    randomAccess: true,
    boundedMediaObserved: true,
    releaseOutcome: "stop_unconfirmed",
    latchRetained: true,
  });
  expect(output).toHaveBeenCalledTimes(3);
});

it.each([1, 24])(
  "does not complete duration capture on wall time alone with %s retained frames",
  async (streamingFrames) => {
    const s = candidateSetup({ streaming: true, streamingFrames });
    Reflect.get(s.candidate, "opts").expectedMs = 3000;
    const capture = s.candidate.capture({ record: 1, begin: 1 }, [6, 7]);
    await vi.advanceTimersByTimeAsync(4000);
    if (streamingFrames === 1) for (const packet of wrapped(video())) s.candidate.ingress.native(packet);
    await vi.advanceTimersByTimeAsync(56001);
    await capture;
    expect(s.candidate.receipt.captureOutcome).toBe("capped");
    s.candidate.ingress.stopExpiry();
  },
);

it("refuses a duration capture without a keyframe start", async () => {
  const s = candidateSetup({ streaming: true, streamingFrames: 0 });
  Reflect.get(s.candidate, "opts").expectedMs = 3000;
  const capture = s.candidate.capture({ record: 1, begin: 1 }, [6, 7]);
  const delta = video();
  delta[42] = 0x02;
  for (const packet of wrapped(delta)) s.candidate.ingress.native(packet);
  await capture;
  expect(s.candidate.receipt).toMatchObject({ captureOutcome: "invalid_media", videoFrames: 0, randomAccess: false });
  s.candidate.ingress.stopExpiry();
});

it.each([0, 1, 2, 3, 5, 9])(
  "continued rejected traffic on route %s prevents silence until the global deadline",
  async (route) => {
    const s = candidateSetup({ eof: true });
    await s.candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
    expect(s.candidate.receipt.stopStatusCount).toBe(1);
    const framer = new PtcsFramer();
    await framer.init(
      () => {},
      (frame, link) => {
        s.candidate.ingress.decoded(frame, link);
      },
    );
    try {
      const pending = s.candidate.observe();
      for (let i = 0; i < 26; i++) {
        await vi.advanceTimersByTimeAsync(900);
        const p = packetize(Buffer.from("invalid compressed synthetic bytes"), {
          channel: route,
          frameId: ++frameId,
        })[0]!;
        p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
        expect(s.candidate.ingress.native(p)).toBe(true);
        const outcome = framer.recvPacket(p);
        expect(outcome).toBe("rejected");
        s.candidate.ingress.received(outcome);
        expect(s.candidate.ingress.lastPlausibleMs).toBe(performance.now());
        expect(s.candidate.ingress.observationComplete()).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(610);
      expect(await pending).toMatchObject({
        cessationOutcome: "cessation_unknown",
        latchRetained: true,
        latchCleared: false,
        unknown: false,
      });
      expect(s.markers).toEqual([true]);
      expect(s.latch()).toBe(true);
    } finally {
      framer.destroy();
    }
  },
);

it.each(["refused", "throws"] as const)(
  "stop send %s with a delayed stop status never reports ceased or clears the latch",
  async (stopSend) => {
    const s = candidateSetup({ stopSend, eof: true });
    await s.candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
    const pending = s.candidate.observe();
    await vi.advanceTimersByTimeAsync(24000);
    const result = await pending;
    expect(result.stopSent).toBe(false);
    expect(result.cessationOutcome).toBe("cessation_unknown");
    expect(result.latchCleared).toBe(false);
    expect(result.latchRetained).toBe(true);
    expect(s.latch()).toBe(true);
  },
);

it("late re-latch failure stays latched and is observable after qualified release", async () => {
  const s = candidateSetup({ eof: true });
  await s.candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
  const pending = s.candidate.observe();
  await vi.advanceTimersByTimeAsync(5010);
  expect((await pending).latchCleared).toBe(true);
  s.failMarker();
  s.candidate.ingress.native(video());
  expect(s.latch()).toBe(true);
  expect(s.candidate.receipt).toMatchObject({
    latchPersistenceFailed: true,
    latchRetained: true,
    latchCleared: false,
    releaseOutcome: "release_unknown",
  });
});

describe("mandatory finalizer and observational release", () => {
  it.each([true, false])(
    "cleanup survives demand with pause failure=%s and measured handoff below 100ms",
    async (pauseThrows) => {
      const { candidate, controller, sent } = candidateSetup({ pauseThrows });
      const run = candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
      controller.abort();
      await run;
      const handoff = performance.now();
      expect(sent.map((p) => JSON.parse(p.subarray(16).toString()).data.cmd)).toEqual([0, 1, 3]);
      expect(handoff).toBeLessThan(100);
      candidate.finalize();
      expect(sent).toHaveLength(3);
      const observation = candidate.observe();
      await vi.advanceTimersByTimeAsync(5010);
      expect((await observation).releaseOutcome).toBe("release_confirmed");
    },
  );
  it.each([true, false])("2/15 uses explicit segment-match boolean=%s under exclusivity", async (matching) => {
    const { candidate } = candidateSetup({ matching, eof: true });
    await candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
    const pending = candidate.observe();
    await vi.advanceTimersByTimeAsync(5010);
    const result = await pending;
    expect(result.releaseOutcome).toBe("release_confirmed");
    expect(result.segmenComparable).toBe(true);
    expect(result.segmenMatchesRequest).toBe(matching);
    expect(result.boundedMediaObserved).toBe(true);
    expect(result.accepted).toBe(false);
  });
  it.each([true, false])("0/7 requires prior EOF=%s", async (eof) => {
    const { candidate, controller } = candidateSetup({ release: false, absent: true, eof });
    const capture = candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
    if (!eof) controller.abort();
    await capture;
    const pending = candidate.observe();
    await vi.advanceTimersByTimeAsync(24010);
    expect((await pending).releaseOutcome).toBe(eof ? "release_confirmed" : "stop_unconfirmed");
  });
  it("never sends through a replacement owner", async () => {
    const { candidate, sent } = candidateSetup({ ownerChanged: true });
    const capture = candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
    await vi.advanceTimersByTimeAsync(20);
    await capture;
    const result = await candidate.observe();
    expect(sent).toHaveLength(1);
    expect(result.latchRetained).toBe(true);
    expect(result.ownerContinuous).toBe(false);
  });
  it("opaque direct reply is consumed before generic body decoding", async () => {
    const { candidate, controller } = candidateSetup();
    const capture = candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
    expect(candidate.ingress.decoded(binary(1700, Buffer.alloc(132, 255), 1, 255, 1), 1)).toBe(false);
    expect(candidate.receipt.directStartMatched).toBe(true);
    controller.abort();
    await capture;
  });
});

it.each([true, false])(
  "rejected capture with stop confirmation=%s preserves failure and qualifies cleanup independently",
  async (release) => {
    const s = candidateSetup({ release });
    const capture = s.candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
    const p = wrapped(Buffer.from("invalid synthetic zstd"))[0]!;
    p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
    s.candidate.ingress.native(p);
    await capture;
    const observe = s.candidate.observe();
    await vi.advanceTimersByTimeAsync(release ? 5010 : 24010);
    const result = await observe;
    expect(result).toMatchObject({
      captureOutcome: "invalid_media",
      boundedMediaObserved: false,
      cessationOutcome: release ? "ceased" : "cessation_unknown",
      releaseOutcome: release ? "release_confirmed" : "stop_unconfirmed",
      latchCleared: release,
      latchRetained: !release,
      unknown: false,
      firstRejectionReason: "zstd-header",
      firstRejectedClass: "playback",
      compressionState: "flagged",
      rejectionCount: 1,
      declaredSizeBucket: "le8KiB",
      assembledSizeBucket: "le8KiB",
      outputSizeBucket: "unknown",
      zstdWindowBucket: "unknown",
      assemblerDecompression: 1,
    });
    expect(s.latch()).toBe(!release);
  },
);

it("accepts a synthetic non-single-segment 8 MiB zstd window and output above 256 KiB", () => {
  const collected = vi.fn();
  const guard = new PlaybackIngress({ end: vi.fn(), media: collected });
  guard.reserve(6, 7);
  guard.capturing = true;
  const bytes = binary(1300, Buffer.alloc(400000));
  const chunks: Buffer[] = [Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x68])];
  for (let i = 0; i < bytes.length; i += 131072) {
    const part = bytes.subarray(i, i + 131072),
      header = Buffer.alloc(3);
    header.writeUIntLE((part.length << 3) | (i + part.length === bytes.length ? 1 : 0), 0, 3);
    chunks.push(header, part);
  }
  const wire = packetize(Buffer.concat(chunks), { channel: 4, frameId: ++frameId });
  for (const p of wire) {
    p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
    guard.native(p);
  }
  expect(collected).toHaveBeenCalledExactlyOnceWith(bytes);
  expect(guard.evidence).toMatchObject({
    rejected: 0,
    decodedWorkBytes: 8388608,
    compressionState: "decoded",
    zstdWindowBucket: "le8MiB",
    outputSizeBucket: "le8MiB",
  });
  const malformed = Buffer.from("invalid");
  guard.native(malformed);
  const frozen = { ...guard.evidence };
  for (const p of wrapped(video(), 4, true)) guard.native(p);
  expect(guard.evidence.firstRejectionReason).toBe(frozen.firstRejectionReason);
  expect(guard.evidence.compressionState).toBe(frozen.compressionState);
});

it("waits within the global deadline for a delayed stop and five fresh seconds", async () => {
  const s = candidateSetup({ release: false });
  const capture = s.candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
  s.candidate.ingress.native(Buffer.from("synthetic-invalid"));
  await capture;
  const observe = s.candidate.observe();
  await vi.advanceTimersByTimeAsync(7000);
  expect(s.latch()).toBe(true);
  s.candidate.ingress.decoded(json({ cmd: 6001, payload: { state: 2, code: 15 } }), 3);
  await vi.advanceTimersByTimeAsync(4999);
  expect(s.latch()).toBe(true);
  await vi.advanceTimersByTimeAsync(20);
  expect(await observe).toMatchObject({
    captureOutcome: "invalid_media",
    releaseOutcome: "release_confirmed",
    cessationOutcome: "ceased",
    latchCleared: true,
  });
});

it("releases concurrent reservations while bounding cumulative decoder work", () => {
  const media = vi.fn(),
    end = vi.fn();
  const guard = new PlaybackIngress({ end, media });
  guard.reserve(6, 7);
  guard.capturing = true;
  for (let n = 0; n < 5; n++) for (const p of wrapped(video(), 4, true)) guard.native(p);
  expect(media).toHaveBeenCalledTimes(4);
  expect(guard.evidence.decodedWorkBytes).toBe(33554432);
  expect(guard.evidence.firstRejectionReason).toBe("limits");
  expect(end).toHaveBeenLastCalledWith("invalid_media");
});
