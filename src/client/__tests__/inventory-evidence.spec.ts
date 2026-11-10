import { describe, expect, it, vi, afterEach } from "vitest";
import { DeviceRegistry } from "../device-registry.js";
import { InventoryErrorRecorder, inventoryError } from "../inventory-evidence.js";
import { MegaApiError, SessionExpiredError } from "../../transport/http/mega-client.js";
const raw = (sn: string) => ({ device_sn: sn, device_model: "T9000", category: "eufy_security", params: [] });
afterEach(() => vi.restoreAllMocks());
describe("inventory roster evidence", () => {
  it("atomically pairs generation and rows, retaining original time through partial/retained failures", async () => {
    let phase = 0;
    vi.spyOn(Date, "now").mockImplementation(() => 1000 + phase * 1000);
    const mega = {
      post: vi.fn(async (_s: string, path: string, body: any) => {
        if (path.endsWith("get_house_list")) {
          if (phase === 2) throw new Error("private");
          return { house_infos: [{ house_id: "private-house" }] };
        }
        if (phase === 2 || (phase === 1 && body.house_id)) throw new MegaApiError("secret body URL", 991, 503);
        return { devices: body.house_id ? [raw("synthetic-b")] : [raw("synthetic-a")] };
      }),
    };
    const errors: any[] = [];
    const registry = new DeviceRegistry({ mega: mega as any, onError: (_e, p) => errors.push(p) });
    const initial = await registry.getDevices();
    expect(registry.evidenceFor(initial)).toMatchObject({
      generation: 1,
      quality: "complete",
      attempted: 3,
      failed: 0,
    });
    phase = 1;
    await registry.getDevices();
    let snapshot = registry.inventorySnapshot();
    expect(snapshot.inventoryEvidence).toMatchObject({
      quality: "partial",
      failed: 1,
      rows: {
        "synthetic-a": { quality: "fresh", lastSuccessfulObservationMs: 2000 },
        "synthetic-b": { quality: "retained", lastSuccessfulObservationMs: 1000 },
      },
    });
    expect(registry.evidenceFor(initial)?.generation).toBe(1);
    phase = 2;
    await registry.getDevices();
    snapshot = registry.inventorySnapshot();
    expect(snapshot.devices).toHaveLength(2);
    expect(snapshot.inventoryEvidence).toMatchObject({
      quality: "retained",
      lastCompleteSuccessMs: 1000,
      rows: { "synthetic-a": { quality: "retained", lastSuccessfulObservationMs: 2000 } },
    });
    expect(JSON.stringify(registry.getInventoryErrors())).not.toMatch(/private|secret|synthetic-/);
  });
  it("preserves explicit authentication errors and known roster", async () => {
    const registry = new DeviceRegistry({
      mega: {
        post: async () => {
          throw new SessionExpiredError("synthetic expired");
        },
      } as any,
      onError: vi.fn(),
    });
    await expect(registry.getDevices()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(registry.list()).toEqual([]);
  });
  it("malformed inventory envelope is decode failure and does not remove known rows", async () => {
    let bad = false;
    const registry = new DeviceRegistry({
      mega: {
        post: async (_s: string, path: string) =>
          path.endsWith("get_house_list") ? { house_infos: [] } : { devices: bad ? {} : [raw("synthetic-a")] },
      } as any,
      onError: vi.fn(),
    });
    await registry.getDevices();
    bad = true;
    await registry.getDevices();
    expect(registry.list()).toHaveLength(1);
    expect(registry.getInventoryErrors().recent[0]?.kind).toBe("decode");
  });
  it("successful absence follows existing removal policy", async () => {
    let rows = [raw("synthetic-a")];
    const registry = new DeviceRegistry({
      mega: {
        post: async (_s: string, path: string) => (path.endsWith("get_house_list") ? {} : { devices: rows }),
      } as any,
      onError: vi.fn(),
    });
    await registry.getDevices();
    rows = [];
    await registry.getDevices();
    expect(registry.list()).toEqual([]);
  });
});
describe("sanitized cloud inventory failures", () => {
  it.each([
    [new MegaApiError("private", -123, 503), "http", -123, 503],
    [new MegaApiError("private", 42, 200), "vendor", 42, 200],
    [Object.assign(new Error("private"), { cause: { code: "ENOTFOUND" } }), "dns", null, null],
    [Object.assign(new Error("private"), { code: "ECONNRESET" }), "connect", null, null],
    [Object.assign(new Error("private"), { code: "CERT_HAS_EXPIRED" }), "tls", null, null],
    [Object.assign(new Error("private"), { code: "ETIMEDOUT" }), "timeout", null, null],
    [new SyntaxError("private"), "decode", null, null],
    [new MegaApiError("private", 2 ** 40, 999), "unknown", null, null],
  ])("projects finite code/status without exception payload %#", (error, kind, vendorCode, httpStatus) => {
    expect(inventoryError(error, "device_list")).toMatchObject({ kind, vendorCode, httpStatus });
  });
  it("bounds samples, saturates totals, detaches output and rejects arbitrary keys", () => {
    const recorder = new InventoryErrorRecorder();
    for (let i = 0; i < 40; i++)
      recorder.record(Object.assign(new Error("PRIVATE"), { code: "PRIVATE", body: "PRIVATE" }), "house_list");
    const result = recorder.diagnostics();
    expect(result).toMatchObject({ total: 40, evicted: 8 });
    expect(result.recent).toHaveLength(32);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    result.recent[0]!.kind = "dns";
    expect(recorder.diagnostics().recent[0]!.kind).toBe("unknown");
    (recorder as any).total = Number.MAX_SAFE_INTEGER;
    recorder.record(null, "device_list");
    expect(recorder.diagnostics().total).toBe(Number.MAX_SAFE_INTEGER);
  });
});
