import { describe, expect, it } from "vitest";
import { lz4BlockDecompress } from "../lz4-block.js";

/**
 * The block decompressor, checked against blocks the reference implementation produced.
 *
 * Every compressed vector below came out of liblz4 1.9.4 (via `lz4.block.compress(data,
 * store_size=False, mode="high_compression")`) — the same bare, sizeless block the map stream carries.
 * Hand-rolled bytes would only prove this file agrees with itself; these prove it agrees with the
 * encoder on the other end of the wire.
 */

const hex = (s: string): Buffer => Buffer.from(s, "hex");

/**
 * A deterministic incompressible filler. A stock LCG, so the test can regenerate the plaintext instead
 * of carrying six hundred characters of it, and so the bytes stay identical on every run.
 */
const noise = (n: number): Buffer => {
  const out = Buffer.alloc(n);
  let x = 1;
  for (let i = 0; i < n; i++) {
    // `Math.imul` and not `*`: the product overflows the range JavaScript numbers hold exactly, and a
    // plain multiply would round it. This has to reproduce the generator byte for byte.
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
};

describe("lz4BlockDecompress — vectors from liblz4", () => {
  it("reads a block that is nothing but literals", () => {
    // Nine incompressible bytes: token 0x90 (nine literals, no match) and then the bytes themselves.
    // An encoder that finds nothing to repeat still has to emit the data, so it costs a byte.
    expect(lz4BlockDecompress(hex("90deadbeef0102030405"), 9)).toEqual(hex("deadbeef0102030405"));
  });

  it("reads a match that overlaps its own output", () => {
    // 64 zero bytes: one literal, then a match at offset 1 running 63 bytes into bytes that do not
    // exist yet when the copy starts. This is the case a `copy`/`copyWithin` shortcut gets wrong, and
    // it is the ordinary case in a map plane, most of which is unexplored space.
    expect(lz4BlockDecompress(hex("1f00010027500000000000"), 64)).toEqual(Buffer.alloc(64));
  });

  it("reads a literal run long enough to need the 255-chain", () => {
    // 300 literals: the token's nibble saturates at 15 and the rest arrives as 0xFF, 0x1E — 15 + 255 +
    // 30. liblz4 emits exactly this token and then the payload verbatim, there being nothing to match.
    const plain = noise(300);
    const block = Buffer.concat([hex("f0ff1e"), plain]);

    expect(lz4BlockDecompress(block, 300)).toEqual(plain);
  });

  it("reads a map-shaped plane: long runs, two fills, a match length past 255", () => {
    // 1 KiB of empty space with two bands drawn in it, which is what a pixel plane looks like. The
    // block ends `...ff 2c 50` — a match nibble of 15 extended by 255 — so this exercises the second
    // 255-chain alongside the first.
    const plane = Buffer.alloc(1024);
    plane.fill(0x55, 200, 260);
    plane.fill(0xaa, 500, 700);

    const block = hex("1f000100b41f550100281f000100dc1faa0100b41f000100ff2c500000000000");
    expect(lz4BlockDecompress(block, 1024)).toEqual(plane);
  });
});

describe("lz4BlockDecompress — what it refuses", () => {
  /** The map-shaped vector above, reused as a known-good block to damage. */
  const GOOD = hex("1f000100b41f550100281f000100dc1faa0100b41f000100ff2c500000000000");

  it("refuses a truncated block rather than returning the part that decoded", () => {
    // The failure this exists to catch. A short block does not announce itself — LZ4 has no checksum
    // and no terminator, so it simply stops early and a lenient reader hands back a half-drawn map that
    // looks entirely real. Only the size the caller already knows can tell the difference.
    for (let cut = 1; cut < GOOD.length; cut++) {
      expect(lz4BlockDecompress(GOOD.subarray(0, cut), 1024), `cut at ${cut}`).toBeUndefined();
    }
  });

  it("refuses a block that decodes to the wrong size", () => {
    expect(lz4BlockDecompress(GOOD, 1023)).toBeUndefined();
    expect(lz4BlockDecompress(GOOD, 1025)).toBeUndefined();
  });

  it("refuses a back-reference pointing before the start of the output", () => {
    // One literal, then a match at offset 2 — a byte that was never written. Reading it would mean
    // reading whatever the buffer happened to hold.
    expect(lz4BlockDecompress(hex("14aa020004"), 8)).toBeUndefined();
  });

  it("refuses a zero offset, which names no byte at all", () => {
    expect(lz4BlockDecompress(hex("14aa000004"), 8)).toBeUndefined();
  });

  it("refuses a literal run that runs off the end of the block", () => {
    expect(lz4BlockDecompress(hex("90dead"), 9)).toBeUndefined();
  });

  it("refuses a 255-chain that never terminates before the end of the block", () => {
    expect(lz4BlockDecompress(hex("f0ffffff"), 800)).toBeUndefined();
  });

  it("refuses a size that is not a plausible allocation", () => {
    // `size` arrives from the wire. A corrupt value must come back as `undefined`, not as an attempt to
    // reserve it.
    expect(lz4BlockDecompress(GOOD, -1)).toBeUndefined();
    expect(lz4BlockDecompress(GOOD, 1.5)).toBeUndefined();
    expect(lz4BlockDecompress(GOOD, Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  it("reads an empty block as empty, and as nothing else", () => {
    expect(lz4BlockDecompress(new Uint8Array(0), 0)).toEqual(Buffer.alloc(0));
    expect(lz4BlockDecompress(new Uint8Array(0), 1)).toBeUndefined();
  });
});
