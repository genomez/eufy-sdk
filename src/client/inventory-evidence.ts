import { MegaApiError } from "../transport/http/mega-client.js";
export type InventoryOperation = "house_list" | "device_list";
export type InventoryKind = "http" | "vendor" | "timeout" | "dns" | "connect" | "tls" | "decode" | "unknown";
export interface InventoryError {
  origin: "device_registry";
  operation: InventoryOperation;
  kind: InventoryKind;
  vendorCode: number | null;
  httpStatus: number | null;
  atMs: number;
}
export interface InventoryRowEvidence {
  quality: "fresh" | "retained";
  lastSuccessfulObservationMs: number | null;
}
export interface InventoryEvidence {
  version: 1;
  generation: number;
  completedAtMs: number;
  quality: "complete" | "partial" | "retained";
  attempted: number;
  failed: number;
  lastCompleteSuccessMs: number | null;
  rows: Record<string, InventoryRowEvidence>;
}
const increment = (n: number) => Math.min(Number.MAX_SAFE_INTEGER, n + 1);
const data = (raw: unknown, key: string): unknown =>
  raw && typeof raw === "object" ? Object.getOwnPropertyDescriptor(raw, key)?.value : undefined;
const codes: Readonly<Record<string, InventoryKind>> = {
  ETIMEDOUT: "timeout",
  UND_ERR_CONNECT_TIMEOUT: "timeout",
  UND_ERR_HEADERS_TIMEOUT: "timeout",
  UND_ERR_BODY_TIMEOUT: "timeout",
  ENOTFOUND: "dns",
  EAI_AGAIN: "dns",
  ECONNREFUSED: "connect",
  ECONNRESET: "connect",
  ENETUNREACH: "connect",
  EHOSTUNREACH: "connect",
  CERT_HAS_EXPIRED: "tls",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
};
/** Exact typed codes only; exception text and arbitrary fields never enter the projection. */
export function inventoryError(error: unknown, operation: InventoryOperation): InventoryError {
  const code = error instanceof MegaApiError ? data(error, "code") : undefined;
  const status = error instanceof MegaApiError ? data(error, "status") : undefined;
  const vendorCode =
    typeof code === "number" && Number.isInteger(code) && code >= -2147483648 && code <= 2147483647 ? code : null;
  const httpStatus =
    typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const transportCode = data(error, "code") ?? data(data(error, "cause"), "code");
  const name = data(error, "name");
  const kind: InventoryKind =
    httpStatus !== null && httpStatus >= 400
      ? "http"
      : vendorCode !== null
        ? "vendor"
        : typeof transportCode === "string" && Object.hasOwn(codes, transportCode)
          ? codes[transportCode]!
          : error instanceof SyntaxError
            ? "decode"
            : name === "TimeoutError"
              ? "timeout"
              : "unknown";
  return { origin: "device_registry", operation, kind, vendorCode, httpStatus, atMs: Date.now() };
}
/** Bounded anonymous inventory-failure history, independent of roster identities. */
export class InventoryErrorRecorder {
  private total = 0;
  private evicted = 0;
  private firstFailureMs: number | null = null;
  private lastFailureMs: number | null = null;
  private lastCompleteSuccessMs: number | null = null;
  private recent: InventoryError[] = [];
  private byKind: Partial<Record<InventoryKind, number>> = {};
  private byOperation: Partial<Record<InventoryOperation, number>> = {};
  private byStatusClass: Record<string, number> = {};
  record(error: unknown, operation: InventoryOperation): InventoryError {
    const sample = inventoryError(error, operation);
    this.total = increment(this.total);
    this.firstFailureMs ??= sample.atMs;
    this.lastFailureMs = sample.atMs;
    this.byKind[sample.kind] = increment(this.byKind[sample.kind] ?? 0);
    this.byOperation[operation] = increment(this.byOperation[operation] ?? 0);
    const status = sample.httpStatus === null ? "unknown" : `${Math.floor(sample.httpStatus / 100)}xx`;
    this.byStatusClass[status] = increment(this.byStatusClass[status] ?? 0);
    this.recent.push(sample);
    if (this.recent.length > 32) {
      this.recent.shift();
      this.evicted = increment(this.evicted);
    }
    return { ...sample };
  }
  complete(at: number): void {
    this.lastCompleteSuccessMs = at;
  }
  diagnostics() {
    return structuredClone({
      version: 1,
      total: this.total,
      evicted: this.evicted,
      firstFailureMs: this.firstFailureMs,
      lastFailureMs: this.lastFailureMs,
      lastCompleteSuccessMs: this.lastCompleteSuccessMs,
      byKind: this.byKind,
      byOperation: this.byOperation,
      byStatusClass: this.byStatusClass,
      recent: this.recent,
    });
  }
}
