import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";

const STATION = "T9000P0000000000";

function fixture() {
  const eufy = new EufyMega({ email: "synthetic@example.test", password: "synthetic", autoRealtime: false });
  const internal = eufy as any;
  const raw = {
    device_sn: STATION,
    device_model: "T9000",
    device_type: 27,
    category: "eufy_security",
    main_sw_version: "4.4.0.4",
    params: [],
  };
  const post = vi
    .spyOn(internal.mega, "post")
    .mockImplementation(async (...args: any[]) =>
      args[1].endsWith("get_house_list") ? { house_infos: [] } : { devices: [{ ...raw }] },
    );
  const params = vi.spyOn(internal.mega, "getDeviceParamList").mockResolvedValue({ params: [] });
  vi.spyOn(internal.mega, "rtcIdentity").mockReturnValue({ authToken: "synthetic", userId: "synthetic" });
  return { eufy, internal, raw, post, params };
}

afterEach(() => vi.restoreAllMocks());

describe("firmware-qualified cached ownership", () => {
  it.each(["4.4.0.4", "4.4.1.4"])("accepts exactly %s and retains its actual firmware", async (version) => {
    const f = fixture();
    f.raw.main_sw_version = version;
    await f.eufy.getDevices();
    const owner = f.eufy.getStorageTelemetryOwner(STATION);
    expect(owner).toMatchObject({ model: "T9000", firmware: version });
    expect(f.eufy.getStorageTelemetryOwner(STATION)).toBe(owner);
    expect(f.params).not.toHaveBeenCalled();
  });

  it.each(["4.4.2.4", "4.4.1.40", "", "4.4.1.4-preview"])("rejects unqualified %s", async (version) => {
    const f = fixture();
    f.raw.main_sw_version = version;
    await f.eufy.getDevices();
    expect(f.eufy.getStorageTelemetryOwner(STATION)).toBeUndefined();
    expect(f.params).not.toHaveBeenCalled();
  });

  it("retires the owner token and aborts an old read when qualified firmware changes", async () => {
    const f = fixture();
    await f.eufy.getDevices();
    const old = f.eufy.getStorageTelemetryOwner(STATION)!;
    const controller = new AbortController();
    f.internal.storageTelemetryReads.set(STATION, new Set([controller]));
    f.raw.main_sw_version = "4.4.1.4";
    await f.eufy.getDevices();
    expect(f.eufy.getStorageTelemetryOwner(STATION)?.token).not.toBe(old.token);
    expect(controller.signal.aborted).toBe(true);
  });

  it.each([false, true])(
    "refreshes all held metadata on a roster change, nested=%s, with no extra requests",
    async (nested) => {
      const f = fixture();
      const events: unknown[] = [];
      f.eufy.on("deviceMetadata", (event) => events.push(event));
      await f.eufy.getDevices();
      const first = await f.eufy.getDevice(STATION);
      const second = await f.eufy.getDevice(STATION);
      expect(first.info?.()?.firmwareVersion).toBe("4.4.0.4");
      f.post.mockClear();
      f.params.mockClear();
      if (nested) (f.raw as any).deviceParams = { main_sw_version: "4.4.1.4" };
      else f.raw.main_sw_version = "4.4.1.4";
      await f.eufy.getDevices();
      expect(first.info?.()?.firmwareVersion).toBe("4.4.1.4");
      expect(second.info?.()?.firmwareVersion).toBe("4.4.1.4");
      expect(events.at(-1)).toEqual({ deviceSn: STATION, firmwareVersion: "4.4.1.4" });
      expect(f.params).not.toHaveBeenCalled();
      expect(f.post).toHaveBeenCalledTimes(2);
      await f.eufy.getDevices();
      expect(events).toHaveLength(2);
    },
  );
});
