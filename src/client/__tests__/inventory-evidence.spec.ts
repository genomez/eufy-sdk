import { describe, expect, it, vi, afterEach } from "vitest";
import { DeviceRegistry } from "../device-registry.js";
import { EufyMega } from "../eufy-mega.js";
import { InventoryErrorRecorder, inventoryError } from "../inventory-evidence.js";
import { MegaApiError, MegaHttpClient, SessionExpiredError } from "../../transport/http/mega-client.js";
import { encryptBody } from "../../core/crypto.js";
const raw = (sn: string) => ({ device_sn: sn, device_model: "T9000", category: "eufy_security", params: [] });
afterEach(() => vi.restoreAllMocks());
describe("inventory roster evidence", () => {
  const operations = ["device_list", "house_list"] as const;
  const rejected = [
    ["envelope_primitive", 42],
    ["envelope_primitive", true],
    ["envelope_primitive", "PRIVATE"],
    ["envelope_array", [raw("PRIVATE")]],
    ["field_not_array", {}],
    ["field_not_array", 42],
    ["field_not_array", "PRIVATE"],
    ["field_not_array", true],
    ["field_not_array", false],
    ["field_not_array", undefined],
  ] as const;
  for (const operation of operations) {
    const field = operation === "house_list" ? "house_infos" : "devices";
    const identity = operation === "house_list" ? "house_id" : "device_sn";
    it.each(rejected)(`${operation} rejects %s without erasing known inventory %#`, async (shape, value) => {
      let bad = false;
      const onError = vi.fn();
      const registry = new DeviceRegistry({
        mega: {
          post: async (_s: string, path: string, body: any) => {
            const malformed = shape === "field_not_array" ? { [field]: value } : value;
            if (path.endsWith("get_house_list"))
              return operation === "house_list" && bad ? malformed : { house_infos: [{ house_id: "synthetic-house" }] };
            if (operation === "device_list" && !body.house_id && bad) return malformed;
            return { devices: [raw(body.house_id ? "synthetic-b" : "synthetic-a")] };
          },
        } as any,
        onError,
      });
      const initial = await registry.getDevices();
      const retained = operation === "device_list" ? "synthetic-a" : "synthetic-b";
      bad = true;
      const next = await registry.getDevices();
      expect(next.map((d) => d.sn).sort()).toEqual(["synthetic-a", "synthetic-b"]);
      expect(registry.evidenceFor(next)).toMatchObject({
        quality: "partial",
        failed: 1,
        lastCompleteSuccessMs: registry.evidenceFor(initial)?.lastCompleteSuccessMs,
        rows: {
          [retained]: {
            quality: "retained",
            lastSuccessfulObservationMs: registry.evidenceFor(initial)?.rows[retained]?.lastSuccessfulObservationMs,
          },
        },
      });
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.any(SyntaxError),
        expect.objectContaining({ kind: "decode", operation, shape }),
      );
      expect(registry.getInventoryErrors()).toMatchObject({
        total: 1,
        toleratedShapes: {},
        recent: [expect.objectContaining({ kind: "decode", operation, shape })],
      });
      expect(JSON.stringify(registry.getInventoryErrors())).not.toMatch(/PRIVATE|synthetic/);
      expect(registry.evidenceFor(initial)).toMatchObject({ generation: 1, quality: "complete" });
    });
    const tolerated = [
      ["field_null", { [field]: null }],
      ["field_missing", {}],
      ["envelope_empty_array", []],
      ["envelope_null", null],
      ["envelope_null", undefined],
      ["envelope_empty_string", ""],
    ] as const;
    it.each(tolerated)(`${operation} tolerates %s but retains missing inventory %#`, async (shape, envelope) => {
      let bad = false;
      let now = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const onError = vi.fn();
      const registry = new DeviceRegistry({
        mega: {
          post: async (_s: string, path: string, body: any) => {
            if (path.endsWith("get_house_list"))
              return operation === "house_list" && bad ? envelope : { house_infos: [{ house_id: "synthetic-house" }] };
            if (operation === "device_list" && !body.house_id && bad) return envelope;
            return { devices: [raw(body.house_id ? "synthetic-b" : "synthetic-a")] };
          },
        } as any,
        onError,
      });
      const initial = await registry.getDevices();
      await registry.pollChanges();
      bad = true;
      now = 2000;
      const retained = operation === "device_list" ? "synthetic-a" : "synthetic-b";
      for (let i = 0; i < 2; i++) {
        expect((await registry.pollChanges()).removed).toEqual([]);
        const { devices, inventoryEvidence } = registry.inventorySnapshot();
        expect(devices.map((d) => d.sn).sort()).toEqual(["synthetic-a", "synthetic-b"]);
        expect(inventoryEvidence).toMatchObject({
          quality: "partial",
          failed: 0,
          lastCompleteSuccessMs: 1000,
          rows: { [retained]: { quality: "retained", lastSuccessfulObservationMs: 1000 } },
        });
      }
      expect(onError).not.toHaveBeenCalled();
      expect(registry.getInventoryErrors()).toMatchObject({
        total: 0,
        recent: [],
        toleratedShapes: { [operation]: { [shape]: 2 } },
      });
      expect(registry.evidenceFor(initial)).toMatchObject({ generation: 1, quality: "complete" });
      expect(JSON.stringify(registry.getInventoryErrors())).not.toMatch(/PRIVATE|synthetic/);
    });
    const dropped = [
      ...[null, undefined, 42, true, "PRIVATE", []].map((row) => ["row_not_object", { [field]: [row] }] as const),
      ...[
        {},
        { [identity]: null },
        { [identity]: NaN },
        { [identity]: Infinity },
        { [identity]: 1.5 },
        { [identity]: Number.MAX_SAFE_INTEGER + 1 },
        { [identity]: true },
        { [identity]: "" },
        ...(operation === "device_list" ? [{ [identity]: "x".repeat(129) }] : []),
      ].map((row) => ["row_missing_serial", { [field]: [row] }] as const),
    ] as const;
    it.each(dropped)(`${operation} marks dropped %s rows partial without errors %#`, async (shape, envelope) => {
      let bad = false;
      const onError = vi.fn();
      const registry = new DeviceRegistry({
        mega: {
          post: async (_s: string, path: string) => {
            if (path.endsWith("get_house_list"))
              return operation === "house_list" && bad ? envelope : { house_infos: [] };
            return operation === "device_list" && bad ? envelope : { devices: [raw("synthetic-a")] };
          },
        } as any,
        onError,
      });
      await registry.getDevices();
      bad = true;
      const next = await registry.getDevices();
      const evidence = registry.evidenceFor(next)!;
      expect(evidence).toMatchObject({ quality: "partial", failed: 0, generation: 2 });
      expect(next.map((d) => d.sn)).toEqual(["synthetic-a"]);
      expect(onError).not.toHaveBeenCalled();
      expect(registry.getInventoryErrors()).toMatchObject({
        total: 0,
        recent: [],
        byKind: {},
        byOperation: {},
        toleratedShapes: { [operation]: { [shape]: 1 } },
      });
      expect(JSON.stringify(registry.getInventoryErrors())).not.toMatch(/PRIVATE|synthetic|xxxxx/);
    });
    it(`${operation} marks unexpected wrappers partial even without a baseline`, async () => {
      const registry = new DeviceRegistry({
        mega: {
          post: async (_s: string, path: string) => {
            if (path.endsWith("get_house_list"))
              return operation === "house_list" ? { list: { house_infos: [] } } : { house_infos: [] };
            return operation === "device_list" ? { list: { devices: [raw("PRIVATE")] } } : { devices: [] };
          },
        } as any,
        onError: vi.fn(),
      });
      const devices = await registry.getDevices();
      expect(registry.evidenceFor(devices)).toMatchObject({
        quality: "partial",
        failed: 0,
        lastCompleteSuccessMs: null,
      });
      expect(registry.getInventoryErrors()).toMatchObject({
        total: 0,
        toleratedShapes: { [operation]: { field_missing_with_keys: 1 } },
      });
      expect(JSON.stringify(registry.getInventoryErrors())).not.toContain("PRIVATE");
    });
  }
  it("queries every valid house and device despite skipped siblings with partial evidence", async () => {
    const calls: unknown[] = [];
    const onError = vi.fn();
    const registry = new DeviceRegistry({
      mega: {
        post: async (_s: string, path: string, body: any) => {
          if (path.endsWith("get_house_list"))
            return {
              house_infos: [null, { house_id: "synthetic-a" }, 42, [], { house_id: "" }, { house_id: "synthetic-b" }],
            };
          calls.push(body);
          return { devices: body.house_id ? [null, raw(body.house_id), {}, 42] : [] };
        },
      } as any,
      onError,
    });
    const devices = await registry.getDevices();
    expect(calls).toEqual([{}, { house_id: "synthetic-a" }, { house_id: "synthetic-b" }]);
    expect(devices.map((d) => d.sn)).toEqual(["synthetic-a", "synthetic-b"]);
    expect(registry.evidenceFor(devices)).toMatchObject({ quality: "partial", attempted: 4, failed: 0 });
    expect(onError).not.toHaveBeenCalled();
    expect(registry.getInventoryErrors()).toMatchObject({
      total: 0,
      recent: [],
      toleratedShapes: {
        house_list: { row_not_object: 3, row_missing_serial: 1 },
        device_list: { row_not_object: 4, row_missing_serial: 2 },
      },
    });
  });
  it("coerces numeric house IDs and serials without mutating the response", async () => {
    const calls: unknown[] = [];
    const row = { ...raw("synthetic"), device_sn: 12345 };
    const registry = new DeviceRegistry({
      mega: {
        post: async (_s: string, path: string, body: any) => {
          if (path.endsWith("get_house_list")) return { house_infos: [{ house_id: 42 }, { house_id: 0 }] };
          calls.push(body);
          return { devices: body.house_id === "42" ? [row] : [] };
        },
      } as any,
      onError: vi.fn(),
    });
    const devices = await registry.getDevices();
    expect(calls).toEqual([{}, { house_id: "42" }, { house_id: "0" }]);
    expect(devices).toMatchObject([{ sn: "12345", stationSn: "12345", raw: { device_sn: "12345" } }]);
    expect(row.device_sn).toBe(12345);
    expect(registry.evidenceFor(devices)).toMatchObject({ quality: "complete", failed: 0 });
    expect(registry.getInventoryErrors().toleratedShapes).toEqual({});
  });
  it("keeps redundant tolerated empties complete when every known serial is freshly observed", async () => {
    let empty = false;
    const registry = new DeviceRegistry({
      mega: {
        post: async (_s: string, path: string, body: any) => {
          if (path.endsWith("get_house_list")) return { house_infos: [{ house_id: "synthetic-house" }] };
          return empty && body.house_id ? { devices: null } : { devices: [raw("synthetic-a")] };
        },
      } as any,
      onError: vi.fn(),
    });
    await registry.getDevices();
    empty = true;
    const devices = await registry.getDevices();
    expect(registry.evidenceFor(devices)).toMatchObject({
      quality: "complete",
      rows: { "synthetic-a": { quality: "fresh" } },
    });
  });
  describe("bounded retention under constant tolerated empties", () => {
    function fixture() {
      let serials = ["synthetic-a", "synthetic-b", "synthetic-c"];
      let now = 1000;
      let failed = false;
      let toleratedEmpty = true;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const mega = {
        post: async (_s: string, path: string, body: any) => {
          if (path.endsWith("get_house_list")) return { house_infos: [{ house_id: "synthetic-house" }] };
          if (!body.house_id) return { devices: toleratedEmpty ? null : [] };
          if (failed) throw new Error("synthetic inventory failure");
          return { devices: serials.map(raw) };
        },
      };
      const createRegistry = () => new DeviceRegistry({ mega: mega as any, onError: vi.fn() });
      return {
        registry: createRegistry(),
        createRegistry,
        roster: (...next: string[]) => {
          serials = next;
        },
        time: (next: number) => {
          now = next;
        },
        fail: (next: boolean) => {
          failed = next;
        },
        normal: () => {
          toleratedEmpty = false;
        },
      };
    }
    it("expires on the third successful miss spanning twenty minutes and restores additions", async () => {
      const f = fixture();
      await f.registry.pollChanges();
      f.roster("synthetic-a", "synthetic-c");
      for (let miss = 1; miss <= 3; miss++) {
        f.time(2000 + (miss - 1) * 600_000);
        const diff = await f.registry.pollChanges();
        expect(diff.removed.map((d) => d.sn)).toEqual(miss < 3 ? [] : ["synthetic-b"]);
        expect(f.registry.inventorySnapshot().inventoryEvidence).toMatchObject({
          quality: miss < 3 ? "partial" : "complete",
          lastCompleteSuccessMs: miss < 3 ? 1000 : 1_202_000,
        });
      }
      f.roster("synthetic-a", "synthetic-c", "synthetic-d");
      const diff = await f.registry.pollChanges();
      expect(diff.added.map((d) => d.sn)).toEqual(["synthetic-d"]);
      expect(diff.removed).toEqual([]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("complete");
    });
    it.each([1, 2])("resets a transient absence after %s misses without a removal", async (misses) => {
      const f = fixture();
      await f.registry.pollChanges();
      for (let episode = 0; episode < 2; episode++) {
        f.roster("synthetic-a", "synthetic-c");
        for (let miss = 0; miss < misses; miss++) {
          expect((await f.registry.pollChanges()).removed).toEqual([]);
          expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("partial");
        }
        f.roster("synthetic-a", "synthetic-b", "synthetic-c");
        const diff = await f.registry.pollChanges();
        expect(diff.removed).toEqual([]);
        expect(diff.added).toEqual([]);
        expect(f.registry.inventorySnapshot().inventoryEvidence).toMatchObject({
          quality: "complete",
          rows: { "synthetic-b": { quality: "fresh" } },
        });
      }
    });
    it.each([1_199_999, 1_200_000, 1_200_001])("requires the twenty-minute bound at %s ms", async (elapsed) => {
      const f = fixture();
      await f.registry.pollChanges();
      f.roster("synthetic-a", "synthetic-c");
      f.time(2000);
      await f.registry.pollChanges();
      f.time(3000);
      await f.registry.pollChanges();
      f.time(2000 + elapsed);
      const diff = await f.registry.pollChanges();
      expect(diff.removed.map((d) => d.sn)).toEqual(elapsed < 1_200_000 ? [] : ["synthetic-b"]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe(
        elapsed < 1_200_000 ? "partial" : "complete",
      );
    });
    it("retains three rapid clean null misses until twenty minutes have passed", async () => {
      const f = fixture();
      await f.registry.pollChanges();
      f.roster("synthetic-a", "synthetic-c");
      for (const time of [2000, 3000, 4000, 1_201_999]) {
        f.time(time);
        expect((await f.registry.pollChanges()).removed).toEqual([]);
        expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("partial");
        expect(f.registry.list().map((d) => d.sn)).toContain("synthetic-b");
      }
      f.time(1_202_000);
      expect((await f.registry.pollChanges()).removed.map((d) => d.sn)).toEqual(["synthetic-b"]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("complete");
    });
    it("normally shaped clean absence removes immediately during a retention episode", async () => {
      const f = fixture();
      await f.registry.pollChanges();
      f.roster("synthetic-a", "synthetic-c");
      expect((await f.registry.pollChanges()).removed).toEqual([]);
      f.normal();
      expect((await f.registry.pollChanges()).removed.map((d) => d.sn)).toEqual(["synthetic-b"]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("complete");
    });
    it("does not promote rows seen only in a partial generation into the complete baseline", async () => {
      const f = fixture();
      await f.registry.pollChanges();
      f.roster("synthetic-a", "synthetic-c", "synthetic-d");
      await f.registry.pollChanges();
      f.roster("synthetic-a", "synthetic-b", "synthetic-c");
      expect((await f.registry.pollChanges()).removed.map((d) => d.sn)).toEqual(["synthetic-d"]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("complete");
    });
    it("expires each missing row independently while another row remains protected", async () => {
      const f = fixture();
      await f.registry.pollChanges();
      f.roster("synthetic-a", "synthetic-c");
      f.time(2000);
      await f.registry.pollChanges();
      f.roster("synthetic-a");
      f.time(602_000);
      await f.registry.pollChanges();
      f.time(1_202_000);
      expect((await f.registry.pollChanges()).removed.map((d) => d.sn)).toEqual(["synthetic-b"]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("partial");
      f.time(1_802_000);
      expect((await f.registry.pollChanges()).removed.map((d) => d.sn)).toEqual(["synthetic-c"]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("complete");
    });
    it("does not start or advance retention bounds during failed polls", async () => {
      const f = fixture();
      await f.registry.pollChanges();
      f.fail(true);
      for (let miss = 0; miss < 3; miss++) {
        f.time(2000 + miss * 600_000);
        expect((await f.registry.pollChanges()).removed).toEqual([]);
        expect(f.registry.list()).toHaveLength(3);
        expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("partial");
      }
      f.fail(false);
      f.roster("synthetic-a", "synthetic-c");
      f.time(1_802_000);
      expect((await f.registry.pollChanges()).removed).toEqual([]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("partial");
      f.time(3_002_000);
      expect((await f.registry.pollChanges()).removed).toEqual([]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("partial");
      f.time(3_602_000);
      expect((await f.registry.pollChanges()).removed.map((d) => d.sn)).toEqual(["synthetic-b"]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("complete");
    });
    it("pauses an existing miss counter across a failed poll", async () => {
      const f = fixture();
      await f.registry.pollChanges();
      f.roster("synthetic-a", "synthetic-c");
      f.time(2000);
      await f.registry.pollChanges();
      f.fail(true);
      f.time(602_000);
      expect((await f.registry.pollChanges()).removed).toEqual([]);
      f.fail(false);
      f.time(1_202_000);
      expect((await f.registry.pollChanges()).removed).toEqual([]);
      expect(f.registry.inventorySnapshot().inventoryEvidence?.quality).toBe("partial");
      f.time(1_802_000);
      expect((await f.registry.pollChanges()).removed.map((d) => d.sn)).toEqual(["synthetic-b"]);
    });
    it("starts from observed rows after restart and bounds later retention afresh", async () => {
      const f = fixture();
      await f.registry.pollChanges();
      f.roster("synthetic-a", "synthetic-c");
      await f.registry.pollChanges();
      const restarted = f.createRegistry();
      expect((await restarted.pollChanges()).removed).toEqual([]);
      expect(restarted.list().map((d) => d.sn)).toEqual(["synthetic-a", "synthetic-c"]);
      expect(restarted.inventorySnapshot().inventoryEvidence?.quality).toBe("complete");
      f.roster("synthetic-a", "synthetic-b", "synthetic-c");
      expect((await restarted.pollChanges()).added.map((d) => d.sn)).toEqual(["synthetic-b"]);
      f.roster("synthetic-a", "synthetic-c");
      for (let miss = 1; miss <= 3; miss++) {
        f.time(2000 + (miss - 1) * 600_000);
        expect((await restarted.pollChanges()).removed.map((d) => d.sn)).toEqual(miss < 3 ? [] : ["synthetic-b"]);
      }
    });
  });
  it.each(["parent_sn", "station_sn"])("binds coerced numeric children through %s", async (field) => {
    const registry = new DeviceRegistry({
      mega: {
        post: async (_s: string, path: string) =>
          path.endsWith("get_house_list")
            ? { house_infos: [] }
            : {
                devices: [
                  { ...raw("synthetic"), device_sn: 12345 },
                  { ...raw("synthetic"), device_sn: 67, [field]: 12345, device_channel: 1 },
                ],
              },
      } as any,
      onError: vi.fn(),
    });
    await registry.getDevices();
    expect(registry.list()[1]?.stationSn).toBe("12345");
    expect(registry.serialForFrame("12345", 1)).toBe("67");
    expect((await registry.record("67")).parentSn).toBe("12345");
  });
  it.each([
    ["envelope_null", null],
    ["envelope_null", undefined],
    ["envelope_empty_string", ""],
    ["envelope_null", encryptBody("null", "00".repeat(32))],
    ["envelope_empty_string", encryptBody('""', "00".repeat(32))],
  ])("retains inventory through successful HTTP envelopes with %s data %#", async (shape, data) => {
    const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "" });
    vi.spyOn(mega, "ensureSessionKey").mockResolvedValue({
      shareKey: "00".repeat(32),
      keyIdent: "synthetic-key",
      createdAt: Date.now(),
    } as any);
    let empty = false;
    const post = vi.spyOn(mega as any, "httpPost").mockImplementation(async (...args: any[]) => ({
      status: 200,
      data: {
        code: 0,
        data: args[0].endsWith("get_house_list")
          ? { house_infos: [] }
          : empty
            ? data
            : { devices: [raw("synthetic-a")] },
      },
    }));
    const onError = vi.fn();
    const registry = new DeviceRegistry({ mega, onError });
    await registry.pollChanges();
    empty = true;
    expect((await registry.pollChanges()).removed).toEqual([]);
    expect(registry.inventorySnapshot().inventoryEvidence).toMatchObject({
      quality: "partial",
      failed: 0,
      rows: { "synthetic-a": { quality: "retained" } },
    });
    expect(registry.getInventoryErrors()).toMatchObject({
      total: 0,
      toleratedShapes: { device_list: { [shape as string]: 1 } },
    });
    expect(post).toHaveBeenCalledTimes(4);
    expect(onError).not.toHaveBeenCalled();
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
    expect(registry.getInventoryErrors().recent[0]).toMatchObject({ kind: "decode", shape: "field_not_array" });
    expect(registry.inventorySnapshot().inventoryEvidence).toMatchObject({
      quality: "retained",
      failed: 1,
      rows: { "synthetic-a": { quality: "retained" } },
    });
  });
  it("successful absence follows existing removal policy", async () => {
    let rows = [raw("synthetic-a")];
    const registry = new DeviceRegistry({
      mega: {
        post: async (_s: string, path: string) =>
          path.endsWith("get_house_list") ? { house_infos: [] } : { devices: rows },
      } as any,
      onError: vi.fn(),
    });
    await registry.pollChanges();
    rows = [];
    expect((await registry.pollChanges()).removed.map((d) => d.sn)).toEqual(["synthetic-a"]);
    expect(registry.list()).toEqual([]);
    expect(registry.inventorySnapshot().inventoryEvidence?.quality).toBe("complete");
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
  it("counts tolerated shapes per operation, saturates and detaches counters without errors", () => {
    const recorder = new InventoryErrorRecorder();
    recorder.tolerate("field_null", "device_list");
    recorder.tolerate("field_null", "device_list");
    recorder.tolerate("row_not_object", "house_list");
    const result = recorder.diagnostics();
    expect(result).toMatchObject({
      total: 0,
      firstFailureMs: null,
      lastFailureMs: null,
      recent: [],
      toleratedShapes: { device_list: { field_null: 2 }, house_list: { row_not_object: 1 } },
    });
    result.toleratedShapes.device_list!.field_null = 99;
    expect(recorder.diagnostics().toleratedShapes.device_list!.field_null).toBe(2);
    (recorder as any).toleratedShapes.device_list.field_null = Number.MAX_SAFE_INTEGER;
    recorder.tolerate("field_null", "device_list");
    expect(recorder.diagnostics().toleratedShapes.device_list!.field_null).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("does not project arbitrary shape properties on exceptions", () => {
    expect(
      inventoryError(Object.assign(new SyntaxError("PRIVATE"), { shape: "PRIVATE" }), "device_list"),
    ).not.toHaveProperty("shape");
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
