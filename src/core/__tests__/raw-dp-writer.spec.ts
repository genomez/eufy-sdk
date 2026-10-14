import { RawDpWriter, rawDp, encodeVarint, zigzag } from "../raw-dp-writer.js";
import { rawDpCodec } from "../../transport/raw-dp.js";

/**
 * The writer is exercised against the SHIPPED reader, not a reimplementation of it.
 *
 * Two encoders of the same guess agree with each other and with nothing else. `rawDpCodec` is what
 * actually reads device payloads, so a value that survives a round-trip through it is a value a device
 * would parse — which is the only claim worth making about an encoder that has no schema to check
 * itself against.
 */
describe("encodeVarint", () => {
  it("encodes the single-byte range as one byte", () => {
    expect(encodeVarint(0)).toEqual([0x00]);
    expect(encodeVarint(1)).toEqual([0x01]);
    expect(encodeVarint(127)).toEqual([0x7f]);
  });

  it("sets the continuation bit at each group boundary", () => {
    expect(encodeVarint(128)).toEqual([0x80, 0x01]);
    expect(encodeVarint(300)).toEqual([0xac, 0x02]);
    expect(encodeVarint(16383)).toEqual([0xff, 0x7f]);
    expect(encodeVarint(16384)).toEqual([0x80, 0x80, 0x01]);
  });

  it("keeps going past 2^31, where a shift-based loop would wrap", () => {
    // The reason this uses division rather than `>>>`: JS bitwise operators are 32-bit, so a shifting
    // encoder emits a well-formed frame carrying the WRONG number here — the worst kind of wire bug.
    expect(encodeVarint(2 ** 31)).toEqual([0x80, 0x80, 0x80, 0x80, 0x08]);
    expect(encodeVarint(2 ** 32 - 1)).toEqual([0xff, 0xff, 0xff, 0xff, 0x0f]);
  });

  it("refuses what it cannot encode rather than truncating", () => {
    expect(() => encodeVarint(-1)).toThrow(/non-negative/);
    expect(() => encodeVarint(1.5)).toThrow(/safe integer/);
    expect(() => encodeVarint(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integer/);
  });
});

describe("zigzag", () => {
  it("maps small negatives onto small unsigned values", () => {
    expect([0, -1, 1, -2, 2].map(zigzag)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps a negative coordinate cheap, which is the whole point", () => {
    // Map coordinates are signed centimetres and routinely negative. As a plain varint, -1 is ten
    // bytes and means 2^64-1; as a sint32 it is one byte. Sending the first to a robot moves it.
    expect(encodeVarint(zigzag(-1))).toHaveLength(1);
    expect(zigzag(-12345)).toBe(24689);
  });

  it("refuses a non-integer", () => {
    expect(() => zigzag(1.5)).toThrow(/safe integer/);
  });
});

describe("RawDpWriter", () => {
  it("frames the body the way the reader unwraps it", () => {
    const value = rawDp((w) => w.int(1, 6).int(2, 111));
    expect(rawDpCodec.decode(value)).toEqual([
      { field: 1, kind: "int", value: 6n },
      { field: 2, kind: "int", value: 111n },
    ]);
  });

  it("round-trips a nested sub-message through the shipped codec", () => {
    const value = rawDp((w) => w.sub(2, (u) => u.sub(1, (v) => v.int(1, 3))));
    const outer = rawDpCodec.decode(value);
    const wrapper = outer?.find((f) => f.field === 2);
    expect(wrapper?.kind).toBe("bytes");
    const middle = rawDpCodec.nested((wrapper as { value: Buffer }).value);
    const inner = middle?.find((f) => f.field === 1);
    expect(rawDpCodec.nested((inner as { value: Buffer }).value)).toEqual([{ field: 1, kind: "int", value: 3n }]);
  });

  it("emits an EMPTY sub-message rather than dropping it", () => {
    // "This subsystem exists and is in its zero state" is a different claim from saying nothing about
    // it, and the readers depend on telling those apart. A writer that optimised the empty case away
    // would silently turn one into the other.
    const fields = rawDpCodec.decode(rawDp((w) => w.sub(4, () => {})));
    expect(fields).toHaveLength(1);
    expect(fields?.[0]).toMatchObject({ field: 4, kind: "bytes" });
    expect((fields?.[0] as { value: Buffer }).value).toHaveLength(0);
  });

  it("writes an explicit zero when asked, and omits nothing on the caller's behalf", () => {
    // proto3 omits zero-valued fields, but whether an explicit zero and an absent field mean the same
    // thing is the message's business. The writer stays out of that decision.
    expect(rawDpCodec.decode(rawDp((w) => w.int(1, 0)))).toEqual([{ field: 1, kind: "int", value: 0n }]);
    expect(rawDpCodec.decode(rawDp(() => {}))).toEqual([]);
  });

  it("carries a repeated field as the wire does — the same number more than once", () => {
    const value = rawDp((w) => w.sub(1, (u) => u.int(1, 7)).sub(1, (u) => u.int(1, 9)));
    expect(rawDpCodec.decode(value)?.map((f) => f.field)).toEqual([1, 1]);
  });

  it("length-prefixes bytes, and accepts a Uint8Array or a plain array", () => {
    const fromArray = rawDp((w) => w.bytes(3, [1, 2, 3]));
    const fromView = rawDp((w) => w.bytes(3, Uint8Array.from([1, 2, 3])));
    expect(fromArray).toBe(fromView);
    expect((rawDpCodec.decode(fromArray)?.[0] as { value: Buffer }).value).toEqual(Buffer.from([1, 2, 3]));
  });

  it("writes bools as protobuf does", () => {
    expect(rawDpCodec.decode(rawDp((w) => w.bool(1, true).bool(2, false)))).toEqual([
      { field: 1, kind: "int", value: 1n },
      { field: 2, kind: "int", value: 0n },
    ]);
  });

  it("survives a body long enough to need a multi-byte length prefix", () => {
    // The frame's own length is a varint too. A body over 127 bytes is where a fixed one-byte prefix
    // would quietly desynchronise the reader.
    const value = rawDp((w) => w.bytes(1, new Array(200).fill(0x41)));
    const field = rawDpCodec.decode(value)?.[0] as { value: Buffer } | undefined;
    expect(field?.value).toHaveLength(200);
  });

  it("refuses a field number that is not one", () => {
    expect(() => rawDp((w) => w.int(0, 1))).toThrow(/field number/);
    expect(() => rawDp((w) => w.int(-1, 1))).toThrow(/field number/);
  });

  it("hands back an unframed body for nesting, and a framed value for the wire", () => {
    const inner = new RawDpWriter().int(1, 5);
    expect(inner.toBytes()).toEqual([0x08, 0x05]);
    // The framed form is the body with its length in front — 2 bytes of body, so a 0x02 prefix.
    expect(Buffer.from(inner.finish(), "base64")).toEqual(Buffer.from([0x02, 0x08, 0x05]));
  });

  it("does not let a caller mutate the body it was handed", () => {
    const w = new RawDpWriter().int(1, 5);
    (w.toBytes() as number[]).push(0xff);
    expect(w.toBytes()).toEqual([0x08, 0x05]);
  });
});
