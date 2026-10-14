import { sniffAnnexbCodec, extractParamSets, hasIdr } from "../annexb.js";

const SC4 = Buffer.from([0, 0, 0, 1]);
const SC3 = Buffer.from([0, 0, 1]);

/** Join NAL bodies with 4-byte start codes into one Annex-B access unit. */
function annexb(...nals: Buffer[]): Buffer {
  return Buffer.concat(nals.flatMap((n) => [SC4, n]));
}

// H.264 NAL first bytes: SPS=0x67 (type 7), PPS=0x68 (type 8), IDR=0x65 (type 5), non-IDR=0x41 (type 1)
const H264_SPS = Buffer.from([0x67, 0x42, 0x00, 0x1e]);
const H264_PPS = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
const H264_IDR = Buffer.from([0x65, 0x88, 0x84]);
// non-IDR slice, type 1, nal_ref_idc=1 (0x21). NOT 0x41: a single NAL byte can't disambiguate codecs
// (0x41 → h264 type 1 but ALSO h265 type 32/VPS), and sniff is only ever run on keyframes in the live
// path, so the config-less case just needs a byte that isn't a param set under either codec.
const H264_P = Buffer.from([0x21, 0x9a, 0x00]);

// H.265 NAL first bytes: VPS type 32 → (0x40), SPS type 33 → (0x42), PPS type 34 → (0x44), IDR_W_RADL type 19/20 → (0x26/0x28)
const H265_VPS = Buffer.from([0x40, 0x01, 0x0c]);
const H265_SPS = Buffer.from([0x42, 0x01, 0x01]);
const H265_PPS = Buffer.from([0x44, 0x01, 0xc0]);
const H265_IDR = Buffer.from([0x26, 0x01, 0xaf]);

describe("sniffAnnexbCodec", () => {
  it("sniffs h264 from an SPS", () => {
    expect(sniffAnnexbCodec(annexb(H264_SPS, H264_PPS, H264_IDR))).toBe("h264");
  });

  it("sniffs h265 from a VPS/SPS/PPS", () => {
    expect(sniffAnnexbCodec(annexb(H265_VPS, H265_SPS, H265_PPS, H265_IDR))).toBe("h265");
  });

  it("returns undefined for a config-less delta frame", () => {
    expect(sniffAnnexbCodec(annexb(H264_P))).toBeUndefined();
  });

  it("handles 3-byte start codes", () => {
    const buf = Buffer.concat([SC3, H264_SPS]);
    expect(sniffAnnexbCodec(buf)).toBe("h264");
  });
});

describe("extractParamSets", () => {
  it("extracts h264 SPS + PPS bodies (start codes stripped)", () => {
    const ps = extractParamSets(annexb(H264_SPS, H264_PPS, H264_IDR));
    expect(ps?.codec).toBe("h264");
    expect(ps?.sps).toHaveLength(1);
    expect(ps?.pps).toHaveLength(1);
    expect(ps?.vps).toHaveLength(0);
    expect(ps!.sps[0].equals(H264_SPS)).toBe(true);
    expect(ps!.pps[0].equals(H264_PPS)).toBe(true);
  });

  it("extracts h265 VPS + SPS + PPS bodies", () => {
    const ps = extractParamSets(annexb(H265_VPS, H265_SPS, H265_PPS, H265_IDR));
    expect(ps?.codec).toBe("h265");
    expect(ps?.vps).toHaveLength(1);
    expect(ps?.sps).toHaveLength(1);
    expect(ps?.pps).toHaveLength(1);
    expect(ps!.vps[0].equals(H265_VPS)).toBe(true);
  });

  it("returns undefined without parameter sets", () => {
    expect(extractParamSets(annexb(H264_P))).toBeUndefined();
  });
});

describe("hasIdr", () => {
  it("detects an h264 IDR", () => {
    expect(hasIdr(annexb(H264_SPS, H264_IDR), "h264")).toBe(true);
    expect(hasIdr(annexb(H264_P), "h264")).toBe(false);
  });

  it("detects an h265 IDR", () => {
    expect(hasIdr(annexb(H265_SPS, H265_IDR), "h265")).toBe(true);
  });
});
