import { performance } from "node:perf_hooks";
import { startHttpObservation } from "../../core/http-observation-context.js";

/** Exact SDK endpoint paths only; arbitrary suffixes, identifiers and query contents are never labels. */
const SAFE_PATHS = {
  "/passport/estimate_domain": "domain_estimate",
  "/openapi/oauth/key/exchange": "key_exchange",
  "/v3/openapi/oauth/key/exchange": "key_exchange",
  "/passport/login": "login",
  "/passport/generate/captcha": "captcha",
  "/app/sendmsg/verify_code": "verify_code",
  "/app/house/get_house_list": "house_list",
  "/app/house/get_devs_list": "device_list",
  "/app/devicemanage/get_device_param_list": "device_params",
  "/app/devicerelation/get_dsk_keys": "device_keys",
  "/app/things/get_product_data_point": "product_data_points",
  "/app/devicemanage/get_user_mqtt_info": "mqtt_info",
  "/app/push/register_push_token": "push_register",
  "/app/clean/get_device_clean_record_list": "clean_records",
  "/app/clean/get_device_map_list": "clean_maps",
  "/app/clean/get_many_device_map_content": "clean_map_content",
  "/v3/aiassis/get_faces": "faces",
  "/v3/aiassis/get_faces_by_ids": "faces",
  "/v3/app/cipher/get_ciphers": "ciphers",
  "/app/light/discover/list": "light_catalog",
  "/app/light/lighteffect/batchget": "light_catalog",
  "/app/light/aigc/recommend/list": "light_catalog",
} as const;

export type CloudHttpCategory = (typeof SAFE_PATHS)[keyof typeof SAFE_PATHS] | "other";
export type CloudHttpStatusClass = "2xx" | "4xx" | "5xx" | "none";

/**
 * One physical POST through MegaHttpClient, including body reading, without request or response data.
 * startedAtMs is UTC epoch milliseconds; elapsedMs is truncated monotonic milliseconds.
 */
export interface CloudHttpEvidence {
  category: CloudHttpCategory;
  startedAtMs: number;
  elapsedMs: number;
  statusClass: CloudHttpStatusClass;
  timeout: boolean;
  failed: boolean;
  failure: "none" | "request" | "body_read" | "http_status";
}

/**
 * Client-instance POST counters and independently bounded slow/failure retention. Envelope codes,
 * decryption and application parsing occur above this boundary: a readable 2xx envelope rejection is
 * not an HTTP failure. Redirect/other status classes map to none; non-2xx responses still count as failed.
 * Media downloads, Solix, Tuya and RTC traffic do not pass through this recorder.
 */
export interface CloudHttpDiagnostics {
  requests: number;
  slow: number;
  timeouts: number;
  failures: number;
  slowThresholdMs: number;
  capacity: number;
  slowEvicted: number;
  failuresEvicted: number;
  recentSlow: CloudHttpEvidence[];
  recentFailures: CloudHttpEvidence[];
}

/** Classify only an exact parsed path; URL text and exception messages are never retained. */
function categoryFor(url: string): CloudHttpCategory {
  try {
    const path = new URL(url).pathname;
    return Object.hasOwn(SAFE_PATHS, path) ? SAFE_PATHS[path as keyof typeof SAFE_PATHS] : "other";
  } catch {
    return "other";
  }
}

/** Bounded numeric observations on the shared cloud POST path; no status changes or retries. */
export class CloudHttpRecorder {
  private requests = 0;
  private slow = 0;
  private timeouts = 0;
  private failures = 0;
  private readonly recentSlow: CloudHttpEvidence[] = [];
  private readonly recentFailures: CloudHttpEvidence[] = [];

  begin(url: string): (status: number | undefined, failure: CloudHttpEvidence["failure"], timeout: boolean) => void {
    const category = categoryFor(url);
    const startedAtMs = Date.now();
    const start = performance.now();
    const observe = startHttpObservation();
    this.requests++;
    return (status, failure, timeout) => {
      const failed = failure !== "none";
      const elapsedMs = Math.max(0, Math.ceil(performance.now() - start));
      observe?.(elapsedMs);
      const statusClass: CloudHttpStatusClass =
        status !== undefined && status >= 200 && status < 300
          ? "2xx"
          : status !== undefined && status >= 400 && status < 500
            ? "4xx"
            : status !== undefined && status >= 500 && status < 600
              ? "5xx"
              : "none";
      const row: CloudHttpEvidence = { category, startedAtMs, elapsedMs, statusClass, timeout, failed, failure };
      if (elapsedMs > 3_000) {
        this.slow++;
        this.recentSlow.push(row);
        if (this.recentSlow.length > 20) this.recentSlow.shift();
      }
      if (timeout) this.timeouts++;
      if (failed) {
        this.failures++;
        this.recentFailures.push(row);
        if (this.recentFailures.length > 20) this.recentFailures.shift();
      }
    };
  }

  diagnostics(): CloudHttpDiagnostics {
    return {
      requests: this.requests,
      slow: this.slow,
      timeouts: this.timeouts,
      failures: this.failures,
      slowThresholdMs: 3_000,
      capacity: 20,
      slowEvicted: Math.max(0, this.slow - 20),
      failuresEvicted: Math.max(0, this.failures - 20),
      recentSlow: this.recentSlow.map((row) => ({ ...row })),
      recentFailures: this.recentFailures.map((row) => ({ ...row })),
    };
  }
}
