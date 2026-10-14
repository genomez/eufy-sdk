/**
 * Annex-B elementary-stream helpers — the single NAL-sniffing source of truth for the P2P media
 * pipeline. Both the live source (codec tag on every frame) and the fMP4 muxer (parameter sets for
 * the init segment) read the stream through here, so the start-code scan + NAL-type decode lives in
 * exactly one place.
 *
 * H.264 (Annex-B): NAL type = `byte & 0x1f`; SPS = 7, PPS = 8, IDR = 5.
 * H.265/HEVC (Annex-B): NAL type = `(byte >> 1) & 0x3f`; VPS = 32, SPS = 33, PPS = 34, IDR = 19/20.
 *
 * @module p2p/annexb
 */
import type { VideoCodec } from "../../core/contracts.js";

/** The 4-byte Annex-B start code emitted ahead of a re-serialized NAL. */
const ANNEXB_START = Buffer.from([0x00, 0x00, 0x00, 0x01]);

/** Iterate the byte offset of every NAL payload (first byte after a 3- or 4-byte start code). */
function* nalStarts(buf: Buffer): Generator<number> {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) yield i + 3;
    else if (i + 4 < buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1)
      yield i + 4;
  }
}

/** Split an Annex-B access unit into its individual NAL bodies (start codes stripped). */
export function splitAnnexbNals(buf: Buffer): Buffer[] {
  const offsets = [...nalStarts(buf)];
  const nals: Buffer[] = [];
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? startCodeBegin(buf, offsets[k + 1]) : buf.length;
    const nal = buf.subarray(offsets[k], end);
    if (nal.length) nals.push(nal);
  }
  return nals;
}

/**
 * Sniff the codec of an Annex-B access unit by its parameter-set NAL units. Returns `undefined` when
 * the buffer carries no config NAL (a plain delta frame) — the caller should carry the last-known
 * codec rather than guess. Only the first 64 bytes are scanned (config NALs lead the access unit).
 */
export function sniffAnnexbCodec(buf: Buffer): VideoCodec | undefined {
  for (const p of nalStarts(buf)) {
    if (p > 64) break;
    const b = buf[p];
    const hevc = (b >> 1) & 0x3f;
    if (hevc === 32 || hevc === 33 || hevc === 34) return "h265";
    const h264 = b & 0x1f;
    if (h264 === 7 || h264 === 8) return "h264";
  }
  return undefined;
}

/** Parameter sets extracted from a keyframe access unit — the input to an fMP4 init segment. */
export interface ParamSets {
  codec: VideoCodec;
  /** H.264 SPS / H.265 SPS NAL bodies (start-code stripped), in stream order. */
  sps: Buffer[];
  /** H.264 PPS / H.265 PPS NAL bodies. */
  pps: Buffer[];
  /** H.265 VPS NAL bodies (empty for H.264). */
  vps: Buffer[];
}

/**
 * Extract the SPS/PPS (and, for H.265, VPS) parameter-set NAL bodies from a keyframe access unit.
 * Each returned buffer is the raw NAL (start-code stripped), ready to embed in an `avcC` / `hvcC`
 * decoder-config record. Returns `undefined` if no parameter sets are present.
 */
export function extractParamSets(buf: Buffer): ParamSets | undefined {
  const codec = sniffAnnexbCodec(buf);
  if (!codec) return undefined;
  const offsets = [...nalStarts(buf)];
  if (!offsets.length) return undefined;
  const sps: Buffer[] = [];
  const pps: Buffer[] = [];
  const vps: Buffer[] = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? startCodeBegin(buf, offsets[k + 1]) : buf.length;
    const nal = buf.subarray(start, end);
    if (!nal.length) continue;
    const b = nal[0];
    if (codec === "h265") {
      const t = (b >> 1) & 0x3f;
      if (t === 32) vps.push(nal);
      else if (t === 33) sps.push(nal);
      else if (t === 34) pps.push(nal);
    } else {
      const t = b & 0x1f;
      if (t === 7) sps.push(nal);
      else if (t === 8) pps.push(nal);
    }
  }
  if (!sps.length && !pps.length) return undefined;
  return { codec, sps, pps, vps };
}

/**
 * The parameter sets in force after `buf`, folding what it announces into `current`.
 *
 * A camera commonly announces SPS/PPS ONCE, with the first keyframe of a stream, so anything that will
 * later hand a burst to a decoder has to watch EVERY unit go past — including ones it discards.
 *
 * Folds per kind rather than replacing wholesale, because a decoder retains the last set it was given of
 * EACH kind: a unit announcing an SPS alone re-states that SPS and says nothing about the PPS, so
 * replacing the whole record would drop a PPS that is still in force. A codec change replaces
 * everything — sets from another codec describe a different bitstream.
 *
 * Cheap on the overwhelmingly common case: {@link extractParamSets} answers from a bounded head scan when
 * a unit carries no config NAL, so an ordinary delta frame costs no full-buffer walk.
 */
export function updatedParamSets(buf: Buffer, current: ParamSets | undefined): ParamSets | undefined {
  const announced = extractParamSets(buf);
  if (!announced) return current;
  if (!current || current.codec !== announced.codec) return announced;
  return {
    codec: announced.codec,
    sps: announced.sps.length ? announced.sps : current.sps,
    pps: announced.pps.length ? announced.pps : current.pps,
    vps: announced.vps.length ? announced.vps : current.vps,
  };
}

/**
 * Re-emit `sets` as Annex-B NALs immediately ahead of `annexb`, so a unit whose parameter sets were
 * sent earlier in the stream becomes decodable on its own.
 *
 * A decoder reads parameter sets in stream order, so they are emitted VPS → SPS → PPS: a PPS ahead of
 * the SPS it references is as useless as none at all. Sets carrying no NALs return the input unchanged
 * rather than an equal copy.
 *
 * Emitting a duplicate set is harmless — a decoder overwrites the entry with the same id — which is why
 * this needs no knowledge of what the unit already carries; {@link extractParamSets} answers what a
 * unit carries already.
 */
export function prefixParamSets(annexb: Buffer, sets: ParamSets): Buffer {
  const ordered = [...sets.vps, ...sets.sps, ...sets.pps];
  if (!ordered.length) return annexb;
  const prefix: Buffer[] = [];
  for (const nal of ordered) prefix.push(ANNEXB_START, nal);
  return Buffer.concat([...prefix, annexb]);
}

/** Given a NAL payload offset, back up over its (3- or 4-byte) start code to the code's first byte. */
function startCodeBegin(buf: Buffer, payloadOffset: number): number {
  // payloadOffset points just past 00 00 01; a 4-byte code has an extra leading 00.
  const threeByte = payloadOffset - 3;
  if (threeByte >= 1 && buf[threeByte - 1] === 0) return threeByte - 1;
  return threeByte;
}

/**
 * Whether an Annex-B access unit contains an IDR (keyframe) NAL. Cheap scan used to key-align the
 * ring buffer / fragment boundaries when the frame header's keyframe flag isn't authoritative.
 */
export function hasIdr(buf: Buffer, codec: VideoCodec): boolean {
  for (const p of nalStarts(buf)) {
    const b = buf[p];
    if (codec === "h265") {
      const t = (b >> 1) & 0x3f;
      if (t === 19 || t === 20) return true;
    } else if ((b & 0x1f) === 5) return true;
  }
  return false;
}

/** A width/height pair in luma samples. */
export interface Size {
  width: number;
  height: number;
}

/**
 * What a parameter set says a picture's dimensions are — both of them.
 *
 * A stream states TWO sizes and a consumer needs whichever matches what it holds. {@link CodedGeometry.width}
 * and `height` are the DISPLAY size, the picture as a viewer should see it. {@link CodedGeometry.coded} is the
 * size it is actually coded at, rounded up to the macroblock (H.264) or CTU (H.265) grid, and
 * {@link CodedGeometry.crop} is the window between them, already scaled from the chroma units the syntax
 * states them in into luma samples.
 *
 * The distinction is not a refinement: 1080 is not a multiple of 16, so the commonest geometry there is codes
 * 1088 rows and crops 8 away. A caller that muxes or measures wants the display size; a caller DECODING frames
 * itself gets the coded size back from its decoder and needs the window to crop with — one that assumes the two
 * are the same emits eight rows of encoder padding and calls the result 1088 tall.
 */
export interface CodedGeometry extends Size {
  /** The size the picture is coded at — macroblock- or CTU-aligned, and never smaller than the display size. */
  coded: Size;
  /** The crop (H.264) or conformance (H.265) window, in LUMA samples. */
  crop: { left: number; top: number; right: number; bottom: number };
}

/**
 * Beyond the widest picture any defined H.264 or H.265 level permits.
 *
 * An exp-Golomb field decodes to an arbitrarily large number from bytes that are not the syntax the
 * reader thinks it is reading, so a dimension past this is evidence the parse went wrong rather than a
 * picture size — and a caller acting on it would size a decoder for a stream that does not exist.
 */
const MAX_CODED_DIMENSION = 32768;

/**
 * Profiles whose SPS carries the chroma, bit-depth and scaling-matrix fields (H.264 Annex A).
 *
 * `144` is the 2005-edition High 4:4:4 that `244` replaced. It is absent from the current standard's list but
 * present in streams, and a set read without its branch lands mid-element — so it is carried here rather
 * than left to misparse into a plausible geometry.
 */
export const H264_CHROMA_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135, 144]);

/** Chroma subsampling per `chroma_format_idc`, which is what scales a crop offset into samples. */
const CHROMA_SUBSAMPLING: Record<number, Size> = {
  0: { width: 1, height: 1 },
  1: { width: 2, height: 2 },
  2: { width: 2, height: 1 },
  3: { width: 1, height: 1 },
};

/**
 * A bit reader over one parameter set's RBSP, with the exp-Golomb encodings H.26x syntax is written in.
 *
 * Reading past the end sets {@link failed} and answers zero rather than throwing, so a parse walks to its
 * end and the caller discards the whole read at once — a mid-parse throw and a partially-consumed reader
 * both invite answering with the fields that happened to land before the bytes ran out.
 *
 * Emulation-prevention bytes are removed up front: a device inserts `0x03` after any `0x00 0x00` so its
 * payload cannot be mistaken for a start code, and every syntax element after one is shifted by 8 bits
 * until it is taken back out.
 */
class RbspReader {
  private readonly bytes: number[] = [];
  private bit = 0;
  failed = false;

  constructor(nal: Buffer, headerBytes: number) {
    for (let i = headerBytes; i < nal.length; i++) {
      const byte = nal[i]!;
      const escape =
        byte === 3 &&
        this.bytes.length >= 2 &&
        this.bytes[this.bytes.length - 1] === 0 &&
        this.bytes[this.bytes.length - 2] === 0;
      if (!escape) this.bytes.push(byte);
    }
  }

  /** The next `count` bits as an unsigned integer, most significant first. */
  u(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const index = this.bit >> 3;
      if (index >= this.bytes.length) {
        this.failed = true;
        return 0;
      }
      value = value * 2 + ((this.bytes[index]! >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return value;
  }

  /**
   * Unsigned exp-Golomb: the leading-zero run gives the width of the value that follows.
   *
   * The run is bounded at the widest a real field uses, because corrupt bytes can present an
   * arbitrarily long one and a reader that followed it to the end of the set would spend the whole
   * buffer proving what the bound establishes at once.
   *
   * The offset is computed with exponentiation rather than a shift: `1 << 32` is `1` in JavaScript, so a
   * 33-bit code word would decode to a small plausible number instead of the runaway value it encodes —
   * which the geometry's range check cannot catch, because a small number looks like a picture.
   */
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      if (this.failed || ++zeros > 32) {
        this.failed = true;
        return 0;
      }
    }
    return zeros === 0 ? 0 : 2 ** zeros - 1 + this.u(zeros);
  }

  /** Signed exp-Golomb, in the standard's mapping of positives onto odd code numbers. */
  se(): number {
    const coded = this.ue();
    return coded % 2 === 0 ? -(coded / 2) : (coded + 1) / 2;
  }

  /** Consume one scaling list, whose length is a run of deltas rather than a declared size. */
  scalingList(coefficients: number): void {
    let next = 8;
    for (let i = 0; i < coefficients && next !== 0; i++) {
      next = (next + this.se() + 256) % 256;
      if (this.failed) return;
    }
  }
}

/**
 * The picture geometry a decoder will produce from the parameter sets in force, or `undefined` when no
 * SPS could be read.
 *
 * This is the authority on a live stream's geometry. A frame header states the geometry at capture start,
 * and a source that reconfigures mid-session leaves it contradicting the bytes it is sending — so a
 * consumer that rebuilt a decoder from the header would size it for a picture the stream is not carrying.
 * The SPS is what the picture actually is.
 *
 * The crop and conformance offsets are part of the answer rather than a refinement of it: 1080 is not a
 * multiple of the 16-sample macroblock, so a 1080p H.264 stream codes 1088 rows and crops 8 away. A read
 * that stopped at the coded size would be wrong by exactly that on the commonest geometry there is.
 *
 * Answers from the LAST SPS of the set, which is the one in force. AV1 is not parsed — the SDK decodes no
 * AV1 sequence header, and a size from another codec's syntax would be a fabrication.
 */
export function codedGeometry(sets: ParamSets): CodedGeometry | undefined {
  const sps = sets.sps[sets.sps.length - 1];
  if (!sps) return undefined;
  const geometry = sets.codec === "h264" ? h264Geometry(sps) : sets.codec === "h265" ? h265Geometry(sps) : undefined;
  if (!geometry) return undefined;
  const { width, height } = geometry;
  const plausible =
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_CODED_DIMENSION &&
    height <= MAX_CODED_DIMENSION;
  return plausible ? geometry : undefined;
}

/**
 * The crop window an H.264 SPS declares, or the conformance window an H.265 one does — the same four
 * offsets, in chroma samples, which is why {@link CHROMA_SUBSAMPLING} scales them into luma.
 */
interface CropWindow {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Read the four offsets where the present flag is set, or all-zero where it is not. */
function cropWindow(r: RbspReader): CropWindow {
  if (r.u(1) !== 1) return { left: 0, right: 0, top: 0, bottom: 0 };
  return { left: r.ue(), right: r.ue(), top: r.ue(), bottom: r.ue() };
}

/**
 * Read an H.264 SPS (ITU-T H.264 §7.3.2.1.1) up to its frame-cropping offsets.
 *
 * Everything between the profile and the geometry is skipped rather than interpreted, but it has to be
 * skipped EXACTLY: the scaling matrices and the picture-order-count fields are variable-length, so a
 * reader that guessed their size would land mid-element and answer a plausible wrong number.
 */
function h264Geometry(sps: Buffer): CodedGeometry | undefined {
  const r = new RbspReader(sps, 1);
  const profileIdc = r.u(8);
  r.u(8);
  r.u(8);
  r.ue();
  let chromaFormatIdc = 1;
  let separateColourPlane = false;
  if (H264_CHROMA_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.u(1) === 1;
    r.ue();
    r.ue();
    r.u(1);
    if (r.u(1) === 1) {
      for (let i = 0; i < (chromaFormatIdc !== 3 ? 8 : 12); i++) {
        if (r.u(1) === 1) r.scalingList(i < 6 ? 16 : 64);
      }
    }
  }
  r.ue();
  const pictureOrderCountType = r.ue();
  if (pictureOrderCountType === 0) r.ue();
  else if (pictureOrderCountType === 1) {
    r.u(1);
    r.se();
    r.se();
    const cycle = r.ue();
    for (let i = 0; i < cycle && !r.failed; i++) r.se();
  }
  r.ue();
  r.u(1);
  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1) === 1;
  if (!frameMbsOnly) r.u(1);
  r.u(1);
  const crop = cropWindow(r);
  if (r.failed) return undefined;
  const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
  const subsampling = CHROMA_SUBSAMPLING[chromaArrayType];
  if (!subsampling) return undefined;
  const fieldFactor = frameMbsOnly ? 1 : 2;
  const coded = { width: widthMbs * 16, height: fieldFactor * heightMapUnits * 16 };
  const luma = {
    left: subsampling.width * crop.left,
    right: subsampling.width * crop.right,
    top: subsampling.height * fieldFactor * crop.top,
    bottom: subsampling.height * fieldFactor * crop.bottom,
  };
  return {
    width: coded.width - luma.left - luma.right,
    height: coded.height - luma.top - luma.bottom,
    coded,
    crop: luma,
  };
}

/**
 * Read an H.265 SPS (ITU-T H.265 §7.3.2.2.1) up to its conformance window.
 *
 * The luma dimensions are stated directly, so the work is reaching them: `profile_tier_level` carries a
 * fixed 88-bit base-layer record plus its level byte, followed by a per-sub-layer one of the same shape
 * whose two halves are separately signalled. Its length is the only thing standing between the reader and
 * the geometry.
 */
function h265Geometry(sps: Buffer): CodedGeometry | undefined {
  const r = new RbspReader(sps, 2);
  r.u(4);
  const maxSubLayersMinus1 = r.u(3);
  r.u(1);
  r.u(32);
  r.u(32);
  r.u(24);
  r.u(8);
  const profilePresent: boolean[] = [];
  const levelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(r.u(1) === 1);
    levelPresent.push(r.u(1) === 1);
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.u(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) {
      r.u(32);
      r.u(32);
      r.u(24);
    }
    if (levelPresent[i]) r.u(8);
  }
  r.ue();
  const chromaFormatIdc = r.ue();
  if (chromaFormatIdc === 3) r.u(1);
  const width = r.ue();
  const height = r.ue();
  const window = cropWindow(r);
  if (r.failed) return undefined;
  const subsampling = CHROMA_SUBSAMPLING[chromaFormatIdc];
  if (!subsampling) return undefined;
  const coded = { width, height };
  const luma = {
    left: subsampling.width * window.left,
    right: subsampling.width * window.right,
    top: subsampling.height * window.top,
    bottom: subsampling.height * window.bottom,
  };
  return {
    width: coded.width - luma.left - luma.right,
    height: coded.height - luma.top - luma.bottom,
    coded,
    crop: luma,
  };
}
