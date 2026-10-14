import { describe, expect, it } from "vitest";
import { byteCodec, frame, int, str, sub, varint } from "./proto-bytes.js";

/**
 * The test double itself, tested.
 *
 * `byteCodec` stands in for the shipped `RawDpCodec` in every capability spec on the clean line, so a
 * disagreement between the two is not a test failure — it is every one of those specs quietly
 * validating a decode against bytes no device sends. The range below is the one that broke: JavaScript
 * bitwise operators truncate to a SIGNED 32-bit int, and the protocol puts values past 2^31 in
 * `uint32` fields on purpose (the scene list's `-2` no-map sentinel is `0xFFFFFFFE`).
 */
describe("byteCodec — agreement with the shipped codec's range", () => {
  const roundTrip = (n: number): bigint | undefined => {
    const fields = byteCodec.decode(frame(int(1, n)));
    const hit = fields?.find((f) => f.field === 1);
    return hit?.kind === "int" ? hit.value : undefined;
  };

  it("round-trips values on both sides of the 32-bit sign boundary", () => {
    // 0 is absent by the proto3 rule `int` implements, so it is not in this list — see below.
    for (const n of [1, 127, 128, 300, 0x7f_ff_ff_ff, 0x80_00_00_00, 0xff_ff_ff_fe, 0xff_ff_ff_ff]) {
      expect(roundTrip(n), `varint ${n}`).toBe(BigInt(n));
    }
  });

  it("answers the no-map sentinel as the unsigned value, never as -2", () => {
    // The exact disagreement: a shift-based reader gives -2 here, the shipped codec gives 4294967294n
    // through protobufjs's `uint64()`. A decode written against the first is wrong on real bytes.
    expect(roundTrip(0xff_ff_ff_fe)).toBe(4_294_967_294n);
  });

  it("omits a zero, because proto3 does", () => {
    expect(byteCodec.decode(frame(int(1, 0)))).toEqual([]);
  });

  it("keeps a present-but-empty sub-message distinct from an absent one", () => {
    expect(byteCodec.decode(frame(sub(2, [])))?.map((f) => f.field)).toEqual([2]);
    expect(byteCodec.decode(frame([]))).toEqual([]);
  });

  it("reads a string field back as its bytes", () => {
    const fields = byteCodec.decode(frame(str(3, "Kitchen")));
    const hit = fields?.find((f) => f.field === 3);
    expect(hit?.kind === "bytes" ? hit.value.toString("utf8") : undefined).toBe("Kitchen");
  });

  it("rejects a payload whose length prefix disagrees with its body", () => {
    const good = Buffer.from(frame(int(1, 5)), "base64");
    expect(byteCodec.decode(good.subarray(0, good.length - 1).toString("base64"))).toBeUndefined();
  });

  it("encodes the varint widths the wire uses", () => {
    expect(varint(1)).toEqual([1]);
    expect(varint(127)).toEqual([127]);
    expect(varint(128)).toEqual([0x80, 0x01]);
    expect(varint(0xff_ff_ff_fe)).toHaveLength(5);
  });
});
