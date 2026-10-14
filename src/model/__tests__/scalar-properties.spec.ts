import { Device } from "../device.js";
import { CAMERA_CMD, RECORDING_QUALITY_TIERS } from "../capabilities/camera.js";
import { BATTERY_PARAM } from "../capabilities/battery.js";
import { MOTION_CMD } from "../capabilities/motion.js";
import { readMemberValue, scalarSpec } from "../capabilities/members.js";

const synthetic = "T8000P0000000000";

describe("typed cached scalar properties", () => {
  it("announces the decoded scalar and invalidation without scheduling a refresh", () => {
    const dev = Device.fromRecord(synthetic, { model: "T8425" });
    const refresh = vi.fn(async () => {});
    dev.setFreshnessPolicy({ staleAfterMs: -1, refresh });
    const changes = dev.applyParams({
      [CAMERA_CMD.RECORDING_QUALITY_SET]: Buffer.from(JSON.stringify({ cur_mode: 0, mode_0: { quality: 1 } })).toString(
        "base64",
      ),
    });
    expect(dev.announcements(changes)).toContainEqual({ property: "recordingQuality", value: 1 });
    expect(dev.getPropertyValue("recordingQuality")).toBe(1);
    expect(dev.announcements(dev.applyParams({ [CAMERA_CMD.RECORDING_QUALITY_SET]: "invalid" }))).toContainEqual({
      property: "recordingQuality",
    });
    expect(refresh).not.toHaveBeenCalled();
  });
  it("keeps opaque string identifiers textual and refuses non-scalar decoder results", () => {
    const member = {
      type: "string" as const,
      description: "Synthetic scalar",
      param: 99998,
      decodedKind: "identifier",
      decode: () => ({ nested: "synthetic" }) as never,
    };
    expect(
      scalarSpec({ name: "example", type: "string", paramType: 99998, writable: false, raw: true }, member).type,
    ).toBe("string");
    expect(
      readMemberValue(
        "example",
        member,
        { example: member },
        () => ({ name: "example", paramType: 99998, ts: 0, value: "synthetic" }),
        {},
      ),
    ).toBeUndefined();
    expect(
      readMemberValue(
        "example",
        { ...member, decode: () => Number.NaN },
        {},
        () => ({ name: "example", paramType: 99998, ts: 0, value: "synthetic" }),
        {},
      ),
    ).toBeUndefined();
  });
  it("decodes recording quality using the same member decoder as the fluent getter", () => {
    const params = {
      [CAMERA_CMD.RECORDING_QUALITY_SET]: Buffer.from(JSON.stringify({ cur_mode: 0, mode_0: { quality: 2 } })).toString(
        "base64",
      ),
    };
    const dev = Device.fromRecord(synthetic, { model: "T8425", params });
    dev.bindActions(
      { codec: "camera", model: "T8425", channel: 0, paramIds: new Set(Object.keys(params).map(Number)) },
      { dispatch: async () => {} },
    );
    expect(dev.getPropertyValue("recordingQuality")).toBe(2);
    expect(dev.getPropertyValue("recordingQuality")).toBe(dev.camera?.()?.recordingQuality);
    expect(dev.getPropertySpecs().find((s) => s.name === "recordingQuality")).toMatchObject({
      type: "enum",
      kind: "enum",
      enumValues: RECORDING_QUALITY_TIERS,
      raw: undefined,
    });
    expect(dev.getProperties().recordingQuality.value).not.toBe(2);
  });

  it("reads event-updated state without triggering freshness, and invalidates a malformed decoded payload", () => {
    const dev = Device.fromRecord(synthetic, { model: "T8425" });
    const refresh = vi.fn(async () => {});
    dev.setFreshnessPolicy({ staleAfterMs: -1, refresh });
    dev.applyParams(
      {
        [CAMERA_CMD.RECORDING_QUALITY_SET]: Buffer.from(
          JSON.stringify({ cur_mode: 0, mode_0: { quality: 1 } }),
        ).toString("base64"),
      },
      0,
    );
    expect(dev.getPropertyValue("recordingQuality")).toBe(1);
    const changes = dev.announcements(dev.applyParams({ [CAMERA_CMD.RECORDING_QUALITY_SET]: "invalid" }, 0));
    expect(changes).toContainEqual({ property: "recordingQuality" });
    expect(dev.getPropertyValue("recordingQuality")).toBeUndefined();
    dev.getPropertyValues();
    dev.getPropertySpecs();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("marks diagnostic-only members explicitly and never projects their payloads or unknown parameters", () => {
    const dev = Device.fromRecord(synthetic, {
      model: "T9000",
      params: {
        [BATTERY_PARAM.BATTERY]: "0",
        [BATTERY_PARAM.BATTERY_STATUS]: "0",
        [BATTERY_PARAM.CAMERA_INFO]: '{"example":"synthetic"}',
        99999: "opaque",
      },
    });
    expect(dev.getPropertyValue("battery")).toBe(0);
    expect(dev.getPropertyValue("charging")).toBe(false);
    expect(dev.getPropertyValue("cameraInfo")).toBeUndefined();
    expect(dev.getPropertySpecs().find((s) => s.name === "cameraInfo")).toMatchObject({ unexposed: true });
    expect(dev.getPropertyValues()).not.toHaveProperty("unknown_99999");
    expect(dev.getPropertyValue("unknown_99999")).toBeUndefined();
    expect(JSON.stringify(dev.getPropertyValues())).not.toContain("synthetic");
  });

  it.each(["T8416", "T8426"])(
    "withholds physical-cell fields on powered %s while preserving workload controls",
    (model) => {
      const dev = Device.fromRecord(synthetic, {
        model,
        params: { [BATTERY_PARAM.BATTERY]: "100", [BATTERY_PARAM.WORKING_MODE]: "0" },
      });
      const names = dev.properties.map((s) => s.name);
      for (const name of [
        "battery",
        "charging",
        "batteryHealth",
        "batteryTemperature",
        "solarIntensity",
        "solarConnected24h",
        "batteryPowerStats",
      ])
        expect(names).not.toContain(name);
      for (const name of ["workingMode", "recordDuration", "recordInterval", "recordAutoStop"])
        expect(names).toContain(name);
    },
  );

  it("keeps a backup battery and supported but not-yet-reported camera readings", () => {
    expect(
      Device.fromRecord(synthetic, { model: "T9000", params: { [BATTERY_PARAM.BATTERY]: "100" } }).getPropertyValue(
        "battery",
      ),
    ).toBe(100);
    const cam = Device.fromRecord(synthetic, { model: "T8170" });
    expect(cam.getPropertySpecs().some((s) => s.name === "recordingQuality")).toBe(true);
    expect(cam.getPropertyValue("recordingQuality")).toBeUndefined();
  });

  it("limits standalone PIR controls to standalone sensors", () => {
    const params = { [MOTION_CMD.SENSOR_PIR_SENSITIVITY]: "37", [MOTION_CMD.SENSOR_WORK_MODE]: "1" };
    const cam = Device.fromRecord(synthetic, { model: "T8416", params });
    const sensor = Device.fromRecord(synthetic, { model: "T8910", deviceType: 10, params });
    for (const name of ["sensorPirSensitivity", "testMode"]) {
      expect(cam.hasProperty(name)).toBe(false);
      expect(sensor.hasProperty(name)).toBe(true);
    }
    expect(sensor.getPropertyValue("testMode")).toBe(true);
  });

  it("does not infer a lock from a user-assigned camera name", () => {
    expect(Device.fromRecord(synthetic, { model: "T8416", name: "Synthetic safe view" }).has("lock")).toBe(false);
    expect(Device.fromRecord(synthetic, { model: "T8416", params: { 6000: "4" } }).has("lock")).toBe(true);
    expect(Device.fromRecord(synthetic, { model: "T8531" }).has("lock")).toBe(true);
  });
});
