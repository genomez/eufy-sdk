import type { RtcSession } from "./session.js";
import { buildPortalPacket, parsePortalPacket, PortalLinkType, type PortalResponse } from "./portal-packet.js";

export const EVENT_TABLE_BYTE_CAP = 256 * 1024;
/** An array of n empty JSON objects requires at least 3n + 1 bytes within the decoded table budget. */
export const CATALOG_QUERY_COUNT_MAX = Math.floor((EVENT_TABLE_BYTE_CAP - 1) / 3);
const TABLE = "history_record_info";
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

/** Passive decoded-frame observation; subscription does not own or change notify reassembly. */
export interface EventTableObservation {
  subscribe: (observe: (decodedBytes: number, frame: PortalResponse) => void) => () => void;
  issued: () => void;
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
      if (value.cmd !== 10000 || value.transaction !== transaction || value.table !== TABLE) return;
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
    const packet = buildPortalPacket({
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
          table: TABLE,
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
