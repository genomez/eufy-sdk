/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { connectionDeadline } from "../../transport/rtc/connection-deadline.js";
import { markRetiredInformationRead } from "../../transport/rtc/retired-information-read.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { Device } from "../../model/device.js";
import { resolveDevice } from "../../model/registry.js";
import type { ParamChange } from "../device-registry.js";
import { DeviceRegistry } from "../device-registry.js";
import type { CommandContext } from "../../model/types.js";

/**
 * The cloud-param poll loop — the producer behind the capabilities' `source:"poll"` event mappings.
 *
 * Driven through the facade end-to-end, because the decode half is covered separately
 * (`capabilities/__tests__/decode-event.spec.ts` asserts param 1550 → `contactState`, and that 1101 maps
 * to nothing now that the battery level is announced generically) and both halves passing in isolation
 * says nothing about a signal actually reaching a listener. A changed param must come out as an event.
 * Also pins the loop's lifecycle: self-rescheduling, surviving a failed pass, and stopping on disconnect.
 */
function makeClient(opts: Record<string, unknown> = {}) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", ...opts });
  Object.defineProperty((eufy as any).mega, "auth", {
    configurable: true,
    get: () => ({ userId: "u", authToken: "t" }),
  });
  vi.spyOn(eufy as any, "startPush").mockResolvedValue(undefined);
  vi.spyOn(eufy as any, "warmWiredP2P").mockResolvedValue({ required: 0, ready: 0, failed: 0, pending: 0 });
  vi.spyOn(eufy, "getMqttDevices").mockReturnValue([]);
  vi.spyOn(eufy, "getDevices").mockResolvedValue([]);
  vi.spyOn((eufy as any).registry, "list").mockReturnValue([{ sn: "a" }]);
  return eufy;
}

const paramChange = (paramType: number, from: string, to: string): ParamChange => ({
  deviceSn: "T8000P0000000000",
  paramType,
  from,
  to,
  params: { [paramType]: to },
});

/** BATTERY_PARAM.BATTERY changing from a known level. */
const batteryChange = (to: string): ParamChange => paramChange(1101, "88", to);

/**
 * A live entry sensor a caller is holding, resolved from a record that reports the contact param — so
 * the `contact` capability is granted and `contact` is a schema property with a typed getter.
 */
function liveContactSensor(eufy: EufyMega, sn = "T8000P0000000000"): Device {
  const record = { model: "T8900", category: "eufy_security", params: { 1550: "0" }, paramUpdatedAt: {} };
  const dev = Device.fromRecord(sn, record);
  vi.spyOn((eufy as any).registry, "record").mockResolvedValue(record);
  (eufy as any).liveDevices.set(sn, new WeakRef(dev));
  return dev;
}

/**
 * A live battery camera a caller is holding, reporting the three members #95 names as announced by
 * nothing: its enablement (1035), its status LED (1045) and its night-vision mode (1277).
 */
function liveCamera(eufy: EufyMega, sn = "T8000P0000000000"): Device {
  const record = {
    deviceType: 9,
    // A battery camera, because the fixture reports a battery level (1101) and is described as one.
    model: "T8114",
    params: { 1101: "88", 1035: "0", 1045: "1", 1277: "1" },
    paramUpdatedAt: {},
  };
  const dev = Device.fromRecord(sn, record);
  vi.spyOn((eufy as any).registry, "record").mockResolvedValue(record);
  (eufy as any).liveDevices.set(sn, new WeakRef(dev));
  return dev;
}

/** Real registry diffs, with synthetic responses only at the external request boundary. */
async function heldCloudCamera(
  params: Record<number, string> = {},
  model = "T8114",
  category = "eufy_security",
  deviceType: number | undefined = 9,
) {
  const sn = "T8000P0000000000";
  const cloud = {
    params: { 1101: "80", ...params } as Record<number, string>,
    channel: 0,
    model: model as string | undefined,
    category: category as string | undefined,
  };
  const fetchParams = vi.fn(async () => ({}));
  const post = vi.fn(async (_service: string, path: string) =>
    path.endsWith("get_house_list")
      ? { house_infos: [] }
      : {
          devices: [
            {
              device_sn: sn,
              device_model: cloud.model,
              device_type: deviceType,
              device_channel: cloud.channel,
              station_sn: sn,
              category: cloud.category,
              params: Object.entries(cloud.params).map(([id, value]) => ({
                param_type: Number(id),
                param_value: value,
              })),
            },
          ],
        },
  );
  const eufy = new EufyMega({ email: "t@example.com", password: "x", autoRealtime: false });
  const client = eufy as any;
  client.registry = new DeviceRegistry({
    mega: { post, getDeviceParamList: fetchParams } as never,
    onError: (error) => {
      throw error;
    },
  });
  const errors: Error[] = [];
  eufy.on("error", (error) => errors.push(error));
  const context = vi.spyOn(client, "commandContext").mockImplementation(
    async (_sn: unknown, record: any) =>
      ({
        codec: resolveDevice({ model, category, deviceType, params: cloud.params }).codec,
        model,
        category,
        deviceType,
        channel: 0,
        paramIds: new Set([...Object.keys(cloud.params), ...Object.keys(record?.dpParams ?? {})].map(Number)),
      }) satisfies CommandContext,
  );
  const dispatch = vi.fn(async (_command: unknown) => {});
  vi.spyOn(client, "commandSinkFor").mockReturnValue({ dispatch });
  vi.spyOn(client, "mediaProviderFor").mockReturnValue(undefined);
  vi.spyOn(client, "ff09SettingsReaderFor").mockReturnValue(undefined);
  vi.spyOn(client, "awaitFirstRealtimeState").mockResolvedValue(undefined);
  const pollChanges = vi.spyOn(client.registry, "pollChanges");
  await client.registry.pollChanges();
  const dev = await eufy.getDevice(sn);
  const seen: unknown[] = [];
  eufy.on("propertyChanged", (event) => seen.push(event));
  const poll = async (next: Record<number, string>) => {
    cloud.params = next;
    await client.pollOnce();
    expect(errors).toEqual([]);
    return pollChanges.mock.results.at(-1)!.value;
  };
  return { dev, client, seen, poll, context, fetchParams, dispatch, cloud };
}

describe("cached cloud read discovery", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("binds a newly discovered read and setter to the current cached channel", async () => {
    const { dev, cloud, poll, dispatch, fetchParams } = await heldCloudCamera();
    cloud.channel = 2;
    await poll({ 1101: "80", 1045: "1" });
    await dev.camera?.()?.setStatusLed?.(false);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ channel: 2 });
    expect(fetchParams).toHaveBeenCalledOnce();
  });

  it("keeps omitted classification facts consistent between schema and bound reads", async () => {
    const { dev, cloud, poll, fetchParams } = await heldCloudCamera({ 1045: "1" });
    cloud.model = undefined;
    cloud.category = undefined;
    await poll({ 1101: "80" });
    expect(dev.codec).toBe("camera");
    expect(dev.model).toBe("T8114");
    expect(dev.camera?.()?.statusLed).toBe(true);
    expect(fetchParams).toHaveBeenCalledOnce();
  });

  it("retains a clean-line read's category gate across an omitted cloud category", async () => {
    const { dev, cloud, poll, fetchParams } = await heldCloudCamera({ 156: "1" }, "T2351", "eufy_home", undefined);
    expect(dev.vacuumClean?.()?.resumeClean).toBe(true);
    cloud.category = undefined;
    await poll({ 1101: "80", 156: "1" });
    expect(dev.codec).toBe("vacuum");
    expect(dev.vacuumClean?.()?.resumeClean).toBe(true);
    expect(fetchParams).toHaveBeenCalledOnce();
  });

  it("retains the legacy clean category without enabling AIoT controls on omission", async () => {
    const { dev, cloud, poll, fetchParams } = await heldCloudCamera({ 104: "41", 151: "1" }, "T2118", "eufy_home_tuya");
    expect(dev.vacuumClean?.()?.battery).toBe(41);
    expect(dev.vacuumClean?.()).not.toHaveProperty("setPower");
    cloud.category = undefined;
    await poll({ 1101: "80", 104: "41", 151: "1" });
    expect(dev.vacuumClean?.()?.battery).toBe(41);
    expect(dev.vacuumClean?.()).not.toHaveProperty("setPower");
    expect(fetchParams).toHaveBeenCalledOnce();
  });
});

describe("cloud-param poll loop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("announces a changed property with the value its getter now answers", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: any[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([{ deviceSn: "T8000P0000000000", property: "contact", value: true }]);
    expect(dev.getProperty("contact")?.value).toBe(true);
  });

  /**
   * The poll's fresh values must reach the live `Device`, not only the registry's record.
   *
   * Nothing else on this path catches the device up: the read-through freshness policy fires on a READ
   * of a stale value and hands that read the stale one, so a value nothing happened to read stayed
   * behind for as long as nobody asked — measured at 11 minutes across poll boundaries.
   */
  it("lands the poll's fresh params on a Device a caller is holding", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
    });
    expect(dev.getProperty("contact")?.value).toBe(false);

    await (eufy as any).pollOnce();

    expect(dev.getProperty("contact")?.value).toBe(true);
  });

  /**
   * The disagreement the announcement exists to avoid: a host told "it changed" reads the getter and
   * concludes nothing did. So the params land BEFORE any event derived from them is emitted.
   */
  it("a listener reading inside a poll event handler sees the post-poll value", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
    });
    const readInHandler: unknown[] = [];
    eufy.on("contactState", () => readInHandler.push(dev.getProperty("contact")?.value));

    await (eufy as any).pollOnce();

    expect(readInHandler).toEqual([true]);
  });

  /** One application per device, however many of its params the pass saw move. */
  it("applies a device's params once for a pass that saw several of them move", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    const applyParams = vi.spyOn(dev, "applyParams");
    // `pollChanges` hands every change of one device the same post-change map — see `ParamChange.params`.
    const params = { 1550: "1", 1141: "-64" };
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [
        { deviceSn: "T8000P0000000000", paramType: 1550, from: "0", to: "1", params },
        { deviceSn: "T8000P0000000000", paramType: 1141, from: "-70", to: "-64", params },
      ],
      added: [],
      removed: [],
      reported: [],
    });

    await (eufy as any).pollOnce();

    expect(applyParams).toHaveBeenCalledExactlyOnceWith(params);
    expect(dev.getProperty("rssi")?.value).toBe(-64);
  });

  /**
   * The poll applies the CHANGES it saw, never the whole cloud snapshot.
   *
   * A realtime report lands in the registry's `dpParams`, which is deliberately kept apart from the
   * cloud record's `params` — so the cloud list still carries the pre-report value for that id long
   * after the device volunteered the new one. Applying the whole snapshot would revert live state to it
   * and announce the revert as a change, which is how an open door comes to read as closed.
   */
  it("does not revert a value a realtime report made fresher", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "applyRealtimeParams").mockImplementation(() => {});
    (eufy as any).applyRealtimeState("T8000P0000000000", { 1550: "1" });
    expect(dev.getProperty("contact")?.value).toBe(true);
    const seen: any[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));
    // The cloud list still says closed, and an unrelated param on the same device moved.
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [
        { deviceSn: "T8000P0000000000", paramType: 1141, from: "-70", to: "-64", params: { 1550: "0", 1141: "-64" } },
      ],
      added: [],
      removed: [],
      reported: [],
    });

    await (eufy as any).pollOnce();

    expect(dev.getProperty("contact")?.value).toBe(true);
    expect(seen).toEqual([{ deviceSn: "T8000P0000000000", property: "rssi", value: -64 }]);
  });

  /**
   * A poll change must be decoded against the changed device's capabilities, exactly as a push is.
   *
   * Without them `resolveHits` cannot disambiguate a param id claimed by more than one capability, so a
   * contested id resolves to nothing and a poll event declared on it is silently never emitted. The
   * resolution itself is pinned in `capabilities/__tests__/decode-event.spec.ts`; what is asserted here
   * is that the argument reaches the decode at all, which is the whole of the defect — no shipped id is
   * contested today, so nothing else about this call is observable from the outside.
   */
  it("decodes a poll change against the changed device's capabilities", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [batteryChange("81")],
      added: [],
      removed: [],
      reported: [],
    });
    const caps = vi.spyOn((eufy as any).registry, "capabilitiesForDevice").mockReturnValue(new Set(["battery"]));

    await (eufy as any).pollOnce();

    expect(caps).toHaveBeenCalledWith("T8000P0000000000");
  });

  /**
   * Camera enablement is the state #47 asked for and #95 generalised: it only ever arrives as a cloud
   * param, so re-reading was the only way to learn of a change and re-reading cannot say WHEN. Both wire
   * ids carry it under opposite polarity — 1035 is a disable bit, 2001 reports it directly — and the
   * announcement carries the value the getter reads, so the polarity is applied once, where the member
   * declares it, and there is no second copy to disagree with.
   */
  it("announces a camera enablement change, in the polarity the reporting id uses", async () => {
    const eufy = makeClient();
    const dev = liveCamera(eufy);
    const pollChanges = vi.spyOn((eufy as any).registry, "pollChanges");
    const seen: any[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));

    pollChanges.mockResolvedValue({ params: [paramChange(1035, "0", "1")], added: [], removed: [], reported: [] });
    await (eufy as any).pollOnce();
    pollChanges.mockResolvedValue({
      params: [paramChange(2001, "false", "true")],
      added: [],
      removed: [],
      reported: [],
    });
    await (eufy as any).pollOnce();

    expect(seen).toEqual([
      { deviceSn: "T8000P0000000000", property: "enabled", value: false },
      { deviceSn: "T8000P0000000000", property: "enabled", value: true },
    ]);
    expect(dev.getProperty("enabled")?.value).toBe(true);
  });

  /**
   * The whole point of the generic announcement: a camera's status LED and night vision, a floodlight's
   * brightness and a device's speaker volume are cloud params with reads that no push carries and no
   * capability declared an event for. Nothing had to be added per member for these to arrive.
   */
  it("announces the members that had no event of their own", async () => {
    const eufy = makeClient();
    liveCamera(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [
        { deviceSn: "T8000P0000000000", paramType: 1045, from: "1", to: "0", params: { 1045: "0", 1277: "2" } },
        { deviceSn: "T8000P0000000000", paramType: 1277, from: "1", to: "2", params: { 1045: "0", 1277: "2" } },
      ],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: any[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([
      { deviceSn: "T8000P0000000000", property: "statusLed", value: false },
      { deviceSn: "T8000P0000000000", property: "nightVision", value: 2 },
    ]);
  });

  /**
   * A property change is a device event like any other, so it reaches the catch-all beside the named
   * listener — a host fanning everything onto a bus gets it without a per-name subscription.
   */
  it("reaches the catch-all listener tagged with its event name", async () => {
    const eufy = makeClient();
    liveCamera(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1045, "1", "0")],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: any[] = [];
    eufy.on("event", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([
      { eventName: "propertyChanged", deviceSn: "T8000P0000000000", property: "statusLed", value: false },
    ]);
  });

  /**
   * `contactState` keeps its name and now overlaps the generic announcement on the poll path — twice for
   * one movement, idempotently. It is not reducible to a property change: it is the same physical state
   * arriving on three transports with edge-triggered dedupe across them, and the FCM push path applies no
   * param at all, so retiring it would make a door-open push announce nothing.
   */
  it("announces a contact movement both semantically and as a property change", async () => {
    const eufy = makeClient();
    liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: string[] = [];
    eufy.on("event", (e) => seen.push(e.eventName));

    await (eufy as any).pollOnce();

    expect(seen).toEqual(["propertyChanged", "contactState"]);
  });

  /**
   * The value can only come from a device's own live state, so a serial no caller ever asked for has
   * none to read and nothing is announced for it. `deviceState` still reports its liveness.
   */
  it("announces nothing for a device no caller is holding", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: any[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
  });

  /**
   * A poll pass re-resolves the devices a caller is holding, and that path only ever ADDS — so it must
   * hand the resolver the whole record. An attached camera is granted guard mode by its curated model
   * row and withheld it again for hanging off a hub; re-resolving from a record that lost the topology
   * would hand it straight back, one param change after the caller got a device that correctly lacked it.
   */
  it("a poll pass does not hand an attached camera back the hub's guard mode", async () => {
    const eufy = makeClient();
    const record = {
      model: "T8170",
      category: "eufy_security",
      deviceType: 48,
      parentSn: "T8030P0000000000",
      params: { 1224: "1" },
      paramUpdatedAt: {},
    };
    vi.spyOn((eufy as any).registry, "record").mockResolvedValue(record);
    const dev = Device.fromRecord("T8000P0000000000", record);
    expect(dev.has("arming")).toBe(false);
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(dev));
    const gained: unknown[] = [];
    eufy.on("deviceCapabilities", (e) => gained.push(e));

    await (eufy as any).widenCapabilities("T8000P0000000000");

    expect(dev.has("arming")).toBe(false);
    expect(gained).toEqual([]);
  });

  it("emits nothing when no param changed", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: unknown[] = [];
    eufy.on("event", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
  });

  it("re-arms after each run, so the loop keeps polling", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("survives a failing poll — reports it and keeps the loop alive", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const boom = new Error("cloud down");
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockRejectedValueOnce(boom)
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });
    const errors: unknown[] = [];
    const listener = vi.fn();
    eufy.on("error", listener);
    eufy.on("error", (e) => errors.push(e));

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledExactlyOnceWith(boom, { origin: "cloud_poll" });
    expect(errors).toContain(boom); // surfaced, not thrown

    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2); // a transient failure must not kill the loop
  });

  it("pollMs:0 disables the loop entirely", async () => {
    const eufy = makeClient({ pollMs: 0 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(poll).not.toHaveBeenCalled();
  });

  it("disconnect stops the loop (no polling after teardown)", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);

    await eufy.disconnect();
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("auto-realtime starts the loop", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    await (eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(1000);

    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe("setPollInterval (runtime poll-interval change)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("reports the configured interval, and the default when unset", () => {
    expect(makeClient({ pollMs: 1234 }).pollIntervalMs).toBe(1234);
    expect(makeClient().pollIntervalMs).toBe(600_000); // DEFAULT_POLL_MS
  });

  it("updates the effective interval", () => {
    const eufy = makeClient({ pollMs: 1000 });
    eufy.setPollInterval(5000);
    expect(eufy.pollIntervalMs).toBe(5000);
  });

  it("re-arms a running loop at the new interval immediately", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1); // old 1s cadence

    eufy.setPollInterval(5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1); // the old 1s tick no longer fires
    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(2); // fires at the new 5s cadence
  });

  it("setPollInterval(0) stops a running loop", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);

    eufy.setPollInterval(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(poll).toHaveBeenCalledTimes(1); // disabled — no further polls
  });
});

describe("device hot-plug events", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const dev = (sn: string) => ({ sn, realtime: "p2p" }) as never;

  it("emits deviceAdded / deviceRemoved from the poll diff", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [dev("NEW")],
      removed: [dev("GONE")],
      reported: [],
    });
    const added: string[] = [];
    const removed: string[] = [];
    eufy.on("deviceAdded", (d) => added.push(d.sn));
    eufy.on("deviceRemoved", (d) => removed.push(d.sn));

    await (eufy as any).pollOnce();

    expect(added).toEqual(["NEW"]);
    expect(removed).toEqual(["GONE"]);
  });

  it("emits nothing when the roster is unchanged", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: string[] = [];
    eufy.on("deviceAdded", (d) => seen.push(d.sn));
    eufy.on("deviceRemoved", (d) => seen.push(d.sn));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
  });
});

/**
 * Shutdown vs the fire-and-forget realtime bring-up.
 *
 * `login()` starts the channels without awaiting them, so a bring-up can finish long after the caller
 * moved on. A finished bring-up is installed only while it is still the current one: otherwise the
 * channels it built are closed on the spot, never installed and never left holding a socket.
 *
 * The bring-up therefore ASSEMBLES rather than installs — a stale one must not tear down the channels
 * a later login legitimately brought up, so the ownership check lives at the single install site.
 */
describe("disconnect during startup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  /** A push client stand-in whose only observable behaviour is whether it got closed. */
  const gatedPush = (eufy: EufyMega) => {
    const client = { close: vi.fn(), setPersistentIds: vi.fn(), on: vi.fn(), connect: vi.fn() };
    let release!: () => void;
    vi.spyOn(eufy as any, "startPush").mockReturnValue(new Promise((r) => (release = () => r(client))));
    return { client, release: () => release() };
  };

  it("closes the channels a slow bring-up opened after teardown had run", async () => {
    const eufy = makeClient();
    const push = gatedPush(eufy);

    const starting = (eufy as any).ensureRealtime();
    await eufy.disconnect();
    push.release();
    await starting;

    await vi.waitFor(() => expect(push.client.close).toHaveBeenCalled());
    expect((eufy as any).pushClient).toBeUndefined(); // never installed
  });

  /**
   * The case a single "closing" flag cannot express: `login()` clears it, so the stale bring-up would
   * finish, see nothing amiss, and overwrite the live channel — stranding the socket it was meant to
   * release and leaving the session with none.
   */
  it("does not clobber the channels a later login brought up", async () => {
    const eufy = makeClient();
    const stale = gatedPush(eufy);

    const starting = (eufy as any).ensureRealtime();
    await eufy.disconnect();

    const fresh = gatedPush(eufy); // the second login's bring-up wins the install
    const restarting = (eufy as any).ensureRealtime();
    fresh.release();
    await restarting;
    stale.release();
    await starting;

    expect((eufy as any).pushClient).toBe(fresh.client);
    expect(fresh.client.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stale.client.close).toHaveBeenCalled());
  });

  it("does not arm the poll loop when the bring-up finishes after a disconnect", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const push = gatedPush(eufy);
    const poll = vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });

    const starting = (eufy as any).ensureRealtime();
    await eufy.disconnect();
    push.release();
    await starting;

    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).not.toHaveBeenCalled();
  });

  it("a later login brings realtime back up", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    vi.spyOn((eufy as any).mega, "login").mockResolvedValue({
      status: "ok",
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    const poll = vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });
    await eufy.disconnect();

    await eufy.login();
    await vi.advanceTimersByTimeAsync(1000);

    expect(poll).toHaveBeenCalled();
  });
});

/**
 * The poll baseline must be a snapshot of VALUES, not of the records the registry hands out.
 *
 * `this.devices` holds the same objects, so anything that updates one in place rewrites the baseline before
 * the next pass can diff against it. `applyRealtimeParams` does exactly that to `lastSeenMs` — a station's
 * report stamps the record the baseline is holding — so a device that reports over realtime loses the poll's
 * liveness signal. The param half is guarded against the same mutation, which no current path performs.
 */
describe("poll baseline isolation", () => {
  beforeEach(() => vi.restoreAllMocks());

  /** A registry with one device whose params a test can mutate the way the realtime path does. */
  async function registryWithDevice() {
    const { DeviceRegistry } = await import("../device-registry.js");
    const device: any = { sn: "T8000P0000000000", params: { 2001: "false" }, lastSeenMs: 1 };
    const registry = new DeviceRegistry({ mega: {} as never, onError: () => {} });
    vi.spyOn(registry, "getDevices").mockImplementation(async () => [device]);
    return { registry, device };
  }

  it("reports a change written into the record after the baseline was taken", async () => {
    const { registry, device } = await registryWithDevice();
    await registry.pollChanges(); // baseline

    device.params = { ...device.params, 2001: "true" }; // the station volunteers the new value
    const diff = await registry.pollChanges();

    expect(diff.params).toEqual([
      { deviceSn: "T8000P0000000000", paramType: 2001, from: "false", to: "true", params: { 2001: "true" } },
    ]);
  });

  /** The half that bites today: a realtime report stamps `lastSeenMs` on the record the baseline holds. */
  it("reports a device as re-reported after its record was updated in place", async () => {
    const { registry, device } = await registryWithDevice();
    await registry.pollChanges();

    device.lastSeenMs = 2;
    const diff = await registry.pollChanges();

    expect(diff.reported.map((d) => d.sn)).toEqual(["T8000P0000000000"]);
  });

  /** An unchanged pass still reports nothing, so the isolation cannot fake a change. */
  it("stays silent when nothing moved", async () => {
    const { registry } = await registryWithDevice();
    await registry.pollChanges();

    const diff = await registry.pollChanges();

    expect(diff.params).toEqual([]);
    expect(diff.reported).toEqual([]);
  });
});

describe("generation-owned RTC state refresh", () => {
  const station = "T8000P0000000000";
  const second = "T8000P0000000001";
  const child = "T8000P0000000002";
  const result = { notificationCorrelation: "temporal-only" as const, devicesUpdated: 1, parametersUpdated: 1 };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  function fixture(opts: Record<string, unknown> = {}) {
    const eufy = makeClient({ pollMs: 1000, ...opts });
    vi.spyOn((eufy as any).registry, "list").mockReturnValue([
      { sn: station, model: "T9000" },
      { sn: station, model: "T9000" },
      { sn: child, model: "T8425", stationSn: station },
      { sn: second, model: "T8010" },
    ]);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });
    return { eufy, refresh: vi.spyOn(eufy, "refreshDeviceState").mockResolvedValue(result) };
  }

  it.each([-1, 1, 29_999, 600_001, 30_000.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid station refresh interval %s",
    (stateRefreshMs) => {
      expect(() => fixture({ rtc: { stateRefreshMs } })).toThrow(RangeError);
    },
  );

  it("refreshes external state without increasing cloud polling or replaying commands", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    const device = Device.fromRecord(child, { model: "T8425", params: { 1400: "1" } });
    (eufy as any).liveDevices.set(child, new WeakRef(device));
    (eufy as any).boundParamIds.set(child, new Set([1400]));
    const dispatch = vi.spyOn((eufy as any).rtc, "dispatchCommand");
    const login = vi.spyOn(eufy, "login");
    const seen: unknown[] = [];
    eufy.on("propertyChanged", (event) => seen.push(event));
    await (eufy as any).ensureRealtime();
    refresh.mockImplementation(async () => {
      (eufy as any).applyRealtimeState(child, { 1400: "0" });
      return result;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(device.getPropertyValue("light")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(device.getPropertyValue("light")).toBe(false);
    expect(seen).toContainEqual({ deviceSn: child, property: "light", value: false });
    expect((eufy as any).registry.pollChanges).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    await eufy.disconnect();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("coalesces a scheduled read with a cloud sweep and waits for completion before rearming", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    await (eufy as any).ensureRealtime();
    let finish!: (value: typeof result) => void;
    refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const poll = (eufy as any).pollOnce();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    finish(result);
    await poll;
    expect(eufy.getStateRefreshDiagnostics().recent.at(-1)).toMatchObject({
      trigger: "scheduled",
      cloudPollJoins: 1,
      outcome: "success",
    });
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)).toMatchObject({
      delayMs: 30_000,
      consecutiveFailures: 0,
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    await eufy.disconnect();
  });

  it("a successful cloud sweep supersedes the pending fast timer", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    refresh.mockRejectedValueOnce(retiredFailure());
    await vi.advanceTimersByTimeAsync(31_000);
    await (eufy as any).pollOnce();
    expect(refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)).toMatchObject({
      delayMs: 30_000,
      consecutiveFailures: 0,
    });
    await eufy.disconnect();
  });

  it("does not reuse retirement proof from an older failure", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    const error = retiredFailure();
    refresh.mockRejectedValueOnce(error);
    await vi.advanceTimersByTimeAsync(32_000);
    refresh.mockRejectedValueOnce(error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)?.delayMs).toBe(60_000);
    await eufy.disconnect();
  });

  async function reachThirdDeadline() {
    vi.setSystemTime(0);
    const state = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    state.eufy.on("error", () => {});
    await (state.eufy as any).ensureRealtime();
    state.refresh.mockRejectedValueOnce(retiredFailure());
    state.refresh.mockImplementation(async () => {
      throw connectionDeadline(station, 12_000);
    });
    await vi.advanceTimersByTimeAsync(152_000);
    expect(state.refresh).toHaveBeenCalledTimes(4);
    return state;
  }

  it("final connection-deadline probe recovers at normal cadence with no write, login or cloud replay", async () => {
    const { eufy, refresh } = await reachThirdDeadline();
    const dispatch = vi.spyOn((eufy as any).rtc, "dispatchCommand");
    const login = vi.spyOn(eufy, "login");
    expect(eufy.getStateRefreshDiagnostics()).toMatchObject({ scheduledPaused: false, failures: 3 });
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)).toMatchObject({
      consecutiveFailures: 3,
      delayMs: 30_000,
    });
    refresh.mockResolvedValue(result);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(5);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)).toMatchObject({
      consecutiveFailures: 0,
      delayMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(6);
    expect(dispatch).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect((eufy as any).registry.pollChanges).not.toHaveBeenCalled();
    await eufy.disconnect();
  });

  it("final connection-deadline probe adds at most one attempt during a sustained outage", async () => {
    const { eufy, refresh } = await reachThirdDeadline();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(5);
    expect(eufy.getStateRefreshDiagnostics()).toMatchObject({ scheduledPaused: true, failures: 4 });
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)).toMatchObject({
      consecutiveFailures: 4,
      delayMs: null,
    });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(refresh).toHaveBeenCalledTimes(5);
    refresh.mockResolvedValue(result);
    await (eufy as any).pollOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(7);
    expect(eufy.getStateRefreshDiagnostics().scheduledPaused).toBe(false);
    await eufy.disconnect();
  });

  it.each([false, true])("final connection-deadline probe cancels on disconnect (in flight: %s)", async (inFlight) => {
    const { eufy, refresh } = await reachThirdDeadline();
    let finish!: (value: typeof result) => void;
    refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(inFlight ? 30_000 : 29_999);
    if (inFlight) {
      expect(refresh).toHaveBeenCalledTimes(5);
      expect(eufy.getStateRefreshDiagnostics()).toMatchObject({ inFlight: true, scheduledPaused: false });
    }
    await eufy.disconnect();
    if (inFlight) {
      expect(refresh.mock.calls[4]![1]!.signal!.aborted).toBe(true);
      finish(result);
    }
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(inFlight ? 5 : 4);
  });

  it("final connection-deadline probe is superseded by a successful cloud sweep", async () => {
    const { eufy, refresh } = await reachThirdDeadline();
    refresh.mockResolvedValue(result);
    await vi.advanceTimersByTimeAsync(20_000);
    await (eufy as any).pollOnce();
    expect(refresh).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh).toHaveBeenCalledTimes(6);
    await eufy.disconnect();
  });

  it("final connection-deadline probe coalesces a cloud caller and pauses on its failure", async () => {
    const { eufy, refresh } = await reachThirdDeadline();
    let reject!: (error: Error) => void;
    refresh.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const cloud = (eufy as any).pollOnce();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refresh).toHaveBeenCalledTimes(5);
    reject(connectionDeadline(station, 12_000));
    await cloud;
    await vi.advanceTimersByTimeAsync(0);
    expect(eufy.getStateRefreshDiagnostics().recent.at(-1)).toMatchObject({ cloudPollJoins: 1 });
    expect(eufy.getStateRefreshDiagnostics().scheduledPaused).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(5);
    await eufy.disconnect();
  });

  it("final connection-deadline probe cannot rearm an obsolete generation", async () => {
    const { eufy, refresh } = await reachThirdDeadline();
    let finish!: (value: typeof result) => void;
    refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(5);
    await eufy.disconnect();
    refresh.mockResolvedValue(result);
    await (eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(20_000);
    finish(result);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(7);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)).toMatchObject({ consecutiveFailures: 0 });
    await eufy.disconnect();
  });

  it.each([
    "RTC scall 486 after 0 retries",
    "RTC scall 408 after 0 retries",
    "rtc: synthetic did not come up within 12000ms",
    "RTC information response timed out",
    "RTC information request rejected (1)",
  ])("keeps the three-failure pause without a local deadline identity: %s", async (message) => {
    vi.setSystemTime(0);
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    refresh.mockRejectedValue(new Error(message));
    await vi.advanceTimersByTimeAsync(210_000);
    expect(eufy.getStateRefreshDiagnostics().scheduledPaused).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    await eufy.disconnect();
  });

  it("does not reuse a consumed connection deadline at the third failure", async () => {
    vi.setSystemTime(0);
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    refresh.mockRejectedValue(connectionDeadline(station, 12_000));
    await vi.advanceTimersByTimeAsync(210_000);
    expect(eufy.getStateRefreshDiagnostics().scheduledPaused).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    await eufy.disconnect();
  });

  it("does not add a deadline probe to a multiple-station sweep", async () => {
    vi.setSystemTime(0);
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    (eufy as any).registry.list.mockReturnValue([
      { sn: station, model: "T9000" },
      { sn: second, model: "T9000" },
    ]);
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    refresh.mockImplementation(async () => {
      throw connectionDeadline(station, 12_000);
    });
    await vi.advanceTimersByTimeAsync(210_000);
    expect(eufy.getStateRefreshDiagnostics().scheduledPaused).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(8);
    await eufy.disconnect();
  });

  it("uses the configured interval for the final deadline probe", async () => {
    vi.setSystemTime(0);
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 60_000 } });
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    refresh.mockImplementation(async () => {
      throw connectionDeadline(station, 12_000);
    });
    await vi.advanceTimersByTimeAsync(420_000);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)?.delayMs).toBe(60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(refresh).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(5);
    await eufy.disconnect();
  });

  it.each(["T8030", "T8425"])("does not schedule RTC reads for a non-T9000 route: %s", async (model) => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    (eufy as any).registry.list.mockReturnValue([{ sn: station, model }]);
    await (eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(eufy.getStateRefreshDiagnostics().targetStations).toBe(0);
    await eufy.disconnect();
  });

  it.each([false, true])("replays recorded read durations with a bounded probe (reachable: %s)", async (reachable) => {
    vi.setSystemTime(0);
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    const starts: number[] = [];
    let attempt = 0;
    refresh.mockImplementation(async () => {
      const index = attempt++;
      starts.push(Date.now());
      const delay = [8_003, 12_003, 12_007, reachable ? 2_105 : 12_003][index]!;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (index === 0) throw retiredFailure();
      if (index < 3 || !reachable) throw connectionDeadline(station, 12_000);
      return result;
    });
    await vi.advanceTimersByTimeAsync(214_013 + (reachable ? 2_105 : 12_003));
    expect(starts).toEqual([30_000, 40_003, 172_006, 214_013]);
    expect(eufy.getStateRefreshDiagnostics().scheduledPaused).toBe(!reachable);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)?.delayMs).toBe(reachable ? 30_000 : null);
    await eufy.disconnect();
  });

  function retiredFailure() {
    const error = new Error("RTC information response timed out");
    markRetiredInformationRead(error);
    return error;
  }

  it("uses one two-second wait after retirement without increasing the three-failure limit", async () => {
    vi.setSystemTime(0);
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    eufy.on("error", () => {});
    const dispatch = vi.spyOn((eufy as any).rtc, "dispatchCommand");
    const login = vi.spyOn(eufy, "login");
    await (eufy as any).ensureRealtime();
    refresh.mockImplementation(async () => {
      throw retiredFailure();
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)?.delayMs).toBe(2_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)?.delayMs).toBe(120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(eufy.getStateRefreshDiagnostics().scheduledPaused).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(dispatch).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    await eufy.disconnect();
  });

  it("resets normal cadence after the accelerated read succeeds", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    refresh.mockRejectedValueOnce(retiredFailure());
    await vi.advanceTimersByTimeAsync(32_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)).toMatchObject({
      delayMs: 30_000,
      consecutiveFailures: 0,
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(4);
    await eufy.disconnect();
  });

  it("does not accelerate an unproven timeout or connection failure", async () => {
    for (const message of [
      "RTC information response timed out",
      "rtc: synthetic did not come up within 12000ms",
      "RTC scall 486 after 0 retries",
    ]) {
      const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
      eufy.on("error", () => {});
      await (eufy as any).ensureRealtime();
      refresh.mockRejectedValueOnce(new Error(message));
      await vi.advanceTimersByTimeAsync(32_000);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)?.delayMs).toBe(60_000);
      await eufy.disconnect();
    }
  });

  it("does not accelerate a sweep of multiple stations", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    (eufy as any).registry.list.mockReturnValue([
      { sn: station, model: "T9000" },
      { sn: second, model: "T9000" },
    ]);
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    refresh.mockRejectedValueOnce(retiredFailure());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)?.delayMs).toBe(60_000);
    await eufy.disconnect();
  });

  it("coalesces a cloud caller during the fast read and preserves failure accounting", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    refresh.mockRejectedValueOnce(retiredFailure());
    let reject!: (e: Error) => void;
    refresh.mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    await vi.advanceTimersByTimeAsync(32_000);
    const cloud = (eufy as any).pollOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(3);
    reject(new Error("rtc: synthetic did not come up within 12000ms"));
    await cloud;
    await vi.advanceTimersByTimeAsync(0);
    expect(eufy.getStateRefreshDiagnostics().recent.at(-1)?.cloudPollJoins).toBe(1);
    expect(eufy.getStateRefreshDiagnostics().schedules.at(-1)).toMatchObject({
      delayMs: 120_000,
      consecutiveFailures: 2,
    });
    await eufy.disconnect();
  });

  it.each([false, true])("cancels accelerated recovery on disconnect (in flight: %s)", async (inFlight) => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    eufy.on("error", () => {});
    await (eufy as any).ensureRealtime();
    refresh.mockRejectedValueOnce(retiredFailure());
    let finish!: (r: typeof result) => void;
    if (inFlight)
      refresh.mockImplementationOnce(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      );
    await vi.advanceTimersByTimeAsync(inFlight ? 32_000 : 31_999);
    await eufy.disconnect();
    if (inFlight) {
      expect(refresh.mock.calls[2]![1]!.signal!.aborted).toBe(true);
      finish(result);
    }
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(inFlight ? 3 : 2);
  });

  it("backs off, pauses after three failures, and resumes after a successful normal sweep", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    const errors: unknown[] = [];
    const listener = vi.fn();
    eufy.on("error", listener);
    eufy.on("error", (error) => errors.push(error));
    await (eufy as any).ensureRealtime();
    const error = new Error("Synthetic read failure");
    refresh.mockRejectedValue(error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(errors).toHaveLength(3);
    expect(listener.mock.calls).toEqual(Array.from({ length: 3 }, () => [error, { origin: "state_refresh" }]));
    expect(
      eufy
        .getStateRefreshDiagnostics()
        .schedules.slice(-3)
        .map((item) => item.delayMs),
    ).toEqual([60_000, 120_000, null]);
    refresh.mockResolvedValue(result);
    await (eufy as any).pollOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(6);
    await eufy.disconnect();
  });

  it("does not rearm an in-flight scheduled sweep after disconnect", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0, rtc: { stateRefreshMs: 30_000 } });
    await (eufy as any).ensureRealtime();
    let finish!: (value: typeof result) => void;
    refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const signal = refresh.mock.calls[1]![1]!.signal!;
    await eufy.disconnect();
    expect(signal.aborted).toBe(true);
    finish(result);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps the optional schedule disabled by default, by zero, and under manual connectivity", async () => {
    for (const options of [
      {},
      { rtc: { stateRefreshMs: 0 } },
      { rtc: { stateRefreshMs: 30_000 }, autoRealtime: false },
    ]) {
      const { eufy, refresh } = fixture({ pollMs: 0, ...options });
      await (eufy as any).ensureRealtime();
      const count = refresh.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(refresh).toHaveBeenCalledTimes(count);
      await eufy.disconnect();
    }
  });

  it("distinguishes successful transport from client processing failure and keeps bounded detached evidence", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0 });
    refresh.mockRestore();
    const exchange = vi.spyOn((eufy as any).rtc, "refreshInformation").mockResolvedValue({
      notificationCorrelation: "temporal-only",
      get frame() {
        throw new Error("synthetic-private-marker");
      },
    });
    await expect(eufy.refreshDeviceState(station)).rejects.toThrow("synthetic-private-marker");
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(eufy.getStateRefreshDiagnostics().lastOperationFailure).toMatchObject({
      phase: "processing",
      failure: "other",
    });
    for (let i = 0; i < 22; i++)
      await expect(eufy.refreshDeviceState("synthetic-missing")).rejects.toThrow("unavailable");
    const snapshot = eufy.getStateRefreshDiagnostics();
    expect(snapshot.operations).toHaveLength(20);
    expect(snapshot.operations[0]!.phase).toBe("validation");
    snapshot.operations[0]!.phase = "processing";
    expect(eufy.getStateRefreshDiagnostics().operations[0]!.phase).toBe("validation");
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-private-marker");
    await eufy.disconnect();
    expect(eufy.getStateRefreshDiagnostics().operations).toEqual([]);
  });

  it("does not warm P2P for a supported RTC station or its attached devices", async () => {
    const { eufy } = fixture({ pollMs: 0 });
    const internals = eufy as any;
    internals.warmWiredP2P.mockRestore();
    vi.spyOn(internals.registry, "p2pDevices").mockReturnValue(internals.registry.list());
    vi.spyOn(internals.p2p, "stationKeyOf").mockImplementation((sn: unknown) => (sn === child ? station : sn));
    vi.spyOn(internals, "stationPower").mockReturnValue("wired");
    const connect = vi.spyOn(internals.p2p, "ensureStation").mockResolvedValue(undefined);
    const readiness = await internals.warmWiredP2P();
    expect(connect).toHaveBeenCalledExactlyOnceWith(second, undefined);
    expect(readiness).toEqual({ required: 1, ready: 1, failed: 0, pending: 0 });
    await eufy.disconnect();
  });

  it("refreshes each supported station once at startup and each existing poll", async () => {
    const { eufy, refresh } = fixture();
    await (eufy as any).ensureRealtime();
    await (eufy as any).ensureRealtime();
    expect(refresh).toHaveBeenCalledExactlyOnceWith(station, { signal: expect.any(AbortSignal), timeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await eufy.disconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps autoRealtime:false manual and pollMs:0 free of repeated refreshes", async () => {
    const manual = fixture({ autoRealtime: false });
    await (manual.eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(1000);
    expect(manual.refresh).not.toHaveBeenCalled();
    await manual.eufy.disconnect();
    const once = fixture({ pollMs: 0 });
    await (once.eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(once.refresh).toHaveBeenCalledTimes(1);
    await once.eufy.disconnect();
  });

  it("shares a sweep between a pending startup and an overlapping poll", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0 });
    let finish!: (value: typeof result) => void;
    refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const startup = (eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(0);
    const poll = (eufy as any).pollOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    finish(result);
    await Promise.all([startup, poll]);
    await eufy.disconnect();
  });

  it("continues to another station after one bounded failure without retrying or logging in", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0 });
    vi.spyOn((eufy as any).registry, "list").mockReturnValue([
      { sn: station, model: "T9000" },
      { sn: second, model: "T9000" },
    ]);
    const failure = new Error("Information read timed out");
    refresh.mockRejectedValueOnce(failure);
    const login = vi.spyOn(eufy, "login");
    const errors: unknown[] = [];
    eufy.on("error", (error) => errors.push(error));
    const readiness = await (eufy as any).ensureRealtime();
    expect(readiness.state).toBe("partial");
    expect(errors).toEqual([failure]);
    expect(refresh.mock.calls.map(([sn]) => sn)).toEqual([station, second]);
    expect(login).not.toHaveBeenCalled();
    await eufy.disconnect();
  });

  it("aborts the owning generation and skips remaining stations after disconnect", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0 });
    vi.spyOn((eufy as any).registry, "list").mockReturnValue([
      { sn: station, model: "T9000" },
      { sn: second, model: "T9000" },
    ]);
    refresh.mockImplementation(
      (_sn, opts) =>
        new Promise((_resolve, reject) => {
          opts!.signal!.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        }),
    );
    const startup = (eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(0);
    await eufy.disconnect();
    expect((await startup).state).toBe("superseded");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it("a superseded sweep cannot clear a replacement generation's in-flight sweep", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0 });
    const finish: Array<(value: typeof result) => void> = [];
    refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish.push(resolve);
        }),
    );
    const first = (eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(0);
    await eufy.disconnect();
    const secondStart = (eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    finish[0]!(result);
    await first;
    const poll = (eufy as any).pollOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    finish[1]!(result);
    await Promise.all([secondStart, poll]);
    await eufy.disconnect();
  });
  it("diagnostics are passive and count qualified sweeps rather than cached snapshots", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0 });
    expect(eufy.getStateRefreshDiagnostics()).toMatchObject({
      active: false,
      attempts: 0,
      lastSuccessMs: null,
      targetStations: 1,
    });
    expect(refresh).not.toHaveBeenCalled();
    await (eufy as any).ensureRealtime();
    const snapshot = eufy.getStateRefreshDiagnostics();
    expect(snapshot).toMatchObject({
      active: true,
      attempts: 1,
      successes: 1,
      failures: 0,
      lastResponseParameters: 1,
      inFlight: false,
    });
    expect(snapshot.lastSuccessMs).toBe(Date.now());
    snapshot.successes = 999;
    expect(eufy.getStateRefreshDiagnostics().successes).toBe(1);
    await eufy.disconnect();
    expect(eufy.getStateRefreshDiagnostics()).toMatchObject({ active: false, attempts: 0, lastSuccessMs: null });
  });

  it("empty and failed reads cannot advance the successful-observation timestamp", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0 });
    await (eufy as any).ensureRealtime();
    const success = eufy.getStateRefreshDiagnostics().lastSuccessMs;
    refresh.mockResolvedValue({ ...result, devicesUpdated: 0, parametersUpdated: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    await (eufy as any).pollOnce();
    expect(eufy.getStateRefreshDiagnostics()).toMatchObject({
      successes: 1,
      failures: 1,
      lastSuccessMs: success,
      lastFailureKind: "empty_response",
    });
    refresh.mockRejectedValue(new Error("RTC information response timed out"));
    await (eufy as any).pollOnce();
    expect(eufy.getStateRefreshDiagnostics()).toMatchObject({
      successes: 1,
      failures: 2,
      lastSuccessMs: success,
      lastFailureKind: "information_response_timeout",
    });
    await eufy.disconnect();
  });

  it("all stations must return usable parameters before a sweep is successful", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0 });
    vi.spyOn((eufy as any).registry, "list").mockReturnValue([
      { sn: station, model: "T9000" },
      { sn: second, model: "T9000" },
    ]);
    refresh.mockResolvedValueOnce(result).mockRejectedValueOnce(new Error("synthetic-private-detail"));
    await (eufy as any).ensureRealtime();
    const diagnostic = eufy.getStateRefreshDiagnostics();
    expect(diagnostic).toMatchObject({
      targetStations: 2,
      attempts: 1,
      successes: 0,
      failures: 1,
      lastSuccessMs: null,
      lastFailureKind: "other",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("synthetic-private-detail");
    expect(JSON.stringify(diagnostic)).not.toContain(station);
    await eufy.disconnect();
  });

  it("a late obsolete response cannot repopulate reset evidence", async () => {
    const { eufy, refresh } = fixture({ pollMs: 0 });
    let finish!: (value: typeof result) => void;
    refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const startup = (eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(0);
    expect(eufy.getStateRefreshDiagnostics()).toMatchObject({ attempts: 1, inFlight: true });
    await eufy.disconnect();
    finish(result);
    await startup;
    expect(eufy.getStateRefreshDiagnostics()).toMatchObject({
      attempts: 0,
      successes: 0,
      lastSuccessMs: null,
      active: false,
    });
  });
});
