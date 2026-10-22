import { normalizePushEvent } from "../../transport/push/push-client.js";
import { describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../core/types.js";
import type { PortalResponse } from "../../transport/rtc/portal-packet.js";
import { DeviceRegistry } from "../device-registry.js";
import { EufyMega } from "../eufy-mega.js";
import { inspectRtcPushSignal } from "../rtc-push.js";

const rtcPushSignal = (...args: Parameters<typeof inspectRtcPushSignal>) => inspectRtcPushSignal(...args).signal;

const HUB = "T8000P0000000000",
  CAMERA = "T8000P0000000001",
  OTHER = "T8000P0000000002";
const roster = (): EufyDevice[] =>
  [
    { sn: HUB, model: "T9000", raw: {} },
    { sn: CAMERA, model: "T8423", stationSn: HUB, raw: { parent_sn: HUB, device_channel: 0 } },
    { sn: OTHER, model: "T8423", stationSn: OTHER, raw: {} },
  ] as EufyDevice[];
function registry(devices = roster()): DeviceRegistry {
  const r = new DeviceRegistry({} as never);
  (r as unknown as { devices: EufyDevice[] }).devices = devices;
  return r;
}
function frame(extra: Record<string, unknown> = {}): PortalResponse {
  return {
    commandId: 1351,
    channel: 255,
    segment: 1,
    isResponse: 0,
    linkType: 3,
    cmd: 2037,
    data: { cmd: 2037, payload: { device_sn: CAMERA, event_type: 3111, ...extra } },
  };
}

describe("RTC notification ownership", () => {
  it("uses the explicit attached camera instead of the station envelope channel", () => {
    expect(rtcPushSignal(HUB, frame({ channel: 0 }), registry())).toMatchObject({
      deviceSn: CAMERA,
      stationSn: HUB,
      eventType: 3111,
    });
  });
  it.each([
    { device_sn: undefined },
    { device_sn: OTHER },
    { device_sn: "unknown" },
    { channel: 1 },
    { channel: "0" },
    { channel: 0, device_channel: 1 },
    { event_type: "3111" },
    { event_type: null },
  ])("declines unqualified ownership or event type %j", (extra) => {
    expect(rtcPushSignal(HUB, frame(extra), registry())).toBeUndefined();
  });
  it("rejects unknown stations, non-RTC stations and ambiguous channels", () => {
    expect(rtcPushSignal("unknown", frame(), registry())).toBeUndefined();
    const devices = roster();
    devices[0]!.model = "T8030";
    expect(rtcPushSignal(HUB, frame(), registry(devices))).toBeUndefined();
    devices[0]!.model = "T9000";
    devices.push({ ...devices[1]!, sn: "T8000P0000000003" });
    expect(rtcPushSignal(HUB, frame({ channel: 0 }), registry(devices))).toBeUndefined();
  });
  it("does not allow raw camel-case scope to overwrite verified scope", () => {
    expect(rtcPushSignal(HUB, frame({ deviceSn: OTHER, stationSn: OTHER }), registry())?.payload).toMatchObject({
      deviceSn: CAMERA,
      stationSn: HUB,
    });
  });
});

describe("RTC notification dispatch through the SDK", () => {
  it("preserves matching doorbell identities across RTC and cloud plus transport redeliveries", async () => {
    const eufy = new EufyMega({
      email: "test@example.com",
      password: "synthetic",
      autoRealtime: false,
      pollMs: 0,
      storedSnapshotCache: false,
    });
    const internal = eufy as any;
    internal.registry.devices = roster();
    const press = vi.fn();
    eufy.on("doorbellPress", press);
    try {
      internal.rtc.deps.onFrame(HUB, frame({ event_type: 3103, unique_id: "press-one" }));
      internal.onCloudPush(
        normalizePushEvent({
          persistentId: "delivery-one",
          payload: { device_sn: CAMERA, station_sn: HUB, event_type: 3103, unique_id: "press-one" },
        }),
      );
      internal.onCloudPush(
        normalizePushEvent({
          persistentId: "delivery-two",
          payload: { device_sn: CAMERA, station_sn: HUB, event_type: 3103 },
        }),
      );
      internal.onCloudPush(
        normalizePushEvent({
          persistentId: "delivery-two",
          payload: { device_sn: CAMERA, station_sn: HUB, event_type: 3103 },
        }),
      );
      expect(press.mock.calls.map(([payload]) => payload.eventId)).toEqual([
        "unique:press-one",
        "unique:press-one",
        "delivery:delivery-two",
        "delivery:delivery-two",
      ]);
    } finally {
      await eufy.disconnect();
    }
  });
  it("delivers names, ID-only and stranger results without a query or login", async () => {
    const eufy = new EufyMega({
      email: "test@example.com",
      password: "synthetic",
      autoRealtime: false,
      pollMs: 0,
      storedSnapshotCache: false,
    });
    const internal = eufy as unknown as {
      registry: DeviceRegistry;
      rtc: { deps: { onFrame: (sn: string, frame: PortalResponse) => void } };
    };
    (internal.registry as unknown as { devices: EufyDevice[] }).devices = roster();
    const person = vi.fn(),
      stranger = vi.fn(),
      all = vi.fn();
    eufy.on("personDetected", person);
    eufy.on("strangerDetected", stranger);
    eufy.on("event", all);
    const login = vi.spyOn(eufy, "login");
    internal.rtc.deps.onFrame(HUB, frame({ nick_name: "Synthetic Person" }));
    internal.rtc.deps.onFrame(HUB, frame({ person_id: 7 }));
    internal.rtc.deps.onFrame(HUB, frame({ event_type: 3112 }));
    internal.rtc.deps.onFrame(HUB, frame({ device_sn: OTHER, nick_name: "Wrong scope" }));
    expect(person).toHaveBeenCalledTimes(2);
    expect(person.mock.calls[0]![0]).toMatchObject({
      deviceSn: CAMERA,
      stationSn: HUB,
      person_name: "Synthetic Person",
    });
    expect(person.mock.calls[1]![0].person_name).toBeUndefined();
    expect(person.mock.calls[1]![0].person_id).toBe(7);
    expect(stranger).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(3);
    expect(login).not.toHaveBeenCalled();
    await eufy.disconnect();
  });
});

describe("presence-only event routing diagnostics", () => {
  it.each([
    [{ device_sn: undefined }, "missing_device"],
    [{ device_sn: "unknown" }, "unknown_device"],
    [{ device_sn: OTHER }, "wrong_station"],
    [{ event_type: "3111" }, "invalid_event_type"],
    [{ channel: "0" }, "invalid_channel"],
    [{ channel: 0, device_channel: 1 }, "channel_conflict"],
    [{ channel: 1 }, "channel_mismatch"],
  ] as const)("explains a declined signal without accepting it: %j", (extra, decision) => {
    const inspected = inspectRtcPushSignal(HUB, frame(extra), registry());
    expect(inspected.decision).toBe(decision);
    expect(inspected.signal).toBeUndefined();
    expect(rtcPushSignal(HUB, frame(extra), registry())).toBeUndefined();
  });

  it.each(["T8425", "T8423", "T8214"])("allows delayed names through RTC and cloud dispatch on %s", async (model) => {
    const eufy = new EufyMega({
      email: "test@example.com",
      password: "synthetic",
      autoRealtime: false,
      pollMs: 0,
      storedSnapshotCache: false,
    });
    const internal = eufy as unknown as {
      registry: DeviceRegistry;
      rtc: { deps: { onFrame: (sn: string, value: PortalResponse) => void } };
      onCloudPush: (event: ReturnType<typeof normalizePushEvent>) => void;
    };
    const devices = roster();
    devices[1]!.model = model;
    (internal.registry as unknown as { devices: EufyDevice[] }).devices = devices;
    const person = vi.fn();
    eufy.on("personDetected", person);
    const login = vi.spyOn(eufy, "login");
    try {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      internal.rtc.deps.onFrame(HUB, frame({ event_type: 3102 }));
      vi.setSystemTime(12000);
      internal.rtc.deps.onFrame(HUB, frame({ nick_name: "Synthetic Person", person_id: 7 }));
      internal.onCloudPush(
        normalizePushEvent({
          payload: {
            device_sn: CAMERA,
            station_sn: HUB,
            event_type: 3111,
            nick_name: "Synthetic Person",
            person_id: 7,
          },
        } as never),
      );
      internal.rtc.deps.onFrame(HUB, frame({ nick_name: "Synthetic Person", person_id: 7 }));
      expect(person).toHaveBeenCalledTimes(4);
      expect(person.mock.calls.map((call) => call[0].person_name)).toEqual([
        undefined,
        "Synthetic Person",
        "Synthetic Person",
        "Synthetic Person",
      ]);
      const trace = eufy.getEventRoutingDiagnostics();
      expect(trace.total).toBe(4);
      expect(trace.recent.map((row) => row.source)).toEqual(["rtc", "rtc", "cloud_push", "rtc"]);
      expect(trace.recent.map((row) => row.derivedNamePresent)).toEqual([false, true, true, true]);
      expect(trace.recent.every((row) => row.decision === "mapped" && row.model === model)).toBe(true);
      expect(trace.recent[1]!.observedAtMs - trace.recent[0]!.observedAtMs).toBe(11000);
      expect(JSON.stringify(trace)).not.toContain("Synthetic Person");
      expect(JSON.stringify(trace)).not.toContain(CAMERA);
      expect(JSON.stringify(trace)).not.toContain(HUB);
      expect(login).not.toHaveBeenCalled();
      await eufy.disconnect();
      expect(eufy.getEventRoutingDiagnostics().total).toBe(0);
    } finally {
      vi.useRealTimers();
      await eufy.disconnect();
    }
  });

  it("separates envelope rejection, model silence and normalized cloud fields", async () => {
    const eufy = new EufyMega({
      email: "test@example.com",
      password: "synthetic",
      autoRealtime: false,
      pollMs: 0,
      storedSnapshotCache: false,
    });
    const internal = eufy as unknown as {
      registry: DeviceRegistry;
      rtc: { deps: { onFrame: (sn: string, value: PortalResponse) => void } };
      onCloudPush: (event: ReturnType<typeof normalizePushEvent>) => void;
    };
    (internal.registry as unknown as { devices: EufyDevice[] }).devices = roster();
    try {
      internal.rtc.deps.onFrame(HUB, frame({ channel: 2, nick_name: "Synthetic rejected name" }));
      internal.rtc.deps.onFrame(HUB, frame({ event_type: 65000, nick_name: "Synthetic unmapped name" }));
      internal.rtc.deps.onFrame(HUB, { ...frame(), isResponse: 1 });
      internal.rtc.deps.onFrame(HUB, { ...frame(), cmd: 1103, data: { cmd: 1103 } });
      internal.onCloudPush(
        normalizePushEvent({
          payload: { device_sn: CAMERA, payload: JSON.stringify({ a: 3111, nick_name: "Synthetic delayed name" }) },
        } as never),
      );
      const trace = eufy.getEventRoutingDiagnostics();
      expect(trace.total).toBe(4);
      expect(trace.recent.map((row) => row.decision)).toEqual(["channel_mismatch", "unmapped", "response", "mapped"]);
      expect(trace.recent[0]).toMatchObject({ nicknamePresent: true, derivedNamePresent: false, semanticEvents: 0 });
      expect(trace.recent[3]).toMatchObject({
        source: "cloud_push",
        eventCode: 3111,
        nicknamePresent: true,
        derivedNamePresent: true,
      });
    } finally {
      await eufy.disconnect();
    }
  });
});
