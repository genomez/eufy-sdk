import { afterEach, describe, expect, it, vi } from "vitest";
import { observeCommand } from "../../core/contracts.js";
import { Device } from "../../model/device.js";
import { EufyMega } from "../eufy-mega.js";

const sn = "T9000P0000000000";
const observation = {
  event: "armingModeChanged",
  property: "armingMode",
  param: 1224,
  expected: 3,
  timeoutMs: 1_000,
  resetStandaloneSession: true,
};

function fixture(commandTimeoutMs?: number) {
  const eufy = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    rtc: { commandTimeoutMs },
  });
  const client = eufy as any;
  client.registry.devices = [{ sn, model: "T9000", params: { 1224: "1" }, raw: {} }];
  const device = Device.fromRecord(sn, { model: "T9000", category: "eufy_security", params: { 1224: "1" } });
  client.liveDevices.set(sn, new WeakRef(device));
  client.boundParamIds.set(sn, new Set([1224]));
  const cloud = vi.spyOn(client.registry, "getDevices").mockResolvedValue(client.registry.devices);
  const route = vi.spyOn(client, "routeCommand").mockResolvedValue(undefined);
  const reset = vi.spyOn(client.p2p, "resetStandaloneSession").mockResolvedValue(undefined);
  const send = () =>
    client
      .commandSinkFor(sn)
      .dispatch(observeCommand({ kind: "set-payload", cmd: 1224, payload: { mode: 3 }, channel: 255 }, observation));
  const report = (value: number) => ({
    commandId: 1103,
    channel: 255,
    segment: 1,
    isResponse: 0,
    linkType: 3,
    data: { params: [{ channel: 255, param_type: 1224, param_value: value }] },
  });
  return { eufy, client, device, cloud, route, reset, send, report };
}

afterEach(() => vi.useRealTimers());

describe("bounded RTC command observation", () => {
  it("expires behind a state transaction without sending after that predecessor finishes", async () => {
    vi.useFakeTimers();
    const { eufy, client, route, send } = fixture(100);
    let release!: () => void;
    const predecessor = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.stateTransitions.set(`${sn}:1224`, predecessor);
    vi.spyOn(client, "refreshEventState").mockResolvedValue(false);
    let outcome = "pending";
    const pending = send().then(
      () => {
        outcome = "success";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(outcome).toBe("RTC command timed out before send");
      expect(route).not.toHaveBeenCalled();
      release();
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(route).not.toHaveBeenCalled();
      expect(client.commandRefreshes.size).toBe(0);
      expect(client.stateTransitions.size).toBe(0);
    } finally {
      release();
      await eufy.disconnect();
    }
  });

  it("passes only the remaining command budget after a predecessor releases the queue", async () => {
    vi.useFakeTimers();
    const { eufy, client, route, send } = fixture(100);
    let release!: () => void;
    client.stateTransitions.set(
      `${sn}:1224`,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    vi.spyOn(client, "refreshEventState").mockResolvedValue(false);
    const start = Date.now();
    const pending = send();
    await vi.advanceTimersByTimeAsync(70);
    expect(route).not.toHaveBeenCalled();
    release();
    await pending;
    expect(route.mock.calls[0]?.[2]).toBe(start + 100);
    await vi.advanceTimersByTimeAsync(40);
    expect(route).toHaveBeenCalledOnce();
    expect(client.commandRefreshes.size).toBe(0);
    await eufy.disconnect();
  });

  it("does not apply the RTC queue budget to another transport", async () => {
    vi.useFakeTimers();
    const { eufy, client, route, send } = fixture(100);
    client.registry.devices[0].model = "T8030";
    let release!: () => void;
    client.stateTransitions.set(
      `${sn}:1224`,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    vi.spyOn(client, "refreshEventState").mockResolvedValue(false);
    let finished = false;
    const pending = send().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(finished).toBe(false);
    release();
    await pending;
    expect(route.mock.calls[0]?.[2]).toBeUndefined();
    await eufy.disconnect();
  });

  it("confirms from one information report without polling cloud or recycling P2P", async () => {
    const { eufy, client, device, cloud, route, reset, send, report } = fixture();
    const events: unknown[] = [];
    eufy.on("armingModeChanged", (event) => events.push(event));
    const read = vi.spyOn(client.rtc, "refreshInformation").mockImplementation(async () => {
      const frame = report(3);
      client.rtc.deps.onFrame(sn, frame);
      return { frame, notificationCorrelation: "temporal-only" };
    });
    await send();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: expect.any(Number) });
    expect(route).toHaveBeenCalledOnce();
    expect(cloud).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(device.getProperty("armingMode")?.value).toBe(3);
    expect(client.observationReads.size).toBe(0);
    await eufy.disconnect();
  });

  it("returns the command ACK before its information read finishes and aborts that read on disconnect", async () => {
    const { eufy, client, reset, send } = fixture();
    let signal: AbortSignal | undefined;
    const read = vi.spyOn(client.rtc, "refreshInformation").mockImplementation((_sn: unknown, opts: any) => {
      signal = opts.signal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const events: unknown[] = [];
    eufy.on("armingModeChanged", (event) => events.push(event));
    await send();
    expect(read).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
    await eufy.disconnect();
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(client.observationReads.size).toBe(0);
    expect(events).toEqual([]);
    expect(reset).not.toHaveBeenCalled();
  });

  it("does not accept a stale report, repeat the read or replay the command", async () => {
    vi.useFakeTimers();
    const { eufy, client, device, route, reset, send, report } = fixture();
    const read = vi.spyOn(client.rtc, "refreshInformation").mockImplementation(async () => {
      const frame = report(1);
      client.rtc.deps.onFrame(sn, frame);
      return { frame, notificationCorrelation: "temporal-only" };
    });
    const unconfirmed: unknown[] = [];
    eufy.on("commandUnconfirmed", (event) => unconfirmed.push(event));
    await send();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(unconfirmed).toHaveLength(1);
    expect(read).toHaveBeenCalledOnce();
    expect(route).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(device.getProperty("armingMode")?.value).toBe(1);
    expect(client.observationReads.size).toBe(0);
    await eufy.disconnect();
  });

  it("keeps an information failure within the existing observation window", async () => {
    vi.useFakeTimers();
    const { eufy, client, route, reset, send } = fixture();
    const read = vi.spyOn(client.rtc, "refreshInformation").mockRejectedValue(new Error("read expired"));
    const unconfirmed: unknown[] = [];
    eufy.on("commandUnconfirmed", (event) => unconfirmed.push(event));
    await send();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(unconfirmed).toHaveLength(1);
    expect(read).toHaveBeenCalledOnce();
    expect(route).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(client.observationReads.size).toBe(0);
    await eufy.disconnect();
  });
  it("cancels a cloud fallback during its delay without another fetch or unconfirmed outcome", async () => {
    vi.useFakeTimers();
    const { eufy, client, send } = fixture();
    vi.spyOn(client.rtc, "refreshInformation").mockRejectedValue(new Error("read expired"));
    const refresh = vi.spyOn(client.registry, "refreshedList");
    const unconfirmed: unknown[] = [];
    eufy.on("commandUnconfirmed", (event) => unconfirmed.push(event));
    await send();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledOnce();
    await eufy.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(unconfirmed).toEqual([]);
  });

  it("skips an information read when the effective state already matches", async () => {
    const { eufy, client, device, cloud, send } = fixture();
    client.registry.applyRealtimeParams(sn, { 1224: "3" });
    device.applyParams({ 1224: "3" });
    const read = vi.spyOn(client.rtc, "refreshInformation");
    await send();
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    expect(cloud).not.toHaveBeenCalled();
    await eufy.disconnect();
  });
});
