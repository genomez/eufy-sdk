import { zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { copyFramingDiagnostics, PassthroughFramer, type FramingDiagnostics, type PortalFramer } from "../framer.js";
import { PTCS_HEADER_LENGTH, PtcsFramer, PtcsReassembler, packetize } from "../ptcs-framer.js";

function compressedPackets(frame: Buffer, frameId: number): Buffer[] {
  const packets = packetize(zstdCompressSync(frame), { frameId, payloadBytes: 8 });
  for (const packet of packets) packet.writeUInt16LE(packet.readUInt16LE(18) | 0x0800, 18);
  return packets;
}

describe("framing diagnostics", () => {
  it("counts partial, duplicate and completed fragments without retaining packet data", () => {
    const delivered = vi.fn();
    const r = new PtcsReassembler(delivered);
    const packets = packetize(Buffer.from("synthetic-frame"), { frameId: 1, payloadBytes: 5 });
    expect(r.push(packets[2]!)).toBe(true);
    expect(r.push(packets[2]!)).toBe(true);
    expect(r.getDiagnostics()).toMatchObject({
      receivedPackets: 2,
      admittedFragments: 1,
      duplicateFragments: 1,
      completedFrames: 0,
      pendingFrames: 1,
      bufferedBytes: 5,
    });
    const detached = r.getDiagnostics();
    detached.receivedPackets = 999;
    detached.pendingFrames = 999;
    detached.bufferedBytes = 999;
    expect(r.getDiagnostics()).toMatchObject({ receivedPackets: 2, pendingFrames: 1, bufferedBytes: 5 });
    expect(r.push(packets[0]!)).toBe(true);
    expect(r.push(packets[1]!)).toBe(true);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(Buffer.from("synthetic-frame"), 0);
    const complete = r.getDiagnostics();
    expect(complete).toMatchObject({
      receivedPackets: 4,
      admittedFragments: 3,
      duplicateFragments: 1,
      completedFrames: 1,
      pendingFrames: 0,
      bufferedBytes: 0,
    });
    expect(Object.values(complete).every((value) => typeof value === "number" && Number.isSafeInteger(value))).toBe(
      true,
    );
    expect(JSON.stringify(complete)).not.toContain("synthetic-frame");
    expect(r.getDiagnostics()).toEqual(complete);
  });

  it.each(["sequence", "length", "compression", "payload", "last"] as const)(
    "counts conflicting %s without preserving the affected assembly",
    (kind) => {
      const r = new PtcsReassembler(vi.fn());
      const [first] = packetize(Buffer.alloc(6, 7), { frameId: 2, payloadBytes: 3 });
      expect(r.push(first!)).toBe(true);
      const conflict = Buffer.from(first!);
      if (kind === "sequence") conflict.writeUInt16LE(1, 6);
      if (kind === "length") conflict.writeUInt32LE(7, 12);
      if (kind === "compression") conflict.writeUInt16LE(conflict.readUInt16LE(18) | 0x0800, 18);
      if (kind === "payload") conflict[PTCS_HEADER_LENGTH] = 8;
      if (kind === "last") conflict.writeUInt16LE(conflict.readUInt16LE(18) | 0x0400, 18);
      expect(r.push(conflict)).toBe(false);
      expect(r.getDiagnostics()).toMatchObject({
        conflicts: 1,
        admittedFragments: 1,
        pendingFrames: 0,
        bufferedBytes: 0,
      });
    },
  );

  it("counts invalid lengths and metadata independently from resource limits", () => {
    const delivered = vi.fn();
    const r = new PtcsReassembler(delivered);
    expect(r.push(Buffer.from("PTCS"))).toBe(false);
    const [truncated] = packetize(Buffer.alloc(4, 1), { frameId: 10, payloadBytes: 4 });
    expect(r.push(truncated!.subarray(0, PTCS_HEADER_LENGTH + 3))).toBe(false);
    const [empty] = packetize(Buffer.alloc(0), { frameId: 11 });
    empty!.writeUInt16LE(0x4000, 18);
    expect(r.push(empty!)).toBe(false);
    const [short] = packetize(Buffer.alloc(4, 1), { frameId: 12 });
    short!.writeUInt32LE(5, 12);
    expect(r.push(short!)).toBe(false);
    const [overrun] = packetize(Buffer.alloc(4, 1), { frameId: 13 });
    overrun!.writeUInt32LE(3, 12);
    expect(r.push(overrun!)).toBe(false);
    expect(r.getDiagnostics()).toMatchObject({
      receivedPackets: 5,
      invalidMetadata: 5,
      admittedFragments: 1,
      completedFrames: 0,
      frameLimit: 0,
      fragmentLimit: 0,
      bufferLimit: 0,
      pendingFrames: 0,
      bufferedBytes: 0,
    });
    expect(delivered).not.toHaveBeenCalled();
  });

  it("reports frame, fragment, capacity and payload bounds without changing rejection policy", () => {
    const r = new PtcsReassembler(vi.fn(), {
      maxFrameBytes: 8,
      maxFragmentsPerFrame: 2,
      maxPendingFrames: 1,
      maxBufferedBytes: 5,
    });
    const [large] = packetize(Buffer.alloc(9, 1), { frameId: 20, payloadBytes: 3 });
    expect(r.push(large!)).toBe(false);
    const indexed = packetize(Buffer.alloc(6, 1), { frameId: 21, payloadBytes: 2 });
    expect(r.push(indexed[2]!)).toBe(false);
    const pending = packetize(Buffer.alloc(8, 1), { frameId: 22, payloadBytes: 4 });
    expect(r.push(pending[0]!)).toBe(true);
    const [other] = packetize(Buffer.alloc(2, 2), { frameId: 23, payloadBytes: 1 });
    expect(r.push(other!)).toBe(false);
    expect(r.getDiagnostics()).toMatchObject({ pendingFrames: 1, bufferedBytes: 4, capacity: 1 });
    expect(r.push(pending[1]!)).toBe(false);
    expect(r.getDiagnostics()).toMatchObject({
      receivedPackets: 5,
      admittedFragments: 1,
      frameLimit: 1,
      fragmentLimit: 1,
      capacity: 1,
      bufferLimit: 1,
      invalidMetadata: 0,
      pendingFrames: 0,
      bufferedBytes: 0,
    });
  });

  it("does not expire on reads or benign non-PTCS packets, and duplicates do not extend idle expiry", () => {
    let now = 0;
    const r = new PtcsReassembler(vi.fn(), { now: () => now, staleMs: 10, maxAgeMs: 100 });
    const [first] = packetize(Buffer.alloc(6), { frameId: 30, payloadBytes: 3 });
    expect(r.push(first!)).toBe(true);
    now = 9;
    expect(r.push(first!)).toBe(true);
    now = 10;
    const expiredButRetained = r.getDiagnostics();
    expect(expiredButRetained).toMatchObject({ pendingFrames: 1, bufferedBytes: 3, expiry: 0 });
    expect(r.getDiagnostics()).toEqual(expiredButRetained);
    expect(r.push(Buffer.from("keepalive"))).toBe(false);
    expect(r.getDiagnostics()).toMatchObject({ nonPtcsPackets: 1, pendingFrames: 1, expiry: 0 });
    expect(r.expire()).toBe(1);
    expect(r.expire()).toBe(0);
    expect(r.getDiagnostics()).toMatchObject({ duplicateFragments: 1, expiry: 1, pendingFrames: 0, bufferedBytes: 0 });
  });

  it("counts absolute expiry during admission even when fragments make progress", () => {
    let now = 0;
    const r = new PtcsReassembler(vi.fn(), { now: () => now, staleMs: 100, maxAgeMs: 10 });
    const packets = packetize(Buffer.alloc(9), { frameId: 31, payloadBytes: 3 });
    expect(r.push(packets[0]!)).toBe(true);
    now = 9;
    expect(r.push(packets[1]!)).toBe(true);
    now = 10;
    const [next] = packetize(Buffer.alloc(1), { frameId: 32 });
    expect(r.push(next!)).toBe(true);
    expect(r.getDiagnostics()).toMatchObject({ expiry: 1, completedFrames: 1, pendingFrames: 0, bufferedBytes: 0 });
  });

  it("counts complete compressed frames and bounded decompression failures", () => {
    const delivered = vi.fn();
    const r = new PtcsReassembler(delivered, { maxFrameBytes: 256 });
    const frame = Buffer.from("synthetic-compressed-frame".repeat(4));
    for (const packet of compressedPackets(frame, 40)) expect(r.push(packet)).toBe(true);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(frame, 0);
    const [invalid] = packetize(Buffer.from("invalid-compressed-content"), { frameId: 41 });
    invalid!.writeUInt16LE(invalid!.readUInt16LE(18) | 0x0800, 18);
    expect(r.push(invalid!)).toBe(false);
    const oversized = compressedPackets(Buffer.alloc(512, 1), 42);
    for (const packet of oversized.slice(0, -1)) expect(r.push(packet)).toBe(true);
    expect(r.push(oversized.at(-1)!)).toBe(false);
    expect(r.getDiagnostics()).toMatchObject({
      completedFrames: 1,
      decompression: 2,
      frameLimit: 0,
      invalidMetadata: 0,
      pendingFrames: 0,
      bufferedBytes: 0,
    });
  });

  it("keeps bare and non-PTCS traffic distinct, preserves final counters and resets on init", async () => {
    const f = new PtcsFramer();
    const delivered = vi.fn();
    const bare = Buffer.from("XZYHsynthetic-bare-frame");
    f.recvPacket(bare);
    expect(Object.values(f.getDiagnostics())).toEqual(Array(16).fill(0));
    await f.init(vi.fn(), delivered);
    try {
      f.recvPacket(bare);
      f.recvPacket(Buffer.from("keepalive"));
      const [pending] = packetize(Buffer.alloc(6), { frameId: 50, payloadBytes: 3 });
      f.recvPacket(pending!);
      expect(f.getDiagnostics()).toMatchObject({
        receivedPackets: 3,
        barePackets: 1,
        nonPtcsPackets: 1,
        completedFrames: 1,
        admittedFragments: 1,
        invalidMetadata: 0,
        pendingFrames: 1,
        bufferedBytes: 3,
      });
      const detached = f.getDiagnostics();
      detached.barePackets = 999;
      expect(f.getDiagnostics().barePackets).toBe(1);
      f.destroy();
      const final = f.getDiagnostics();
      expect(final).toMatchObject({
        receivedPackets: 3,
        barePackets: 1,
        completedFrames: 1,
        pendingFrames: 0,
        bufferedBytes: 0,
      });
      f.recvPacket(bare);
      f.destroy();
      expect(f.getDiagnostics()).toEqual(final);
      await f.init(vi.fn(), delivered);
      expect(Object.values(f.getDiagnostics())).toEqual(Array(16).fill(0));
    } finally {
      f.destroy();
    }
  });

  it("copies only bounded numeric observations and permits framers without diagnostics", () => {
    const optional: PortalFramer = new PassthroughFramer();
    expect(optional.getDiagnostics).toBeUndefined();
    const clean = new PtcsFramer().getDiagnostics();
    const supplied = {
      ...clean,
      receivedPackets: Number.MAX_SAFE_INTEGER + 100,
      barePackets: -1,
      nonPtcsPackets: 1.9,
      completedFrames: Number.POSITIVE_INFINITY,
      capacity: Number.NaN,
      conflicts: "synthetic-private-text",
      payload: Buffer.from("synthetic-private-text"),
    };
    const copied = copyFramingDiagnostics(supplied as unknown as FramingDiagnostics);
    expect(copied).toEqual({ ...clean, receivedPackets: Number.MAX_SAFE_INTEGER, nonPtcsPackets: 1 });
    expect(Object.keys(copied)).toEqual(Object.keys(clean));
    copied.receivedPackets = 3;
    expect(supplied.receivedPackets).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(JSON.stringify(copied)).not.toContain("synthetic-private-text");
  });

  it("saturates receive counters without wrapping or changing packet acceptance", () => {
    const r = new PtcsReassembler(vi.fn());
    const counters = Reflect.get(r, "counters") as Record<string, number>;
    counters.receivedPackets = Number.MAX_SAFE_INTEGER;
    counters.nonPtcsPackets = Number.MAX_SAFE_INTEGER;
    expect(r.push(Buffer.from("keepalive"))).toBe(false);
    expect(r.getDiagnostics()).toMatchObject({
      receivedPackets: Number.MAX_SAFE_INTEGER,
      nonPtcsPackets: Number.MAX_SAFE_INTEGER,
      invalidMetadata: 0,
    });
  });
});
