import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MegaHttpClient } from "../mega-client.js";

let monotonic = 0;

function fixture() {
  const api = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic-password" });
  const post = (path: string, body: string | object = {}, headers = {}) =>
    (api as any).httpPost(`https://synthetic.invalid${path}`, body, headers) as Promise<{
      status: number;
      data: unknown;
    }>;
  return { api, post };
}

function response(status: number, elapsedMs: number, body = "{}") {
  return {
    status,
    text: async () => {
      monotonic += elapsedMs;
      return body;
    },
  };
}

beforeEach(() => {
  monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared cloud HTTP evidence", () => {
  it.each([
    ["/passport/estimate_domain", "domain_estimate"],
    ["/openapi/oauth/key/exchange", "key_exchange"],
    ["/v3/openapi/oauth/key/exchange", "key_exchange"],
    ["/passport/login", "login"],
    ["/passport/generate/captcha", "captcha"],
    ["/app/sendmsg/verify_code", "verify_code"],
    ["/app/house/get_house_list", "house_list"],
    ["/app/house/get_devs_list", "device_list"],
    ["/app/devicemanage/get_device_param_list", "device_params"],
    ["/app/devicerelation/get_dsk_keys", "device_keys"],
    ["/app/things/get_product_data_point", "product_data_points"],
    ["/app/devicemanage/get_user_mqtt_info", "mqtt_info"],
    ["/app/push/register_push_token", "push_register"],
    ["/app/clean/get_device_clean_record_list", "clean_records"],
    ["/app/clean/get_device_map_list", "clean_maps"],
    ["/app/clean/get_many_device_map_content", "clean_map_content"],
    ["/v3/aiassis/get_faces", "faces"],
    ["/v3/aiassis/get_faces_by_ids", "faces"],
    ["/v3/app/cipher/get_ciphers", "ciphers"],
    ["/app/light/discover/list", "light_catalog"],
    ["/app/light/lighteffect/batchget", "light_catalog"],
    ["/app/light/aigc/recommend/list", "light_catalog"],
    ["/app/house/get_house_list/synthetic-id", "other"],
    ["/app/house/unrecognized", "other"],
    ["/constructor", "other"],
  ])("maps only exact endpoint paths: %s", async (path, category) => {
    const { api, post } = fixture();
    vi.mocked(fetch).mockResolvedValue(response(200, 3_001) as Response);
    await post(`${path}?token=synthetic-query`, "synthetic-body", { authorization: "synthetic-header" });
    expect(api.getCloudHttpDiagnostics().recentSlow).toEqual([
      {
        category,
        startedAtMs: 1_800_000_000_000,
        elapsedMs: 3_001,
        statusClass: "2xx",
        timeout: false,
        failed: false,
        failure: "none",
      },
    ]);
    expect(JSON.stringify(api.getCloudHttpDiagnostics())).not.toMatch(/synthetic|https|authorization|token/);
  });

  it("includes fetch and body reading, uses monotonic integer milliseconds and preserves the timeout", async () => {
    const { api, post } = fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(fetch).mockImplementation(async () => {
      monotonic += 2_000.4;
      vi.mocked(Date.now).mockReturnValue(1_799_000_000_000);
      return response(200, 1_001.5, '{"code":0,"data":{}}') as Response;
    });
    expect(await post("/passport/login")).toEqual({ status: 200, data: { code: 0, data: {} } });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(20_000);
    expect(api.getCloudHttpDiagnostics().recentSlow[0]).toMatchObject({
      startedAtMs: 1_800_000_000_000,
      elapsedMs: 3_002,
    });
  });

  it("retains fractional milliseconds beyond the slow threshold", async () => {
    const { api, post } = fixture();
    vi.mocked(fetch).mockResolvedValue(response(200, 3_000.01) as Response);
    await post("/app/house/get_devs_list");
    expect(api.getCloudHttpDiagnostics().slow).toBe(1);
    expect(api.getCloudHttpDiagnostics().recentSlow[0]!.elapsedMs).toBe(3_001);
  });

  it.each([200, 204, 302, 400, 401, 408, 429, 500, 503])(
    "retains genuine non-2xx failure evidence without changing returned status %i",
    async (status) => {
      const { api, post } = fixture();
      vi.mocked(fetch).mockResolvedValue(response(status, 3_000) as Response);
      expect((await post("/app/house/get_devs_list")).status).toBe(status);
      const failed = status < 200 || status >= 300;
      const diagnostics = api.getCloudHttpDiagnostics();
      expect(diagnostics).toMatchObject({ requests: 1, slow: 0, failures: Number(failed), timeouts: 0 });
      if (failed)
        expect(diagnostics.recentFailures[0]).toMatchObject({
          statusClass: status >= 500 ? "5xx" : status >= 400 ? "4xx" : "none",
          failure: "http_status",
          timeout: false,
        });
    },
  );

  it.each(["request", "body_read"])("preserves the original %s error without retaining its message", async (phase) => {
    const { api, post } = fixture();
    const error = new Error("synthetic-secret-error");
    vi.mocked(fetch).mockImplementation(async () => {
      monotonic += 11;
      if (phase === "request") throw error;
      return {
        status: 200,
        text: async () => {
          monotonic += 19;
          throw error;
        },
      } as unknown as Response;
    });
    await expect(post("/unknown/synthetic-id")).rejects.toBe(error);
    expect(api.getCloudHttpDiagnostics().recentFailures).toEqual([
      {
        category: "other",
        startedAtMs: 1_800_000_000_000,
        elapsedMs: phase === "request" ? 11 : 30,
        statusClass: phase === "request" ? "none" : "2xx",
        failure: phase,
        failed: true,
        timeout: false,
      },
    ]);
  });

  it.each(["request", "body_read"])(
    "recognizes a timeout during %s, including an aborted body stream",
    async (phase) => {
      const { api, post } = fixture();
      const controller = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      const reason = new DOMException("synthetic-secret-timeout", "TimeoutError");
      const bodyError = new DOMException("synthetic-secret-abort", "AbortError");
      vi.mocked(fetch).mockImplementation(async () => {
        if (phase === "request") {
          monotonic += 20_000;
          controller.abort(reason);
          throw reason;
        }
        return {
          status: 200,
          text: async () => {
            monotonic += 20_000;
            controller.abort(reason);
            throw bodyError;
          },
        } as unknown as Response;
      });
      await expect(post("/app/house/get_house_list")).rejects.toBe(phase === "request" ? reason : bodyError);
      expect(api.getCloudHttpDiagnostics()).toMatchObject({ requests: 1, slow: 1, timeouts: 1, failures: 1 });
      expect(api.getCloudHttpDiagnostics().recentFailures[0]).toMatchObject({ failure: phase, timeout: true });
    },
  );

  it("bounds independent slow and failure rings and returns detached snapshots", async () => {
    const { api, post } = fixture();
    vi.mocked(fetch).mockResolvedValue(response(500, 1) as Response);
    for (let i = 0; i < 24; i++) await post("/passport/login");
    vi.mocked(fetch).mockResolvedValue(response(200, 3_001) as Response);
    for (let i = 0; i < 30; i++) await post("/app/house/get_devs_list");
    vi.mocked(fetch).mockResolvedValue(response(200, 1) as Response);
    for (let i = 0; i < 30; i++) await post("/passport/login");
    const snapshot = api.getCloudHttpDiagnostics();
    expect(snapshot).toMatchObject({ requests: 84, failures: 24, slow: 30, slowEvicted: 10, failuresEvicted: 4 });
    expect(snapshot.recentSlow).toHaveLength(20);
    expect(snapshot.recentFailures).toHaveLength(20);
    expect(snapshot.recentFailures.every((row) => row.category === "login")).toBe(true);
    snapshot.recentFailures[0]!.elapsedMs = 999;
    snapshot.recentSlow.length = 0;
    expect(api.getCloudHttpDiagnostics().recentFailures[0]!.elapsedMs).toBe(1);
    expect(api.getCloudHttpDiagnostics().recentSlow).toHaveLength(20);
  });

  it("wires discovery, key exchange and signed calls through the recorder while leaving envelope failures above it", async () => {
    const { api } = fixture();
    vi.mocked(fetch).mockResolvedValue(response(200, 3_001, '{"code":0,"data":{}}') as Response);
    await api.estimateDomain();
    const failure = new Error("synthetic-key-failure");
    vi.mocked(fetch).mockRejectedValueOnce(failure);
    await expect(api.ensureSessionKey()).rejects.toBe(failure);
    vi.spyOn(api, "ensureSessionKey").mockResolvedValue({
      shareKey: "00".repeat(32),
      keyIdent: "00".repeat(16),
      clientPublicKeyHex: "00".repeat(65),
      clientPrivateKeyHex: "00".repeat(32),
      createdAt: Date.now(),
    });
    vi.mocked(fetch).mockResolvedValue(
      response(200, 3_001, '{"code":20004,"msg":"synthetic-envelope-error"}') as Response,
    );
    await expect(api.getDeviceParamList("T8000P0000000000")).rejects.toMatchObject({ code: 20004 });
    expect(api.getCloudHttpDiagnostics()).toMatchObject({ requests: 3, failures: 1, slow: 2 });
    expect(api.getCloudHttpDiagnostics().recentSlow.map((row) => row.category)).toEqual([
      "domain_estimate",
      "device_params",
    ]);
    expect(api.getCloudHttpDiagnostics().recentFailures[0]!.category).toBe("key_exchange");
  });
});
