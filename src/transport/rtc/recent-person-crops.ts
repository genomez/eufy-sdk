import type { EventTableReceipt } from "./event-table-candidate.js";

/** Bounds apply to one existing idle session; cancellation never acquires a replacement. */
export interface RecentPersonCropOptions {
  count?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** In-memory metadata only; unsupported or malformed scalar values become null. */
export interface PersonCropRow {
  record_id: number | null;
  crop_id: number | null;
  picture_id: number | null;
  person_id: number | null;
  person_recog_flag: number | null;
  detection_type: number | null;
  device_sn: string | null;
  start_utc: number | null;
  end_utc: number | null;
  update_time: number | string | null;
}

export interface RecentPersonCropResult {
  outcome: EventTableReceipt["outcome"];
  rows?: PersonCropRow[];
}

/** Decimal integer strings and safe integers are the only accepted numeric representations. */
function integer(value: unknown): number | null {
  const parsed = typeof value === "string" && /^-?\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) ? parsed : null;
}

/** Explicit projection excludes paths, features, bounding boxes and arbitrary row properties. */
export function projectPersonCrop(raw: unknown): PersonCropRow {
  const row = raw as Record<string, unknown>;
  return {
    record_id: integer(row.record_id),
    crop_id: integer(row.crop_id),
    picture_id: integer(row.picture_id),
    person_id: integer(row.person_id),
    person_recog_flag: integer(row.person_recog_flag),
    detection_type: integer(row.detection_type),
    device_sn:
      typeof row.device_sn === "string" && row.device_sn.length > 0 && row.device_sn.length <= 128
        ? row.device_sn
        : null,
    start_utc: integer(row.start_utc),
    end_utc: integer(row.end_utc),
    update_time:
      integer(row.update_time) ??
      (typeof row.update_time === "string" &&
      /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(row.update_time)
        ? row.update_time
        : null),
  };
}
