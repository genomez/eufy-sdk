import type { CommandContext } from "../types.js";
import {
  VACUUM_DOCK,
  DOCK_ACTIVITIES,
  decodeDockActivity,
  decodeDockFirmware,
  encodeStationCommand,
  type VacuumDockActions,
} from "../vacuum-dock.js";
import { bind } from "./bind.js";
import { byteCodec, frame, int, sub } from "./proto-bytes.js";

function dockCtx(model?: string, category?: string): CommandContext {
  return { channel: 0, codec: "vacuum", model, category, paramIds: new Set([173]) };
}

describe("vacuum_dock capability module", () => {
  it("declares the capability + schema", () => {
    expect(VACUUM_DOCK.capability).toBe("vacuum_dock");
    // writeOnly members are excluded from the property schema; the two reads are what remain.
    expect(VACUUM_DOCK.properties.map((p) => p.name)).toEqual(["dockFirmwareVersion", "dockState"]);
  });

  it("is detected by DP 173, not as a vacuum-codec baseline", () => {
    expect(VACUUM_DOCK.detection?.evidenceParams).toEqual([173]);
    expect(VACUUM_DOCK.detection?.codecs).toBeUndefined();
  });

  it("is a clean-line module", () => {
    expect(VACUUM_DOCK.line).toBe("clean");
  });
});

describe("vacuum_dock — write members are unverified (no setters installed)", () => {
  it("emptyDust / washMops / dryMops are absent on the bound object — unverified until StationRequest is captured", () => {
    const { acts } = bind<VacuumDockActions>("vacuum_dock", dockCtx("T2351"));
    // All write members are unverified — no setter is installed regardless of category.
    expect((acts as Record<string, unknown>).emptyDust).toBeUndefined();
    expect((acts as Record<string, unknown>).washMops).toBeUndefined();
    expect((acts as Record<string, unknown>).dryMops).toBeUndefined();
  });

  it("emptyDust / washMops / dryMops are also absent when model and category are both absent", () => {
    const { acts } = bind<VacuumDockActions>("vacuum_dock", dockCtx(undefined));
    expect((acts as Record<string, unknown>).emptyDust).toBeUndefined();
    expect((acts as Record<string, unknown>).washMops).toBeUndefined();
    expect((acts as Record<string, unknown>).dryMops).toBeUndefined();
  });

  it("dockState has a typed getter, and answers undefined without a bound codec", () => {
    const { acts } = bind<VacuumDockActions>("vacuum_dock", dockCtx("T2351"));
    expect("dockState" in (acts as object)).toBe(true);
    expect(acts.dockState).toBeUndefined();
  });

  it("declares its whole domain on the property schema, so a caller can offer the set", () => {
    const dockState = VACUUM_DOCK.members!.dockState as { decode?: unknown; decodedValues?: readonly unknown[] };
    expect(dockState.decode).toBeTypeOf("function");
    expect(dockState.decodedValues).toEqual(DOCK_ACTIVITIES);
  });
});

/** A `StationResponse` carrying the auto-maintenance config at #1 and the given status body at #2. */
function station(statusBody: number[]): string {
  return frame([...sub(1, [...sub(1, []), ...sub(2, [])]), ...sub(2, statusBody)]);
}

describe("decodeDockActivity (StationStatus → dock activity)", () => {
  it("reads the mop system's own state", () => {
    expect(decodeDockActivity(station(int(2, 1)), byteCodec)).toBe("washing");
    expect(decodeDockActivity(station(int(2, 2)), byteCodec)).toBe("drying");
    expect(decodeDockActivity(station(int(2, 3)), byteCodec)).toBe("descaling");
  });

  it("is idle when the status is present and states nothing — an absent state is IDLE, not missing", () => {
    expect(decodeDockActivity(station([]), byteCodec)).toBe("idle");
    expect(decodeDockActivity(station(int(1, 1)), byteCodec)).toBe("idle");
  });

  it("reads each independent subsystem", () => {
    expect(decodeDockActivity(station(int(3, 1)), byteCodec)).toBe("emptyingDust");
    expect(decodeDockActivity(station(int(4, 1)), byteCodec)).toBe("addingWater");
    expect(decodeDockActivity(station(int(5, 1)), byteCodec)).toBe("recyclingWater");
    expect(decodeDockActivity(station(int(6, 1)), byteCodec)).toBe("makingDisinfectant");
    expect(decodeDockActivity(station(int(7, 1)), byteCodec)).toBe("cuttingHair");
  });

  it("answers the most specific subsystem when several report at once", () => {
    expect(decodeDockActivity(station([...int(3, 1), ...int(4, 1), ...int(7, 1)]), byteCodec)).toBe("emptyingDust");
  });

  it("prefers a busy subsystem over the mop state", () => {
    expect(decodeDockActivity(station([...int(2, 2), ...int(3, 1)]), byteCodec)).toBe("emptyingDust");
  });

  it("reads a false subsystem flag as not running", () => {
    expect(decodeDockActivity(station([...int(3, 0), ...int(2, 1)]), byteCodec)).toBe("washing");
  });

  it("does not read the auto-maintenance config as status — field 1 is a different message", () => {
    expect(decodeDockActivity(frame(sub(1, [...sub(1, []), ...sub(2, []), ...sub(3, [])])), byteCodec)).toBeUndefined();
  });

  it("is unknown for a state value the dock's own status message does not declare", () => {
    expect(decodeDockActivity(station(int(2, 9)), byteCodec)).toBe("unknown");
  });

  it("is undefined for every way the dock has not stated an activity", () => {
    expect(decodeDockActivity(frame([]), byteCodec)).toBeUndefined();
    expect(decodeDockActivity(station(int(2, 1)), undefined)).toBeUndefined();
    expect(decodeDockActivity(undefined, byteCodec)).toBeUndefined();
    expect(decodeDockActivity(7, byteCodec)).toBeUndefined();
  });
});

/**
 * `DeviceInfo` (DP 169). Only the dock's nested block is read — the robot's own `software`(4) sits at
 * the top level and must not be mistaken for it.
 */
describe("decodeDockFirmware (DeviceInfo.station.software)", () => {
  /** A `DeviceInfo` carrying the robot's own firmware, and optionally the dock's block. */
  function deviceInfo(robotSw: string, dockSw?: string): string {
    const str = (field: number, v: string): number[] => sub(field, [...Buffer.from(v, "utf-8")]);
    return frame([...str(4, robotSw), ...(dockSw === undefined ? [] : sub(11, str(1, dockSw)))]);
  }

  it("reads the dock's version, not the robot's", () => {
    expect(decodeDockFirmware(deviceInfo("9.9.9", "1.2.3"), byteCodec)).toBe("1.2.3");
  });

  it("is undefined while the robot is not docked — no station block is normal", () => {
    expect(decodeDockFirmware(deviceInfo("9.9.9"), byteCodec)).toBeUndefined();
  });

  it("is undefined when the station block carries no version", () => {
    expect(decodeDockFirmware(frame(sub(11, [])), byteCodec)).toBeUndefined();
  });

  it("is undefined for every way it is not stated", () => {
    expect(decodeDockFirmware(frame([]), byteCodec)).toBeUndefined();
    expect(decodeDockFirmware(deviceInfo("9.9.9", "1.2.3"), undefined)).toBeUndefined();
    expect(decodeDockFirmware(undefined, byteCodec)).toBeUndefined();
    expect(decodeDockFirmware(7, byteCodec)).toBeUndefined();
  });
});

describe("StationRequest — frames built, deliberately not callable", () => {
  it("wraps one manual command in manual_cmd(2), set to true", () => {
    // go_collect_dust is field 3 of the oneof. The frame is StationRequest{ manual_cmd{ 3: true } }.
    const fields = byteCodec.decode(encodeStationCommand(3));
    expect(fields).toHaveLength(1);
    expect(fields?.[0]).toMatchObject({ field: 2, kind: "bytes" });
    expect(byteCodec.nested((fields?.[0] as { value: Buffer }).value)).toEqual([{ field: 3, kind: "int", value: 1n }]);
  });

  it("sets exactly one command per frame, as a oneof requires", () => {
    for (const cmd of [1, 2, 3, 4, 5, 6]) {
      const inner = byteCodec.nested((byteCodec.decode(encodeStationCommand(cmd))?.[0] as { value: Buffer }).value);
      expect(inner).toEqual([{ field: cmd, kind: "int", value: 1n }]);
    }
  });

  it("installs NO setter for any dock command, however plausible its frame", () => {
    // The whole point of `unverified`. These frames come from the vendor proto and have never been
    // driven on a device; an AIoT DP write is fire-and-forget, so a wrong one looks like success.
    // Having written the bytes must not be mistaken for having confirmed them.
    const { acts, sent } = bind<VacuumDockActions>("vacuum_dock", dockCtx("T2351", "eufy_home"));
    const a = acts as Record<string, unknown>;
    for (const name of ["emptyDust", "washMops", "dryMops", "selfMaintain", "removeScale", "cutHair"]) {
      expect(a[name]).toBeUndefined();
      expect(a[`set${name[0].toUpperCase()}${name.slice(1)}`]).toBeUndefined();
    }
    expect(sent).toEqual([]);
  });
});
