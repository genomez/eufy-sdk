import { afterEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../core/types.js";
import type { RtcCommandRouter, InformationRefreshResult } from "../../transport/rtc/command-router.js";
import type { DeviceRegistry } from "../device-registry.js";
import { EufyMega } from "../eufy-mega.js";
import { scope, cameras, station } from "../../transport/rtc/__tests__/recordings-fixture.js";

const clients: EufyMega[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  vi.restoreAllMocks();
});
const receipt = 1_800_000_000_000;
function fixture() {
  const client = new EufyMega({
    email: "synthetic@example.invalid",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  clients.push(client);
  const internals = client as unknown as {
    registry: Pick<DeviceRegistry, "list" | "applyRealtimeParams"> & { devices: EufyDevice[] };
    rtc: RtcCommandRouter;
    realtimeEpoch: number;
  };
  internals.registry.devices = [
    { sn: station, model: "T9000", lastSeenMs: 1000, params: {}, raw: {} },
    ...cameras.map((sn, channel) => ({
      sn,
      stationSn: station,
      model: "T8425",
      lastSeenMs: 1000,
      params: { 1400: "0" },
      raw: { device_channel: channel },
    })),
  ] as EufyDevice[];
  const current = vi.spyOn(internals.rtc, "informationResultCurrent").mockReturnValue(true);
  const read = vi.spyOn(internals.rtc, "refreshInformation");
  const result = (params: unknown[]): InformationRefreshResult => ({
    frame: { commandId: 1103, channel: 255, segment: 1, isResponse: 0, linkType: 3, data: { params } },
    notificationCorrelation: "temporal-only",
    currentAtArrival: true,
    sessionGeneration: 1,
    informationReceivedAtMs: receipt,
  });
  return { client, internals, current, read, result };
}
const entry = (channel: number, extra: Record<string, unknown> = {}) => ({
  channel,
  param_type: 1400,
  param_value: "0",
  ...extra,
});

describe("successful scoped information receipt", () => {
  it("stamps unchanged represented camera params only, without applying properties or health again", async () => {
    const f = fixture();
    f.read.mockResolvedValue(f.result([entry(0)]));
    const apply = vi.spyOn(f.internals.registry, "applyRealtimeParams");
    const states = vi.fn();
    const properties = vi.fn();
    const motion = vi.fn();
    f.client.on("deviceState", states);
    f.client.on("propertyChanged", properties);
    f.client.on("motion", motion);
    const health = f.client.cameraHealth(cameras[0]!);
    expect(await f.client.refreshDeviceState(station)).toMatchObject({ devicesUpdated: 1, parametersUpdated: 1 });
    expect(f.client.deviceState(cameras[0]!).lastSeenMs).toBe(receipt);
    expect(f.client.deviceState(station).lastSeenMs).toBe(1000);
    expect(f.client.deviceState(cameras[1]!).lastSeenMs).toBe(1000);
    expect(states).toHaveBeenCalledTimes(1);
    expect(properties).not.toHaveBeenCalled();
    expect(motion).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(f.client.cameraHealth(cameras[0]!)).toEqual(health);
    await f.client.refreshDeviceState(station);
    expect(states).toHaveBeenCalledTimes(1);
  });
  it("station-only result does not manufacture sibling contact", async () => {
    const f = fixture();
    f.read.mockResolvedValue(f.result([entry(255)]));
    await f.client.refreshDeviceState(station);
    expect(f.client.deviceState(station).lastSeenMs).toBe(receipt);
    for (const sn of cameras) expect(f.client.deviceState(sn).lastSeenMs).toBe(1000);
  });
  it.each([
    { params: [] },
    { params: [entry(0, { device_sn: cameras[1] })] },
    { params: [entry(77)] },
    { params: [entry(0, { param_value: null })] },
  ])("does not stamp unqualified or empty parameter maps", async ({ params }) => {
    const f = fixture();
    f.read.mockResolvedValue(f.result(params as unknown[]));
    expect(await f.client.refreshDeviceState(station)).toMatchObject({ devicesUpdated: 0, parametersUpdated: 0 });
    expect(f.internals.registry.list().every((d) => d.lastSeenMs === 1000)).toBe(true);
  });
  it.each(["ACK-only", "timeout", "failed send"])("does not stamp %s failure", async (kind) => {
    const f = fixture();
    f.read.mockRejectedValue(new Error(kind));
    await expect(f.client.refreshDeviceState(station)).rejects.toThrow(kind);
    expect(f.internals.registry.list().every((d) => d.lastSeenMs === 1000)).toBe(true);
  });
  it.each(["aborted", "epoch", "owner"])("rejects completed results after %s change", async (kind) => {
    const f = fixture();
    const abort = new AbortController();
    f.read.mockImplementation(async () => {
      if (kind === "aborted") abort.abort();
      if (kind === "epoch") f.internals.realtimeEpoch++;
      if (kind === "owner") f.current.mockReturnValue(false);
      return f.result([entry(0)]);
    });
    await expect(f.client.refreshDeviceState(station, { signal: abort.signal })).rejects.toThrow("interrupted");
    expect(f.internals.registry.list().every((d) => d.lastSeenMs === 1000)).toBe(true);
  });
  it("does not regress a newer passive receipt or announce the same receipt twice", async () => {
    const f = fixture();
    f.internals.registry.applyRealtimeParams(cameras[0]!, { 1400: "0" }, receipt);
    const states = vi.fn();
    f.client.on("deviceState", states);
    f.read.mockResolvedValue(f.result([entry(0)]));
    await f.client.refreshDeviceState(station);
    f.read.mockResolvedValue({ ...f.result([entry(0)]), informationReceivedAtMs: receipt - 1 });
    await f.client.refreshDeviceState(station);
    expect(f.client.deviceState(cameras[0]!).lastSeenMs).toBe(receipt);
    expect(states).not.toHaveBeenCalled();
  });
  it("rejects stale owner metadata using the actual router guard", async () => {
    const f = fixture();
    f.current.mockRestore();
    f.read.mockResolvedValue(f.result([entry(0)]));
    await expect(f.client.refreshDeviceState(station)).rejects.toThrow("interrupted");
    expect(f.client.deviceState(cameras[0]!).lastSeenMs).toBe(1000);
  });
  it.each([station, cameras[0]!])(
    "does not stamp a represented camera under conflicting inventory ownership",
    async (sn) => {
      const f = fixture();
      (f.internals.registry as unknown as { inventoryConflicts: Set<string> }).inventoryConflicts.add(sn);
      f.read.mockResolvedValue(f.result([entry(0)]));
      await f.client.refreshDeviceState(station);
      expect(f.client.deviceState(cameras[0]!).lastSeenMs).toBe(1000);
    },
  );
});

describe("facade cache-only refusals", () => {
  it.each(["realtime_disabled", "inventory_conflict", "recordings_unavailable"])(
    "classifies playback admission as %s without transport activity",
    async (gate) => {
      const f = fixture();
      const opts = Reflect.get(f.client, "opts");
      opts.rtc = { ...opts.rtc, recordings: { enabled: true, stationBinding: station, allowedCameras: cameras } };
      opts.autoRealtime = gate === "realtime_disabled" ? false : true;
      vi.spyOn(f.client, "getRecordingAccountNamespace").mockReturnValue(scope.accountNamespace);
      if (gate === "inventory_conflict")
        (f.internals.registry as unknown as { inventoryConflicts: Set<string> }).inventoryConflicts.add(station);
      const read = vi.spyOn(f.internals.rtc, "readEventPlaybackCandidate");
      await expect(f.client.pullRecordingClip(scope, {} as never, { video: vi.fn() })).rejects.toMatchObject({
        admissionGateName: gate,
        captureOutcome: "not_admitted",
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("sets pacing through the facade without discovery or session acquisition", () => {
    const f = fixture();
    const discovery = vi.spyOn(f.client, "getDevices");
    const set = vi.spyOn(f.internals.rtc, "setRecordingPacing");
    expect(f.client.setRecordingPacing({ coverGapMs: 0, coverQuietMs: 0, coverRatePerMinute: 0 })).toEqual({
      coverGapMs: 0,
      coverQuietMs: 0,
      coverRatePerMinute: 0,
    });
    expect(set).toHaveBeenCalledOnce();
    expect(discovery).not.toHaveBeenCalled();
  });
  it("disabled recording methods do not discover devices, acquire a session or throw private text", async () => {
    const f = fixture();
    const discovery = vi.spyOn(f.client, "getDevices");
    const read = vi.spyOn(f.internals.rtc, "readRecordingCatalog");
    expect(await f.client.readRecordingCatalog(scope)).toEqual({ status: "unavailable", reason: "disabled" });
    expect(await f.client.readRecordingCover(scope, {} as never)).toEqual({
      status: "unavailable",
      reason: "disabled",
    });
    expect(discovery).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(f.client.getRecordingAccountNamespace(new Uint8Array(31))).toBeNull();
  });
  it("the information guard rejects owner/lifecycle changes even if a reply claims arrival was current", () => {
    const f = fixture();
    f.current.mockRestore();
    expect(f.internals.rtc.informationResultCurrent(station, f.result([entry(0)]))).toBe(false);
  });
});
