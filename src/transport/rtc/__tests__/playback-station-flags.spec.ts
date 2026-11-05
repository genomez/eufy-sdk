import { describe, expect, it, vi } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { PlaybackIngress, PLAYBACK_FRAME_BYTES } from "../playback-ingress.js";
import { PtcsFramer, packetize } from "../ptcs-framer.js";
import { buildPortalHeader } from "../portal-packet.js";

let id = 0;
const frame = (command: number, size: number) =>
  Buffer.concat([buildPortalHeader(command, size, 101, 9, 6), Buffer.alloc(size, 7)]);
const orFlag = (packets: Buffer[], bits: number) => {
  for (const p of packets) p.writeUInt16LE(p.readUInt16LE(18) | bits, 18);
  return packets;
};
const split = (bytes: Buffer, payloadBytes = 800, frameId = ++id, sequence = 0, channel = 4) =>
  packetize(bytes, { channel, frameId, payloadBytes, sequence });

async function capturing() {
  const media = vi.fn();
  const ingress = new PlaybackIngress({ now: () => 0, end: vi.fn(), media });
  ingress.reserve(6, 7);
  ingress.capturing = true;
  const framer = new PtcsFramer({ now: () => 0 });
  await framer.init(
    () => {},
    (bytes, link) => ingress.decoded(bytes, link),
  );
  return {
    ingress,
    media,
    receive: (packets: Buffer[]) => {
      for (const p of packets) if (ingress.native(p)) ingress.received(framer.recvPacket(p));
    },
    close: () => {
      framer.destroy();
      ingress.stopExpiry();
    },
  };
}

describe("playback flags the station sends", () => {
  it("accepts bit 0x2000 on every fragment of a playback video frame", async () => {
    const s = await capturing();
    try {
      s.receive(orFlag(split(frame(1300, 52_000)), 0x2000));
      expect(s.ingress.evidence.firstRejectionReason).toBe("none");
      expect(s.media).toHaveBeenCalledOnce();
    } finally {
      s.close();
    }
  });

  for (const bits of [0x8000, 0x1000])
    it(`still rejects reserved bit 0x${bits.toString(16)}`, async () => {
      const s = await capturing();
      try {
        s.receive(orFlag(split(frame(1300, 4000)), bits));
        expect(s.ingress.evidence.firstRejectionReason).toBe("flags");
        expect(s.media).not.toHaveBeenCalled();
      } finally {
        s.close();
      }
    });

  it("reserves the declared size for flagged plain audio frames, so many fit the work budget", async () => {
    const s = await capturing();
    try {
      for (let n = 0; n < 40; n++) s.receive(orFlag(split(frame(1301, 200)), 0x0800));
      expect(s.ingress.evidence.firstRejectionReason).toBe("none");
      expect(s.media).toHaveBeenCalledTimes(40);
      expect(s.ingress.evidence.decodedWorkBytes).toBeLessThan(64 * 1024);
    } finally {
      s.close();
    }
  });

  it("still reserves the inflation ceiling for a genuinely compressed frame", async () => {
    const s = await capturing();
    try {
      s.receive(orFlag(split(zstdCompressSync(frame(1300, 20_000))), 0x0800));
      expect(s.ingress.evidence.firstRejectionReason).toBe("none");
      expect(s.media).toHaveBeenCalledOnce();
      expect(s.ingress.evidence.decodedWorkBytes).toBeGreaterThanOrEqual(PLAYBACK_FRAME_BYTES);
    } finally {
      s.close();
    }
  });

  it("tells apart an audio and a video frame that share one frame id", async () => {
    const s = await capturing();
    try {
      const shared = ++id;
      const video = split(frame(1300, 6000), 800, shared, 5);
      const audio = orFlag(split(frame(1301, 200), 800, shared, 6), 0x0800);
      s.receive([video[0]!, video[1]!, audio[0]!, ...video.slice(2)]);
      expect(s.ingress.evidence.firstRejectionReason).toBe("none");
      expect(s.media).toHaveBeenCalledTimes(2);
    } finally {
      s.close();
    }
  });

  it("keeps the ceiling when a later fragment of a flagged frame arrives first", async () => {
    const s = await capturing();
    try {
      const packets = orFlag(split(frame(1300, 4000)), 0x0800);
      s.receive([packets[1]!]);
      expect(s.ingress.evidence.decodedWorkBytes).toBeGreaterThanOrEqual(PLAYBACK_FRAME_BYTES);
    } finally {
      s.close();
    }
  });
});
