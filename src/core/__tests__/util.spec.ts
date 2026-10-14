import { asBool, clamp, structuralEqual, u16be, u16le, u32be, u32le } from "../util.js";

describe("asBool", () => {
  it("treats explicit true-ish values as true", () => {
    expect(asBool(true)).toBe(true);
    expect(asBool(1)).toBe(true);
    expect(asBool("1")).toBe(true);
    expect(asBool("true")).toBe(true);
    expect(asBool("True")).toBe(true);
    expect(asBool("TRUE")).toBe(true);
  });

  it('does NOT treat the string "false"/"0" as true (the Boolean() footgun)', () => {
    // Boolean("false") === true — the bug this helper exists to prevent.
    expect(asBool("false")).toBe(false);
    expect(asBool("0")).toBe(false);
    expect(asBool("off")).toBe(false);
    expect(asBool("no")).toBe(false);
  });

  it("treats false-ish and empty values as false", () => {
    expect(asBool(false)).toBe(false);
    expect(asBool(0)).toBe(false);
    expect(asBool("")).toBe(false);
    expect(asBool(null)).toBe(false);
    expect(asBool(undefined)).toBe(false);
  });
});

describe("clamp", () => {
  it("rounds and bounds into [min, max]", () => {
    expect(clamp(50.6, 0, 100)).toBe(51);
    expect(clamp(250, 0, 100)).toBe(100);
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  it(
    "fails safe to min on NaN — Math.max/Math.min propagate NaN rather than ignoring it, so this " +
      "must be an explicit check, not implicit",
    () => {
      expect(clamp(Number("x"), 0, 100)).toBe(0);
      expect(clamp(NaN, 5, 9)).toBe(5);
    },
  );
});

describe("fixed-width integer encoders", () => {
  it("encode LE/BE at the right width", () => {
    expect(u16le(0x0102).toString("hex")).toBe("0201");
    expect(u16be(0x0102).toString("hex")).toBe("0102");
    expect(u32le(0x01020304).toString("hex")).toBe("04030201");
    expect(u32be(0x01020304).toString("hex")).toBe("01020304");
  });

  it("mask/coerce out-of-range + negative inputs instead of throwing", () => {
    expect(u16le(0x1_0102).toString("hex")).toBe("0201"); // truncated to 16 bits
    expect(u32be(-1).toString("hex")).toBe("ffffffff"); // >>> 0 normalizes to unsigned
  });
});

describe("structuralEqual", () => {
  it("compares primitives with Object.is semantics", () => {
    expect(structuralEqual(1, 1)).toBe(true);
    expect(structuralEqual("a", "a")).toBe(true);
    expect(structuralEqual(true, true)).toBe(true);
    expect(structuralEqual(null, null)).toBe(true);
    expect(structuralEqual(undefined, undefined)).toBe(true);
    expect(structuralEqual(NaN, NaN)).toBe(true); // JSON.stringify-free: NaN matches NaN
    expect(structuralEqual(1, 2)).toBe(false);
    expect(structuralEqual(1, "1")).toBe(false);
    expect(structuralEqual(null, undefined)).toBe(false);
    expect(structuralEqual(0, false)).toBe(false);
  });

  it("treats objects with the same keys/values but different key ORDER as equal (the flap fix)", () => {
    expect(structuralEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(structuralEqual({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
  });

  it("distinguishes differing objects (value, extra key, missing key)", () => {
    expect(structuralEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(structuralEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(structuralEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it("compares arrays by length then elementwise, order-sensitive", () => {
    expect(structuralEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(structuralEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(structuralEqual([1, 2], [2, 1])).toBe(false);
    expect(structuralEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(structuralEqual([1, 2], { 0: 1, 1: 2 })).toBe(false); // array vs object
  });
});
