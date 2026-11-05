import { afterEach, describe, expect, it, vi } from "vitest";
import { performance as nativePerformance } from "node:perf_hooks";
import { PlaybackIngress, PLAYBACK_EXPIRY_SWEEP_MS } from "../playback-ingress.js";
import { EventPlaybackCandidate } from "../event-playback-candidate.js";
import { packetize, type PtcsReassembler } from "../ptcs-framer.js";
import { buildPortalHeader } from "../portal-packet.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  vi.spyOn(nativePerformance, "now").mockImplementation(() => performance.now());
  const end = vi.fn();
  const guard = new PlaybackIngress({ end, media: vi.fn() });
  guard.reserve(6, 7);
  guard.capturing = true;
  guard.startExpiry();
  const body = Buffer.alloc(5000);
  const packets = packetize(Buffer.concat([buildPortalHeader(1300, body.length, 101, 9, 6), body]), {
    channel: 4,
    frameId: 1,
    payloadBytes: 1000,
  });
  const assembler = Reflect.get(guard, "assembler") as PtcsReassembler;
  return { guard, end, packets, assembler };
}

describe("independent playback expiry", () => {
  it("expires a silent incomplete frame without ingress or observation polling", async () => {
    const { guard, packets, assembler, end } = setup();
    try {
      guard.native(packets[0]);
      await vi.advanceTimersByTimeAsync(14999);
      expect(assembler.bufferedBytes).toBe(1000);
      await vi.advanceTimersByTimeAsync(1);
      expect(assembler.bufferedBytes).toBe(0);
      expect(assembler.pending).toBe(0);
      expect(guard.evidence).toMatchObject({ unknown: false, rejected: 1 });
      expect(end).toHaveBeenCalledExactlyOnceWith("invalid_media");
      expect(guard.lastPlausibleMs).toBe(15000);
      expect(guard.observationComplete()).toBe(false);
    } finally {
      guard.stopExpiry();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the absolute deadline despite unique fragment progress", async () => {
    const { guard, packets, assembler } = setup();
    try {
      guard.native(packets[0]);
      await vi.advanceTimersByTimeAsync(1000);
      guard.native(packets[1]);
      expect(assembler.bufferedBytes).toBe(2000);
      await vi.advanceTimersByTimeAsync(14000);
      expect(assembler.pending).toBe(0);
      expect(guard.lastPlausibleMs).toBe(15000);
    } finally {
      guard.stopExpiry();
    }
  });

  it("expires an idle frame within 15250ms at the worst sweep phase", async () => {
    const { guard, packets, assembler } = setup();
    try {
      await vi.advanceTimersByTimeAsync(1);
      guard.native(packets[0]);
      await vi.advanceTimersByTimeAsync(14999);
      expect(assembler.pending).toBe(1);
      await vi.advanceTimersByTimeAsync(PLAYBACK_EXPIRY_SWEEP_MS);
      expect(assembler.pending).toBe(0);
      expect(guard.lastPlausibleMs - 1).toBeLessThanOrEqual(15250);
    } finally {
      guard.stopExpiry();
    }
  });

  it("duplicates reset ingress silence but never refresh idle expiry", async () => {
    const { guard, packets, assembler } = setup();
    try {
      guard.native(packets[0]);
      await vi.advanceTimersByTimeAsync(1500);
      guard.native(packets[0]);
      expect(guard.lastPlausibleMs).toBe(1500);
      expect(assembler.getDiagnostics().duplicateFragments).toBe(1);
      await vi.advanceTimersByTimeAsync(13500);
      expect(assembler.bufferedBytes).toBe(0);
      expect(guard.evidence.unknown).toBe(false);
      expect(guard.lastPlausibleMs).toBe(15000);
    } finally {
      guard.stopExpiry();
    }
  });

  it("conflicting fragments discard state and require fresh silence", () => {
    const { guard, packets, assembler, end } = setup();
    try {
      guard.native(packets[0]);
      const conflict = Buffer.from(packets[0]!);
      conflict[28] = 1;
      guard.native(conflict);
      expect(assembler.bufferedBytes).toBe(0);
      expect(assembler.getDiagnostics().conflicts).toBe(1);
      expect(guard.evidence.unknown).toBe(false);
      expect(end).toHaveBeenCalledWith("invalid_media");
    } finally {
      guard.stopExpiry();
    }
  });

  it("sweeps during cleanup and remains active in payload-free quarantine until teardown", async () => {
    const { guard, packets, assembler } = setup();
    guard.native(packets[0]);
    guard.capturing = false;
    await vi.advanceTimersByTimeAsync(15000);
    expect(assembler.pending).toBe(0);
    expect(guard.evidence.unknown).toBe(false);
    expect(guard.lastPlausibleMs).toBe(15000);
    guard.quarantine();
    expect(vi.getTimerCount()).toBe(1);
    guard.native(packets[0]);
    expect(assembler.bufferedBytes).toBe(0);
    guard.stopExpiry();
    guard.stopExpiry();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("invocation timer teardown", () => {
  it.each(["refused", "aborted", "no_media", "cap", "owner", "marker", "send", "pause", "deadline"])(
    "releases all timers after %s",
    async (mode) => {
      vi.useFakeTimers();
      vi.spyOn(nativePerformance, "now").mockImplementation(() => performance.now());
      const controller = new AbortController();
      let continuous = true;
      const candidate = new EventPlaybackCandidate({
        deadlineMs: performance.now() + 24000,
        continuous: () => continuous,
        startAllowed: () => mode !== "refused",
        signal: controller.signal,
        account: "synthetic",
        segment: () => 9,
        latch: () => {},
        marker: () => {
          if (mode === "marker") throw Error("fixture");
        },
        send: (packet) => {
          const sub = JSON.parse(packet.subarray(16).toString()).data.cmd;
          if (mode === "send" || (mode === "pause" && sub === 1)) throw Error("fixture");
          return true;
        },
      });
      const pending = candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
      if (mode === "owner") continuous = false;
      if (mode === "aborted" || mode === "pause") controller.abort();
      if (mode === "cap") candidate.end("capped");
      if (mode === "deadline") candidate.end("timeout");
      await vi.advanceTimersByTimeAsync(5010);
      await pending;
      const observation = candidate.observe();
      await vi.advanceTimersByTimeAsync(24010);
      await observation;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("tears down when observation throws", async () => {
    const { guard } = setup();
    guard.stopExpiry();
    let fail = false;
    const controller = new AbortController();
    const candidate = new EventPlaybackCandidate({
      deadlineMs: 24000,
      continuous: () => {
        if (fail) throw Error("fixture");
        return true;
      },
      startAllowed: () => true,
      signal: controller.signal,
      account: "synthetic",
      segment: () => 9,
      marker: () => {},
      latch: () => {},
      send: () => true,
    });
    const pending = candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
    controller.abort();
    await pending;
    fail = true;
    await expect(candidate.observe()).rejects.toThrow("fixture");
    expect(vi.getTimerCount()).toBe(0);
  });
});
