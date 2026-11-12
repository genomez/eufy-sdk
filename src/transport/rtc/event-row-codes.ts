import { appendFileSync } from "node:fs";
import { chicagoInstant } from "./event-time.js";

const LINE_CAP = 5000;
const ID_CAP = 2000;
const SAFE_KEY = /^[a-z][a-z0-9_]{0,47}$/;
const PRIVATE_KEY =
  /(?:serial|name|path|url|uri|thumb|text|token|account|password|secret|comment|description|message|email|phone)|(?:^|_)(?:sn|(?:station|device|camera|user)_?(?:id|sn))(?:_|$)/;

/** Numeric decimal strings and numbers only; booleans, blanks, fractions and unsafe integers are absent. */
function integer(value: unknown): number | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length > 64 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return undefined;
    value = Number(text);
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Schema-like numeric fields, excluding identity and content columns even when their values are numeric. */
function integerFields(row: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(row).flatMap(([key, raw]) => {
      const value = integer(raw);
      return SAFE_KEY.test(key) && !/\d{4,}/.test(key) && !PRIVATE_KEY.test(key) && value !== undefined
        ? [[key, value]]
        : [];
    }),
  );
}

/** Process-local ordinals, last-2000-id change detection (a record is rewritten only when its integers change)
 * and a hard 5000-successful-line lifetime limit. */
export class EventRowCodeDiagnostic {
  private readonly ids = new Map<number, string>();
  private readonly cameras = new Map<string, number>();
  private written = 0;

  constructor(
    private readonly writeLine: (line: string) => void = (line) =>
      appendFileSync(process.env.EUFY_EVENT_ROW_CODES_FILE ?? "/tmp/eufy-event-row-codes.log", line, { mode: 0o600 }),
  ) {}

  /** Writes JSON lines containing only record_id, epoch start_time, camera_index, codes and str_extra integers. */
  writeRows(rows: readonly unknown[], timeZone?: string, station?: string): void {
    for (const raw of rows) {
      if (this.written >= LINE_CAP) return;
      try {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const row = raw as Record<string, unknown>;
        const record = integer(row.record_id);
        if (record === undefined || record < 1) continue;
        const start = integer(row.start_time) ?? chicagoInstant(row.start_time, timeZone);
        if (start === undefined || start < 1) continue;
        const serial = typeof row.device_sn === "string" && row.device_sn.length ? row.device_sn : null;
        const channel = integer(row.channel) ?? integer(row.device_channel) ?? null;
        if (serial === null && channel === null) continue;
        const camera = JSON.stringify([station ?? null, serial, channel]);
        const index = this.cameras.get(camera) ?? this.cameras.size;
        let extra: unknown;
        if (typeof row.str_extra === "string") {
          try {
            extra = JSON.parse(row.str_extra);
          } catch {}
        }
        const codes = integerFields(row);
        delete codes.record_id;
        delete codes.start_time;
        const line = {
          record_id: record,
          start_time: start,
          camera_index: index,
          codes,
          str_extra:
            extra && typeof extra === "object" && !Array.isArray(extra)
              ? integerFields(extra as Record<string, unknown>)
              : {},
        };
        const signature = JSON.stringify([index, line.codes, line.str_extra]);
        if (this.ids.get(record) === signature) continue;
        this.writeLine(`${JSON.stringify(line)}\n`);
        this.cameras.set(camera, index);
        this.ids.delete(record);
        this.ids.set(record, signature);
        if (this.ids.size > ID_CAP) this.ids.delete(this.ids.keys().next().value!);
        this.written++;
      } catch {}
    }
  }
}

/** Shared across routers so replacement sessions do not reset the process lifetime diagnostic budget. */
export const eventRowCodes = new EventRowCodeDiagnostic();
