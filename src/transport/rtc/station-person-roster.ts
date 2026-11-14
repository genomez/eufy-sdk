import type { EventTableReceipt } from "./event-table-candidate.js";
import { personTableInteger, personTableUpdateTime } from "./person-table-values.js";

/** Bounds apply to one existing idle session; cancellation never acquires a replacement. */
export interface StationPersonRosterOptions {
  count?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** In-memory roster scalars only; unsupported or malformed values become null. */
export interface PersonRosterRow {
  person_id: number | null;
  name: string | null;
  ignore_flag: number | null;
  update_time: number | string | null;
}

export interface StationPersonRosterResult {
  outcome: EventTableReceipt["outcome"];
  rows?: PersonRosterRow[];
}

/** Explicit projection excludes all fields except identity, bounded name, ignore flag and update time. */
export function projectPersonRosterRow(raw: unknown): PersonRosterRow {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const name = typeof row.name === "string" ? row.name.trim() : "";
  return {
    person_id: personTableInteger(row.person_id),
    name: name.length >= 1 && name.length <= 64 ? name : null,
    ignore_flag: personTableInteger(row.ignore_flag),
    update_time: personTableUpdateTime(row.update_time),
  };
}
