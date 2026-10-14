/**
 * The Raw-DP frame, arriving hex-encoded instead of base64.
 *
 * A robot publishes its map to a second MQTT topic — `biz/eufy_home/<model>/<sn>/res` — and the
 * payloads there are the SAME `varint(len) ++ protobufMessage` frame every Raw DP carries, wrapped in
 * a JSON envelope and written as hex rather than base64. So the whole reader already exists: only the
 * outer encoding differs, and this turns one into the other.
 *
 * Deliberately not a second codec. `RawDpCodec` owns the framing, the length-prefix validity check and
 * the wire-type walk; re-implementing any of that for a different string encoding would be two readers
 * to keep in agreement, which is how they stop agreeing.
 *
 * @module core/raw-dp-hex
 */

/**
 * Hex the biz stream carries, re-encoded as the base64 a {@link RawDpCodec} reads — or `undefined`
 * when the input is not clean hex.
 *
 * **The validation is the point, and it is not paranoia.** `Buffer.from(s, "hex")` never throws: it
 * decodes until it meets a character that is not a hex digit and silently returns what it got, and it
 * drops a trailing half-byte from an odd-length string. For base64 that silent truncation is harmless,
 * because the codec's length prefix will not match the shortened body and the payload is rejected —
 * the reader's own doc says so. Hex breaks that guarantee: truncation removes bytes from the END,
 * so `"02" + "aabb" + <garbage>` decodes to a prefix of 2 followed by exactly two bytes, passes the
 * length check, and hands back a message with the garbage quietly discarded. A shorter,
 * self-consistent, WRONG payload is the one failure the codec cannot catch for us, so it is caught
 * here instead.
 *
 * An empty string is `undefined` rather than an empty frame: the envelope omits the field entirely
 * when there is nothing to send, so "" means "no payload", not "a payload of no bytes".
 */
export function hexToRawDp(hex: string): string | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  return Buffer.from(hex, "hex").toString("base64");
}
