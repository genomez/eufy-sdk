import type { RtcSession } from "./session.js";
import { buildPortalPacket, parsePortalHeader, parsePortalPacket, PortalLinkType } from "./portal-packet.js";
import { decompressFrame } from "./ptcs-framer.js";

export const EVENT_TABLE_BYTE_CAP = 256 * 1024;
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
  compressedBytes: number;
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

/** One transaction-correlated table query; only the existing session's notify inspector owns its bytes. */
export function collectEventTableCandidate(
  session: RtcSession,
  accountId: string,
  segment: number,
  transaction: string,
  signal: AbortSignal,
  deadlineMs: number,
  continuity: () => { ownerContinuous: boolean; generationContinuous: boolean },
): Promise<EventTableReceipt> {
  const started = performance.now();
  const receipt: EventTableReceipt = {
    outcome: "busy/not_admitted",
    elapsedMs: 0,
    compressedBytes: 0,
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
    if (!valid() || !accountId.trim() || Buffer.byteLength(accountId) > 128) {
      finish("busy/not_admitted");
      return;
    }
    release = session.inspectNotify?.({
      maxBytes: EVENT_TABLE_BYTE_CAP,
      onReject: () => finish("receive_rejected"),
      onFrame: (encoded) => {
        if (!sent || !valid()) return;
        const compressed = encoded.length >= 4 && encoded.readUInt32LE(0) === 0xfd2fb528;
        if (compressed) receipt.compressedBytes += encoded.length;
        if (encoded.length > EVENT_TABLE_BYTE_CAP || receipt.compressedBytes > EVENT_TABLE_BYTE_CAP) {
          finish("receive_rejected");
          return;
        }
        const decoded = compressed ? decompressFrame(encoded, EVENT_TABLE_BYTE_CAP) : encoded;
        if (!decoded) {
          finish("malformed_zstd");
          return;
        }
        receipt.decompressedBytes += decoded.length;
        if (receipt.decompressedBytes > EVENT_TABLE_BYTE_CAP) {
          finish("receive_rejected");
          return;
        }
        const header = parsePortalHeader(decoded);
        if (!header || header.paramLength !== decoded.length - 16) {
          finish("invalid_reply");
          return;
        }
        const frame = parsePortalPacket(decoded, PortalLinkType.NOTIFY);
        const body = frame?.data;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          if (header.commandId === 1306) {
            finish("invalid_reply");
            return;
          }
          return decoded;
        }
        const value = body as Record<string, unknown>;
        if (value.cmd !== 10000 && value.cmd !== 1306) return decoded;
        if (value.transaction !== transaction || value.table !== TABLE) return;
        if (value.cmd !== 10000 || header.channel !== 255 || !Number.isSafeInteger(value.mIntRet)) {
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
        return;
      },
    });
    if (!release) {
      finish("busy/not_admitted");
      return;
    }
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
            count: 20,
            start_date: "",
            end_date: "",
            start_id: 0,
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
      accepted = session.sendCommand(packet);
      if (!accepted) finish("send_refused");
      else complete();
    } catch {
      finish("send_refused");
    }
  });
}
