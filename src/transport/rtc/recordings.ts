import { createHmac, timingSafeEqual } from "node:crypto";
import { parseRecordingTime, type RecordingTimeStatus } from "./event-time.js";

export type { RecordingTimeStatus } from "./event-time.js";
export const CATALOG_QUERY_COUNT = 20;
export const CATALOG_MIN_ATTEMPT_MS = 120_000;
export const CATALOG_TIMEOUT_MS = 8_000;
export const COVER_TIMEOUT_MS = 8_000;
export const RENEWAL_RESERVE_MS = 5_000;
export const OWNER_OBSERVE_MS = 60_000;
export const READ_QUIET_MS = 2_000;
export const COVER_START_GAP_MS = 5_000;
export const COVER_ATTEMPTS_PER_MINUTE = 6;

/** Installed, opt-in internal topology. Names never establish membership. */
export interface RecordingPolicy {
  enabled: boolean;
  stationBinding: string;
  allowedCameras: ReadonlySet<string> | readonly string[];
}

/** Trusted internal inputs; the key must be a durably installed random 32-byte value. */
export interface RecordingReadScope {
  stationSn: string;
  cameraSns: ReadonlySet<string>;
  accountNamespace: string;
  identityKey: Uint8Array;
}

/** Bounds the entire operation, including local scheduler admission; default and maximum are 8000 ms. */
export interface RecordingReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Fixed refusal codes contain no transport exception, identifier, vendor value or path. */
export type RecordingReadReason =
  | "disabled"
  | "scope_invalid"
  | "store_unavailable"
  | "invalid_options"
  | "busy"
  | "owner_unavailable"
  | "owner_changed"
  | "owner_unhealthy"
  | "observing"
  | "quiet_period"
  | "renewal_due"
  | "rate_limited"
  | "selector_invalid"
  | "selector_reserved"
  | "reply_capacity"
  | "timeout"
  | "aborted"
  | "invalid_reply"
  | "send_refused";

/** No recording operation throws transport exception text through its result boundary. */
export type RecordingReadFailure = { status: "deferred" | "unavailable"; reason: RecordingReadReason };

/** Private, sealed observed selector. Persist only in restricted storage; never publish on a wire. */
export interface InternalCoverSelector {
  sourceKey: string;
  cameraSn: string;
  stationBinding: string;
  thumbPath: string;
  observedAtMs: number;
  selectorMac: string;
}

/** Labels are fixed numeric fallbacks until a verified recording-type mapping exists. */
export interface RecordingKind {
  code: number | null;
  label: string;
}

/** Internal catalog row, requiring explicit allowlist projection before any public serialization. */
export interface InternalRecordingRow {
  scopeId: string;
  cameraId: string;
  eventId: string;
  cameraSn: string;
  sourceKey: string;
  identityStartBasis: string;
  sourceStartLocal: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  startedAtUtc: string | null;
  startedAtLocal: string | null;
  timeStatus: RecordingTimeStatus;
  durationSeconds: number | null;
  durationBasis: "end_minus_start" | "qualified_duration_field" | "unknown";
  eventType: RecordingKind;
  detectType: RecordingKind;
  firstObservedAtMs: number;
  /** Private account-and-station-bound path fingerprint, retained even when a shared path has no selector. */
  coverPathKey: string | null;
  coverSelector: InternalCoverSelector | null;
}

/** Bounded counts only; raw rows and arbitrary JSON keys are discarded. */
export interface RecordingDiagnostics {
  rejected: number;
  identity_conflict: number;
}
export type CatalogReadResult =
  { status: "ok"; rows: InternalRecordingRow[]; diagnostics: RecordingDiagnostics } | RecordingReadFailure;
export type CoverReadResult = { status: "ok"; jpeg: Buffer } | RecordingReadFailure;

/** Explicit public projection excludes all internal identity bases and selectors. */
export type RecordingRowView = Pick<
  InternalRecordingRow,
  | "scopeId"
  | "cameraId"
  | "eventId"
  | "startedAtMs"
  | "endedAtMs"
  | "startedAtUtc"
  | "startedAtLocal"
  | "timeStatus"
  | "durationSeconds"
  | "durationBasis"
  | "eventType"
  | "detectType"
>;

/** Length-prefixed UTF-8 tuples and separate domains prevent concatenation and cross-purpose ambiguity. */
function mac(key: Uint8Array, domain: string, ...values: string[]): string {
  const hmac = createHmac("sha256", key);
  for (const value of [domain, ...values]) {
    const bytes = Buffer.from(value);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    hmac.update(size).update(bytes);
  }
  return hmac.digest("hex");
}

/** Opaque account namespace derived only from the current in-memory account identity. */
export function recordingAccountNamespace(key: Uint8Array, accountIdentity: string): string {
  return "a_" + mac(key, "recordings.account.v1", accountIdentity);
}

/** Private full hashes remain available to detect any truncated ID collision. */
function opaque(prefix: string, full: string): string {
  return prefix + Buffer.from(full, "hex").toString("base64url").slice(0, 22);
}

/** Strict selectors are station storage tokens, never filesystem paths or network locations. */
export function validRecordingPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 2048) return false;
  if (/[\x00-\x1f\x7f-\x9f]/u.test(value) || /[\\:%?#]/u.test(value) || value.startsWith("//")) return false;
  return !value.split("/").some((part) => part === "." || part === "..");
}

/** Full selector MAC binds observed path, source identity, camera, station and receipt time. */
function selectorMac(scope: RecordingReadScope, selector: Omit<InternalCoverSelector, "selectorMac">): string {
  return mac(
    scope.identityKey,
    "recordings.selector.v1",
    scope.accountNamespace,
    selector.sourceKey,
    selector.cameraSn,
    selector.stationBinding,
    selector.thumbPath,
    String(selector.observedAtMs),
  );
}

/** Constant-time full-MAC comparison precedes every uncached selected-image read. */
export function verifyRecordingSelector(scope: RecordingReadScope, selector: InternalCoverSelector): boolean {
  if (
    !selector ||
    scope.identityKey?.length !== 32 ||
    !scope.cameraSns.has(selector.cameraSn) ||
    selector.stationBinding !== scope.stationSn ||
    !/^[a-f0-9]{64}$/.test(selector.sourceKey) ||
    !/^[a-f0-9]{64}$/.test(selector.selectorMac) ||
    !validRecordingPath(selector.thumbPath) ||
    !Number.isSafeInteger(selector.observedAtMs) ||
    selector.observedAtMs <= 0
  )
    return false;
  return timingSafeEqual(Buffer.from(selectorMac(scope, selector), "hex"), Buffer.from(selector.selectorMac, "hex"));
}

/** Identity tokens keep their explicit type; parser support does not change event identity. */
function startIdentity(value: unknown): string | undefined {
  if (typeof value === "string") {
    const token = value.replace(/^[\x09-\x0d ]+|[\x09-\x0d ]+$/g, "");
    if (!token.length || Buffer.byteLength(token) > 64) return;
    return "string:" + token;
  }
  if (typeof value === "number" && Number.isFinite(value) && Buffer.byteLength(String(value)) <= 64)
    return "number:" + String(value);
  return;
}

function kind(value: unknown, label: string): RecordingKind {
  const code = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 65535 ? value : null;
  return { code, label: code === null ? label + " unknown" : `${label} ${code}` };
}

/** Opaque identifier ties use code-unit order, independent of process locale. */
function eventOrder(a: InternalRecordingRow, b: InternalRecordingRow): number {
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** Latest station-window normalization uses only qualified membership and immutable HMAC identity. */
export function normalizeRecordingRows(
  rows: readonly unknown[],
  scope: RecordingReadScope,
  identityKey = scope.identityKey,
  nowMs = Date.now(),
): CatalogReadResult {
  if (identityKey?.length !== 32) return { status: "unavailable", reason: "store_unavailable" };
  if (rows.length > CATALOG_QUERY_COUNT) return { status: "unavailable", reason: "invalid_reply" };
  const keyed = { ...scope, identityKey };
  const scopeFull = mac(identityKey, "recordings.scope.v1", scope.accountNamespace, scope.stationSn);
  const scopeId = opaque("s_", scopeFull);
  const diagnostics = { rejected: 0, identity_conflict: 0 };
  const result = new Map<string, InternalRecordingRow>();
  const hashes = new Map<string, string>();
  const conflicted = new Set<string>();
  const records = new Map<string, string>();
  const cameraHashes = new Map<string, string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      diagnostics.rejected++;
      continue;
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.device_sn !== "string" || !scope.cameraSns.has(row.device_sn)) {
      diagnostics.rejected++;
      continue;
    }
    const basis = startIdentity(row.start_time);
    if (typeof row.record_id !== "number" || !Number.isSafeInteger(row.record_id) || row.record_id <= 0 || !basis) {
      diagnostics.rejected++;
      continue;
    }
    const cameraFull = mac(identityKey, "recordings.camera.v1", scopeId, row.device_sn);
    const cameraId = opaque("c_", cameraFull);
    const priorCamera = cameraHashes.get(cameraId);
    cameraHashes.set(cameraId, cameraFull);
    if (priorCamera && priorCamera !== cameraFull) {
      diagnostics.identity_conflict++;
      continue;
    }
    const record = String(row.record_id);
    const sourceKey = mac(identityKey, "recordings.event.v1", scopeId, cameraId, record, basis);
    const eventId = opaque("e_", sourceKey);
    const recordKey = mac(identityKey, "recordings.record.v1", cameraId, record);
    const previousStart = records.get(recordKey);
    if (previousStart && previousStart !== basis) diagnostics.identity_conflict++;
    records.set(recordKey, basis);
    const start = parseRecordingTime(typeof row.start_time === "string" ? basis.slice(7) : row.start_time);
    const end = parseRecordingTime(row.end_time);
    const duration = start.atMs !== null && end.atMs !== null ? (end.atMs - start.atMs) / 1000 : null;
    const durationSeconds = duration !== null && duration >= 0 && duration <= 86400 ? duration : null;
    const selector = validRecordingPath(row.thumb_path)
      ? {
          sourceKey,
          cameraSn: row.device_sn,
          stationBinding: scope.stationSn,
          thumbPath: row.thumb_path,
          observedAtMs: nowMs,
        }
      : null;
    const normalized: InternalRecordingRow = {
      scopeId,
      cameraId,
      eventId,
      cameraSn: row.device_sn,
      sourceKey,
      identityStartBasis: mac(identityKey, "recordings.start.v1", basis),
      sourceStartLocal: start.sourceLocal,
      startedAtMs: start.atMs,
      endedAtMs: end.atMs,
      startedAtUtc: start.utc,
      startedAtLocal: start.local,
      timeStatus: start.timeStatus,
      durationSeconds,
      durationBasis: durationSeconds === null ? "unknown" : "end_minus_start",
      eventType: kind(row.event_type, "Event"),
      detectType: kind(row.detect_type, "Detection"),
      firstObservedAtMs: nowMs,
      coverPathKey: selector
        ? mac(identityKey, "recordings.path.v1", scope.accountNamespace, scope.stationSn, selector.thumbPath)
        : null,
      coverSelector: selector ? { ...selector, selectorMac: selectorMac(keyed, selector) } : null,
    };
    const prior = result.get(eventId);
    if (
      (hashes.has(eventId) && hashes.get(eventId) !== sourceKey) ||
      (prior && JSON.stringify(prior) !== JSON.stringify(normalized))
    ) {
      conflicted.add(eventId);
      diagnostics.identity_conflict++;
    }
    hashes.set(eventId, sourceKey);
    if (!conflicted.has(eventId)) result.set(eventId, normalized);
    else result.delete(eventId);
  }
  const paths = new Map<string, InternalRecordingRow[]>();
  for (const row of result.values())
    if (row.coverSelector) {
      const path = row.coverSelector.thumbPath;
      paths.set(path, [...(paths.get(path) ?? []), row]);
    }
  for (const entries of paths.values()) if (entries.length > 1) for (const row of entries) row.coverSelector = null;
  return {
    status: "ok",
    diagnostics,
    rows: [...result.values()].sort((a, b) =>
      a.startedAtMs !== null && b.startedAtMs !== null
        ? b.startedAtMs - a.startedAtMs || eventOrder(a, b)
        : a.startedAtMs !== null
          ? -1
          : b.startedAtMs !== null
            ? 1
            : b.firstObservedAtMs - a.firstObservedAtMs || eventOrder(a, b),
    ),
  };
}

/** Only this allowlist is safe to serialize; internal rows themselves remain private. */
export function projectRecordingRow(row: InternalRecordingRow): RecordingRowView {
  return {
    scopeId: row.scopeId,
    cameraId: row.cameraId,
    eventId: row.eventId,
    startedAtMs: row.startedAtMs,
    endedAtMs: row.endedAtMs,
    startedAtUtc: row.startedAtUtc,
    startedAtLocal: row.startedAtLocal,
    timeStatus: row.timeStatus,
    durationSeconds: row.durationSeconds,
    durationBasis: row.durationBasis,
    eventType: kind(row.eventType.code, "Event"),
    detectType: kind(row.detectType.code, "Detection"),
  };
}
