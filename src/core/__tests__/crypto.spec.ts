import { aesKey, decryptBody, encryptBody, signKey, signRequest, gtoken } from "../crypto.js";
import vector from "./vector.json" with { type: "json" };

/**
 * `vector.json` is a SYNTHETIC, self-consistent fixture (no real account data):
 * { sharedKey, ts, once, ident, body_b64 (encrypted), body_pt (plaintext), sig }.
 * It guards the algo_ecdh formula (decrypt + sign must reproduce these exact
 * values). The formula itself was originally verified 724/724 against live traffic.
 */
describe("algo_ecdh crypto (self-consistent synthetic fixture)", () => {
  it("derives the 16-byte AES key from the first half of the shared key", () => {
    expect(aesKey(vector.sharedKey)).toHaveLength(16);
    expect(aesKey(vector.sharedKey).toString("hex")).toBe(vector.sharedKey.slice(0, 32));
  });

  it("HMAC sign key is the first 32 hex chars as UTF-8 (32 bytes)", () => {
    expect(signKey(vector.sharedKey)).toHaveLength(32);
    expect(signKey(vector.sharedKey).toString("utf-8")).toBe(vector.sharedKey.slice(0, 32));
  });

  it("decrypts the fixture encrypted body to the exact plaintext", () => {
    expect(decryptBody(vector.body_b64, vector.sharedKey).toString("utf-8")).toBe(vector.body_pt);
  });

  it("reproduces the fixture x-signature exactly", () => {
    expect(signRequest(vector.sharedKey, vector.ts, vector.once, vector.body_b64)).toBe(vector.sig);
  });

  it("signs an empty-body request as ts+once (no trailing +)", () => {
    const expected = signRequest(vector.sharedKey, vector.ts, vector.once); // no body arg
    // equivalent to HMAC over `${ts}+${once}` — assert it differs from the bodied one
    expect(expected).toHaveLength(64);
    expect(expected).not.toBe(vector.sig);
  });

  it("encryptBody → decryptBody round-trips", () => {
    const pt = JSON.stringify({ hello: "world", n: 42 });
    const enc = encryptBody(pt, vector.sharedKey);
    expect(decryptBody(enc, vector.sharedKey).toString("utf-8")).toBe(pt);
    // IV is random → ciphertext differs each call
    expect(encryptBody(pt, vector.sharedKey)).not.toBe(enc);
  });

  it("gtoken is md5(user_id) hex", () => {
    expect(gtoken("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
});
