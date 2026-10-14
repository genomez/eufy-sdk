import { randomBytes } from "node:crypto";
import { buildStringCommandPayload, encryptP2PData, paddingP2PData, decryptP2PData } from "../codec.js";

/**
 * Framing round-trip for the string-payload control command (used by
 * P2PSession.requestImage → CMD_SET_PAYLOAD). We can't exercise the live UDP
 * exchange offline, but we CAN prove the byte layout + AES-128-ECB head match the
 * app's `buildCommandWithStringTypePayload`: header len, channel/encType word, and
 * that the encrypted body decrypts back to the (zero-padded) JSON value.
 */
describe("buildStringCommandPayload (CMD_SET_PAYLOAD framing)", () => {
  const key = randomBytes(16);
  const value = JSON.stringify({ cmd: 1308, payload: [{ file: "/userdata/push/x.jpg" }] });

  it("lays out [len][0000][0100][channel,encType][0000][data] and encrypts the body", () => {
    const buf = buildStringCommandPayload(value, 0, key, 1);
    const declaredLen = buf.readUInt16LE(0);
    expect(buf.subarray(2, 4)).toEqual(Buffer.from([0x00, 0x00]));
    expect(buf.subarray(4, 6)).toEqual(Buffer.from([0x01, 0x00])); // magic
    expect(buf[6]).toBe(0x00); // channel 0
    expect(buf[7]).toBe(0x01); // encType 1 (level-1) since a key was given
    expect(buf.subarray(8, 10)).toEqual(Buffer.from([0x00, 0x00]));

    const body = buf.subarray(10);
    expect(body.length).toBe(declaredLen);
    expect(body.length % 16).toBe(0); // padded to block size

    const decrypted = decryptP2PData(body, key);
    // strip trailing zero padding, compare to original JSON
    const text = decrypted.toString("utf-8").replace(/\0+$/, "");
    expect(text).toBe(value);
  });

  it("unencrypted variant (no key) writes encType 0 and raw body", () => {
    const buf = buildStringCommandPayload(value, 0);
    expect(buf[7]).toBe(0x00); // encType 0
    expect(buf.subarray(10).toString("utf-8")).toBe(value);
  });

  it("encryptP2PData/paddingP2PData round-trip", () => {
    const padded = paddingP2PData(Buffer.from(value));
    expect(padded.length % 16).toBe(0);
    expect(decryptP2PData(encryptP2PData(padded, key), key).equals(padded)).toBe(true);
  });
});
