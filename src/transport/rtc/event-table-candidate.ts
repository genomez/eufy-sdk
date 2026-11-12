import type { RtcSession } from "./session.js";
import { buildPortalPacket, parsePortalPacket, PortalLinkType, type PortalResponse } from "./portal-packet.js";

export const EVENT_TABLE_BYTE_CAP = 256 * 1024;
/** An array of n empty JSON objects requires at least 3n + 1 bytes within the decoded table budget. */
export const CATALOG_QUERY_COUNT_MAX = Math.floor((EVENT_TABLE_BYTE_CAP - 1) / 3);
const TABLE = "history_record_info";
export type EventTableName = typeof TABLE | "event_person_list";
const TOP_FIELDS = ["cmd", "count", "data", "end_id", "mIntRet", "msg", "start_id", "table", "transaction", "version"];
const ROW_FIELDS = [
  "device_sn",
  "record_id",
  "thumb_path",
  "video_path",
  "start_time",
  "end_time",
  "duration",
  "event_type",
  "detect_type",
];

export interface EventTableReceipt {
  outcome:
    | "success"
    | "empty"
    | "busy/not_admitted"
    | "ack_only/timeout"
    | "timeout"
    | "abandoned"
    | "owner_changed"
    | "receive_rejected"
    | "malformed_zstd"
    | "invalid_reply"
    | "result_nonzero"
    | "send_refused";
  elapsedMs: number;
  compressedBytes: number | null;
  decompressedBytes: number;
  rowCount: number | null;
  fieldTypes: Record<string, string[]>;
  resultCode: number | null;
  ownerContinuous: boolean;
  generationContinuous: boolean;
}

/** Count/type evidence only; the allowlist prevents arbitrary JSON keys becoming receipt content. */
function fieldTypes(body: Record<string, unknown>, rows: unknown[]): Record<string, string[]> {
  const type = (value: unknown) =>
    value === undefined ? "absent" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return Object.fromEntries([
    ...TOP_FIELDS.map((key) => [key, [type(body[key])]]),
    ...ROW_FIELDS.map((key) => [
      "row." + key,
      [...new Set(rows.map((row) => type((row as Record<string, unknown>)[key])))].sort(),
    ]),
  ]);
}

const ROW_KEY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
/** Nested names must look like schema (lowercase snake case, no digit runs), not data such as serials or names. */
const NESTED_KEY_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const DIGIT_RUN = /\d{4,}/;
/** A nested object with more distinct names than this is treated as a data-keyed map. */
const NESTED_KEY_MAX = 12;
const ROW_KEY_LIMIT = 150;

/**
 * Value-free shape of event-table rows for one diagnostic log line: every column name with its value
 * type and row count, plus one level of nested names inside object values or JSON-object strings.
 * Names that do not look like identifiers are counted as `<other>`; no value ever appears.
 */
export function eventRowKeyShape(rows: readonly unknown[]): string {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const type = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
  const nested = (prefix: string, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > NESTED_KEY_MAX) {
      bump(`${prefix}.<many>`);
      return;
    }
    for (const [inner, v] of entries)
      bump(
        NESTED_KEY_NAME.test(inner) && !DIGIT_RUN.test(inner) ? `${prefix}.${inner}:${type(v)}` : `${prefix}.<other>`,
      );
  };
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      bump("<non-object row>");
      continue;
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!ROW_KEY_NAME.test(key) || DIGIT_RUN.test(key)) {
        bump("<other>");
        continue;
      }
      bump(`${key}:${type(value)}`);
      nested(key, value);
      if (typeof value === "string" && value.trimStart().startsWith("{")) {
        try {
          nested(`${key}{json}`, JSON.parse(value));
        } catch {
          bump(`${key}{json}:unparsed`);
        }
      }
    }
  }
  const entries = [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const shown = entries.slice(0, ROW_KEY_LIMIT).map(([key, n]) => `${key}x${n}`);
  if (entries.length > ROW_KEY_LIMIT) shown.push(`+${entries.length - ROW_KEY_LIMIT} more`);
  return `rows=${rows.length} ${shown.join(" ")}`;
}

/** Passive decoded-frame observation; subscription does not own or change notify reassembly. */
export interface EventTableObservation {
  subscribe: (observe: (decodedBytes: number, frame: PortalResponse) => void) => () => void;
  issued: () => void;
}

/** Database FULL_TABLE (10000) read in the same nested 1350/1306 station envelope as queryDatabase. */
export function buildEventTableRequest(
  accountId: string,
  segment: number,
  transaction: string,
  queryCount = 20,
  beforeRecordId?: number,
  table: EventTableName = TABLE,
): Buffer {
  return buildPortalPacket({
    commandId: 1350,
    channel: 255,
    segment,
    payload: {
      account_id: accountId,
      cmd: 1306,
      mChannel: 255,
      mValue3: 0,
      payload: {
        cmd: 10000,
        table,
        transaction,
        payload: {
          count: queryCount,
          start_date: "",
          end_date: "",
          start_id: beforeRecordId === undefined ? 0 : beforeRecordId - 1,
          end_id: 1,
          flag: 0,
          need_ai: 1,
          res_unzip: 1,
          update_time: "0",
          start_time: "0",
          alarm_id: "",
        },
      },
    },
  });
}

/** One transaction-correlated table query, observing only already-decoded router frames. */
export function collectEventTableCandidate(
  session: RtcSession,
  accountId: string,
  segment: number,
  transaction: string,
  signal: AbortSignal,
  deadlineMs: number,
  continuity: () => { ownerContinuous: boolean; generationContinuous: boolean },
  observation: EventTableObservation,
  onRows?: (rows: unknown[], envelopeValid: boolean) => void,
  beforeRecordId?: number,
  queryCount = 20,
  table: EventTableName = TABLE,
): Promise<EventTableReceipt> {
  const started = performance.now();
  const receipt: EventTableReceipt = {
    outcome: "busy/not_admitted",
    elapsedMs: 0,
    compressedBytes: null,
    decompressedBytes: 0,
    rowCount: null,
    fieldTypes: {},
    resultCode: null,
    ...continuity(),
  };
  return new Promise((resolve) => {
    let settled = false,
      sent = false,
      accepted = false,
      acknowledged = false;
    let answer: Record<string, unknown> | undefined;
    let release: (() => void) | undefined;
    const finish = (outcome: EventTableReceipt["outcome"]) => {
      if (settled) return;
      settled = true;
      release?.();
      session.off("commandData", onData);
      session.off("close", onClose);
      session.off("error", onClose);
      signal.removeEventListener("abort", onAbort);
      Object.assign(receipt, continuity(), {
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        outcome,
      });
      resolve(receipt);
    };
    const valid = () => {
      if (signal.aborted) {
        onAbort();
        return false;
      }
      if (performance.now() >= deadlineMs) {
        finish(acknowledged ? "ack_only/timeout" : "timeout");
        return false;
      }
      const current = continuity();
      if (!session.isConnected || !current.ownerContinuous || !current.generationContinuous) {
        finish("owner_changed");
        return false;
      }
      return !settled;
    };
    const complete = () => {
      if (!accepted || !acknowledged || !answer || !valid()) return;
      const rows = answer.data as unknown[];
      receipt.rowCount = rows.length;
      receipt.fieldTypes = fieldTypes(answer, rows);
      onRows?.(
        rows,
        typeof answer.version === "string" &&
          Number.isSafeInteger(answer.count) &&
          answer.count === rows.length &&
          Number.isSafeInteger(answer.start_id) &&
          Number.isSafeInteger(answer.end_id),
      );
      finish(rows.length ? "success" : "empty");
    };
    const onData = (bytes: Buffer, link: number) => {
      if (!sent || !valid() || link !== PortalLinkType.COMMAND || bytes.length > 1024) return;
      const frame = parsePortalPacket(bytes, link);
      if (frame?.commandId !== 1350 || frame.channel !== 255 || frame.segment !== segment || frame.isResponse !== 1)
        return;
      if (frame.errCode !== 0) {
        receipt.resultCode = frame.errCode ?? null;
        finish("result_nonzero");
        return;
      }
      acknowledged = true;
      complete();
    };
    const onClose = () => finish("owner_changed");
    const onAbort = () =>
      finish(
        signal.reason === "deadline" || performance.now() >= deadlineMs
          ? acknowledged
            ? "ack_only/timeout"
            : "timeout"
          : "abandoned",
      );
    if (
      !Number.isInteger(queryCount) ||
      queryCount < 1 ||
      queryCount > CATALOG_QUERY_COUNT_MAX ||
      !valid() ||
      !accountId.trim() ||
      Buffer.byteLength(accountId) > 128
    ) {
      finish("busy/not_admitted");
      return;
    }
    release = observation.subscribe((decodedBytes, frame) => {
      if (
        !sent ||
        !valid() ||
        frame.linkType !== PortalLinkType.NOTIFY ||
        frame.commandId !== 1306 ||
        frame.channel !== 255 ||
        frame.isResponse !== 0
      )
        return;
      if (decodedBytes > EVENT_TABLE_BYTE_CAP) {
        receipt.decompressedBytes += decodedBytes;
        finish("receive_rejected");
        return;
      }
      const body = frame.data;
      if (!body || typeof body !== "object" || Array.isArray(body)) return;
      const value = body as Record<string, unknown>;
      if (value.cmd !== 10000 || value.transaction !== transaction || value.table !== table) return;
      receipt.decompressedBytes += decodedBytes;
      if (receipt.decompressedBytes > EVENT_TABLE_BYTE_CAP) {
        finish("receive_rejected");
        return;
      }
      if (!Number.isSafeInteger(value.mIntRet)) {
        finish("invalid_reply");
        return;
      }
      receipt.resultCode = value.mIntRet as number;
      if (value.mIntRet !== 0) {
        finish("result_nonzero");
        return;
      }
      if (
        !Array.isArray(value.data) ||
        value.data.some((row) => !row || typeof row !== "object" || Array.isArray(row))
      ) {
        finish("invalid_reply");
        return;
      }
      answer = value;
      complete();
    });
    session.on("commandData", onData);
    session.on("close", onClose);
    session.on("error", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (!valid()) return;
    const packet = buildEventTableRequest(accountId, segment, transaction, queryCount, beforeRecordId, table);
    try {
      if (!valid()) return;
      sent = true;
      observation.issued();
      accepted = session.sendCommand(packet);
      if (!accepted) finish("send_refused");
      else complete();
    } catch {
      finish("send_refused");
    }
  });
}
