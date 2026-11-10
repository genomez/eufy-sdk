import { describe, expect, it, vi, afterEach } from "vitest";
import { DeviceRegistry } from "../device-registry.js";
import { EufyMega } from "../eufy-mega.js";
import { InventoryErrorRecorder, inventoryError } from "../inventory-evidence.js";
import { MegaApiError, SessionExpiredError } from "../../transport/http/mega-client.js";
const raw = (sn: string) => ({ device_sn: sn, device_model: "T9000", category: "eufy_security", params: [] });
afterEach(() => vi.restoreAllMocks());
describe("inventory roster evidence", () => {
  it.each([42, true, "unexpected", [], [raw("synthetic-b")], { unexpected: [] }, { devices: null }])(
    "rejects malformed device envelopes without erasing known inventory %#",
    async (malformed) => {
      let bad = false;
      const onError = vi.fn();
      const registry = new DeviceRegistry({
        mega: {
          post: async (_s: string, path: string) =>
            path.endsWith("get_house_list") ? {} : bad ? malformed : { devices: [raw("synthetic-a")] },
        } as any,
        onError,
      });
      const initial = await registry.getDevices();
      bad = true;
      const next = await registry.getDevices();
      expect(next.map((d) => d.sn)).toEqual(["synthetic-a"]);
      expect(registry.evidenceFor(next)).toMatchObject({
        quality: "retained",
        failed: 1,
        lastCompleteSuccessMs: registry.evidenceFor(initial)?.lastCompleteSuccessMs,
      });
      expect(onError).toHaveBeenCalledWith(
        expect.any(SyntaxError),
        expect.objectContaining({ kind: "decode", operation: "device_list" }),
      );
      expect(registry.evidenceFor(initial)).toMatchObject({ generation: 1, quality: "complete" });
    },
  );
  it.each([42, true, "unexpected", [], { unexpected: [] }, { house_infos: null }])(
    "rejects malformed house envelopes and retains missing inventory %#",
    async (malformed) => {
      let bad = false;
      const registry = new DeviceRegistry({
        mega: {
          post: async (_s: string, path: string) =>
            path.endsWith("get_house_list") ? (bad ? malformed : {}) : { devices: bad ? [] : [raw("synthetic-a")] },
        } as any,
        onError: vi.fn(),
      });
      await registry.getDevices();
      bad = true;
      const next = await registry.getDevices();
      expect(next.map((d) => d.sn)).toEqual(["synthetic-a"]);
      expect(registry.evidenceFor(next)).toMatchObject({ quality: "partial", failed: 1 });
      expect(registry.getInventoryErrors().recent).toEqual([
        expect.objectContaining({ kind: "decode", operation: "house_list" }),
      ]);
    },
  );
  it("queries every valid house despite malformed siblings and records partial decode", async () => {
    const calls: unknown[] = [];
    const registry = new DeviceRegistry({
      mega: {
        post: async (_s: string, path: string, body: any) => {
          if (path.endsWith("get_house_list"))
            return {
              house_infos: [null, { house_id: "synthetic-a" }, 42, [], { house_id: "" }, { house_id: "synthetic-b" }],
            };
          calls.push(body);
          return { devices: body.house_id ? [raw(body.house_id)] : [] };
        },
      } as any,
      onError: vi.fn(),
    });
    const devices = await registry.getDevices();
    expect(calls).toEqual([{}, { house_id: "synthetic-a" }, { house_id: "synthetic-b" }]);
    expect(devices.map((d) => d.sn)).toEqual(["synthetic-a", "synthetic-b"]);
    expect(registry.evidenceFor(devices)).toMatchObject({ quality: "partial", attempted: 4, failed: 1 });
    expect(registry.getInventoryErrors().recent).toEqual([
      expect.objectContaining({ kind: "decode", operation: "house_list" }),
    ]);
  });
  it("keeps successful roster evidence immutable across overlapping authentication failure", async () => {
    const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
    const client = eufy as any;
    let calls = 0;
    let rejectOther!: (error: Error) => void;
    const gate = new Promise((_, reject) => {
      rejectOther = reject;
    });
    client.mega.post = async (_s: string, path: string) => {
      if (path.endsWith("get_house_list")) return ++calls === 1 ? gate : {};
      return { devices: [raw("synthetic-a")] };
    };
    const other = eufy.getDevices().catch((e) => e);
    client.registry.onRoster = () => rejectOther(new SessionExpiredError("synthetic"));
    const snapshot = await eufy.getDevicesWithInventory();
    expect(await other).toBeInstanceOf(SessionExpiredError);
    expect(snapshot.inventoryEvidence).toMatchObject({ generation: 1, quality: "complete", failed: 0 });
    expect(client.registry.evidenceFor(snapshot.devices)).toEqual(snapshot.inventoryEvidence);
    expect(client.registry.inventorySnapshot().inventoryEvidence).toMatchObject({
      generation: 2,
      quality: "retained",
      failed: 1,
    });
    expect(client.registry.list()).not.toBe(snapshot.devices);
    await eufy.disconnect();
  });
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
