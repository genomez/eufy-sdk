import type { RawDpCodec, RawDpField } from "../../../core/contracts.js";

/**
 * Byte-real protobuf fixtures for the Raw-DP capabilities, and a reader for them.
 *
 * Several clean-line DPs carry a whole message whose meaning depends on which sub-messages sit beside
 * each other and on which fields are ABSENT. A fake codec handing back one flat field list cannot
 * express either, so it cannot exercise those decodes at all: proto3 omits a zero-valued field, which
 * makes "the enum's zero member" and "nothing was said" the same bytes, and telling them apart is
 * exactly what the decodes do.
 *
 * The reader below mirrors the `core/contracts` {@link RawDpCodec} contract without importing
 * `transport/raw-dp.ts` — specs under `src/model` may not reach into `transport/`, and re-deriving the
 * read here is what proves a capability depends on the CONTRACT rather than on that implementation.
 *
 * Test-only: this file has no `.spec` suffix, so it ships to neither `dist/` nor the test run on its own.
 */

/** Encode an unsigned integer as a protobuf varint. */
export function varint(n: number): number[] {
  const out: number[] = [];
  // Division and modulo rather than `&` and `>>>`, for the reason the reader below spells out: a
  // `uint32` field can legitimately carry a value past 2^31, and the bitwise pair stops being safe
  // there. Encoding and decoding have to agree across the WHOLE range the protocol uses.
  let v = n;
  while (v > 0x7f) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

/**
 * A varint-valued field, omitted entirely when zero.
 *
 * That omission is the proto3 default rule and it is the point, not a shortcut: a fixture that emitted
 * an explicit zero would be a message no device sends.
 */
export function int(field: number, value: number): number[] {
  return value === 0 ? [] : [...varint(field << 3), ...varint(value)];
}

/**
 * A length-delimited sub-message field, always emitted.
 *
 * An EMPTY sub-message is still a present one, which is how these protocols say "this subsystem exists
 * and is in its zero state" as opposed to saying nothing about it.
 */
export function sub(field: number, body: number[]): number[] {
  return [...varint((field << 3) | 2), ...varint(body.length), ...body];
}

/**
 * A length-delimited string field, always emitted — an empty string is a present field with no bytes,
 * which is how a device says "this name is blank" rather than "there is no name here".
 */
export function str(field: number, value: string): number[] {
  return sub(field, [...Buffer.from(value, "utf8")]);
}

/**
 * A `sint32`/`sint64` field, zig-zag encoded and omitted when zero.
 *
 * The map's coordinates are signed centimetres, and the wire does not record which of `int32` and
 * `sint32` a field was declared as — so a fixture that wrote a negative as a plain varint would be
 * testing a decode against bytes the device never sends, and would make an un-zigzagged reader look
 * correct.
 */
export function sint(field: number, value: number): number[] {
  return int(field, value < 0 ? -2 * value - 1 : 2 * value);
}

/**
 * A length-delimited field holding arbitrary bytes — a pixel plane, not a sub-message.
 *
 * Same wire type as {@link sub}, and kept separate for the same reason the decoders keep their readers
 * separate: asking for a message where the payload holds image data is how a decoder ends up walking
 * pixels as if they were fields.
 */
export function blob(field: number, value: Uint8Array): number[] {
  return sub(field, [...value]);
}

/** Wrap a message body in the `varint(len) ++ body` framing a Raw DP value carries, base64-encoded. */
export function frame(body: number[]): string {
  return Buffer.from([...varint(body.length), ...body]).toString("base64");
}

/**
 * A schema-less reader over real bytes, on the same terms as the shipped codec: it walks fields by
 * number and wire type and reports what it finds, and rejects a payload whose length prefix disagrees
 * with its body or that carries a wire type it does not handle.
 */
export const byteCodec: RawDpCodec = {
  decode(value: string) {
    const buf = Buffer.from(value, "base64");
    let pos = 0;
    let len = 0;
    let shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++]!;
      len |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const body = buf.subarray(pos);
    return len === body.length ? this.nested(body) : undefined;
  },

  nested(value: Buffer) {
    const out: RawDpField[] = [];
    let pos = 0;
    // Accumulated as a BigInt, NOT with `|=` and `<<`. JavaScript's bitwise operators truncate to a
    // SIGNED 32-bit int, so `0xFFFFFFFE` — the vendor's `-2` sentinel written into a `uint32` — comes
    // back as `-2` from a shift-based reader while the shipped codec reads it through protobufjs's
    // `uint64()` and answers `4294967294n`. A double that disagrees with the real thing on a value the
    // protocol actually sends is worse than no double: it validates a decode against a lie.
    const readVarint = (): bigint => {
      let v = 0n;
      let shift = 0n;
      while (pos < value.length) {
        const b = value[pos++]!;
        v |= BigInt(b & 0x7f) << shift;
        shift += 7n;
        if (!(b & 0x80)) break;
      }
      return v;
    };
    while (pos < value.length) {
      const tag = Number(readVarint());
      const field = tag >>> 3;
      if ((tag & 7) === 0) out.push({ field, kind: "int", value: readVarint() });
      else if ((tag & 7) === 2) {
        const len = Number(readVarint());
        out.push({ field, kind: "bytes", value: value.subarray(pos, pos + len) });
        pos += len;
      } else return undefined;
    }
    return out;
  },
};
