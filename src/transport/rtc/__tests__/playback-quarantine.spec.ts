import { describe, expect, it, vi } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { PlaybackIngress } from "../playback-ingress.js";
import { PtcsFramer, packetize } from "../ptcs-framer.js";
import { buildPortalHeader } from "../portal-packet.js";

let id = 0;
const frame = (command: number, selector: number, size = 5000) =>
  Buffer.concat([buildPortalHeader(command, size, 101, 9, selector), Buffer.alloc(size)]);
function packets(bytes: Buffer, route: number, compressed = false, fragmented = true) {
  const result = packetize(compressed ? zstdCompressSync(bytes) : bytes, {
    channel: route,
    frameId: ++id,
    payloadBytes: fragmented ? 8 : 1000,
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

describe("selector-specific quarantine", () => {
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
  it("bounds post-release compressed work without retaining partial media", async () => {
    const s = await setup();
    try {
      for (let i = 0; i < 40; i++) for (const p of packets(frame(1300, 6, 4), 4, true, false)) s.receive(p);
      expect(s.guard.evidence.decodedWorkBytes).toBe(4 * 1024 * 1024);
      expect(s.late).toHaveBeenCalledTimes(16);
      expect(s.guard.evidence.collectorAttempts).toBe(0);
      expect(s.guard.evidence.unknown).toBe(true);
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
