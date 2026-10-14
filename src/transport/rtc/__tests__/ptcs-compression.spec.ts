import { constants, zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { packetize, PtcsFramer, PtcsReassembler } from "../ptcs-framer.js";

/** Synthetic compressed bytes split across independently marked PTCS fragments. */
function compressedPackets(encoded: Buffer, frameId = 1, payloadBytes = 7): Buffer[] {
  const packets = packetize(encoded, { frameId, channel: 2, payloadBytes });
  for (const packet of packets) packet.writeUInt16LE(packet.readUInt16LE(18) | 0x0800, 18);
  return packets;
}

/** A synthetic Zstandard frame with one raw block and explicit content-size/window declarations. */
function rawFrame(value: Buffer, windowLog = 10, contentBytes = 0): Buffer {
  const single = contentBytes === 1;
  const contentFlag = contentBytes <= 1 ? 0 : Math.log2(contentBytes);
  const header = Buffer.alloc(5 + (single ? 0 : 1) + contentBytes);
  header.writeUInt32LE(0xfd2fb528);
  header[4] = (contentFlag << 6) | (single ? 0x20 : 0);
  if (!single) header[5] = (windowLog - 10) << 3;
  let size = BigInt(value.length - (contentBytes === 2 ? 256 : 0));
  for (let i = 0; i < contentBytes; i++) {
    header[header.length - contentBytes + i] = Number(size & 255n);
    size >>= 8n;
  }
  const block = Buffer.alloc(3);
  block.writeUIntLE((value.length << 3) | 1, 0, 3);
  return Buffer.concat([header, block, value]);
}

/** Complete input with no delivery must release its assembly and remain reusable. */
function expectRejected(encoded: Buffer, maxFrameBytes = 8192): void {
  const frame = vi.fn();
  const r = new PtcsReassembler(frame, { maxFrameBytes, maxPendingFrames: 1 });
  const chunks = compressedPackets(encoded);
  let accepted = true;
  for (const chunk of chunks) accepted = r.push(chunk);
  expect(accepted).toBe(false);
  expect(frame).not.toHaveBeenCalled();
  expect(r.pending).toBe(0);
  expect(r.bufferedBytes).toBe(0);
  const plain = Buffer.from("recovered");
  for (const chunk of packetize(plain, { frameId: 1, channel: 2 })) expect(r.push(chunk)).toBe(true);
  expect(frame).toHaveBeenCalledExactlyOnceWith(plain, 2);
}

describe("PTCS compressed receive frames", () => {
  it.each([false, true])("decompresses exactly once after complete assembly, reversed: %s", (reverse) => {
    const original = Buffer.from('XZYH{"params":[{"value":"synthetic-value"}]}');
    const encoded = zstdCompressSync(original);
    const chunks = compressedPackets(encoded);
    if (reverse) chunks.reverse();
    const frame = vi.fn();
    const r = new PtcsReassembler(frame);
    for (const chunk of chunks.slice(0, -1)) expect(r.push(chunk)).toBe(true);
    expect(frame).not.toHaveBeenCalled();
    expect(r.push(chunks.at(-1)!)).toBe(true);
    expect(frame).toHaveBeenCalledExactlyOnceWith(original, 2);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
  });

  it("leaves unflagged compressed-looking bytes unchanged", () => {
    const encoded = zstdCompressSync(Buffer.from("synthetic-value"));
    const frame = vi.fn();
    const r = new PtcsReassembler(frame);
    for (const packet of packetize(encoded, { frameId: 1, channel: 2 })) expect(r.push(packet)).toBe(true);
    expect(frame).toHaveBeenCalledExactlyOnceWith(encoded, 2);
  });

  it("uses compressed length for assembly and supports an empty decoded frame", () => {
    for (const original of [Buffer.alloc(0), Buffer.alloc(1024, 65)]) {
      const frame = vi.fn();
      const r = new PtcsReassembler(frame);
      const encoded = zstdCompressSync(original);
      for (const packet of compressedPackets(encoded)) {
        expect(packet.readUInt32LE(12)).toBe(encoded.length);
        expect(r.push(packet)).toBe(true);
      }
      expect(frame).toHaveBeenCalledExactlyOnceWith(original, 2);
    }
  });

  it.each([false, true])(
    "rejects mixed compression flags including identical duplicate bytes, initially compressed: %s",
    (compressed) => {
      for (const duplicate of [false, true]) {
        const frame = vi.fn();
        const r = new PtcsReassembler(frame);
        const chunks = compressedPackets(zstdCompressSync(Buffer.from("synthetic-value")));
        const first = Buffer.from(chunks[0]!);
        if (!compressed) first.writeUInt16LE(first.readUInt16LE(18) & ~0x0800, 18);
        const conflicting = Buffer.from(chunks[duplicate ? 0 : 1]!);
        conflicting.writeUInt16LE(
          compressed ? conflicting.readUInt16LE(18) & ~0x0800 : conflicting.readUInt16LE(18) | 0x0800,
          18,
        );
        expect(r.push(first)).toBe(true);
        expect(r.push(conflicting)).toBe(false);
        expect(r.pending).toBe(0);
        expect(r.bufferedBytes).toBe(0);
        expect(frame).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a conflicting compression flag when the last fragment arrives first", () => {
    const frame = vi.fn();
    const r = new PtcsReassembler(frame);
    const chunks = compressedPackets(zstdCompressSync(Buffer.from("synthetic-value")));
    expect(r.push(chunks.at(-1)!)).toBe(true);
    const first = chunks[0]!;
    first.writeUInt16LE(first.readUInt16LE(18) & ~0x0800, 18);
    expect(r.push(first)).toBe(false);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
    expect(frame).not.toHaveBeenCalled();
  });

  it("ignores identical compressed duplicates without charging them twice", () => {
    const original = Buffer.from("synthetic-value");
    const chunks = compressedPackets(zstdCompressSync(original));
    const frame = vi.fn();
    const r = new PtcsReassembler(frame);
    expect(r.push(chunks[0]!)).toBe(true);
    const retained = r.bufferedBytes;
    expect(r.push(chunks[0]!)).toBe(true);
    expect(r.bufferedBytes).toBe(retained);
    for (const chunk of chunks.slice(1)) expect(r.push(chunk)).toBe(true);
    expect(frame).toHaveBeenCalledExactlyOnceWith(original, 2);
  });

  it("rejects every incomplete prefix even when native decoding could return partial bytes", () => {
    for (const checksumFlag of [0, 1]) {
      const encoded = zstdCompressSync(Buffer.from("synthetic-value"), {
        params: { [constants.ZSTD_c_checksumFlag]: checksumFlag },
      });
      for (let length = 0; length < encoded.length; length++) expectRejected(encoded.subarray(0, length));
    }
  });

  it("rejects concatenated streams, skippable frames and trailing bytes", () => {
    const encoded = zstdCompressSync(Buffer.from("synthetic-value"));
    expectRejected(Buffer.concat([encoded, encoded]));
    expectRejected(Buffer.concat([encoded, Buffer.from([0])]));
    const skippable = Buffer.alloc(8);
    skippable.writeUInt32LE(0x184d2a50);
    expectRejected(skippable);
    expectRejected(Buffer.concat([encoded, skippable]));
  });

  it("rejects malformed magic, reserved fields, reserved blocks and checksum corruption", () => {
    expectRejected(Buffer.from("synthetic-invalid-compressed-content"));
    const reserved = rawFrame(Buffer.from("synthetic-value"));
    reserved[4]! |= 8;
    expectRejected(reserved);
    const block = rawFrame(Buffer.from("synthetic-value"));
    block[6]! |= 6;
    expectRejected(block);
    const checksum = zstdCompressSync(Buffer.from("synthetic-value"), {
      params: { [constants.ZSTD_c_checksumFlag]: 1 },
    });
    checksum[checksum.length - 1]! ^= 1;
    expectRejected(checksum);
  });

  it.each([0, 1, 2, 4, 8])("accepts complete raw blocks with content-size field width %i", (width) => {
    const original = Buffer.alloc(width === 2 ? 300 : 16, 65);
    const frame = vi.fn();
    const r = new PtcsReassembler(frame);
    for (const chunk of compressedPackets(rawFrame(original, 10, width))) expect(r.push(chunk)).toBe(true);
    expect(frame).toHaveBeenCalledExactlyOnceWith(original, 2);
  });

  it("accepts complete RLE blocks and ignores the unused descriptor bit", () => {
    const original = Buffer.alloc(32, 65);
    const encoded = rawFrame(original);
    encoded[4]! |= 0x10;
    encoded.writeUIntLE((original.length << 3) | 3, 6, 3);
    const frame = vi.fn();
    const r = new PtcsReassembler(frame);
    for (const chunk of compressedPackets(encoded.subarray(0, 10))) expect(r.push(chunk)).toBe(true);
    expect(frame).toHaveBeenCalledExactlyOnceWith(original, 2);
  });

  it("rejects a declared content size that differs from decoded output", () => {
    const encoded = rawFrame(Buffer.alloc(16, 65), 10, 1);
    encoded[5] = 17;
    expectRejected(encoded);
  });

  it.each([0, 1])(
    "bounds output with known and unknown content sizes, declared size enabled: %i",
    (contentSizeFlag) => {
      const encoded = zstdCompressSync(Buffer.alloc(4096, 65), {
        params: { [constants.ZSTD_c_contentSizeFlag]: contentSizeFlag },
      });
      expect(encoded.length).toBeLessThan(128);
      expectRejected(encoded, 128);
    },
  );

  it("enforces the decoder window budget independently of output size", () => {
    const original = Buffer.alloc(16, 65);
    expectRejected(rawFrame(original, 11), 1024);
    expectRejected(rawFrame(original, 24), 16 * 1024 * 1024);
    const frame = vi.fn();
    const r = new PtcsReassembler(frame, { maxFrameBytes: 1024 });
    for (const chunk of compressedPackets(rawFrame(original, 10))) expect(r.push(chunk)).toBe(true);
    expect(frame).toHaveBeenCalledExactlyOnceWith(original, 2);
  });

  it("bounds unknown-size expansion even when the declared window fits", () => {
    const encoded = rawFrame(Buffer.alloc(512, 65));
    encoded.writeUIntLE((512 << 3) | 3, 6, 3);
    expectRejected(encoded.subarray(0, 10), 128);
  });

  it("releases capacity before delivery and preserves callback exceptions", () => {
    const original = Buffer.from("synthetic-value");
    const failure = new Error("synthetic callback failure");
    const frame = vi.fn().mockImplementationOnce(() => {
      throw failure;
    });
    const r = new PtcsReassembler(frame, { maxPendingFrames: 1 });
    const chunks = compressedPackets(zstdCompressSync(original));
    for (const chunk of chunks.slice(0, -1)) r.push(chunk);
    expect(() => r.push(chunks.at(-1)!)).toThrow(failure);
    expect(r.pending).toBe(0);
    expect(r.bufferedBytes).toBe(0);
    for (const chunk of compressedPackets(zstdCompressSync(original), 2)) expect(r.push(chunk)).toBe(true);
    expect(frame).toHaveBeenCalledTimes(2);
  });

  it("applies bounded decompression through PtcsFramer and preserves channel mapping", async () => {
    const original = Buffer.from("synthetic-value");
    const frame = vi.fn();
    const framer = new PtcsFramer({ maxFrameBytes: 128 });
    try {
      await framer.init(vi.fn(), frame);
      for (const chunk of compressedPackets(zstdCompressSync(Buffer.alloc(4096)))) framer.recvPacket(chunk);
      expect(frame).not.toHaveBeenCalled();
      for (const chunk of compressedPackets(zstdCompressSync(original), 2)) framer.recvPacket(chunk);
      expect(frame).toHaveBeenCalledExactlyOnceWith(original, 3);
    } finally {
      framer.destroy();
    }
  });
});
