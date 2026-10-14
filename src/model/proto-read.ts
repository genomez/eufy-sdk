/**
 * The field readers every Raw-DP decoder on this line shares.
 *
 * `RawDpCodec` hands back a flat list of `{ field, kind, value }` and stops there — it has no schema
 * and no idea which message it just walked. Turning that list into a reading is the decoder's job, and
 * these are the readers every decoder on this line shares: the interesting part is not the code but the
 * RULE each one encodes, and a rule spelled out in three places drifts in two of them.
 *
 * **The rule, in one line: proto3 omits a zero, so absent and zero are the same bytes.** A field set to
 * `0`, `false` or `""` is not written to the wire at all, which means no reader here can tell "the
 * device said zero" from "the device said nothing". Every function below therefore answers with the
 * zero member rather than with `undefined`, and a decoder that needs the distinction has to find it
 * somewhere else in the message — a `oneof` branch, a sibling flag, a wrapper message whose presence
 * is itself the signal. Reading a defaulted zero as a real value is where this project's silent wire
 * bugs have come from, three times over.
 *
 * @module model/proto-read
 */
import type { RawDpCodec, RawDpField } from "../core/contracts.js";

/** Read a varint field as a number, or `0` — proto3 omits a zero, so absent and zero are one value. */
export function int(fields: readonly RawDpField[] | undefined, field: number): number {
  const hit = fields?.find((f) => f.field === field);
  return hit?.kind === "int" ? Number(hit.value) : 0;
}

/** Read a bool field on the same terms: absent is `false`, because that is what the vendor omitted. */
export function flag(fields: readonly RawDpField[] | undefined, field: number): boolean {
  const hit = fields?.find((f) => f.field === field);
  return hit?.kind === "int" && hit.value !== 0n;
}

/**
 * Read a `sint32`/`sint64` field, undoing the zig-zag encoding.
 *
 * The codec reads every varint unsigned, because the wire does not say which of `int32`, `sint32` and
 * `uint32` a field was declared as — only the message's author knows, and that is the decoder. A
 * `sint32` maps small negatives onto small unsigned values so they cost one byte instead of ten, and
 * left alone they read as large positives: the map's coordinates are signed centimetres and routinely
 * negative, so a point at `-150` would otherwise decode to `299` and place a wall on the wrong side of
 * the room. This is the exact inverse of the writer's `zigzag`.
 */
export function signed(fields: readonly RawDpField[] | undefined, field: number): number {
  const raw = int(fields, field);
  return raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2;
}

/**
 * Read a string field, or `undefined`.
 *
 * An empty string reads as `undefined` too: proto3 omits it, so a device that sent no name and one
 * that sent an empty name are the same bytes, and `""` is not a name.
 */
export function text(fields: readonly RawDpField[] | undefined, field: number): string | undefined {
  const hit = fields?.find((f) => f.field === field);
  return hit?.kind === "bytes" && hit.value.length > 0 ? hit.value.toString("utf8") : undefined;
}

/**
 * Read a length-delimited field as its raw bytes — a blob the sender did not intend as a message.
 *
 * Distinct from {@link sub} on purpose: a pixel plane and a nested message are the same wire type, and
 * asking for one when the payload holds the other is how a decoder ends up walking image data as if it
 * were fields. An empty payload reads as `undefined`, on the same proto3 rule as {@link text}.
 */
export function bytes(fields: readonly RawDpField[] | undefined, field: number): Buffer | undefined {
  const hit = fields?.find((f) => f.field === field);
  return hit?.kind === "bytes" && hit.value.length > 0 ? hit.value : undefined;
}

/** Step into a sub-message, or `undefined` when the container is absent or is not one. */
export function sub(
  codec: RawDpCodec,
  fields: readonly RawDpField[] | undefined,
  field: number,
): readonly RawDpField[] | undefined {
  const hit = fields?.find((f) => f.field === field);
  return hit?.kind === "bytes" ? codec.nested(hit.value) : undefined;
}

/** Every repeat of one length-delimited field, stepped into — `find` would collapse a repeated one. */
export function each(
  codec: RawDpCodec,
  fields: readonly RawDpField[] | undefined,
  field: number,
): (readonly RawDpField[])[] {
  return (fields ?? []).flatMap((f) => {
    if (f.field !== field || f.kind !== "bytes") return [];
    const inner = codec.nested(f.value);
    return inner ? [inner] : [];
  });
}
