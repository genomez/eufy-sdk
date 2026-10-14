import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeCommand, type Command } from "../../core/contracts.js";
import { Device } from "../../model/device.js";
import { buildPortalHeader, parsePortalHeader, PORTAL_HEADER_LENGTH } from "../../transport/rtc/portal-packet.js";
import { EufyMega } from "../eufy-mega.js";

const STATION = "T9000P0000000000";
const CAMERA = "T8425P0000000000";

/** Synthetic session with manually admitted acknowledgements and the real transport queue. */
class HeldAckSession extends EventEmitter {
  connected = false;
  closed = false;
  packets: Buffer[] = [];
  get isConnected(): boolean {
    return this.connected && !this.closed;
  }
  async connect(): Promise<void> {
    this.connected = true;
    this.emit("connected");
  }
  sendCommand(packet: Buffer): boolean {
    if (!this.isConnected) return false;
    this.packets.push(packet);
    return true;
  }
  ack(packet: Buffer, link = 1): void {
    const header = parsePortalHeader(packet)!;
    const body = Buffer.alloc(4);
    this.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(header.commandId, body.length, header.channel, header.segment, 1), body]),
      link,
    );
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.emit("close");
  }
}

/** Real model binding and facade routing against an entirely synthetic cached account. */
function fixture(parent: string | null = "T9000", unrelatedS1 = false) {
  const eufy = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
    rtc: { sessionRefreshMs: 0 },
  });
  const client = eufy as any;
  const params = { 1400: "0" };
  const type = parent === null ? 46 : 47;
  const model = parent === null ? "T8442" : "T8425";
  client.registry.devices = [
    ...(parent ? [{ sn: STATION, model: parent, params: {}, raw: {} }] : []),
    {
      sn: CAMERA,
      model,
      ...(parent ? { stationSn: STATION } : {}),
      params,
      api: "mega",
      category: "eufy_security",
      raw: { device_channel: 2, device_type: type, ...(parent ? { parent_sn: STATION } : {}) },
    },
    ...(unrelatedS1 ? [{ sn: "T9000P0000000099", model: "T9000", params: {}, raw: {} }] : []),
  ];
  const device = Device.fromRecord(CAMERA, { model, deviceType: type, category: "eufy_security", params });
  client.liveDevices.set(CAMERA, new WeakRef(device));
  client.boundParamIds.set(CAMERA, new Set([1400]));
  device.bindActions(
    { channel: 2, codec: "camera", deviceType: type, paramIds: new Set([1400]) },
    client.commandSinkFor(CAMERA),
  );
  const rtc = vi.spyOn(client.rtc, "dispatchCommand").mockResolvedValue(undefined);
  const p2p = vi.spyOn(client.p2p, "dispatchCommand").mockResolvedValue(undefined);
  const mqtt = vi.spyOn(client.mqtt, "dispatchCommand").mockResolvedValue(undefined);
  const tuya = vi.spyOn(client.tuya, "dispatchCommand").mockResolvedValue(undefined);
  const read = vi.spyOn(client.rtc, "refreshInformation").mockResolvedValue(undefined);
  const cloud = vi.spyOn(client.registry, "getDevices").mockResolvedValue(client.registry.devices);
  const refresh = vi.spyOn(client, "refreshEventState").mockResolvedValue(false);
  const outcomes: unknown[] = [];
  const events: unknown[] = [];
  eufy.on("commandUnconfirmed", (event) => outcomes.push(event));
  eufy.on("event", (event) => {
    if (String(event.eventName) === "lightChanged") events.push(event);
  });
  return { eufy, client, device, rtc, p2p, mqtt, tuya, read, cloud, refresh, outcomes, events };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("S1 passive readback boundaries", () => {
  it("keeps held wire ACKs serialized after bypassing semantic convergence", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let releaseRefresh!: (value: boolean) => void;
    f.refresh.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseRefresh = resolve;
        }),
    );
    const session = new HeldAckSession();
    f.rtc.mockRestore();
    f.client.rtc.deps.identity = () => ({
      authToken: "synthetic-token",
      userId: "synthetic-user",
      accountUserId: "synthetic-account",
      gtoken: "synthetic-gtoken",
    });
    f.client.rtc.deps.shard = () => "ie-pr";
    f.client.rtc.deps.createSession = () => session;
    const settled: string[] = [];
    const on = f.device.light!()!
      .on()
      .then(() => settled.push("on"));
    const off = f.device.light!()!
      .off()
      .then(() => settled.push("off"));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(session.packets).toHaveLength(1);
      expect(settled).toEqual([]);
      expect(JSON.parse(session.packets[0]!.subarray(PORTAL_HEADER_LENGTH).toString()).data.value).toBe(1);
      session.ack(session.packets[0]!, 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.packets).toHaveLength(1);
      expect(settled).toEqual([]);
      session.ack(session.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.packets).toHaveLength(2);
      expect(settled).toEqual(["on"]);
      expect(JSON.parse(session.packets[1]!.subarray(PORTAL_HEADER_LENGTH).toString()).data.value).toBe(0);
      expect(parsePortalHeader(session.packets[1]!)!.segment).not.toBe(parsePortalHeader(session.packets[0]!)!.segment);
      session.ack(session.packets[0]!);
      session.ack(session.packets[1]!, 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toEqual(["on"]);
      session.ack(session.packets[1]!);
      await Promise.all([on, off]);
      expect(settled).toEqual(["on", "off"]);
      expect(f.refresh).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.cloud).not.toHaveBeenCalled();
      expect(f.device.light!()!.isOn).toBe(false);
      expect(f.events).toEqual([]);
      expect(f.outcomes).toEqual([]);
    } finally {
      releaseRefresh?.(false);
      await f.eufy.disconnect();
      await Promise.allSettled([on, off]);
    }
  });

  it.each([
    ["standalone", null, false],
    ["other HomeBase", "T8030", false],
    ["other HomeBase with S1 elsewhere", "T8030", true],
  ] as const)("preserves the observed transaction for %s", async (_label, parent, unrelatedS1) => {
    vi.useFakeTimers();
    const f = fixture(parent, unrelatedS1);
    let release!: (value: boolean) => void;
    f.refresh.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    f.refresh.mockResolvedValueOnce(true);
    try {
      await f.device.light!()!.on();
      expect(f.p2p).toHaveBeenCalledOnce();
      expect(f.refresh).toHaveBeenCalledOnce();
      const off = f.device.light!()!.off();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.p2p).toHaveBeenCalledOnce();
      expect(f.client.commandRefreshes.size).toBe(1);
      expect(f.client.stateTransitions.size).toBe(1);
      expect(f.events).toEqual([]);
      release(true);
      await off;
      await vi.advanceTimersByTimeAsync(0);
      expect(f.p2p).toHaveBeenCalledTimes(2);
      expect(f.refresh).toHaveBeenCalledTimes(2);
      expect(f.events).toHaveLength(2);
      expect(f.rtc).not.toHaveBeenCalled();
      expect(f.client.commandRefreshes.size).toBe(0);
      expect(f.client.stateTransitions.size).toBe(0);
    } finally {
      release?.(false);
      await f.eufy.disconnect();
    }
  });

  it.each([
    ["mqtt-dp", { kind: "mqtt-dp", mqttCmdCode: 1, cmdCode: 2, fields: [] }, "mqtt"],
    [
      "mqtt-dp-preset",
      { kind: "mqtt-dp-preset", mqttCmdCode: 1, cmdCode: 2, companionCmdCode: 3, presetId: 4 },
      "mqtt",
    ],
    [
      "mqtt-dp-color",
      { kind: "mqtt-dp-color", mqttCmdCode: 1, cmdCode: 2, red: 1, green: 2, blue: 3, segmentCount: 1 },
      "mqtt",
    ],
    ["aiot MQTT", { kind: "aiot-dp", dp: 1, value: true }, "mqtt"],
    ["aiot Tuya", { kind: "aiot-dp", dp: 1, value: true }, "tuya"],
    ["ff09 MQTT", { kind: "ff09-autolock", adminUserId: "synthetic-admin", deviceSn: CAMERA, enabled: true }, "mqtt"],
    [
      "ff09 P2P",
      { kind: "ff09-setting-toggle", adminUserId: "synthetic-admin", deviceSn: CAMERA, settingId: 1, value: true },
      "p2p",
    ],
  ] as const)(
    "preserves special %s precedence despite S1 topology and passive policy",
    async (_label, command, transport) => {
      vi.useFakeTimers();
      const f = fixture();
      const target = f.client.registry.devices.find((device: any) => device.sn === CAMERA);
      if (transport === "tuya") target.category = "eufy_home_tuya";
      if (transport === "p2p") target.p2pDid = "XXXXXXX-000000-XXXXX";
      let release!: (value: boolean) => void;
      f.refresh.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      );
      const sink = f.client.commandSinkFor(CAMERA);
      const observed = () =>
        observeCommand({ ...command } as Command, {
          event: "lightChanged",
          property: "light",
          param: 1400,
          expected: 1,
          timeoutMs: 20_000,
          passiveReadback: true,
        });
      try {
        await sink.dispatch(observed());
        expect(f[transport]).toHaveBeenCalledOnce();
        expect(f.refresh).toHaveBeenCalledOnce();
        const second = sink.dispatch(observed());
        await vi.advanceTimersByTimeAsync(0);
        expect(f[transport]).toHaveBeenCalledOnce();
        expect(f.client.stateTransitions.size).toBe(1);
        release(false);
        await second;
        await vi.advanceTimersByTimeAsync(0);
        expect(f[transport]).toHaveBeenCalledTimes(2);
        expect(f.refresh).toHaveBeenCalledTimes(2);
        expect(f.rtc).not.toHaveBeenCalled();
        expect(f.events).toEqual([]);
        expect(f.client.commandRefreshes.size).toBe(0);
      } finally {
        release?.(false);
        await f.eufy.disconnect();
      }
    },
  );

  it.each(["on", "off", "set"] as const)(
    "returns the original RTC %s error without retry or alternate dispatch",
    async (action) => {
      vi.useFakeTimers();
      const f = fixture();
      const failure = new Error("synthetic ambiguous ACK failure");
      f.rtc.mockRejectedValueOnce(failure);
      try {
        const light = f.device.light!()!;
        await expect(action === "set" ? light.set(true) : light[action]()).rejects.toBe(failure);
        await vi.advanceTimersByTimeAsync(40_000);
        expect(f.rtc).toHaveBeenCalledOnce();
        expect(f.p2p).not.toHaveBeenCalled();
        expect(f.mqtt).not.toHaveBeenCalled();
        expect(f.tuya).not.toHaveBeenCalled();
        expect(f.refresh).not.toHaveBeenCalled();
        expect(f.read).not.toHaveBeenCalled();
        expect(f.events).toEqual([]);
        expect(f.outcomes).toEqual([]);
      } finally {
        await f.eufy.disconnect();
      }
    },
  );

  it.each(["missing", "shared", "mismatched"] as const)("rejects a %s RTC channel without sending", async (issue) => {
    const f = fixture();
    const target = f.client.registry.devices.find((device: any) => device.sn === CAMERA);
    if (issue === "missing") target.raw = { parent_sn: STATION };
    if (issue === "shared") f.client.registry.devices.push({ ...target, sn: "T8425P0000000099" });
    if (issue === "mismatched") target.raw = { parent_sn: STATION, device_channel: 3 };
    try {
      await expect(f.device.light!()!.on()).rejects.toThrow("unambiguous attached-device channel");
      expect(f.rtc).not.toHaveBeenCalled();
      expect(f.p2p).not.toHaveBeenCalled();
      expect(f.refresh).not.toHaveBeenCalled();
    } finally {
      await f.eufy.disconnect();
    }
  });
});
