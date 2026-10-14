import { describe, expect, it } from "vitest";
import { hexToRawDp } from "../raw-dp-hex.js";

/**
 * The hex → base64 re-encode, and the silent truncation it exists to stop.
 *
 * `Buffer.from(s, "hex")` never throws. It decodes until it meets a non-hex character and returns what
 * it has, and it drops a trailing half-byte. The Raw-DP codec normally catches a mangled payload with
 * its length prefix — a body shorter than the prefix claims is rejected — but hex truncation removes
 * bytes from the END, which can leave a prefix and body that still agree. That case is unfixable
 * downstream, so it is refused here.
 */
describe("hexToRawDp", () => {
  /** A real Raw-DP frame: varint(2) then two bytes. */
  const FRAME_HEX = "02aabb";
  const FRAME_B64 = Buffer.from([0x02, 0xaa, 0xbb]).toString("base64");

  it("re-encodes a clean frame", () => {
    expect(hexToRawDp(FRAME_HEX)).toBe(FRAME_B64);
  });

  it("accepts either case, as the wire uses both", () => {
    expect(hexToRawDp("02AABB")).toBe(FRAME_B64);
    expect(hexToRawDp("02aAbB")).toBe(FRAME_B64);
  });

  it("refuses hex that would truncate into a VALID-looking shorter frame", () => {
    // The failure the codec cannot catch. `Buffer.from` stops at the "z": what survives is
    // varint(2) + aabb, whose prefix matches its body exactly. It would decode, and the rest of the
    // message would be gone without a word.
    const truncatesCleanly = `${FRAME_HEX}zz99887766`;
    expect(Buffer.from(truncatesCleanly, "hex").toString("base64")).toBe(FRAME_B64); // what Node does
    expect(hexToRawDp(truncatesCleanly)).toBeUndefined(); // what this does instead
  });

  it("refuses an odd-length string, which loses its last half-byte", () => {
    expect(hexToRawDp("02aab")).toBeUndefined();
  });

  it("refuses a string with no hex in it at all", () => {
    expect(hexToRawDp("not hex")).toBeUndefined();
    expect(hexToRawDp("zzzz")).toBeUndefined();
  });

  it("refuses whitespace and separators rather than stripping them", () => {
    // A reader that stripped these would accept a shape the wire never sends, and would then be the
    // only place that knows the payload can look like that.
    expect(hexToRawDp("02 aa bb")).toBeUndefined();
    expect(hexToRawDp("02:aa:bb")).toBeUndefined();
    expect(hexToRawDp("0x02aabb")).toBeUndefined();
  });

  it("reads an empty payload as absent, not as an empty frame", () => {
    // The envelope omits the field when there is nothing to send, so "" means "no payload".
    expect(hexToRawDp("")).toBeUndefined();
  });

  it("round-trips every byte value, so no encoding step mangles the high bits", () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const hex = all.toString("hex");

    expect(hexToRawDp(hex)).toBe(all.toString("base64"));
    expect(Buffer.from(hexToRawDp(hex)!, "base64")).toEqual(all);
  });
});
