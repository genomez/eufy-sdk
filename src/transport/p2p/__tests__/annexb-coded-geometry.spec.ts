import { describe, expect, it } from "vitest";
import { codedGeometry, extractParamSets, type ParamSets } from "../annexb.js";
import { CHROMA_BRANCH_PROFILES, H264, H265, h264Sps, h265Sps, unit } from "./live-source-fixtures.js";

/**
 * The coded geometry is what the SPS says, not what a frame header says.
 *
 * A frame header states the geometry at capture start and a camera that reconfigures mid-session leaves it
 * contradicting the bytes, so acting on the header can rebuild a decoder for a size the stream is not
 * carrying. The SPS is the size a decoder will actually produce, which is why the crop and conformance
 * offsets are part of the answer rather than a detail: 1080 is not a multiple of the 16-pixel macroblock,
 * so every 1080p stream codes 1088 rows and crops 8 off the bottom. A reader that ignored that would be
 * consistently wrong by exactly that much and never notice.
 */
const setsOf = (...nals: readonly (readonly number[])[]): ParamSets => extractParamSets(unit(...nals))!;

describe("codedGeometry — H.264", () => {
  it("reads a geometry that needs no crop", () => {
    expect(codedGeometry(setsOf(h264Sps({ widthMbs: 80, heightMapUnits: 45 }), H264.pps))).toEqual({
      width: 1280,
      height: 720,
      coded: { width: 1280, height: 720 },
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
    });
  });

  it("crops the coded height back to the 1080 a decoder produces", () => {
    const sps = h264Sps({ widthMbs: 120, heightMapUnits: 68, crop: { bottom: 4 } });
    expect(codedGeometry(setsOf(sps, H264.pps))).toEqual({
      width: 1920,
      height: 1080,
      coded: { width: 1920, height: 1088 },
      crop: { left: 0, right: 0, top: 0, bottom: 8 },
    });
  });

  it("reads the rungs of an adaptive ladder as distinct geometries", () => {
    const rungs = [
      { shape: { widthMbs: 40, heightMapUnits: 23, crop: { bottom: 4 } }, expected: { width: 640, height: 360 } },
      { shape: { widthMbs: 60, heightMapUnits: 34, crop: { bottom: 2 } }, expected: { width: 960, height: 540 } },
      { shape: { widthMbs: 120, heightMapUnits: 68, crop: { bottom: 4 } }, expected: { width: 1920, height: 1080 } },
    ];
    expect(rungs.map(({ shape }) => codedGeometry(setsOf(h264Sps(shape), H264.pps)))).toMatchObject(
      rungs.map(({ expected }) => expected),
    );
  });

  it("scales a horizontal crop by the chroma format", () => {
    const sps = h264Sps({ widthMbs: 80, heightMapUnits: 45, profileIdc: 100, crop: { left: 1, right: 2 } });
    expect(codedGeometry(setsOf(sps, H264.pps))).toEqual({
      width: 1274,
      height: 720,
      coded: { width: 1280, height: 720 },
      crop: { left: 2, right: 4, top: 0, bottom: 0 },
    });
  });

  it("takes a 4:4:4 crop offset in whole samples", () => {
    const sps = h264Sps({
      widthMbs: 80,
      heightMapUnits: 45,
      profileIdc: 100,
      chromaFormatIdc: 3,
      crop: { left: 1, right: 2 },
    });
    expect(codedGeometry(setsOf(sps, H264.pps))).toMatchObject({ width: 1277, height: 720 });
  });

  it("doubles the coded height of an interlaced set and its vertical crop unit", () => {
    const sps = h264Sps({ widthMbs: 80, heightMapUnits: 22, frameMbsOnly: false, crop: { bottom: 1 } });
    expect(codedGeometry(setsOf(sps, H264.pps))).toEqual({
      width: 1280,
      height: 700,
      coded: { width: 1280, height: 704 },
      crop: { left: 0, right: 0, top: 0, bottom: 4 },
    });
  });

  it("skips signalled scaling lists to reach the geometry behind them", () => {
    const sps = h264Sps({
      widthMbs: 120,
      heightMapUnits: 68,
      profileIdc: 100,
      scalingMatrix: true,
      crop: { bottom: 4 },
    });
    expect(codedGeometry(setsOf(sps, H264.pps))).toMatchObject({ width: 1920, height: 1080 });
  });

  /**
   * Every profile that takes the chroma branch has to be recognised as taking it. A profile read without it
   * lands mid-element and answers a plausible geometry rather than nothing, which is the one failure the
   * range check cannot catch — so this walks the whole list rather than the two profiles in common use.
   */
  it("reaches the geometry behind the chroma branch for every profile that carries one", () => {
    const read = CHROMA_BRANCH_PROFILES.map((profileIdc) =>
      codedGeometry(setsOf(h264Sps({ widthMbs: 80, heightMapUnits: 45, profileIdc }), H264.pps)),
    );
    expect(read).toMatchObject(CHROMA_BRANCH_PROFILES.map(() => ({ width: 1280, height: 720 })));
  });
});

describe("codedGeometry — H.265", () => {
  it("reads the luma dimensions directly", () => {
    expect(codedGeometry(setsOf(H265.vps, h265Sps({ widthLuma: 1920, heightLuma: 1080 }), H265.pps))).toMatchObject({
      width: 1920,
      height: 1080,
    });
  });

  it("applies the conformance window, scaled by the chroma format", () => {
    const sps = h265Sps({ widthLuma: 1920, heightLuma: 1088, window: { bottom: 4 } });
    expect(codedGeometry(setsOf(H265.vps, sps, H265.pps))).toEqual({
      width: 1920,
      height: 1080,
      coded: { width: 1920, height: 1088 },
      crop: { left: 0, right: 0, top: 0, bottom: 8 },
    });
  });

  it("skips the per-sub-layer profile and level records", () => {
    const sps = h265Sps({ widthLuma: 1280, heightLuma: 720, maxSubLayersMinus1: 2 });
    expect(codedGeometry(setsOf(H265.vps, sps, H265.pps))).toMatchObject({ width: 1280, height: 720 });
  });
});

/**
 * A geometry read is a parse of bytes a device sent, so it is a trust boundary: the answer is a geometry
 * or nothing, never a number derived from a set the reader ran off the end of. A caller uses this to
 * decide whether its decoder is still valid, and a wrong number there is worse than no answer.
 */
describe("codedGeometry — what it refuses to answer", () => {
  it("answers undefined for a set carrying no SPS", () => {
    expect(codedGeometry({ codec: "h264", sps: [], pps: [Buffer.from(H264.pps)], vps: [] })).toBeUndefined();
  });

  it("answers undefined for an SPS truncated before its geometry", () => {
    const full = Buffer.from(h264Sps({ widthMbs: 80, heightMapUnits: 45 }));
    expect(codedGeometry({ codec: "h264", sps: [full.subarray(0, 3)], pps: [], vps: [] })).toBeUndefined();
  });

  it("answers undefined for the stub SPS bodies a fixture uses as a shape", () => {
    expect(codedGeometry(setsOf(H264.sps, H264.pps))).toBeUndefined();
  });

  it("answers undefined rather than a guess for AV1, which it cannot parse", () => {
    expect(codedGeometry({ codec: "av1", sps: [Buffer.alloc(32)], pps: [], vps: [] })).toBeUndefined();
  });

  it("refuses a geometry outside the range a coded picture can have", () => {
    const sps = h264Sps({ widthMbs: 80, heightMapUnits: 45, crop: { right: 4096 } });
    expect(codedGeometry(setsOf(sps, H264.pps))).toBeUndefined();
  });

  /**
   * A wide exp-Golomb field must decode to the number it encodes, or be refused.
   *
   * The leading-zero run gives the value's bit width, and a 33-bit code word overflows a signed 32-bit
   * shift: `1 << 32` is `1` in JavaScript, not `4294967296`. Getting that wrong turns a runaway field into a
   * small plausible number instead of a rejection, which is the one outcome the range check cannot catch —
   * `48x64` looks like a picture. Measured before the fix at exactly that.
   */
  it.each([2 ** 20, 2 ** 30, 2 ** 31, 2 ** 32])(
    "refuses rather than wraps a width field of %i macroblocks",
    (widthMbs) => {
      expect(codedGeometry(setsOf(h264Sps({ widthMbs, heightMapUnits: 68 }), H264.pps))).toBeUndefined();
    },
  );

  /**
   * An H.265 `profile_tier_level` puts a run of zero bytes ahead of the geometry, so a device escapes it with
   * the `0x03` a start-code scan must not mistake for payload. Leaving the escape in shifts every syntax
   * element after it, which makes the read wrong rather than absent.
   */
  it("reads through emulation-prevention bytes rather than over them", () => {
    const escaped = Buffer.from(h265Sps({ widthLuma: 1920, heightLuma: 1088, window: { bottom: 4 } }));
    expect(escaped.includes(Buffer.from([0x00, 0x00, 0x03]))).toBe(true);
    expect(codedGeometry({ codec: "h265", sps: [escaped], pps: [], vps: [] })).toMatchObject({
      width: 1920,
      height: 1080,
    });
  });

  it("answers from the last SPS in force when a set carries several", () => {
    const first = Buffer.from(h264Sps({ widthMbs: 80, heightMapUnits: 45 }));
    const second = Buffer.from(h264Sps({ widthMbs: 60, heightMapUnits: 34, crop: { bottom: 2 } }));
    expect(codedGeometry({ codec: "h264", sps: [first, second], pps: [], vps: [] })).toMatchObject({
      width: 960,
      height: 540,
    });
  });
});
