import { describe, expect, it } from "vitest";
import {
  AAC_FRAME_MS,
  AdtsFrameReader,
  describeAdts,
  isSupportedAdts,
  MAX_AUDIO_FRAME_BYTES,
  parseAdtsHeader,
} from "../adts.js";

/**
 * Build one ADTS frame exactly the way the V6 app's encoder does
 * (`media/player/audio/AacEncode.java:43-51`): AAC-LC, 16 kHz, mono, no CRC. `payloadLen` is the
 * audio payload; the header's own length field covers header + payload.
 */
function adtsFrame(payloadLen: number, fill = 0xaa, opts: { freqIndex?: number; channels?: number } = {}): Buffer {
  const total = 7 + payloadLen;
  const freqIndex = opts.freqIndex ?? 8;
  const channels = opts.channels ?? 1;
  const h = Buffer.alloc(7);
  h[0] = 0xff;
  h[1] = 0xf9;
  h[2] = (1 << 6) | (freqIndex << 2) | ((channels >> 2) & 0x01);
  h[3] = ((channels & 0x03) << 6) | ((total >> 11) & 0x03);
  h[4] = (total >> 3) & 0xff;
  h[5] = ((total & 0x07) << 5) | 0x1f;
  h[6] = 0xfc;
  return Buffer.concat([h, Buffer.alloc(payloadLen, fill)]);
}

describe("ADTS header parsing", () => {
  it("decodes the app's own header shape — AAC-LC, 16 kHz, mono", () => {
    const h = parseAdtsHeader(adtsFrame(100));
    expect(h).toEqual({ frameLength: 107, headerLength: 7, profile: 1, frequencyIndex: 8, channels: 1 });
    expect(isSupportedAdts(h!)).toBe(true);
  });

  it("reports a 9-byte header when the CRC bit says the frame carries one", () => {
    const f = adtsFrame(100);
    f[1] &= ~0x01;
    expect(parseAdtsHeader(f)!.headerLength).toBe(9);
  });

  it("rejects a run with no syncword, and one too short to decide", () => {
    expect(parseAdtsHeader(Buffer.alloc(7))).toBeUndefined();
    expect(parseAdtsHeader(adtsFrame(100).subarray(0, 6))).toBeUndefined();
  });

  it("rejects a frameLength that cannot even cover its own header", () => {
    const f = adtsFrame(100);
    f[3] &= 0xfc;
    f[4] = 0;
    f[5] &= 0x1f;
    expect(parseAdtsHeader(f)).toBeUndefined();
  });

  it("refuses parameters the device's audio path is not fixed at", () => {
    const wrongRate = parseAdtsHeader(adtsFrame(100, 0xaa, { freqIndex: 4 }))!;
    const stereo = parseAdtsHeader(adtsFrame(100, 0xaa, { channels: 2 }))!;
    expect(isSupportedAdts(wrongRate)).toBe(false);
    expect(isSupportedAdts(stereo)).toBe(false);
    expect(describeAdts(wrongRate)).toBe("AAC-LC, 44100 Hz, 1 channel(s)");
    expect(describeAdts(stereo)).toBe("AAC-LC, 16000 Hz, 2 channel(s)");
  });
});

describe("AdtsFrameReader", () => {
  it("yields whole frames from a stream that already aligns", () => {
    const r = new AdtsFrameReader();
    const out = r.push(Buffer.concat([adtsFrame(100, 0x11), adtsFrame(120, 0x22)]));
    expect(out.map((f) => f.length)).toEqual([107, 127]);
    expect(r.pending).toBe(0);
  });

  it("holds a frame that straddles two chunks instead of splitting it", () => {
    const whole = adtsFrame(200, 0x33);
    const r = new AdtsFrameReader();
    expect(r.push(whole.subarray(0, 50))).toEqual([]);
    expect(r.pending).toBe(50);
    const out = r.push(whole.subarray(50));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(whole);
    expect(r.pending).toBe(0);
  });

  it("reassembles byte-at-a-time input — the worst case a chunked host can produce", () => {
    const frames = [adtsFrame(64, 0x01), adtsFrame(96, 0x02), adtsFrame(48, 0x03)];
    const stream = Buffer.concat(frames);
    const r = new AdtsFrameReader();
    const out: Buffer[] = [];
    for (const b of stream) out.push(...r.push(Buffer.from([b])));
    expect(out).toEqual(frames);
    expect(r.pending).toBe(0);
  });

  it("resyncs past leading garbage rather than failing the stream", () => {
    const frame = adtsFrame(80, 0x44);
    const out = new AdtsFrameReader().push(Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]), frame]));
    expect(out).toEqual([frame]);
  });
});

describe("device audio constants", () => {
  it("one AAC-LC frame at 16 kHz is 64 ms", () => {
    expect(AAC_FRAME_MS).toBe(64);
  });

  it("the frame ceiling matches what the app refuses to send", () => {
    expect(MAX_AUDIO_FRAME_BYTES).toBe(640);
  });
});
