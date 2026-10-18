/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { DeviceRegistry, type DeviceRecord } from "../device-registry.js";
import type { EufyDevice } from "../../core/types.js";
import type { MegaHttpClient } from "../../transport/http/mega-client.js";

function camera(): EufyDevice {
  return {
    sn: "CAMERA",
    stationSn: "STATION",
    model: "T8114",
    category: "eufy_security",
    raw: { device_type: 9, device_channel: 1 },
    params: {},
  } as EufyDevice;
}

function fixture() {
  const eufy = new EufyMega({ email: "synthetic@example.com", password: "synthetic", autoRealtime: false });
  const internals = eufy as unknown as { registry: DeviceRegistry; realtimeEpoch: number };
  const roster = [camera()];
  vi.spyOn(internals.registry, "list").mockImplementation(() => roster);
  const post = vi.spyOn(eufy.api, "post").mockRejectedValue(new Error("unexpected request"));
  const overlay = vi.spyOn(eufy.api, "getDeviceParamList").mockRejectedValue(new Error("unexpected request"));
  const auth = vi.spyOn(eufy.api, "auth", "get").mockReturnValue({ userId: "OWNER", authToken: "synthetic" });
  return { eufy, internals, roster, post, overlay, auth };
}

afterEach(() => vi.restoreAllMocks());

describe("cache-only inventory generation", () => {
  it("returns a stable opaque token without I/O or model resolution", () => {
    const { eufy, post, overlay } = fixture();
    const getDevice = vi.spyOn(eufy, "getDevice");
    const scope = eufy.getInventoryScope();
    expect(eufy.getInventoryScope()).toBe(scope);
    expect(eufy.getInventoryConflicts()).toEqual([]);
    expect(JSON.stringify(scope)).toBe('{"epoch":0}');
    expect(Object.isFrozen(scope)).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
    expect(getDevice).not.toHaveBeenCalled();
  });

  it("ignores params, names, roster ordering and equivalent replacement records", () => {
    const { eufy, roster } = fixture();
    roster.push({ ...camera(), sn: "OTHER" });
    const scope = eufy.getInventoryScope();
    roster[0].name = "changed";
    roster[0].params = { 1101: "90" };
    roster.reverse();
    roster[0] = { ...roster[0], raw: { ...(roster[0].raw as Record<string, unknown>) } };
    expect(eufy.getInventoryScope()).toBe(scope);
  });

  it.each(["stationSn", "model", "category", "sn", "device_type", "device_channel"])(
    "invalidates when %s changes in place",
    (field) => {
      const { eufy, roster } = fixture();
      const scope = eufy.getInventoryScope();
      if (field === "device_type" || field === "device_channel") (roster[0].raw as Record<string, unknown>)[field] = 7;
      else Object.assign(roster[0], { [field]: "different" });
      expect(eufy.getInventoryScope()).not.toBe(scope);
    },
  );

  it("invalidates on roster addition/removal, account switch and lifecycle epoch change", () => {
    const { eufy, internals, roster, auth } = fixture();
    let scope = eufy.getInventoryScope();
    roster.push({ ...camera(), sn: "OTHER" });
    expect(eufy.getInventoryScope()).not.toBe(scope);
    scope = eufy.getInventoryScope();
    roster.pop();
    expect(eufy.getInventoryScope()).not.toBe(scope);
    scope = eufy.getInventoryScope();
    auth.mockReturnValue({ userId: "OTHER_OWNER", authToken: "synthetic" });
    expect(eufy.getInventoryScope()).not.toBe(scope);
    scope = eufy.getInventoryScope();
    internals.realtimeEpoch++;
    expect(eufy.getInventoryScope()).not.toBe(scope);
    expect(eufy.getInventoryScope().epoch).toBe(1);
  });

  it("invalidates when duplicate-conflict evidence changes even if merged rows stay identical", () => {
    const { eufy, internals, post, overlay } = fixture();
    const conflicts = vi.spyOn(internals.registry, "conflicts").mockReturnValue([]);
    const scope = eufy.getInventoryScope();
    conflicts.mockReturnValue(["CAMERA"]);
    const rejectedScope = eufy.getInventoryScope();
    expect(rejectedScope).not.toBe(scope);
    expect(eufy.getInventoryScope()).toBe(rejectedScope);
    conflicts.mockReturnValue([]);
    expect(eufy.getInventoryScope()).not.toBe(rejectedScope);
    expect(post).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
  });

  it("reuses the resolved DeviceRecord for command binding", async () => {
    const { eufy, internals, roster, post, overlay } = fixture();
    const rec: DeviceRecord = { model: "T8114", deviceType: 9, parentSn: "STATION", params: {}, paramUpdatedAt: {} };
    const record = vi.spyOn(internals.registry, "record").mockResolvedValue(rec);
    vi.spyOn(internals.registry, "require").mockReturnValue(roster[0]);
    const device = await eufy.getDevice("CAMERA");
    expect(device.sn).toBe("CAMERA");
    expect(device.stationSn).toBe("STATION");
    expect(record).toHaveBeenCalledExactlyOnceWith("CAMERA");
    expect(post).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
  });
});

function raw(extra: Record<string, unknown> = {}) {
  return {
    device_sn: "CAMERA",
    station_sn: "STATION",
    device_model: "T8114",
    device_type: 9,
    device_channel: 1,
    ...extra,
  };
}

describe("house roster duplicate conflicts", () => {
  it.each(["station_sn", "device_model", "device_type", "device_channel"])(
    "retains differing %s despite last-row merge and clears only after a complete clean refresh",
    async (field) => {
      let duplicate: Record<string, unknown> = {
        [field]: typeof raw()[field as keyof ReturnType<typeof raw>] === "number" ? 2 : "OTHER",
      };
      let partial = false;
      const post = vi.fn(async (_service: string, path: string, body: unknown) => {
        if (path.endsWith("get_house_list")) return { house_infos: [{ house_id: "HOUSE" }] };
        if ((body as { house_id?: string }).house_id) {
          if (partial) throw new Error("synthetic partial");
          return { devices: [raw(duplicate)] };
        }
        return { devices: [raw()] };
      });
      const eufy = new EufyMega({ email: "synthetic@example.com", password: "synthetic", autoRealtime: false });
      const internals = eufy as unknown as { registry: DeviceRegistry };
      internals.registry = new DeviceRegistry({ mega: { post } as unknown as MegaHttpClient, onError: () => {} });
      const emptyScope = eufy.getInventoryScope();
      await internals.registry.getDevices();
      expect(eufy.getInventoryConflicts()).toEqual(["CAMERA"]);
      expect(eufy.getInventoryScope()).not.toBe(emptyScope);
      const conflictScope = eufy.getInventoryScope();
      const detached = eufy.getInventoryConflicts() as string[];
      detached.length = 0;
      expect(eufy.getInventoryConflicts()).toEqual(["CAMERA"]);
      partial = true;
      await internals.registry.getDevices();
      expect(eufy.getInventoryConflicts()).toEqual(["CAMERA"]);
      partial = false;
      duplicate = {};
      await internals.registry.getDevices();
      expect(eufy.getInventoryConflicts()).toEqual([]);
      expect(eufy.getInventoryScope()).not.toBe(conflictScope);
      const calls = post.mock.calls.length;
      eufy.getInventoryScope();
      eufy.getInventoryConflicts();
      expect(post).toHaveBeenCalledTimes(calls);
    },
  );

  it("accepts identical house duplicates and differing property values", async () => {
    const registry = new DeviceRegistry({
      mega: {
        post: async (_service: string, path: string) =>
          path.endsWith("get_house_list")
            ? { house_infos: [] }
            : { devices: [raw(), raw({ params: [{ param_type: 1101, param_value: "85" }] })] },
      } as unknown as MegaHttpClient,
      onError: () => {},
    });
    await registry.getDevices();
    expect(registry.conflicts()).toEqual([]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].params).toEqual({ 1101: "85" });
  });
});
