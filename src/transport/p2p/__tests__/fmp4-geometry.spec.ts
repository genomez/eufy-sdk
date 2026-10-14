import { describe, expect, it } from "vitest";
import { Fmp4Muxer } from "../fmp4.js";
import { H264, h264Sps, unit, videoFrame } from "./live-source-fixtures.js";

/**
 * What geometry the init segment declares.
 *
 * The muxer had one source for it — the frame header, falling back to zero — so a stream whose header
 * carried no geometry produced a track declaring a zero-height picture, and one whose header disagreed
 * with its own parameter sets produced a track declaring the disagreement. The parameter sets state the
 * size a decoder will actually produce, and the muxer holds them already because the `avcC` it writes is
 * built from them.
 */
const SPS_1080 = h264Sps({ widthMbs: 120, heightMapUnits: 68, crop: { bottom: 4 } });

/** The `width` and `height` fields of the visual sample entry (`avc1` payload @ 0x18 / 0x1a). */
function sampleEntryGeometry(init: Buffer): { width: number; height: number } {
  const payload = init.indexOf(Buffer.from("avc1", "ascii")) + 4;
  return { width: init.readUInt16BE(payload + 24), height: init.readUInt16BE(payload + 26) };
}

/** The 16.16 fixed-point `width` and `height` of the track header (`tkhd` payload @ 0x4c / 0x50). */
function trackGeometry(init: Buffer): { width: number; height: number } {
  const payload = init.indexOf(Buffer.from("tkhd", "ascii")) + 4;
  return { width: init.readUInt32BE(payload + 76) >>> 16, height: init.readUInt32BE(payload + 80) >>> 16 };
}

function initSegmentFor(frame: Parameters<Fmp4Muxer["push"]>[0]): Buffer {
  const mux = new Fmp4Muxer();
  const emitted = mux.push(frame, 0);
  expect(emitted?.init).toBeDefined();
  return emitted!.init!;
}

describe("fMP4 init-segment geometry", () => {
  it("declares the geometry the parameter sets state", () => {
    const init = initSegmentFor(videoFrame(unit(SPS_1080, H264.pps, H264.idr)));
    expect(sampleEntryGeometry(init)).toEqual({ width: 1920, height: 1080 });
    expect(trackGeometry(init)).toEqual({ width: 1920, height: 1080 });
  });

  it("prefers the parameter sets over a frame header that disagrees with them", () => {
    const frame = videoFrame(unit(SPS_1080, H264.pps, H264.idr), { width: 640, height: 360 });
    expect(sampleEntryGeometry(initSegmentFor(frame))).toEqual({ width: 1920, height: 1080 });
  });

  it("falls back to the frame header when the parameter sets carry no readable geometry", () => {
    const frame = videoFrame(unit(H264.sps, H264.pps, H264.idr), { width: 1600, height: 1200 });
    expect(sampleEntryGeometry(initSegmentFor(frame))).toEqual({ width: 1600, height: 1200 });
  });

  it("declares a height rather than zero when only the parameter sets know it", () => {
    const frame = videoFrame(unit(SPS_1080, H264.pps, H264.idr), { width: 0, height: 0 });
    expect(sampleEntryGeometry(initSegmentFor(frame))).toEqual({ width: 1920, height: 1080 });
  });
});

/**
 * A sample keeps the parameter-set NALs its access unit carried.
 *
 * That is what lets a decoder follow a reconfiguration the init segment cannot describe: a camera changes
 * coded geometry within one session, the init segment is written once, and the recording stays decodable
 * only because every later keyframe re-states its own sets inside `mdat`. Stripping them to the declared
 * out-of-band config alone would leave every sample after the first change undecodable.
 */
describe("fMP4 samples", () => {
  /**
   * A fragment closes BEFORE the sample that ends it is added, so the reconfigured keyframe leaves in the
   * fragment after the boundary it opened — here, the flushed tail.
   */
  it("retains the parameter sets a keyframe carried, so a reconfiguration is followed in-band", () => {
    const mux = new Fmp4Muxer({ fragmentSeconds: 0 });
    mux.push(videoFrame(unit(SPS_1080, H264.pps, H264.idr)), 0);
    const reconfigured = h264Sps({ widthMbs: 80, heightMapUnits: 45 });
    mux.push(videoFrame(unit(reconfigured, H264.pps, H264.idr)), 100);
    const tail = mux.flush();
    expect(tail?.data.includes(Buffer.from(reconfigured))).toBe(true);
  });
});
