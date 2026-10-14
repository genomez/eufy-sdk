/**
 * Decompressor for a raw LZ4 *block* — the form the map stream's pixel planes arrive in.
 *
 * The robot publishes its map over a second MQTT topic, and the pixel planes inside are compressed
 * with LZ4 whenever that saves anything. There is no flag saying so: the message carries both the
 * `pixels` bytes and a `pixel_size`, and **the two disagreeing IS the flag** — a plane that compressed
 * to nothing useful is sent verbatim, with the two equal. So the caller decides, and passes the size
 * it already has.
 *
 * **Why not an npm package.** What travels here is a bare LZ4 block: no magic number, no frame header,
 * no checksum, no stored size. Every LZ4 package on npm speaks the *frame* format by default and
 * exposes the block API awkwardly if at all, and the block format itself is one loop over four
 * quantities. A dependency would be more code to audit than the sixty lines here, so this is
 * hand-written and tested against blocks produced by the reference liblz4 implementation.
 *
 * @module core/lz4-block
 */

/**
 * The largest output this will allocate, well past any real map plane.
 *
 * `size` comes from the wire, so a corrupt or hostile message could ask for gigabytes before a single
 * byte is validated. A 2bpp plane covering a large home is a few hundred kilobytes; this ceiling is two
 * orders of magnitude above that and exists only so a bad number becomes `undefined` rather than an
 * allocation.
 */
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Decompress an LZ4 block into exactly `size` bytes, or `undefined` if the block is malformed.
 *
 * **Every failure is `undefined`, and the length check is what makes that trustworthy.** A truncated or
 * corrupt block does not fail loudly on its own — LZ4 has no checksum and no terminator, so a mangled
 * block usually just stops producing output early, and a decompressor that returned what it had would
 * hand back a plausible, short, wrong map. Requiring the output to reach `size` exactly turns that into
 * a rejection, and it costs nothing: the caller already knows the size, which is how it knew to call.
 *
 * The other rejections are the reads that would otherwise wander: a length that runs off the end of the
 * block, a back-reference pointing before the start of the output or nowhere at all, and a match that
 * would overrun `size`.
 *
 * Matches may overlap their own output — an offset of 1 with a length of 200 is how a run of one
 * repeated byte is encoded, and it is the common case in a mostly-empty map. That is why the copy below
 * is a byte-at-a-time loop and not a block copy: the bytes it reads are ones it just wrote.
 */
export function lz4BlockDecompress(block: Uint8Array, size: number): Buffer | undefined {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OUTPUT) return undefined;

  const out = Buffer.alloc(size);
  const end = block.length;
  let pos = 0;
  let written = 0;

  /**
   * Read a length whose leading nibble saturated at 15, extended by a chain of bytes that ends at the
   * first one below 255. Returns `undefined` if the chain runs off the end of the block, which is what
   * a truncated block looks like from here.
   */
  const extend = (base: number): number | undefined => {
    let len = base;
    if (base !== 15) return len;
    for (;;) {
      if (pos >= end) return undefined;
      const extra = block[pos++]!;
      len += extra;
      if (extra !== 0xff) return len;
    }
  };

  while (pos < end) {
    const token = block[pos++]!;

    const literals = extend(token >> 4);
    if (literals === undefined) return undefined;
    if (pos + literals > end || written + literals > size) return undefined;
    for (let i = 0; i < literals; i++) out[written++] = block[pos++]!;

    // A block ends on its literal run: there is no terminator, so running out here is the normal exit.
    if (pos === end) break;

    if (pos + 2 > end) return undefined;
    const offset = block[pos]! | (block[pos + 1]! << 8);
    pos += 2;
    if (offset === 0 || offset > written) return undefined;

    const match = extend(token & 0xf);
    if (match === undefined) return undefined;
    const length = match + 4; // the minimum match is 4 bytes, so the nibble counts from there
    if (written + length > size) return undefined;

    let from = written - offset;
    for (let i = 0; i < length; i++) out[written++] = out[from++]!;
  }

  return written === size ? out : undefined;
}
