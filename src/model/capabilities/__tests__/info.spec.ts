/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { INFO, type DeviceInfo } from "../info.js";
import { detectCapabilities } from "../index.js";
import type { CommandContext } from "../types.js";
import type { CommandSink } from "../../../core/contracts.js";

// A no-op sink — `info` is read-only and never dispatches, but `actions()` takes the arg positionally.
const SINK: CommandSink = { dispatch: async () => {} };

describe("info capability module", () => {
  it("declares a universal, read-only capability with no wire properties", () => {
    expect(INFO.capability).toBe("info");
    expect(INFO.properties).toEqual([]);
    expect(INFO.buildCommand).toBeUndefined();
    expect(INFO.events).toBeUndefined();
  });

  it("detection matches every device (all codecs)", () => {
    expect(INFO.detection?.detect?.({}, "camera")).toBe(true);
    expect(INFO.detection?.detect?.({}, "vacuum")).toBe(true);
    // …and it therefore shows up in the resolved capability set for any codec.
    expect(detectCapabilities({}, "camera")).toContain("info");
    expect(detectCapabilities({}, "vacuum")).toContain("info");
  });

  it("actions() projects the command context into a DeviceInfo object", () => {
    // Synthetic serial per the PII rule — never a real device serial.
    const ctx: CommandContext = {
      channel: 0,
      codec: "camera",
      paramIds: new Set(),
      model: "T8000P0000000000",
      serial: "T8000P0000000000",
      name: "Camera A",
      deviceType: 31,
      firmwareVersion: "3.8.2.8",
      hardwareVersion: "V05",
      firmwareSubVersion: "1.0.0.1",
      macAddress: "02:00:00:00:00:01",
      updateAvailable: true,
    };
    const info = INFO.actions!({ ctx, sink: SINK, read: () => undefined }) as unknown as DeviceInfo;
    expect(info).toEqual({
      manufacturer: "eufy",
      model: "T8000P0000000000",
      serialNumber: "T8000P0000000000",
      name: "Camera A",
      deviceType: 31,
      firmwareVersion: "3.8.2.8",
      hardwareVersion: "V05",
      firmwareSubVersion: "1.0.0.1",
      macAddress: "02:00:00:00:00:01",
      updateAvailable: true,
    });
  });

  it("manufacturer is constant and absent fields stay undefined (never fabricated)", () => {
    const ctx: CommandContext = { channel: 0, codec: "camera", paramIds: new Set() };
    const info = INFO.actions!({ ctx, sink: SINK, read: () => undefined }) as unknown as DeviceInfo;
    expect(info.manufacturer).toBe("eufy");
    expect(info.model).toBeUndefined();
    expect(info.serialNumber).toBeUndefined();
    expect(info.name).toBeUndefined();
    expect(info.firmwareVersion).toBeUndefined();
    expect(info.hardwareVersion).toBeUndefined();
    expect(info.firmwareSubVersion).toBeUndefined();
    expect(info.macAddress).toBeUndefined();
    expect(info.updateAvailable).toBeUndefined();
  });
});
