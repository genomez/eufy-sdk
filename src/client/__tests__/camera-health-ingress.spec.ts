import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { CameraHealthIngress } from "../camera-health-ingress.js";
import type { Capability } from "../../model/index.js";
import type { EufyDevice } from "../../core/types.js";
import { normalizePushEvent, PushClient } from "../../transport/push/push-client.js";
import { mcsRoot } from "../../transport/push/proto.js";
import { MessageTag } from "../../transport/push/message-tags.js";
import type { McsParser } from "../../transport/push/parser.js";
import type { PushEvent, RawPushMessage } from "../../transport/push/types.js";
import { CAMERA_CONTACT_TTL_MS } from "../camera-health.js";

const TARGET = "T8425P0000000000";
const OTHER = "T8425P0000000001";
const STATION = "T9000P0000000000";
const PUSH_TIME = 1_790_741_400_000;
const PUSH_BODY = {
  device_sn: TARGET,
  station_sn: STATION,
  event_type: 3102,
  pic_url: "https://example.test/thumbnail.jpg",
  create_time: PUSH_TIME - 7000,
  trigger_time: PUSH_TIME - 7000,
};

/** Replays the MCS envelope-preservation and nested-thumbnail fixture shapes without opening a socket. */
function parsedDetection(payload: unknown, siblings: Record<string, string> = {}): PushEvent {
  const client = new PushClient({
    fid: "synthetic",
    androidId: "1",
    securityToken: "2",
    fcmToken: "synthetic",
    createdAt: 0,
  });
  let raw!: RawPushMessage;
  client.on("message", (value: RawPushMessage) => {
    raw = value;
  });
  const data = mcsRoot().lookupType("mcs_proto.DataMessageStanza");
  const encoded = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([0])]).toString("base64");
  const frame = Buffer.concat([
    Buffer.from([41, MessageTag.DataMessageStanza]),
    data
      .encodeDelimited({
        from: "synthetic",
        category: "synthetic",
        appData: [
          { key: "payload", value: encoded },
          ...Object.entries(siblings).map(([key, value]) => ({ key, value })),
        ],
      })
      .finish(),
  ]);
  try {
    const parser = (client as unknown as { parser: McsParser }).parser;
    parser.handleData(frame.subarray(0, 6));
    parser.handleData(frame.subarray(6));
    return normalizePushEvent(raw);
  } finally {
    client.close();
  }
}

function fixture() {
  vi.useFakeTimers();
  const devices = [
    { sn: TARGET, stationSn: STATION, model: "T8425", deviceClass: "camera" },
    { sn: OTHER, stationSn: STATION, model: "T8124", deviceClass: "camera" },
    { sn: STATION, model: "T9000", deviceClass: "homebase" },
  ] as EufyDevice[];
  const registry = {
    list: () => devices,
    conflicts: () => [] as string[],
    capabilitiesForDevice: (sn: string) => new Set<Capability>(sn === OTHER ? ["battery"] : []),
    serialForFrame: (_station: string, channel: number) => (channel === 1 ? TARGET : channel === 2 ? OTHER : undefined),
  };
  const event = vi.fn();
  const ingress = new CameraHealthIngress("synthetic-account", registry, event);
  const payload = () => ({
    device_sn: TARGET,
    station_sn: STATION,
    channel: 1,
    event_time: Math.floor(Date.now() / 1000),
  });
  return { ingress, registry, devices, event, payload };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("suppressed signal diagnostics", () => {
  it.each([
    [" -100.0 ", "sentinel_-100", -100],
    ["malformed-private-text", "non_numeric", null],
    ["", "non_numeric", null],
    ["-1e2", "non_numeric", null],
    ["9".repeat(400), "out_of_range", null],
  ] as const)("classifies %s without retaining payload text", (raw, reason, value) => {
    const f = fixture();
    f.ingress.params(TARGET, { 1142: raw }, "hub_report");
    expect(f.ingress.rssiSuppression(TARGET)).toEqual({
      reason,
      source: "hub_report",
      receivedAtMs: Date.now(),
      value,
    });
    expect(f.ingress.status(TARGET)?.rssi).toEqual({ value: null, valid: false, lastValidMs: null });
    f.ingress.store.close();
  });

  it("keeps only the last suppression, its own source and receipt time, across valid and absent reports", () => {
    const f = fixture();
    expect(f.ingress.rssiSuppression(TARGET)).toBeNull();
    f.ingress.params(TARGET, { 1142: "-100" }, "hub_report");
    const first = f.ingress.rssiSuppression(TARGET)!;
    vi.advanceTimersByTime(10);
    f.ingress.params(TARGET, { 1142: "-60" }, "cloud_params");
    const health = f.ingress.status(TARGET)!;
    f.ingress.params(TARGET, {}, "hub_report");
    expect(f.ingress.rssiSuppression(TARGET)).toEqual(first);
    f.ingress.params(TARGET, { 1142: "private-text" }, "cloud_params");
    expect(f.ingress.rssiSuppression(TARGET)).toEqual({
      reason: "non_numeric",
      source: "cloud_params",
      receivedAtMs: Date.now(),
      value: null,
    });
    expect(f.ingress.status(TARGET)?.rssi.lastValidMs).toBe(health.rssi.lastValidMs);
    f.ingress.recordRssiSuppression(TARGET, { 1142: "-100" }, "realtime_overlay");
    expect(f.ingress.rssiSuppression(TARGET)?.source).toBe("realtime_overlay");
    const copy = f.ingress.rssiSuppression(TARGET)!;
    copy.source = "cloud_params";
    expect(f.ingress.rssiSuppression(TARGET)?.source).toBe("realtime_overlay");
    expect(f.ingress.rssiSuppression(OTHER)).toBeNull();
    f.ingress.roster([]);
    expect(f.ingress.rssiSuppression(TARGET)).toBeNull();
    f.ingress.store.close();
  });

  it("leaves finite fractional and unconventional signal values unsuppressed", () => {
    const f = fixture();
    for (const raw of ["-60.5", "17", "-101", "0"])
      f.ingress.recordRssiSuppression(TARGET, { 1142: raw }, "realtime_overlay");
    expect(f.ingress.rssiSuppression(TARGET)).toBeNull();
    expect(f.event).not.toHaveBeenCalled();
    f.ingress.store.close();
  });

  it("bounds retention and ignores unknown, non-camera and conflicting identities", () => {
    const f = fixture();
    const camera = f.devices[0]!;
    f.devices.splice(
      0,
      f.devices.length,
      ...Array.from({ length: 1030 }, (_, index) => ({ ...camera, sn: `camera-${index}` })),
    );
    for (const device of f.devices) f.ingress.recordRssiSuppression(device.sn, { 1142: "-100" }, "hub_report");
    expect(f.ingress.rssiSuppression("camera-0")).toBeNull();
    expect(f.ingress.rssiSuppression("camera-5")).toBeNull();
    expect(f.ingress.rssiSuppression("camera-6")?.reason).toBe("sentinel_-100");
    expect(f.ingress.rssiSuppression("camera-1029")?.reason).toBe("sentinel_-100");
    f.ingress.recordRssiSuppression("missing", { 1142: "-100" }, "hub_report");
    expect(f.ingress.rssiSuppression("missing")).toBeNull();
    f.registry.conflicts = () => ["camera-6"];
    f.ingress.roster(f.devices);
    expect(f.ingress.rssiSuppression("camera-6")).toBeNull();
    f.ingress.store.close();
  });
});

describe("HomeBase camera status ingress", () => {
  it("holds hub-online without a timer until a different report or parent loss", () => {
    const f = fixture();
    vi.setSystemTime(PUSH_TIME);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - PUSH_TIME);
    f.ingress.parent(STATION, "connected");
    f.ingress.params(TARGET, { 1131: "1" }, "hub_report");
    expect(f.ingress.store.diagnostics().timers).toBe(0);
    vi.advanceTimersByTime(CAMERA_CONTACT_TTL_MS - 1);
    expect(f.event.mock.calls.at(-1)?.[0].connectivity).toBe("online");
    vi.advanceTimersByTime(1);
    expect(f.event.mock.calls.at(-1)?.[0]).toMatchObject({ connectivity: "online", basis: "vendor_status" });
    expect(f.ingress.store.diagnostics().timers).toBe(0);
    f.ingress.store.close();
  });

  it("labels an 1182-only update with its batch source without reusing retained 1131 for assessment", () => {
    const f = fixture();
    f.ingress.parent(STATION, "connected");
    f.ingress.params(TARGET, { 1131: "0" }, "hub_report");
    vi.advanceTimersByTime(1);
    f.ingress.params(TARGET, { 1182: "1" }, "cloud_params");
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "offline",
      rawStatus: { p1131: 0, p1182: 1, source: "cloud_params" },
    });
    f.ingress.store.close();
  });

  it.each(["T8425", "T8426", "T8416", "T8214", "T8134", "T8170", "T8171"])(
    "assesses %s numeric and boolean reports and keeps cloud status raw-only",
    (model) => {
      const f = fixture();
      f.devices[0]!.model = model;
      f.ingress.parent(STATION, "connected");
      for (const [raw, connectivity] of [
        ["1", "online"],
        ["0", "offline"],
        ["true", "online"],
        ["false", "offline"],
      ]) {
        vi.advanceTimersByTime(1);
        f.ingress.params(TARGET, { 1131: raw! }, "hub_report");
        expect(f.ingress.status(TARGET)).toMatchObject({
          connectivity,
          basis: "vendor_status",
          evidence: "hub_reported",
          lastContactMs: null,
        });
      }
      vi.advanceTimersByTime(1);
      f.ingress.params(TARGET, { 1131: "1" }, "cloud_params");
      expect(f.ingress.status(TARGET)).toMatchObject({
        connectivity: "offline",
        rawStatus: { p1131: 1, source: "cloud_params" },
      });
      vi.advanceTimersByTime(1);
      f.ingress.params(TARGET, { 1131: "2", 1182: "1" }, "hub_report");
      expect(f.ingress.status(TARGET)).toMatchObject({
        connectivity: "unknown",
        rawStatus: { p1131: 2, p1182: 1, source: "hub_report" },
      });
      f.ingress.store.close();
    },
  );

  it.each(["T8423", "T8419", "T9999", "T8124", "unknown"])("keeps model %s raw-only", (model) => {
    const f = fixture();
    f.devices[0]!.model = model;
    f.registry.capabilitiesForDevice = () => new Set<Capability>(["battery"]);
    f.ingress.parent(STATION, "connected");
    for (const raw of ["1", "0", "true", "false"]) {
      vi.advanceTimersByTime(1);
      f.ingress.params(TARGET, { 1131: raw }, "hub_report");
      expect(f.ingress.status(TARGET)?.connectivity).toBe("unknown");
    }
    f.ingress.store.close();
  });

  it.each(["no parent", "self parent", "non-HomeBase parent", "missing parent"])(
    "requires HomeBase attachment: %s",
    (kind) => {
      const f = fixture();
      if (kind === "no parent") delete f.devices[0]!.stationSn;
      if (kind === "self parent") f.devices[0]!.stationSn = TARGET;
      if (kind === "non-HomeBase parent") f.devices[2]!.deviceClass = "camera";
      if (kind === "missing parent") f.devices.pop();
      f.ingress.parent(f.devices[0]!.stationSn || TARGET, "connected");
      f.ingress.params(TARGET, { 1131: "0" }, "hub_report");
      expect(f.ingress.status(TARGET)?.connectivity).toBe("unknown");
      f.ingress.store.close();
    },
  );

  it("retires an assessment when the parent disappears from the roster", () => {
    const f = fixture();
    f.ingress.parent(STATION, "connected");
    f.ingress.params(TARGET, { 1131: "0" }, "hub_report");
    expect(f.ingress.status(TARGET)?.connectivity).toBe("offline");
    f.devices.pop();
    f.ingress.roster(f.devices);
    expect(f.ingress.status(TARGET)?.connectivity).toBe("unknown");
    f.ingress.store.close();
  });

  it("reassesses only on a new report after a parent blip and deduplicates identical receipt batches", () => {
    const f = fixture();
    f.ingress.parent(STATION, "connected");
    f.ingress.params(TARGET, { 1131: "1" }, "hub_report");
    const first = f.ingress.status(TARGET)!;
    const count = f.event.mock.calls.length;
    f.ingress.params(TARGET, { 1131: "1" }, "hub_report");
    expect(f.ingress.status(TARGET)).toEqual(first);
    expect(f.event.mock.calls.length).toBe(count);
    vi.advanceTimersByTime(1);
    f.ingress.parent(STATION, "disconnected");
    vi.advanceTimersByTime(1);
    f.ingress.params(TARGET, { 1131: "0" }, "hub_report");
    expect(f.ingress.status(TARGET)).toMatchObject({ connectivity: "unknown", basis: "parent_unassessable" });
    vi.advanceTimersByTime(1);
    f.ingress.parent(STATION, "connected");
    expect(f.ingress.status(TARGET)?.connectivity).toBe("unknown");
    vi.advanceTimersByTime(1);
    f.ingress.params(TARGET, { 1131: "0" }, "hub_report");
    expect(f.ingress.status(TARGET)?.connectivity).toBe("offline");
    f.ingress.store.close();
  });

  it("replays the power-cut timeline among 14 stable siblings without treating retained data as child contact", () => {
    const f = fixture();
    vi.setSystemTime(PUSH_TIME);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - PUSH_TIME);
    for (let i = 0; i < 13; i++)
      f.devices.push({
        sn: `synthetic-sibling-${i}`,
        stationSn: STATION,
        model: "T8425",
        deviceClass: "camera",
      } as EufyDevice);
    f.ingress.parent(STATION, "connected");
    const sweep = (targetStatus: string) => {
      for (const child of f.devices.filter((item) => item.deviceClass === "camera")) {
        const value = child.sn === TARGET ? targetStatus : child.sn === OTHER ? "2" : "1";
        f.ingress.params(child.sn, { 1131: value, 1182: "0", 1142: "-46" }, "hub_report");
      }
    };
    sweep("1");
    for (let elapsed = 30_000; elapsed <= 240_000; elapsed += 30_000) {
      vi.advanceTimersByTime(30_000);
      sweep("1");
    }
    vi.advanceTimersByTime(7_000);
    sweep("0");
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "offline",
      lastContactMs: null,
      lastHubReportMs: PUSH_TIME + 247_000,
    });
    for (let elapsed = 277_000; elapsed <= 607_000; elapsed += 30_000) {
      vi.advanceTimersByTime(30_000);
      sweep("0");
      f.ingress.params(TARGET, { 1131: "1", 1182: "0", 1142: "-46" }, "cloud_params");
      expect(f.ingress.status(TARGET)?.connectivity).toBe("offline");
    }
    vi.advanceTimersByTime(6_000);
    expect(Date.now() - PUSH_TIME).toBe(613_000);
    expect(f.ingress.status(TARGET)?.connectivity).toBe("offline");
    vi.advanceTimersByTime(23_000);
    sweep("1");
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "online",
      basis: "vendor_status",
      evidence: "hub_reported",
      lastContactMs: null,
    });
    for (const child of f.devices.filter((item) => item.sn.startsWith("synthetic-sibling-")))
      expect(f.ingress.status(child.sn)?.connectivity).toBe("online");
    expect(f.ingress.status(OTHER)).toMatchObject({ connectivity: "unknown", rawStatus: { p1131: 2 } });
    expect(f.ingress.store.diagnostics().entries).toBe(15);
    f.ingress.store.close();
  });
});

describe("camera evidence source qualification", () => {
  it.each(["roundtrip", "conflict"])("retires observer ownership on every %s roster installation", (kind) => {
    const f = fixture();
    const old = f.ingress.command(TARGET)!;
    old.sent();
    if (kind === "roundtrip") f.devices[0]!.stationSn = "synthetic-next-parent";
    else f.registry.conflicts = () => [TARGET];
    f.ingress.roster(f.devices);
    f.devices[0]!.stationSn = STATION;
    f.registry.conflicts = () => [];
    f.ingress.roster(f.devices);
    const receipt = { status: "rejected", sendAttempted: true, effect: "unconfirmed", rejectionCode: -109 } as const;
    old.response(receipt);
    old.finish(receipt);
    expect(f.ingress.status(TARGET)).toMatchObject({ hubOfflineCount: 0, lastOutcome: null });
  });

  it("keeps thin battery and unknown models unqualified until real mains evidence exists", () => {
    const f = fixture();
    f.registry.capabilitiesForDevice = () => new Set<Capability>();
    f.ingress.media(OTHER);
    expect(f.ingress.status(OTHER)).toMatchObject({ connectivity: "unknown", lastContactSource: "media" });
    f.registry.capabilitiesForDevice = () => new Set<Capability>(["battery"]);
    vi.advanceTimersByTime(1);
    f.ingress.media(OTHER);
    expect(f.ingress.status(OTHER)?.connectivity).toBe("unknown");
    f.ingress.media(TARGET);
    expect(f.ingress.status(TARGET)?.connectivity).toBe("unknown");
    f.ingress.store.close();
  });

  it("invalidates old command and media observers on removal, channel/model or parent change", () => {
    const f = fixture();
    const old = f.ingress.command(TARGET)!;
    const media = f.ingress.live(TARGET)!;
    old.sent();
    f.ingress.roster([]);
    f.devices[0]!.stationSn = "synthetic-next-parent";
    f.ingress.status(TARGET);
    old.response({ status: "rejected", sendAttempted: true, effect: "unconfirmed", rejectionCode: -109 });
    old.finish({ status: "rejected", sendAttempted: true, effect: "unconfirmed", rejectionCode: -109 });
    media();
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "unknown",
      hubOfflineCount: 0,
      lastOutcome: null,
      lastContactMs: null,
    });
    const next = f.ingress.command(TARGET)!;
    f.devices[0]!.model = "T8124";
    next.response({ status: "rejected", sendAttempted: true, effect: "unconfirmed", rejectionCode: -109 });
    expect(f.ingress.status(TARGET)?.hubOfflineCount).toBe(0);
    f.ingress.store.close();
  });

  it("records a correlated response and a finalized receipt only once per observer", () => {
    const f = fixture();
    const observer = f.ingress.command(TARGET)!;
    const receipt = { status: "rejected", sendAttempted: true, effect: "unconfirmed", rejectionCode: -109 } as const;
    observer.sent();
    observer.response(receipt);
    observer.response(receipt);
    observer.finish(receipt);
    observer.finish(receipt);
    expect(f.ingress.status(TARGET)).toMatchObject({ hubOfflineCount: 1, outcomes: { unknown: { rejected: 1 } } });
  });

  it("records fresh explicit child detection and preserves battery contact as historical", () => {
    const f = fixture();
    f.ingress.push(TARGET, STATION, f.payload(), 3101);
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "unknown",
      basis: "startup",
      lastContactSource: "push",
    });
    f.ingress.push(OTHER, STATION, { ...f.payload(), device_sn: OTHER, channel: 2 }, 3101);
    expect(f.ingress.status(OTHER)).toMatchObject({ connectivity: "unknown", lastContactSource: "push" });
    expect(f.ingress.status(STATION)).toBeUndefined();
  });

  it.each([
    { device_sn: OTHER },
    { device_sn: undefined },
    { deviceSn: OTHER },
    { station_sn: "synthetic-other-parent" },
    { stationSn: "synthetic-other-parent" },
    { channel: 2 },
    { c: 2 },
    { channel: "1" },
    { event_time: undefined },
    { event_time: "bad" },
    { event_time: 1 },
    { trigger_time: 1 },
    { event_time: Number.MAX_SAFE_INTEGER },
  ])("rejects ambiguous, stale, malformed or future detection provenance %s", (change) => {
    const f = fixture();
    f.ingress.push(TARGET, STATION, { ...f.payload(), ...change }, 3101);
    expect(f.ingress.status(TARGET)?.lastContactMs).toBeNull();
    f.ingress.store.close();
  });

  it("rejects parent-only, non-detection and conflicting cloud envelope claims", () => {
    const f = fixture();
    f.ingress.push(STATION, STATION, { ...f.payload(), device_sn: STATION }, 3101);
    f.ingress.push(TARGET, STATION, f.payload(), 4);
    f.ingress.cloudPush({
      deviceSn: TARGET,
      stationSn: STATION,
      eventType: 3101,
      payload: f.payload(),
      raw: { payload: { device_sn: OTHER } },
    } as PushEvent);
    expect(f.ingress.status(TARGET)?.lastContactMs).toBeNull();
    f.registry.conflicts = () => [TARGET];
    f.ingress.media(TARGET);
    expect(f.ingress.status(TARGET)).toBeUndefined();
  });

  it("records receipt times and original status numbers/booleans without deriving contact", () => {
    const f = fixture();
    f.ingress.params(TARGET, { 1131: "5", 1182: "false", 1142: "-71" }, "hub_report");
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "unknown",
      lastContactMs: null,
      lastHubReportMs: Date.now(),
      rawStatus: { p1131: 5, p1182: false, observedMs: Date.now() },
      rssi: { value: -71, valid: true, lastValidMs: Date.now() },
    });
    vi.advanceTimersByTime(1);
    f.ingress.params(TARGET, { 1131: "true", 1182: "0", 1142: "-100" }, "cloud_params");
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "unknown",
      lastContactMs: null,
      lastCloudParamMs: Date.now(),
      rawStatus: { p1131: true, p1182: 0 },
      rssi: { value: null, valid: false, lastValidMs: Date.now() - 1 },
    });
  });

  it.each(["", "true", "null", " ", "0x10", "-71.5", "Infinity", "{}"])("marks malformed RSSI %s invalid", (value) => {
    const f = fixture();
    f.ingress.params(TARGET, { 1142: value }, "hub_report");
    expect(f.ingress.status(TARGET)?.rssi).toEqual({ value: null, valid: false, lastValidMs: null });
  });

  it("retires removed-camera state and outcomes instead of leaking it into a new registration", () => {
    const f = fixture();
    f.ingress.media(TARGET);
    const previous = f.ingress.status(TARGET)!;
    f.ingress.roster([]);
    expect(f.ingress.store.diagnostics()).toMatchObject({ entries: 0, timers: 0 });
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "unknown",
      lastContactMs: null,
      incarnation: previous.incarnation,
    });
    expect(f.ingress.status(TARGET)!.revision).toBeGreaterThan(previous.revision);
    f.ingress.store.close();
  });
});

describe("parsed cloud detection health evidence", () => {
  it.each([
    ["split millisecond envelope", PUSH_BODY, { event_time: String(PUSH_TIME), push_time: String(PUSH_TIME + 2000) }],
    ["split seconds envelope", PUSH_BODY, { event_time: String(PUSH_TIME / 1000) }],
    ["body-only event", { ...PUSH_BODY, event_time: PUSH_TIME }, {}],
    ["body-only source clocks", { ...PUSH_BODY, session_id: "synthetic-event" }, {}],
    ["split source clocks", PUSH_BODY, { station_sn: STATION }],
    ["packed object body", { event_time: String(PUSH_TIME), payload: PUSH_BODY }, {}],
    ["packed JSON-string body", { event_time: String(PUSH_TIME), payload: JSON.stringify(PUSH_BODY) }, {}],
    [
      "explicit envelope-only child",
      { device_sn: TARGET, event_time: String(PUSH_TIME), payload: { ...PUSH_BODY, device_sn: undefined } },
      {},
    ],
    [
      "split envelope-only child",
      { ...PUSH_BODY, device_sn: undefined },
      { device_sn: TARGET, event_time: String(PUSH_TIME) },
    ],
    [
      "matching envelope and body claims",
      { device_sn: TARGET, station_sn: STATION, event_time: String(PUSH_TIME), payload: PUSH_BODY },
      {},
    ],
    ["mixed source seconds and milliseconds", { ...PUSH_BODY, create_time: (PUSH_TIME - 7000) / 1000 }, {}],
    ["short detection fields", { ...PUSH_BODY, event_type: undefined, a: 3102, s: STATION, c: 1 }, {}],
  ] as const)("accepts fresh exact-child %s with the oldest producer time", (_name, payload, siblings) => {
    const f = fixture();
    vi.setSystemTime(PUSH_TIME + 10_000);
    const event = parsedDetection(payload, siblings);
    f.ingress.cloudPush(event);
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "unknown",
      basis: "startup",
      lastContactSource: "push",
      lastContactMs: PUSH_TIME - 7000,
      enforcement: "observe_only",
      commandsBlocked: false,
    });
    expect(f.ingress.status(OTHER)?.lastContactMs).toBeNull();
    f.ingress.store.close();
  });

  it("accepts an explicit envelope child and clock without body identity or clocks", () => {
    const f = fixture();
    vi.setSystemTime(PUSH_TIME);
    f.ingress.cloudPush(parsedDetection({ event_type: 3102 }, { device_sn: TARGET, event_time: String(PUSH_TIME) }));
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "unknown",
      lastContactMs: PUSH_TIME,
      lastContactSource: "push",
    });
    f.ingress.store.close();
  });

  it.each(["envelope", "event_time", "create_time", "trigger_time"] as const)(
    "uses %s when it is the oldest fresh clock and expires from that clock",
    (oldest) => {
      const f = fixture();
      vi.setSystemTime(PUSH_TIME);
      vi.spyOn(performance, "now").mockImplementation(() => Date.now() - PUSH_TIME);
      const body = { ...PUSH_BODY, event_time: PUSH_TIME, create_time: PUSH_TIME, trigger_time: PUSH_TIME };
      const envelope = { event_time: String(PUSH_TIME) };
      if (oldest === "envelope") envelope.event_time = String(PUSH_TIME - 7000);
      else body[oldest] = PUSH_TIME - 7000;
      f.ingress.cloudPush(parsedDetection(body, envelope));
      expect(f.ingress.status(TARGET)?.lastContactMs).toBe(PUSH_TIME - 7000);
      vi.advanceTimersByTime(CAMERA_CONTACT_TTL_MS - 7001);
      expect(f.ingress.status(TARGET)?.connectivity).toBe("unknown");
      vi.advanceTimersByTime(1);
      expect(f.ingress.status(TARGET)).toMatchObject({ connectivity: "unknown", basis: "startup" });
      f.ingress.store.close();
    },
  );

  it.each(["envelope", "event_time", "create_time", "trigger_time"] as const)(
    "rejects every supplied stale, future or malformed %s clock beside fresh clocks",
    (clock) => {
      const f = fixture();
      vi.setSystemTime(PUSH_TIME);
      for (const invalid of [
        PUSH_TIME - CAMERA_CONTACT_TTL_MS,
        PUSH_TIME - CAMERA_CONTACT_TTL_MS - 1,
        PUSH_TIME + 1,
        null,
        NaN,
        Infinity,
        -Infinity,
        "invalid",
        "",
        0,
        -1,
        Number.MAX_SAFE_INTEGER,
        PUSH_TIME + 0.5,
      ]) {
        const body: Record<string, unknown> = { ...PUSH_BODY, event_time: PUSH_TIME };
        const envelope: Record<string, unknown> = { event_time: String(PUSH_TIME), payload: body };
        if (clock === "envelope") envelope.event_time = invalid;
        else body[clock] = invalid;
        f.ingress.cloudPush(normalizePushEvent({ payload: envelope }));
        expect(f.ingress.status(TARGET)?.lastContactMs, `${clock}: ${invalid}`).toBeNull();
      }
      f.ingress.store.close();
    },
  );

  it.each([
    [
      "stale body beside fresh envelope",
      { ...PUSH_BODY, trigger_time: PUSH_TIME - CAMERA_CONTACT_TTL_MS },
      String(PUSH_TIME),
    ],
    ["stale envelope beside fresh body", PUSH_BODY, String(PUSH_TIME - CAMERA_CONTACT_TTL_MS)],
    ["future body beside fresh envelope", { ...PUSH_BODY, event_time: PUSH_TIME + 1 }, String(PUSH_TIME)],
    ["future envelope beside fresh body", PUSH_BODY, String(PUSH_TIME + 1)],
    ["malformed envelope beside fresh body", PUSH_BODY, "invalid"],
  ] as const)("rejects parsed %s", (_name, body, event_time) => {
    const f = fixture();
    vi.setSystemTime(PUSH_TIME);
    f.ingress.cloudPush(parsedDetection(body, { event_time }));
    expect(f.ingress.status(TARGET)?.lastContactMs).toBeNull();
    f.ingress.store.close();
  });

  it.each([
    ["conflicting envelope camera", PUSH_BODY, { device_sn: OTHER }],
    ["conflicting body camera alias", { ...PUSH_BODY, deviceSn: OTHER }, {}],
    ["conflicting envelope parent", PUSH_BODY, { station_sn: "synthetic-other-parent" }],
    ["conflicting short parent", { ...PUSH_BODY, s: "synthetic-other-parent" }, {}],
    ["conflicting child channel", { ...PUSH_BODY, channel: 2 }, {}],
    ["conflicting short child channel", { ...PUSH_BODY, c: 2 }, {}],
    ["station-only identity", { ...PUSH_BODY, device_sn: undefined, s: STATION }, {}],
    ["short station field naming a child", { ...PUSH_BODY, device_sn: undefined, s: TARGET }, {}],
    ["missing explicit identity", { ...PUSH_BODY, device_sn: undefined }, {}],
    ["malformed explicit body identity", { ...PUSH_BODY, device_sn: null }, { device_sn: TARGET }],
    ["malformed explicit envelope identity", PUSH_BODY, { device_sn: "" }],
    ["parent identity", { ...PUSH_BODY, device_sn: STATION }, {}],
    ["non-detection", { ...PUSH_BODY, event_type: 4 }, {}],
  ] as const)("rejects parsed %s", (_name, body, envelope) => {
    const f = fixture();
    vi.setSystemTime(PUSH_TIME);
    f.ingress.cloudPush(parsedDetection(body, { event_time: String(PUSH_TIME), ...envelope }));
    expect(f.ingress.status(TARGET)?.lastContactMs).toBeNull();
    expect(f.ingress.status(OTHER)?.lastContactMs).toBeNull();
    f.ingress.store.close();
  });

  it("does not use delivery clocks as producer evidence", () => {
    const f = fixture();
    vi.setSystemTime(PUSH_TIME);
    f.ingress.cloudPush(
      parsedDetection(
        { ...PUSH_BODY, create_time: undefined, trigger_time: undefined, push_time: PUSH_TIME, sent: PUSH_TIME },
        { push_time: String(PUSH_TIME) },
      ),
    );
    expect(f.ingress.status(TARGET)?.lastContactMs).toBeNull();
    f.ingress.store.close();
  });

  it("rejects replayed producer evidence despite a newer envelope clock", () => {
    const f = fixture();
    vi.setSystemTime(PUSH_TIME);
    const event = parsedDetection(PUSH_BODY, { event_time: String(PUSH_TIME) });
    f.ingress.cloudPush(event);
    const accepted = f.ingress.status(TARGET)!;
    vi.advanceTimersByTime(1000);
    f.ingress.cloudPush(event);
    f.ingress.cloudPush(parsedDetection(PUSH_BODY, { event_time: String(Date.now()) }));
    expect(f.ingress.status(TARGET)).toEqual(accepted);
    f.ingress.cloudPush(parsedDetection({ ...PUSH_BODY, trigger_time: PUSH_TIME - 8000 }));
    expect(f.ingress.status(TARGET)).toEqual(accepted);
    f.ingress.store.close();
  });
});

describe("qualified camera hold", () => {
  it.each(
    ["T8425", "T8426", "T8416", "T8214", "T8134", "T8170", "T8171"].flatMap((model) =>
      [false, true].map((battery) => ({ model, battery })),
    ),
  )("holds $model with battery=$battery", ({ model, battery }) => {
    const f = fixture();
    vi.setSystemTime(PUSH_TIME);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - PUSH_TIME);
    f.devices[0]!.model = model;
    f.registry.capabilitiesForDevice = () => new Set<Capability>(battery ? ["battery"] : []);
    f.ingress.parent(STATION, "connected");
    for (const value of [1, 0]) {
      vi.advanceTimersByTime(1);
      f.ingress.params(TARGET, { 1131: String(value) }, "hub_report");
      vi.advanceTimersByTime(86_400_000);
      f.ingress.media(TARGET);
      expect(f.ingress.status(TARGET)?.connectivity).toBe(value ? "online" : "offline");
      expect(f.ingress.store.diagnostics().timers).toBe(0);
    }
    vi.advanceTimersByTime(1);
    f.ingress.parent(STATION, "unknown");
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "unknown",
      basis: "parent_unassessable",
      commandsBlocked: false,
    });
    f.ingress.store.close();
  });
});

describe("additional topology scope cases", () => {
  it("does not qualify non-T9000 HomeBase p1131", () => {
    const f = fixture();
    f.devices[0]!.model = "T8170";
    f.devices[2]!.model = "T8030";
    f.ingress.parent(STATION, "connected");
    vi.advanceTimersByTime(1);
    f.ingress.params(TARGET, { 1131: "0" }, "hub_report");
    expect(f.ingress.status(TARGET)?.connectivity).toBe("unknown");
    f.ingress.store.close();
  });
  it("invalidates held status if the parent registry model ceases to be qualified", () => {
    const f = fixture();
    f.ingress.parent(STATION, "connected");
    vi.advanceTimersByTime(1);
    f.ingress.params(TARGET, { 1131: "1" }, "hub_report");
    f.devices[2]!.model = "T8030";
    f.ingress.roster(f.devices);
    expect(f.ingress.status(TARGET)?.connectivity).toBe("unknown");
    f.ingress.store.close();
  });
});

describe("parent binding ownership", () => {
  it("retires held status and captured observers on parent model change", () => {
    const f = fixture();
    f.ingress.parent(STATION, "connected");
    f.ingress.params(TARGET, { 1131: "0" }, "hub_report");
    const oldRevision = f.ingress.status(TARGET)!.revision;
    const command = f.ingress.command(TARGET)!;
    const media = f.ingress.live(TARGET)!;
    f.devices[2]!.model = "T8030";
    f.ingress.roster(f.devices);
    expect(f.ingress.status(TARGET)!.revision).toBeGreaterThan(oldRevision);
    vi.advanceTimersByTime(1);
    media();
    command.finish({ status: "acknowledged", sendAttempted: true, effect: "unconfirmed" });
    expect(f.ingress.status(TARGET)).toMatchObject({
      connectivity: "unknown",
      lastContactMs: null,
      lastOutcome: null,
      enforcement: "observe_only",
    });
    f.ingress.params(TARGET, { 1131: "0" }, "hub_report");
    expect(f.ingress.status(TARGET)?.connectivity).toBe("unknown");
    f.ingress.store.close();
  });
});
