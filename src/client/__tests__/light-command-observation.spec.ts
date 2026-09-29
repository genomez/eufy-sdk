import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Device } from "../../model/device.js";
import { EufyMega } from "../eufy-mega.js";

const sn = "T8425P0000000000";
const clients: EufyMega[] = [];

/** A bound light with a fake command transport and controlled device-list readback. */
function fixture(initial: boolean, reportsSwitch = true) {
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
  clients.push(eufy);
  const client = eufy as any;
  const params: Record<number, string> = { 1401: "50" };
  if (reportsSwitch) params[1400] = initial ? "1" : "0";
  const record = { sn, model: "T8425", params, raw: { device_channel: 0, device_type: 47 } };
  client.registry.devices = [record];
  const device = Device.fromRecord(sn, { model: "T8425", deviceType: 47, category: "eufy_security", params });
  client.liveDevices.set(sn, new WeakRef(device));
  client.boundParamIds.set(sn, new Set(Object.keys(params).map(Number)));
  device.bindActions(
    { channel: 0, codec: "camera", deviceType: 47, paramIds: new Set(Object.keys(params).map(Number)) },
    client.commandSinkFor(sn),
  );
  const route = vi.spyOn(client, "routeCommand").mockResolvedValue(undefined);
  const read = vi.spyOn(client.registry, "refreshedList").mockResolvedValue(record);
  const reset = vi.spyOn(client.p2p, "resetStandaloneSession").mockResolvedValue(undefined);
  const unconfirmed: unknown[] = [];
  const events: unknown[] = [];
  const errors: unknown[] = [];
  eufy.on("commandUnconfirmed", (value) => unconfirmed.push(value));
  eufy.on("event", (value) => events.push(value));
  eufy.on("error", (value) => errors.push(value));
  const report = (on: boolean) => client.applyRealtimeState(sn, { 1400: on ? "1" : "0" });
  return { client, device, record, route, read, reset, unconfirmed, events, errors, report };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("light command observation", () => {
  it.each(["set on", "set off", "on", "off"] as const)(
    "reports stale readback for %s without replaying the command",
    async (action) => {
      const on = action.endsWith("on");
      const { device, route, read, reset, unconfirmed, errors } = fixture(!on);
      const light = device.light!()!;
      await (action.startsWith("set") ? light.set(on) : light[action as "on" | "off"]());
      expect(unconfirmed).toEqual([]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(read).toHaveBeenCalled();
      expect(unconfirmed).toEqual([
        { sn, property: "light", param: 1400, expected: on ? 1 : 0, observed: on ? "0" : "1", timeoutMs: 20_000 },
      ]);
      expect(device.light!()!.isOn).toBe(!on);
      expect(route).toHaveBeenCalledOnce();
      expect(reset).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    },
  );

  it.each([true, false])("applies readback for %s without inventing a transition event", async (on) => {
    const { client, device, record, read, route, unconfirmed, events, errors } = fixture(!on);
    read.mockImplementation(async () => {
      record.params[1400] = on ? "1" : "0";
      return record;
    });
    await device.light!()!.set(on);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledOnce();
    expect(device.light!()!.isOn).toBe(on);
    expect(client.stateTransitions.size).toBe(0);
    expect(route).toHaveBeenCalledOnce();
    expect(unconfirmed).toEqual([]);
    expect(events).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("keeps the inbound generic event while awaiting matching cloud readback", async () => {
    const { client, device, record, read, route, report, events, unconfirmed, errors } = fixture(false);
    await device.light!()!.on();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledOnce();
    report(true);
    read.mockImplementation(async () => {
      record.params[1400] = "1";
      return record;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(device.light!()!.isOn).toBe(true);
    expect(events).toEqual([{ deviceSn: sn, property: "light", value: true, eventName: "propertyChanged" }]);
    expect(client.stateTransitions.size).toBe(0);
    expect(route).toHaveBeenCalledOnce();
    expect(unconfirmed).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("does not require readback for a device that never reported the switch parameter", async () => {
    const { device, read, route, unconfirmed, errors } = fixture(false, false);
    await device.light!()!.on();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(route).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(unconfirmed).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("does not claim a fresh read when cached state already matches", async () => {
    const { client, device, read, route, unconfirmed, events, errors } = fixture(false);
    await device.light!()!.off();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.stateTransitions.size).toBe(0);
    expect(route).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(unconfirmed).toEqual([]);
    expect(events).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("finishes the first observation before dispatching an opposite command", async () => {
    const { device, route, unconfirmed, errors } = fixture(false);
    await device.light!()!.on();
    const off = device.light!()!.off();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(route).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await off;
    expect(route).toHaveBeenCalledTimes(2);
    expect(unconfirmed).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});
