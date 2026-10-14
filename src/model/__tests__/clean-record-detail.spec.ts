import { parseCleanRecordDetail, unwrapCleanRecordBlob, CLEAN_FINISH_REASONS } from "../clean-record-detail.js";
// The shared byte-real reader, which mirrors the `RawDpCodec` contract without importing
// `transport/` — a spec under `src/model` may not reach across that line.
import { byteCodec } from "../capabilities/__tests__/proto-bytes.js";

/** Wrap a message body in the vendor's container: magic, a length, the body, then its checksum. */
function container(body: number[], lenWidth = 2): Uint8Array {
  const len: number[] = [];
  for (let i = lenWidth - 1; i >= 0; i--) len.push((body.length >> (8 * i)) & 0xff);
  const prefix = [0xaa, 0x01, ...len, ...body];
  const sum = prefix.reduce((a, b) => a + b, 0) & 0xffff;
  return Uint8Array.from([...prefix, (sum >> 8) & 0xff, sum & 0xff]);
}

/** A varint field, as protobuf writes one. */
function int(field: number, value: number): number[] {
  const out = [field * 8];
  let v = value;
  while (v > 0x7f) {
    out.push((v % 0x80) + 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

describe("unwrapCleanRecordBlob", () => {
  it("unwraps a well-formed container", () => {
    expect(unwrapCleanRecordBlob(container([1, 2, 3]))).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("finds the body whichever width the length field turns out to be", () => {
    // The length field's width is not documented. Rather than assume one, the reader keeps whichever
    // makes the checksum and the declared length agree — so it does not depend on a guess.
    for (const width of [1, 2, 4]) {
      expect(unwrapCleanRecordBlob(container([7, 7, 7], width))).toEqual(Uint8Array.from([7, 7, 7]));
    }
  });

  it("refuses a blob whose checksum does not hold", () => {
    // The checksum is the oracle. Without this check a wrong length guess would yield a plausible
    // wrong message, which is worse than no message at all.
    const bad = container([1, 2, 3]);
    bad[bad.length - 1] ^= 0xff;
    expect(unwrapCleanRecordBlob(bad)).toBeUndefined();
  });

  it("refuses a blob that is not one of these at all", () => {
    expect(unwrapCleanRecordBlob(Uint8Array.from([0x00, 0x01, 0x00, 0x00, 0x00]))).toBeUndefined();
    expect(unwrapCleanRecordBlob(Uint8Array.from([0xaa]))).toBeUndefined();
    expect(unwrapCleanRecordBlob(Uint8Array.from([]))).toBeUndefined();
  });

  it("refuses a container whose stated length disagrees with its body", () => {
    // Checksum-valid but internally inconsistent — a truncated or padded blob.
    const body = [1, 2, 3];
    const prefix = [0xaa, 0x01, 0x00, 0x09, ...body];
    const sum = prefix.reduce((a, b) => a + b, 0) & 0xffff;
    expect(unwrapCleanRecordBlob(Uint8Array.from([...prefix, sum >> 8, sum & 0xff]))).toBeUndefined();
  });
});

describe("parseCleanRecordDetail", () => {
  const run = [
    ...int(1, 1750000000),
    ...int(2, 1750003600),
    ...int(3, 3600),
    ...int(4, 42),
    ...int(5, 2),
    ...int(6, 1),
  ];

  it("reads a whole run", () => {
    expect(parseCleanRecordDetail(container(run), byteCodec)).toEqual({
      startTime: 1750000000,
      endTime: 1750003600,
      duration: 3600,
      area: 42,
      cleanType: 2,
      finishReason: "manual",
    });
  });

  it("reads an omitted field as zero, which is what proto3 means by omitting it", () => {
    const partial = parseCleanRecordDetail(container(int(1, 1750000000)), byteCodec);
    expect(partial).toMatchObject({ startTime: 1750000000, endTime: 0, duration: 0, area: 0 });
  });

  it("reads an absent finish reason as the run having completed", () => {
    // `completed` is the enum's zero member and proto3 omits a zero, so an absent reason is a run that
    // ended the ordinary way — not a run whose ending is unknown.
    expect(parseCleanRecordDetail(container(int(3, 60)), byteCodec)?.finishReason).toBe("completed");
  });

  it("answers undefined for a reason this version cannot name, rather than a neighbouring one", () => {
    expect(parseCleanRecordDetail(container(int(6, 99)), byteCodec)?.finishReason).toBeUndefined();
    expect(CLEAN_FINISH_REASONS).toEqual(["completed", "manual", "lowPower", "exception"]);
  });

  it("is undefined for bytes that are not a valid container", () => {
    expect(parseCleanRecordDetail(Uint8Array.from([1, 2, 3]), byteCodec)).toBeUndefined();
  });
});
