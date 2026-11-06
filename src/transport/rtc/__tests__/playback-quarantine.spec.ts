import { describe, expect, it, vi } from "vitest";
import { zstdCompressSync } from "node:zlib";
import {
  PlaybackIngress,
  PLAYBACK_LATE_WINDOW_MS,
  PLAYBACK_LATE_WINDOW_BYTES,
  PLAYBACK_LATE_WINDOW_FRAMES,
} from "../playback-ingress.js";
import { PtcsFramer, packetize } from "../ptcs-framer.js";
import { buildPortalHeader } from "../portal-packet.js";

const PLAYBACK_FRAME_BYTES = 256 * 1024;
let id = 0;
const frame = (command: number, selector: number, size = 5000) =>
  Buffer.concat([buildPortalHeader(command, size, 101, 9, selector), Buffer.alloc(size)]);
function packets(bytes: Buffer, route: number, compressed = false, fragmented = true, fragmentBytes = 8) {
  const result = packetize(compressed ? zstdCompressSync(bytes) : bytes, {
    channel: route,
    frameId: ++id,
    payloadBytes: fragmented ? fragmentBytes : 1000,
  });
  if (compressed) for (const p of result) p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
  return result;
}
async function setup(released = true) {
  let unresolved = !released,
    now = 0;
  const late = vi.fn(() => {
    unresolved = true;
  });
  const delivered = vi.fn();
  const guard = new PlaybackIngress({
    now: () => now,
    end: vi.fn(),
    media: vi.fn(),
    late,
    liveAllowed: () => !unresolved,
  });
  guard.reserve(6, 7);
  if (released) guard.quarantine();
  const framer = new PtcsFramer();
  await framer.init(
    () => {
      throw Error("network_disabled");
    },
    (bytes, link) => {
      if (guard.decoded(bytes, link)) delivered();
    },
  );
  return {
    guard,
    late,
    delivered,
    setNow: (v: number) => {
      now = v;
    },
    receive: (p: Buffer) => {
      if (guard.native(p)) framer.recvPacket(p);
    },
    close: () => {
      framer.destroy();
      guard.stopExpiry();
    },
  };
}

it.each([1300, 1301, 1303])("does not exempt quarantined live command %s on a rejected channel", async (command) => {
  const s = await setup();
  try {
    const bytes = Buffer.concat([buildPortalHeader(command, 22, 102, 9, 1), Buffer.alloc(22)]);
    expect(s.guard.decoded(bytes, 5)).toBe(false);
    expect(s.guard.prestartSafe()).toBe(false);
    expect(s.guard.evidence.wrongRouteFrames).toBe(1);
  } finally {
    s.close();
  }
});

describe("selector-specific quarantine", () => {
  for (const command of [1300, 1301])
    for (const compressed of [false, true])
      for (const route of [4, 5])
        it(`fails closed for reserved length mismatch command=${command} compressed=${compressed} route=${route}`, async () => {
          const s = await setup();
          try {
            const bytes = frame(command, 6, 4);
            bytes.writeUInt32LE(5, 6);
            s.receive(packets(bytes, route, compressed, false)[0]!);
            expect(s.late).toHaveBeenCalledOnce();
            expect(s.guard.evidence.unknown).toBe(true);
            s.receive(packets(frame(1300, 1, 4), 5, false, false)[0]!);
            expect(s.delivered).not.toHaveBeenCalled();
          } finally {
            s.close();
          }
        });
  for (const kind of [
    "missing",
    "invalid",
    "reserved-control",
    "inner-oversized",
    "envelope-truncated",
    "envelope-oversized",
  ])
    for (const compressed of [false, true])
      it(`fails closed for complete playback ${kind} compressed=${compressed}`, async () => {
        const s = await setup();
        try {
          let bytes = frame(kind === "reserved-control" ? 1350 : 1300, 6, 4);
          if (kind === "missing") bytes = bytes.subarray(0, 8);
          if (kind === "invalid") bytes[0] = bytes[0]! ^ 0xff;
          if (kind === "inner-oversized") bytes.writeUInt32LE(3, 6);
          let p = packets(bytes, 4, compressed, false)[0]!;
          if (kind === "envelope-truncated") p = p.subarray(0, 29);
          if (kind === "envelope-oversized") p.writeUInt32LE(PLAYBACK_FRAME_BYTES + 1, 12);
          s.receive(p);
          expect(s.late).toHaveBeenCalledOnce();
          expect(s.guard.evidence.unknown).toBe(true);
          expect(s.guard.evidence.collectorAttempts).toBe(0);
        } finally {
          s.close();
        }
      });
  for (const route of [0, 5])
    for (const compressed of [false, true])
      it(`does not re-latch ordinary malformed route=${route} compressed=${compressed}`, async () => {
        const s = await setup();
        try {
          const bytes = frame(1300, 1, 4);
          bytes.writeUInt32LE(5, 6);
          s.receive(packets(bytes, route, compressed, false)[0]!);
          s.receive(packets(Buffer.alloc(8), route, compressed, false)[0]!);
          expect(s.late).not.toHaveBeenCalled();
          expect(s.delivered).not.toHaveBeenCalled();
        } finally {
          s.close();
        }
      });
  it("fails closed for a bare reserved length mismatch through wrong", async () => {
    const s = await setup();
    try {
      const bytes = frame(1301, 7, 4);
      bytes.writeUInt32LE(5, 6);
      s.receive(bytes);
      expect(s.late).toHaveBeenCalledOnce();
      expect(s.guard.evidence.unknown).toBe(true);
    } finally {
      s.close();
    }
  });
  for (const route of [1, 5])
    for (const compressed of [false, true])
      for (const fragmented of [false, true]) {
        it(`delivers separately admitted live route=${route} compressed=${compressed} fragmented=${fragmented}`, async () => {
          const s = await setup();
          try {
            for (const p of packets(frame(1300, 1, fragmented ? 5000 : 4), route, compressed, fragmented)) s.receive(p);
            expect(s.delivered).toHaveBeenCalledOnce();
            expect(s.late).not.toHaveBeenCalled();
            expect(s.guard.evidence.wrongRouteFrames).toBe(0);
          } finally {
            s.close();
          }
        });
      }
  for (const selector of [6, 7])
    for (const command of [1300, 1301])
      for (const compressed of [false, true]) {
        it(`re-latches only decoded reserved media selector=${selector} command=${command} compressed=${compressed}`, async () => {
          const s = await setup();
          try {
            const parts = packets(frame(command, selector), 5, compressed);
            expect(parts.length).toBeGreaterThan(1);
            for (const p of parts.slice(0, -1)) s.receive(p);
            expect(s.late).not.toHaveBeenCalled();
            expect(s.guard.evidence.wrongRouteFrames).toBe(0);
            s.receive(parts.at(-1)!);
            expect(s.late).toHaveBeenCalledOnce();
            expect(s.guard.evidence.wrongRouteFrames).toBe(1);
            expect(s.delivered).not.toHaveBeenCalled();
            for (const p of packets(frame(1300, 1), 5)) s.receive(p);
            expect(s.delivered).not.toHaveBeenCalled();
          } finally {
            s.close();
          }
        });
      }
  it("unattributable decoded media is discarded without blocking a later admitted live frame", async () => {
    const s = await setup();
    try {
      for (const p of packets(frame(1300, 8), 5)) s.receive(p);
      expect(s.delivered).not.toHaveBeenCalled();
      expect(s.guard.evidence.wrongRouteFrames).toBe(1);
      expect(s.late).not.toHaveBeenCalled();
      for (const p of packets(frame(1300, 1), 5)) s.receive(p);
      expect(s.delivered).toHaveBeenCalledOnce();
    } finally {
      s.close();
    }
  });
  for (const route of [0, 1, 2, 3, 4, 5, 9]) {
    it(`fragments still prevent false silence before release on route=${route}`, async () => {
      const s = await setup(false);
      try {
        const first = packets(frame(1300, 6), route)[0]!;
        s.setNow(4999);
        s.receive(first);
        expect(s.guard.lastPlausibleMs).toBe(4999);
        s.setNow(5999);
        s.receive(first);
        expect(s.guard.lastPlausibleMs).toBe(5999);
        expect(s.late).not.toHaveBeenCalled();
        expect(s.delivered).not.toHaveBeenCalled();
        if (route !== 4) expect(s.guard.observationComplete()).toBe(false);
      } finally {
        s.close();
      }
    });
  }
  it("playback-route quarantine observes fragments without assembling or re-latching", async () => {
    const s = await setup();
    try {
      s.setNow(100);
      for (const p of packets(frame(1300, 6), 4)) s.receive(p);
      expect(s.guard.lastPlausibleMs).toBe(100);
      expect(s.late).not.toHaveBeenCalled();
      expect(s.guard.evidence.wrongRouteFrames).toBe(0);
      expect(s.delivered).not.toHaveBeenCalled();
    } finally {
      s.close();
    }
  });
  for (const selector of [6, 7])
    for (const command of [1300, 1301])
      for (const compressed of [false, true]) {
        it(`re-latches complete playback-route media selector=${selector} command=${command} compressed=${compressed}`, async () => {
          const s = await setup();
          try {
            s.setNow(100);
            const complete = packets(frame(command, selector, 4), 4, compressed, false);
            expect(complete).toHaveLength(1);
            s.receive(complete[0]!);
            expect(s.guard.lastPlausibleMs).toBe(100);
            expect(s.late).toHaveBeenCalledOnce();
            expect(s.delivered).not.toHaveBeenCalled();
            expect(s.guard.evidence.collectorAttempts).toBe(0);
            expect(s.guard.evidence.mediaBytes).toBe(0);
            expect(s.guard.evidence.wrongRouteFrames).toBe(0);
            expect(s.guard.observationComplete()).toBe(true);
          } finally {
            s.close();
          }
        });
      }
  it("inspects a compressed reserved frame after allowed live traffic exceeds every old budget", async () => {
    const s = await setup();
    try {
      const live = packets(frame(1300, 1, 512), 5, false, false)[0]!;
      for (let i = 0; i < 16385; i++) s.receive(live);
      const ordinary = packets(frame(1300, 1, 4), 4, true, false)[0]!;
      for (let i = 0; i < 300; i++) s.receive(ordinary);
      expect(s.delivered).toHaveBeenCalledTimes(16385);
      expect(s.guard.evidence.nativeBytes).toBeGreaterThan(4 * 1024 * 1024);
      expect(s.guard.evidence.nativeMessages).toBeGreaterThan(16384);
      expect(s.guard.evidence.decodedWorkBytes).toBe(300 * 20);
      expect(s.late).not.toHaveBeenCalled();
      s.receive(packets(frame(1301, 7, 4), 4, true, false)[0]!);
      expect(s.late).toHaveBeenCalledOnce();
      expect(s.guard.evidence.unknown).toBe(false);
      s.receive(live);
      expect(s.delivered).toHaveBeenCalledTimes(16385);
    } finally {
      s.close();
    }
  });
  it.each([false, true])(
    "sustained 30 fps live traffic refills across five windows, compressed=%s",
    async (compressed) => {
      const s = await setup();
      try {
        const live = packets(frame(1300, 1, PLAYBACK_FRAME_BYTES - 16), 5, compressed, true, 1000);
        const inspection = packets(frame(1300, 1, compressed ? PLAYBACK_FRAME_BYTES - 16 : 512), 4, compressed, false);
        expect(inspection).toHaveLength(1);
        for (let window = 0; window < 5; window++) {
          for (let i = 0; i < 30; i++) {
            s.setNow(window * PLAYBACK_LATE_WINDOW_MS + i * 33);
            for (const p of live) s.receive(p);
            s.receive(inspection[0]!);
          }
          expect(s.delivered).toHaveBeenCalledTimes((window + 1) * 30);
          expect(s.guard.evidence.decodedWorkBytes).toBe((window + 1) * 30 * (compressed ? PLAYBACK_FRAME_BYTES : 528));
          expect(s.late).not.toHaveBeenCalled();
          expect(s.guard.evidence.unknown).toBe(false);
        }
        s.receive(packets(frame(1300, 6, 4), 4, true, false)[0]!);
        expect(s.late).toHaveBeenCalledOnce();
        expect(s.guard.evidence.collectorAttempts).toBe(0);
        expect(s.guard.evidence.mediaBytes).toBe(0);
      } finally {
        s.close();
      }
    },
  );
  it.each(["bytes", "frames"])("fails closed at the post-release %s window limit and refills", async (limit) => {
    const s = await setup();
    try {
      const size = limit === "bytes" ? PLAYBACK_FRAME_BYTES - 16 : 4;
      const count = limit === "bytes" ? PLAYBACK_LATE_WINDOW_BYTES / PLAYBACK_FRAME_BYTES : PLAYBACK_LATE_WINDOW_FRAMES;
      const ordinary = packets(frame(1300, 1, size), 4, true, false)[0]!;
      for (let i = 0; i < count; i++) s.receive(ordinary);
      expect(s.late).not.toHaveBeenCalled();
      expect(s.guard.evidence.decodedWorkBytes).toBe(count * (size + 16));
      s.receive(packets(frame(1301, 7, 4), 4, true, false)[0]!);
      expect(s.late).toHaveBeenCalledOnce();
      expect(s.guard.evidence.unknown).toBe(true);
      expect(s.guard.evidence.decodedWorkBytes).toBe(count * (size + 16));
      s.setNow(PLAYBACK_LATE_WINDOW_MS);
      s.receive(packets(frame(1301, 7, 4), 4, true, false)[0]!);
      expect(s.late).toHaveBeenCalledTimes(2);
      expect(s.guard.evidence.decodedWorkBytes).toBe(count * (size + 16) + 20);
      expect(s.guard.evidence.collectorAttempts).toBe(0);
    } finally {
      s.close();
    }
  });
  it("capture cutoff cannot disable post-release inspection", async () => {
    const s = await setup(false);
    try {
      const live = packets(frame(1300, 1, 512), 5, false, false)[0]!;
      for (let i = 0; i < 8000; i++) s.receive(live);
      expect(s.guard.evidence.cutoff).toBe(true);
      s.guard.quarantine();
      s.receive(packets(frame(1300, 6, 4), 4, true, false)[0]!);
      expect(s.late).toHaveBeenCalledOnce();
      expect(s.guard.evidence.decodedWorkBytes).toBe(20);
    } finally {
      s.close();
    }
  });
  it("complete malformed compression fails closed without a finalized end callback", async () => {
    const s = await setup();
    try {
      const p = packets(Buffer.from("invalid-compression"), 4, false, false)[0]!;
      p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
      s.receive(p);
      expect(s.late).toHaveBeenCalledOnce();
      expect(s.guard.evidence.unknown).toBe(true);
      expect(s.guard.evidence.decodedWorkBytes).toBe(PLAYBACK_FRAME_BYTES);
      expect(s.guard.evidence.collectorAttempts).toBe(0);
    } finally {
      s.close();
    }
  });
  for (const selector of [1, 8])
    it(`ignores complete playback-route media without a reserved selector ${selector}`, async () => {
      const s = await setup();
      try {
        for (const p of packets(frame(1300, selector, 4), 4, false, false)) s.receive(p);
        expect(s.late).not.toHaveBeenCalled();
        expect(s.delivered).not.toHaveBeenCalled();
      } finally {
        s.close();
      }
    });
});
