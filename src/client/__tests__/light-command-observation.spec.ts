import { afterEach, describe, expect, it, vi } from "vitest";
import { Device } from "../../model/device.js";
import { EufyMega } from "../eufy-mega.js";

const stationSn = "T9000P0000000000";
const cameraSn = "T8425P0000000000";

/** A real bound light member with synthetic cloud state and a controlled RTC information response. */
function fixture(initial: boolean) {
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
  const client = eufy as any;
  const params = { 1400: initial ? "1" : "0" };
  client.registry.devices = [
    { sn: stationSn, model: "T9000", params: {}, raw: {} },
    { sn: cameraSn, model: "T8425", stationSn, params, raw: { device_channel: 0, device_type: 47 } },
  ];
  const device = Device.fromRecord(cameraSn, { model: "T8425", deviceType: 47, category: "eufy_security", params });
  client.liveDevices.set(cameraSn, new WeakRef(device));
  client.boundParamIds.set(cameraSn, new Set([1400]));
  device.bindActions(
    { channel: 0, codec: "camera", deviceType: 47, paramIds: new Set([1400]) },
    client.commandSinkFor(cameraSn),
  );
  const cloud = vi.spyOn(client.registry, "getDevices").mockResolvedValue(client.registry.devices);
  const route = vi.spyOn(client.rtc, "dispatchCommand").mockResolvedValue(undefined);
  const reset = vi.spyOn(client.p2p, "resetStandaloneSession").mockResolvedValue(undefined);
  const report = (value: string | number, encodedList = false) => {
    const frame = {
      commandId: 1103,
      channel: 255,
      segment: 1,
      isResponse: 0,
      linkType: 3,
      data: { [encodedList ? "db_bypass_str" : "params"]: [{ channel: 0, param_type: 1400, param_value: value }] },
    };
    client.rtc.deps.onFrame(stationSn, frame);
    return { frame, notificationCorrelation: "temporal-only" };
  };
  const confirmed: unknown[] = [];
  const unconfirmed: unknown[] = [];
  eufy.on("lightChanged", (event) => confirmed.push(event));
  eufy.on("commandUnconfirmed", (event) => unconfirmed.push(event));
  return { eufy, client, device, cloud, route, reset, report, confirmed, unconfirmed };
}

afterEach(() => vi.useRealTimers());

describe("light command observation", () => {
  it.each([true, false])("acknowledges an RTC light write %s without active readback", async (on) => {
    const { eufy, client, device, cloud, route, reset, report, confirmed, unconfirmed } = fixture(!on);
    const read = vi.spyOn(client.rtc, "refreshInformation");
    await device.light!()!.set(on);
    expect(device.light!()!.isOn).toBe(!on);
    expect(read).not.toHaveBeenCalled();
    expect(route).toHaveBeenCalledOnce();
    expect(route.mock.calls[0]?.[2]).toMatchObject({ deadlineAtMs: expect.any(Number) });
    expect(cloud).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(confirmed).toEqual([]);
    expect(unconfirmed).toEqual([]);
    report(on ? 1 : 0);
    expect(device.light!()!.isOn).toBe(on);
    expect(confirmed).toEqual([]);
    await eufy.disconnect();
  });

  it.each(["on", "off"] as const)("keeps the %s alias passive until an encoded information report", async (action) => {
    const on = action === "on";
    const { eufy, client, device, route, report, confirmed } = fixture(!on);
    const read = vi.spyOn(client.rtc, "refreshInformation");
    await device.light!()![action]();
    expect(device.light!()!.isOn).toBe(!on);
    expect(route).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    report(Buffer.from(on ? "1" : "0").toString("base64"), true);
    expect(device.light!()!.isOn).toBe(on);
    expect(confirmed).toEqual([]);
    await eufy.disconnect();
  });

  it("does not turn stale state into an active timeout or replay the command", async () => {
    vi.useFakeTimers();
    const { eufy, client, device, route, reset, confirmed, unconfirmed } = fixture(false);
    const read = vi.spyOn(client.rtc, "refreshInformation");
    await device.light!()!.on();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(confirmed).toEqual([]);
    expect(unconfirmed).toEqual([]);
    expect(device.light!()!.isOn).toBe(false);
    expect(route).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    await eufy.disconnect();
  });

  it("does not confirm a command from cached equality", async () => {
    const { eufy, client, device, route, confirmed } = fixture(false);
    const read = vi.spyOn(client.rtc, "refreshInformation");
    await device.light!()!.off();
    expect(confirmed).toEqual([]);
    expect(route).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    await eufy.disconnect();
  });
  it("announces generic state and preserves the realtime value in a newly resolved device", async () => {
    const { eufy, client, device, report } = fixture(false);
    const changes: unknown[] = [];
    eufy.on("propertyChanged", (event) => changes.push(event));
    vi.spyOn(client.mega, "getDeviceParamList").mockResolvedValue({ params: [{ param_type: 1400, param_value: "0" }] });
    report(1);
    expect(changes).toEqual([{ deviceSn: cameraSn, property: "light", value: true }]);
    expect(device.getPropertyValue("light")).toBe(true);
    const snapshot = await eufy.getDevice(cameraSn);
    expect(snapshot.getPropertyValue("light")).toBe(true);
    expect(snapshot.light!()!.isOn).toBe(true);
    await eufy.disconnect();
  });

  it.each([0, 1_000])("dispatches a newer OFF without waiting for ON convergence after %i ms", async (spacing) => {
    vi.useFakeTimers();
    const { eufy, client, device, route, confirmed, unconfirmed } = fixture(false);
    const read = vi.spyOn(client.rtc, "refreshInformation");
    await device.light!()!.on();
    await vi.advanceTimersByTimeAsync(spacing);
    await device.light!()!.off();
    expect(route).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
    expect(unconfirmed).toEqual([]);
    expect(confirmed).toEqual([]);
    expect(client.commandRefreshes.size).toBe(0);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(route).toHaveBeenCalledTimes(2);
    expect(device.getPropertyValue("light")).toBe(false);
    await eufy.disconnect();
  });
});

describe("qualified property observations", () => {
  it("announces a repeated OFF report without claiming a property change", async () => {
    const { eufy, client, device, report } = fixture(false);
    const observed: unknown[] = [];
    const changed: unknown[] = [];
    eufy.on("propertiesObserved", (e) => observed.push(e));
    eufy.on("propertyChanged", (e) => changed.push(e));
    report(0);
    report(0);
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({ deviceSn: cameraSn, source: "rtc", properties: { light: false } });
    expect(changed).toEqual([]);
    expect(device.light!()!.isOn).toBe(false);
    const unrelated = {
      commandId: 1103,
      channel: 255,
      segment: 3,
      isResponse: 0,
      linkType: 3,
      data: { params: [{ channel: 0, param_type: 999999, param_value: "opaque" }] },
    };
    client.rtc.deps.onFrame(stationSn, unrelated);
    expect(observed).toHaveLength(2);
    client.applyRealtimeState(cameraSn, { 1400: "1" });
    expect(observed).toHaveLength(2);
    await eufy.disconnect();
  });

  it("does not turn a successful command or cached equality into a device receipt", async () => {
    const { eufy, device } = fixture(false);
    const observed: unknown[] = [];
    eufy.on("propertiesObserved", (e) => observed.push(e));
    await device.light!()!.off();
    expect(observed).toEqual([]);
    await eufy.disconnect();
  });

  it("records repeated qualified report timings only for previously commanded targets", async () => {
    const { eufy, client, report } = fixture(false);
    const lookup = vi.spyOn(client.rtc, "getCommandTarget");
    report(0);
    expect(eufy.getRtcObservationDiagnostics().recent).toEqual([]);
    lookup.mockReturnValue({ target: 2, latestCommandAttempt: 7 });
    report(0);
    report(0);
    expect(eufy.getRtcObservationDiagnostics().recent).toEqual([
      { attempt: 7, target: 2, observedAtMs: expect.any(Number), properties: 1 },
      { attempt: 7, target: 2, observedAtMs: expect.any(Number), properties: 1 },
    ]);
    client.applyRealtimeState(cameraSn, { 1400: "1" });
    expect(eufy.getRtcObservationDiagnostics().total).toBe(2);
    expect(eufy.getRtcObservationContext(cameraSn)).toEqual({ target: 2, latestCommandAttempt: 7 });
    await eufy.disconnect();
    expect(eufy.getRtcObservationDiagnostics()).toEqual({ lifecycle: 1, total: 0, evicted: 0, recent: [] });
  });
});
