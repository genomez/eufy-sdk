/**
 * The per-run detail blob a {@link CleanRecord} points at — map and statistics for one cleaning run.
 *
 * `get_device_clean_record_list` answers a list of runs, each carrying a `downloadUrl`. The bytes
 * behind that URL are NOT a bare protobuf: they arrive inside the vendor's own container, with a magic
 * header, a length, and a trailing checksum. This owns both halves — unwrapping the container and
 * reading the message inside it — and neither fetches the URL nor decides whether it is safe to.
 *
 * Fetching stays with the caller on purpose: the host these URLs point at is unconfirmed, and this
 * client's binary path is host-allowlisted with SSRF checks by design. Handing the SDK a URL to fetch
 * would route around a control that exists for a reason.
 *
 * @module model/clean-record-detail
 */
import type { RawDpCodec } from "../core/contracts.js";

/** Why a run ended, as the vendor's `finish_reason` reports it. */
export const CLEAN_FINISH_REASONS = ["completed", "manual", "lowPower", "exception"] as const;
export type CleanFinishReason = (typeof CLEAN_FINISH_REASONS)[number];

/** One completed run's statistics, decoded from its detail blob. */
export interface CleanRecordDetail {
  /** When the run started, in unix SECONDS. */
  readonly startTime: number;
  /** When the run ended, in unix seconds. */
  readonly endTime: number;
  /** How long the run took, in seconds. */
  readonly duration: number;
  /** Area covered, in the unit the device reports it in (m² on every model seen so far). */
  readonly area: number;
  /** The cleaning type the run used, as the vendor's raw enum index. */
  readonly cleanType: number;
  /** Why the run ended. `undefined` when the device reported a value this version does not name. */
  readonly finishReason: CleanFinishReason | undefined;
}

/** Field numbers inside `CleanRecordDesc` — the message the container carries. */
const DETAIL_FIELD = {
  START_TIME: 1,
  END_TIME: 2,
  DURATION: 3,
  AREA: 4,
  CLEAN_TYPE: 5,
  FINISH_REASON: 6,
} as const;

/** The container's magic bytes: a marker and a version. */
const MAGIC = [0xaa, 0x01] as const;
/** The trailing checksum's width, in bytes. */
const CHECKSUM_BYTES = 2;

/**
 * Unwrap the vendor's container and hand back the protobuf inside it, or `undefined`.
 *
 * The container is `0xAA 0x01`, a length, the message, then a two-byte big-endian checksum over every
 * byte before it. **The width of the length field is not documented**, so rather than assume one, this
 * tries the plausible widths and keeps the one whose checksum verifies — the checksum is the oracle,
 * and a wrong guess about the length fails it rather than producing a plausible wrong message.
 *
 * That is the whole reason this validates instead of parsing optimistically: a run's statistics that
 * are quietly wrong are worse than statistics a caller could not read.
 */
export function unwrapCleanRecordBlob(blob: Uint8Array): Uint8Array | undefined {
  if (blob.length < MAGIC.length + 1 + CHECKSUM_BYTES) return undefined;
  if (blob[0] !== MAGIC[0] || blob[1] !== MAGIC[1]) return undefined;

  const end = blob.length - CHECKSUM_BYTES;
  let sum = 0;
  for (let i = 0; i < end; i++) sum += blob[i]!;
  const stated = (blob[end]! << 8) | blob[end + 1]!;
  if ((sum & 0xffff) !== stated) return undefined;

  // The checksum holds, so the container is real; now find where the body starts. A length field that
  // agrees with the body it precedes is the one the vendor wrote.
  for (const width of [2, 4, 1]) {
    const start = MAGIC.length + width;
    if (start > end) continue;
    let declared = 0;
    for (let i = MAGIC.length; i < start; i++) declared = declared * 256 + blob[i]!;
    if (declared === end - start) return blob.subarray(start, end);
  }
  return undefined;
}

/**
 * Decode one run's detail blob into a {@link CleanRecordDetail}.
 *
 * `codec` is the same {@link RawDpCodec} the capabilities read DP payloads with — passed in rather
 * than imported, because the implementation lives in the transport layer and this one does not reach
 * across that line.
 *
 * Every field defaults to `0` when the message omits it: proto3 omits a zero, so a run that covered no
 * area and one that said nothing about area are the same bytes, and `0` is the honest reading of both.
 * `finishReason` is the exception — an index this version cannot name answers `undefined` rather than
 * being flattened onto a neighbouring reason.
 *
 * Returns `undefined` when the container fails its checksum or the bytes inside are not a message —
 * never throws, and never a partial read.
 *
 * **`Extra` is not decoded.** The message carries a nested `Extra { mode, mus, error_code, prompt_code }`
 * whose own field number within `CleanRecordDesc` is not recorded in any source this SDK can point at.
 * Reading it would mean picking a number, and a wrong one would silently report another field's bytes.
 */
export function parseCleanRecordDetail(blob: Uint8Array, codec: RawDpCodec): CleanRecordDetail | undefined {
  const body = unwrapCleanRecordBlob(blob);
  if (!body) return undefined;
  const fields = codec.nested(Buffer.from(body));
  if (!fields) return undefined;

  const num = (field: number): number => {
    const found = fields.find((f) => f.field === field);
    return found?.kind === "int" ? Number(found.value) : 0;
  };
  const reason = fields.find((f) => f.field === DETAIL_FIELD.FINISH_REASON);

  return {
    startTime: num(DETAIL_FIELD.START_TIME),
    endTime: num(DETAIL_FIELD.END_TIME),
    duration: num(DETAIL_FIELD.DURATION),
    area: num(DETAIL_FIELD.AREA),
    cleanType: num(DETAIL_FIELD.CLEAN_TYPE),
    // An absent reason is the enum's zero member, which is `completed` — the ordinary way a run ends.
    finishReason:
      reason === undefined
        ? CLEAN_FINISH_REASONS[0]
        : reason.kind === "int"
          ? CLEAN_FINISH_REASONS[Number(reason.value)]
          : undefined,
  };
}
