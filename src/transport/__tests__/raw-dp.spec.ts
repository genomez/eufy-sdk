import { describe, it, expect } from "vitest";
import { rawDpCodec } from "../raw-dp.js";

/**
 * The Raw-DP codec against synthetic payloads only — every fixture is built here from bytes, so nothing
 * captured from a real device is committed. `message()` applies the outer `varint(len) ++ body` wrapper
 * a Raw DP value carries; `body()` builds the inner field run.
 */
function tag(field: number, wire: number): number {
  return (field << 3) | wire;
}
function body(...parts: number[][]): Buffer {
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}
function message(inner: Buffer): string {
  return Buffer.concat([Buffer.from([inner.length]), inner]).toString("base64");
}

describe("rawDpCodec.decode", () => {
  it("reads a varint field", () => {
    expect(rawDpCodec.decode(message(body([tag(2, 0), 5])))).toEqual([{ field: 2, kind: "int", value: 5n }]);
  });

  it("reads a multi-byte varint past the 32-bit boundary", () => {
    // 0x1_0000_0000 = 4294967296, seven-bit groups little-endian with the continuation bit set.
    const encoded = [tag(1, 0), 0x80, 0x80, 0x80, 0x80, 0x10];
    expect(rawDpCodec.decode(message(body(encoded)))).toEqual([{ field: 1, kind: "int", value: 4294967296n }]);
  });

  it("reads fixed32 and fixed64 as ints", () => {
    const fixed32 = [tag(3, 5), 0x01, 0x00, 0x00, 0x00];
    const fixed64 = [tag(4, 1), 0x02, 0, 0, 0, 0, 0, 0, 0];
    expect(rawDpCodec.decode(message(body(fixed32, fixed64)))).toEqual([
      { field: 3, kind: "int", value: 1n },
      { field: 4, kind: "int", value: 2n },
    ]);
  });

  it("reads a length-delimited field as raw bytes, leaving interpretation to the caller", () => {
    const text = Buffer.from("ok", "utf8");
    const fields = rawDpCodec.decode(message(body([tag(7, 2), text.length], [...text])));

    expect(fields).toHaveLength(1);
    expect(fields?.[0]).toMatchObject({ field: 7, kind: "bytes" });
    expect((fields?.[0] as { value: Buffer }).value.toString("utf8")).toBe("ok");
  });

  it("keeps every field of a run, in wire order, including repeats of one field number", () => {
    const fields = rawDpCodec.decode(message(body([tag(2, 0), 3], [tag(9, 0), 1], [tag(2, 0), 4])));
    expect(fields?.map((f) => f.field)).toEqual([2, 9, 2]);
  });

  it("rejects a length prefix that disagrees with the body", () => {
    const inner = body([tag(2, 0), 5]);
    const wrongPrefix = Buffer.concat([Buffer.from([inner.length + 1]), inner]).toString("base64");
    expect(rawDpCodec.decode(wrongPrefix)).toBeUndefined();
  });

  it("rejects a group marker rather than misaligning the fields after it", () => {
    expect(rawDpCodec.decode(message(body([tag(1, 3)])))).toBeUndefined();
  });

  it("rejects a truncated field", () => {
    const inner = body([tag(7, 2), 8, 0x01]);
    expect(rawDpCodec.decode(Buffer.concat([Buffer.from([inner.length]), inner]).toString("base64"))).toBeUndefined();
  });

  it("rejects a non-base64 string and an empty one", () => {
    expect(rawDpCodec.decode("not-base64-@@")).toBeUndefined();
    expect(rawDpCodec.decode("")).toBeUndefined();
  });
});

describe("rawDpCodec.nested", () => {
  it("re-reads a length-delimited field's bytes as a field list", () => {
    const inner = body([tag(1, 0), 7]);
    const outer = rawDpCodec.decode(message(body([tag(5, 2), inner.length], [...inner])));
    const nestedBytes = (outer?.[0] as { value: Buffer }).value;

    expect(rawDpCodec.nested(nestedBytes)).toEqual([{ field: 1, kind: "int", value: 7n }]);
  });

  it("takes no length prefix — a prefixed buffer is a different, wrong read", () => {
    const inner = body([tag(1, 0), 7]);
    expect(rawDpCodec.nested(Buffer.concat([Buffer.from([inner.length]), inner]))).not.toEqual([
      { field: 1, kind: "int", value: 7n },
    ]);
  });

  it("rejects bytes that are not a field run", () => {
    expect(rawDpCodec.nested(Buffer.from([tag(1, 3)]))).toBeUndefined();
  });
});
