import { describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../core/types.js";
import { Device } from "../../model/device.js";
import type { PortalResponse } from "../../transport/rtc/portal-packet.js";
import type { RtcCommandRouter } from "../../transport/rtc/command-router.js";
import { DeviceRegistry } from "../device-registry.js";
import { EufyMega } from "../eufy-mega.js";
import { rtcStateParameters } from "../rtc-state.js";

const HUB = "T8000P0000000000";
const SENSOR = "T8000P0000000001";
const OTHER = "T8000P0000000002";
const TWIN = "T8000P0000000003";

function roster(): EufyDevice[] {
  return [
    { sn: HUB, model: "T9000", raw: {} },
    { sn: SENSOR, model: "T8900", stationSn: HUB, raw: { parent_sn: HUB, device_channel: 0 } },
    { sn: OTHER, model: "T9000", raw: {} },
  ] as EufyDevice[];
}

function registryWith(devices = roster()): DeviceRegistry {
  const registry = new DeviceRegistry({} as never);
  (registry as unknown as { devices: EufyDevice[] }).devices = devices;
  return registry;
}

function frame(params: unknown[], extra: Record<string, unknown> = {}): PortalResponse {
  return { commandId: 1103, channel: 255, segment: 1, isResponse: 0, linkType: 3, data: { params, ...extra } };
}

const entry = (owner: Record<string, unknown>, value: unknown = 1) => ({
  ...owner,
  param_type: 1550,
  param_value: value,
});

describe("qualified RTC information state", () => {
  it("maps entry station markers and the attached channel zero independently of the packet header", () => {
    const updates = rtcStateParameters(
      HUB,
      frame([
        entry({ channel: 255 }),
        { ...entry({ device_channel: 1000 }), param_type: 1224 },
        entry({ dev_type: 0 }),
      ]),
      registryWith(),
    );
    expect(updates.get(HUB)).toEqual({ 1550: "1", 1224: "1" });
    expect(updates.get(SENSOR)).toEqual({ 1550: "1" });
  });

  it("accepts agreeing explicit serial aliases only within the current station roster", () => {
    expect(
      rtcStateParameters(
        HUB,
        frame([
          entry({ device_sn: SENSOR, dev_sn: SENSOR, channel: 0 }),
          entry({ device_sn: OTHER }),
          entry({ device_sn: "unknown" }),
        ]),
        registryWith(),
      ),
    ).toEqual(new Map([[SENSOR, { 1550: "1" }]]));
  });

  it.each([
    {},
    { channel: "0" },
    { channel: null },
    { channel: -1 },
    { channel: 0.5 },
    { channel: 42 },
    { channel: 0, device_channel: 255 },
    { channel: 0, dev_type: 255 },
    { device_sn: SENSOR, dev_sn: HUB },
    { device_sn: SENSOR, channel: 255 },
    { device_sn: SENSOR, channel: 42 },
    { device_sn: null, channel: 0 },
  ])("rejects missing, invalid, or conflicting ownership %j", (owner) => {
    expect(rtcStateParameters(HUB, frame([entry(owner)]), registryWith()).size).toBe(0);
  });

  it("rejects ambiguous channels rather than relying on roster order or station fallback", () => {
    const devices = roster();
    devices.push({ ...devices[1]!, sn: TWIN });
    for (const ordered of [devices, [...devices].reverse()]) {
      expect(rtcStateParameters(HUB, frame([entry({ channel: 0 })]), registryWith(ordered)).size).toBe(0);
    }
  });

  it("does not let an unqualified device claim channel zero", () => {
    const devices = roster();
    devices[1]!.raw = { parent_sn: HUB };
    expect(rtcStateParameters(HUB, frame([entry({})]), registryWith(devices)).size).toBe(0);
  });

  it("preserves numeric and structured parameter values for the existing model decoders", () => {
    const updates = rtcStateParameters(
      HUB,
      frame([
        { ...entry({ channel: 255 }, 0), param_type: 1299 },
        { ...entry({ channel: 255 }, { enabled: true, mode: 2 }), param_type: 1300 },
      ]),
      registryWith(),
    );
    expect(updates.get(HUB)).toEqual({ 1299: "0", 1300: '{"enabled":true,"mode":2}' });
  });

  it("decodes qualified bypass strings while rejecting malformed base64 and invalid UTF8", () => {
    const payload = frame([], {
      db_bypass_str: [
        entry({ channel: 0 }, Buffer.from("1\0").toString("base64")),
        { ...entry({ channel: 255 }, "!!!!"), param_type: 1224 },
        { ...entry({ channel: 255 }, "/w=="), param_type: 1225 },
        { ...entry({ channel: 255 }, "Zh=="), param_type: 1226 },
      ],
    });
    expect(rtcStateParameters(HUB, payload, registryWith())).toEqual(new Map([[SENSOR, { 1550: "1" }]]));
  });

  it.each([NaN, Infinity, null, undefined])("does not convert invalid values into state", (value) => {
    expect(
      rtcStateParameters(HUB, frame([{ ...entry({ channel: 255 }), param_value: value }]), registryWith()).size,
    ).toBe(0);
  });

  it("ignores responses, unrelated commands, unknown stations and non-T9000 stations", () => {
    const valid = frame([entry({ channel: 255 })]);
    expect(rtcStateParameters(HUB, { ...valid, isResponse: 1 }, registryWith()).size).toBe(0);
    expect(rtcStateParameters(HUB, { ...valid, commandId: 1151 }, registryWith()).size).toBe(0);
    expect(rtcStateParameters("unknown", valid, registryWith()).size).toBe(0);
    const devices = roster();
    devices[0]!.model = "T8010";
    expect(rtcStateParameters(HUB, valid, registryWith(devices)).size).toBe(0);
  });
});

function facade() {
  const eufy = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  const internals = eufy as unknown as {
    registry: DeviceRegistry;
    rtc: Pick<RtcCommandRouter, "refreshInformation"> & {
      deps: { onFrame: (sn: string, frame: PortalResponse) => void };
    };
    liveDevices: Map<string, WeakRef<Device>>;
    boundParamIds: Map<string, ReadonlySet<number>>;
  };
  (internals.registry as unknown as { devices: EufyDevice[] }).devices = roster();
  const device = Device.fromRecord(SENSOR, { model: "T8900", category: "eufy_security", params: { 1550: "0" } });
  internals.liveDevices.set(SENSOR, new WeakRef(device));
  internals.boundParamIds.set(SENSOR, new Set([1550]));
  return { eufy, internals, device };
}

describe("RTC state through the facade", () => {
  it("does not replace a device report with an unchanged stale cloud snapshot", async () => {
    const { eufy, internals, device } = facade();
    const devices = roster().map((entry): EufyDevice => ({
      ...entry,
      params: entry.sn === SENSOR ? { 1550: "0" } : {},
    }));
    vi.spyOn(internals.registry, "getDevices").mockResolvedValue(devices);
    await internals.registry.pollChanges();
    internals.rtc.deps.onFrame(HUB, frame([entry({ channel: 0 }, 1)]));
    expect(device.getProperty("contact")?.value).toBe(true);
    const retire = vi.spyOn(internals.registry, "retireRealtimeParams");
    await (eufy as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    expect(retire).not.toHaveBeenCalled();
    expect(device.getProperty("contact")?.value).toBe(true);
    expect(internals.registry.hasRealtimeState(SENSOR)).toBe(true);
    await eufy.disconnect();
  });

  it("updates the held model and realtime overlay, with duplicate reports producing no duplicate property change", async () => {
    const { eufy, internals, device } = facade();
    const changes: unknown[] = [];
    const states: unknown[] = [];
    eufy.on("propertyChanged", (event) => changes.push(event));
    eufy.on("deviceState", (event) => states.push(event));
    const apply = vi.spyOn(internals.registry, "applyRealtimeParams");
    const report = frame([entry({ channel: 0 })]);
    internals.rtc.deps.onFrame(HUB, report);
    internals.rtc.deps.onFrame(HUB, report);
    expect(apply).toHaveBeenCalledWith(SENSOR, { 1550: "1" });
    expect(device.getProperty("contact")?.value).toBe(true);
    expect(changes).toEqual([{ deviceSn: SENSOR, property: "contact", value: true }]);
    expect(states).toHaveLength(2);
    expect(internals.registry.hasRealtimeState(SENSOR)).toBe(true);
    await eufy.disconnect();
  });

  it("requests the attached device's station once and reports qualified counts without applying twice", async () => {
    const { eufy, internals } = facade();
    const report = frame([entry({ channel: 0 })]);
    const apply = vi.spyOn(internals.registry, "applyRealtimeParams");
    const refresh = vi.spyOn(internals.rtc, "refreshInformation").mockImplementation(async () => {
      internals.rtc.deps.onFrame(HUB, report);
      return { frame: report, notificationCorrelation: "temporal-only" };
    });
    const signal = new AbortController().signal;
    await expect(eufy.refreshDeviceState(SENSOR, { signal, timeoutMs: 1234 })).resolves.toEqual({
      notificationCorrelation: "temporal-only",
      devicesUpdated: 1,
      parametersUpdated: 1,
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(HUB, { signal, timeoutMs: 1234 });
    expect(apply).toHaveBeenCalledTimes(1);
    await eufy.disconnect();
  });

  it("rejects unsupported or already aborted requests before opening a session", async () => {
    const { eufy, internals } = facade();
    const refresh = vi.spyOn(internals.rtc, "refreshInformation");
    await expect(eufy.refreshDeviceState("unknown")).rejects.toThrow("unavailable");
    await expect(eufy.refreshDeviceState(HUB, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
    await eufy.disconnect();
  });

  it("does not open a session when device discovery finishes after disconnect", async () => {
    const { eufy, internals } = facade();
    (internals.registry as unknown as { devices: EufyDevice[] }).devices = [];
    let finish!: () => void;
    vi.spyOn(eufy, "getDevices").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      (internals.registry as unknown as { devices: EufyDevice[] }).devices = roster();
      return roster();
    });
    const refresh = vi.spyOn(internals.rtc, "refreshInformation");
    const pending = eufy.refreshDeviceState(HUB);
    const rejected = expect(pending).rejects.toThrow("interrupted");
    await eufy.disconnect();
    finish();
    await rejected;
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not rebind or announce a widening report after disconnect", async () => {
    const { eufy, internals, device } = facade();
    vi.spyOn(internals.registry, "record").mockResolvedValue({
      model: "T8900",
      category: "eufy_security",
      params: { 1550: "0" },
      paramUpdatedAt: {},
      dpParams: { 1551: "1" },
    });
    let finish!: (value: never) => void;
    let entered!: () => void;
    const contextEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rebind = vi.spyOn(eufy as unknown as { rebindReads: (sn: string) => Promise<void> }, "rebindReads");
    const context = vi.spyOn(eufy as unknown as { commandContext: () => Promise<unknown> }, "commandContext");
    context.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          entered();
        }),
    );
    const bind = vi.spyOn(device, "bindActions");
    const states: unknown[] = [];
    eufy.on("deviceState", (event) => states.push(event));
    internals.rtc.deps.onFrame(HUB, frame([{ ...entry({ channel: 0 }), param_type: 1551 }]));
    // Preserve the race boundary: disconnect after the context read starts, not before the record await.
    await contextEntered;
    expect(context).toHaveBeenCalledTimes(1);
    expect(states).toHaveLength(1);
    await eufy.disconnect();
    finish({ paramIds: new Set([1550, 1551]) } as never);
    await rebind.mock.results[0]!.value;
    expect(bind).not.toHaveBeenCalled();
    expect(states).toHaveLength(1);
  });

  it("does not rebind or announce when a widening record read finishes after disconnect", async () => {
    const { eufy, internals, device } = facade();
    let finishRecord!: (record: Awaited<ReturnType<DeviceRegistry["record"]>>) => void;
    const record = vi.spyOn(internals.registry, "record").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRecord = resolve;
        }),
    );
    const context = vi.spyOn(eufy as unknown as { commandContext: () => Promise<unknown> }, "commandContext");
    context.mockResolvedValue({ paramIds: new Set([1550, 1551]) });
    const rebind = vi.spyOn(eufy as unknown as { rebindReads: (sn: string) => Promise<void> }, "rebindReads");
    const bind = vi.spyOn(device, "bindActions");
    const reresolve = vi.spyOn(device, "reresolve");
    const apply = vi.spyOn(device, "applyParams");
    const states: unknown[] = [];
    eufy.on("deviceState", (event) => states.push(event));
    internals.rtc.deps.onFrame(HUB, frame([{ ...entry({ channel: 0 }), param_type: 1551 }]));
    expect(record).toHaveBeenCalledExactlyOnceWith(SENSOR);
    expect(context).not.toHaveBeenCalled();
    expect(states).toHaveLength(1);
    await eufy.disconnect();
    apply.mockClear();
    finishRecord({
      model: "T8900",
      category: "eufy_security",
      params: {},
      paramUpdatedAt: {},
      dpParams: { 1551: "1" },
    });
    await rebind.mock.results[0]!.value;
    expect(bind).not.toHaveBeenCalled();
    expect(reresolve).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(states).toHaveLength(1);
  });
});
