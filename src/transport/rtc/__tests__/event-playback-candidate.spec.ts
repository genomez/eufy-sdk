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
const video = () => {
  const body = Buffer.alloc(29);
  body.writeUInt32LE(7);
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
  it("never falls back after highest eligible row has an ambiguous time", () => {
    expect(
      selectPlayback(
        [row("2026-07-01 12:00:00", undefined, 39), row("2026-11-01 01:30:00")],
        new Set(["camera-synthetic"]),
        new Set(["excluded-synthetic"]),
      ),
    ).toBeUndefined();
  });
  it("excludes private camera policy and duplicate selectors", () => {
    const r = row("2026-07-01 12:00:00");
    expect(selectPlayback([r], new Set(["camera-synthetic"]), new Set(["camera-synthetic"]))).toBeUndefined();
    expect(selectPlayback([r, r], new Set(["camera-synthetic"]), new Set())).toBeUndefined();
  });
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
    const oversized = wrapped(Buffer.alloc(262145))[0]!;
    expect(guard.native(oversized)).toBe(false);
    for (const p of wrapped(binary(1300, Buffer.alloc(262145)), 4, true)) guard.native(p);
    expect(media).not.toHaveBeenCalled();
    expect(guard.evidence.unknown).toBe(true);
  });
  it("collects compressed playback with bounded native output", () => {
    const media = vi.fn(),
      guard = new PlaybackIngress({ end: () => {}, media });
    guard.reserve(6, 7);
    guard.capturing = true;
    for (const p of wrapped(video(), 4, true)) guard.native(p);
    expect(media).toHaveBeenCalledOnce();
    expect(guard.evidence.decodedWorkBytes).toBe(262144);
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
    expect(guard.observationComplete()).toBe(false);
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
} = {}) {
  vi.useFakeTimers();
  vi.spyOn(nativePerformance, "now").mockImplementation(() => performance.now());
  const controller = new AbortController(),
    sent: Buffer[] = [],
    markers: boolean[] = [];
  let segment = 0,
    continuous = true;
  const candidate = new EventPlaybackCandidate({
    deadlineMs: performance.now() + 24000,
    continuous: () => continuous,
    startAllowed: () => true,
    signal: controller.signal,
    account: "synthetic",
    segment: () => ++segment,
    marker: (value) => markers.push(value),
    latch: () => {},
    send: (p) => {
      sent.push(p);
      const body = JSON.parse(p.subarray(16).toString());
      if (body.data.cmd === 0) {
        candidate.ingress.decoded(json({ cmd: 6001, payload: { state: 1, code: 0 } }), 3);
        for (const packet of wrapped(video())) candidate.ingress.native(packet);
        if (eof) candidate.ingress.decoded(json({ cmd: 6001, payload: { state: 2, code: 14 } }), 3);
        if (ownerChanged) continuous = false;
      }
      if (body.data.cmd === 1 && pauseThrows) throw new Error("synthetic");
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
  return { candidate, controller, sent, markers };
}

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
    await vi.advanceTimersByTimeAsync(5010);
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
