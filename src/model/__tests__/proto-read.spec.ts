import { describe, expect, it } from "vitest";
import { zigzag } from "../../core/raw-dp-writer.js";
import { byteCodec, blob, frame, int, sint, str, sub } from "../capabilities/__tests__/proto-bytes.js";
import { bytes, each, flag, signed, text } from "../proto-read.js";
import { int as readInt, sub as readSub } from "../proto-read.js";

/**
 * The shared field readers, and the one proto3 rule they all encode.
 *
 * Three decoders depend on these now, so a change here is a change to all three at once. What is
 * pinned below is not the arithmetic but the ANSWERS each reader gives when a field is absent — which
 * is the same answer it gives when the field was zero, because proto3 writes neither.
 */
describe("the absent-is-zero rule", () => {
  const empty = byteCodec.decode(frame([]));

  it("reads an absent varint as zero, because that is what the sender omitted", () => {
    expect(readInt(empty, 1)).toBe(0);
    expect(readInt(undefined, 1)).toBe(0);
  });

  it("reads an absent bool as false", () => {
    expect(flag(empty, 1)).toBe(false);
  });

  it("reads an absent or empty string as undefined", () => {
    // "" is not a name a host should render, and the wire cannot tell it from silence.
    const fields = byteCodec.decode(frame([...str(1, ""), ...str(2, "Kitchen")]));
    expect(text(fields, 1)).toBeUndefined();
    expect(text(fields, 2)).toBe("Kitchen");
    expect(text(fields, 3)).toBeUndefined();
  });

  it("keeps a present-but-empty sub-message distinct from an absent one", () => {
    // The one distinction the wire DOES carry, and several decodes turn on it: an empty wrapper says
    // "this exists and is in its zero state", nothing at all says nothing.
    const fields = byteCodec.decode(frame(sub(1, [])));
    expect(readSub(byteCodec, fields, 1)).toEqual([]);
    expect(readSub(byteCodec, fields, 2)).toBeUndefined();
  });
});

describe("signed", () => {
  it("is the exact inverse of the writer's zigzag", () => {
    // The two halves of the same encoding live in different layers — the writer in core, the reader
    // here — so nothing but a test holds them together. A disagreement would put a wall on the wrong
    // side of the room and look like a device fault.
    for (const n of [0, 1, -1, 2, -2, 63, -64, 150, -150, 32_767, -32_768, 1_000_000, -1_000_000]) {
      const fields = byteCodec.decode(frame(int(1, zigzag(n))));
      expect(signed(fields, 1), `${n}`).toBe(n);
    }
  });

  it("reads an absent coordinate as zero and not as a large positive", () => {
    expect(signed(byteCodec.decode(frame([])), 1)).toBe(0);
  });

  it("agrees with the fixture helper the map specs build coordinates with", () => {
    // If `sint` and `signed` were wrong in the same direction the map specs would pass while the
    // decoder was broken, so the helper is pinned against the shipped encoder too.
    expect(sint(1, -150)).toEqual(int(1, zigzag(-150)));
  });
});

describe("bytes and sub over the same wire type", () => {
  const fields = byteCodec.decode(frame([...blob(1, Buffer.from([0xff, 0x00, 0xff])), ...sub(2, int(1, 7))]));

  it("hands back a blob untouched", () => {
    expect(bytes(fields, 1)).toEqual(Buffer.from([0xff, 0x00, 0xff]));
  });

  it("reads an empty blob as absent", () => {
    expect(bytes(byteCodec.decode(frame(blob(1, Buffer.alloc(0)))), 1)).toBeUndefined();
  });

  it("steps into a message when asked for one", () => {
    expect(readInt(readSub(byteCodec, fields, 2), 1)).toBe(7);
  });
});

describe("each", () => {
  it("returns every repeat, where find would collapse them to the first", () => {
    const fields = byteCodec.decode(frame([...sub(1, int(1, 10)), ...sub(1, int(1, 20)), ...sub(2, [])]));
    expect(each(byteCodec, fields, 1).map((f) => readInt(f, 1))).toEqual([10, 20]);
  });

  it("returns nothing for a field that is not there", () => {
    expect(each(byteCodec, byteCodec.decode(frame([])), 1)).toEqual([]);
    expect(each(byteCodec, undefined, 1)).toEqual([]);
  });
});
