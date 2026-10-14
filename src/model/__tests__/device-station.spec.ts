import { describe, expect, it } from "vitest";
import { Device } from "../device.js";
import type { CloudRecord } from "../types.js";

/**
 * The station a device's traffic belongs to, on the device itself.
 *
 * `parentSn` is present on the record only for a device hanging off a base. A device with none is its own
 * station, so every device has one.
 */
const BASE = "T8010P0000000000";
const CAM = "T8210P0000000001";
const record = (over: Partial<CloudRecord> = {}): CloudRecord => ({ deviceType: 30, model: "T8210", ...over });

describe("Device.stationSn", () => {
  it("is the parent for a device whose record names one", () => {
    expect(Device.fromRecord(CAM, record({ parentSn: BASE })).stationSn).toBe(BASE);
  });

  it("is the device's own serial for a record naming no parent", () => {
    expect(Device.fromRecord(CAM, record()).stationSn).toBe(CAM);
  });

  it("answers one base's serial for each of its attached cameras", () => {
    const attached = [CAM, "T8114P0000000003"].map((sn) => Device.fromRecord(sn, record({ parentSn: BASE })));
    expect(attached.map((device) => device.stationSn)).toEqual([BASE, BASE]);
  });

  /** A record stating no parent is silent about topology, as it is about every other identity field. */
  it("keeps a parent a later record does not restate", () => {
    const device = Device.fromRecord(CAM, record({ parentSn: BASE }));
    device.reresolve(record());
    expect(device.stationSn).toBe(BASE);
  });
});
