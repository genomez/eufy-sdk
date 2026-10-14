import { beforeEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { EufyDevice } from "../../core/types.js";
import type { DeviceRegistry } from "../device-registry.js";
import { RtcCommandRouter } from "../../transport/rtc/command-router.js";

const targetSn = "T8000P0000000000";
const parentSn = "T8000P0000000001";
function cached(sn: string, model: string, deviceType?: unknown, stationSn?: string): EufyDevice {
  return {
    sn,
    model,
    stationSn,
    raw: { device_type: deviceType, device_name: "synthetic-private-name", session: "synthetic-private-session" },
  } as EufyDevice;
}
function client(roster: EufyDevice[]) {
  const eufy = new EufyMega({ email: "synthetic@example.com", password: "synthetic" });
  const internals = eufy as unknown as { registry: DeviceRegistry; rtcDevice(sn: string): EufyDevice | undefined };
  const list = vi.spyOn(internals.registry, "list").mockReturnValue(roster);
  const getDevices = vi.spyOn(internals.registry, "getDevices").mockImplementation(async () => {
    throw new Error("roster fetch");
  });
  const getDevice = vi.spyOn(eufy, "getDevice").mockImplementation(async () => {
    throw new Error("model lookup");
  });
  return { eufy, internals, list, getDevices, getDevice };
}

describe("retained cached device context", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([
    ["T9000", 10005, true],
    ["T8010", 0, false],
    ["T8030", 18, false],
    ["synthetic-unknown", undefined, false],
  ])("uses existing parent route authority for %s without family guesses", (model, deviceType, rtcMedia) => {
    const target = cached(targetSn, "T8214", 94, parentSn);
    const parent = cached(parentSn, model, deviceType);
    const fixture = client([target, parent]);
    const result = fixture.eufy.getCachedDeviceContext({ sn: targetSn, stationSn: parentSn });
    expect(result).toMatchObject({
      targetCached: true,
      parentCached: true,
      targetDeviceType: 94,
      topology: "attached",
      parentLink: "consistent",
      rtcDevice: false,
      rtcMedia,
    });
    expect(fixture.list).toHaveBeenCalledOnce();
    expect(fixture.getDevice).not.toHaveBeenCalled();
    expect(fixture.getDevices).not.toHaveBeenCalled();
    expect(fixture.internals.rtcDevice(targetSn)).toBe(rtcMedia ? target : undefined);
    expect(result.rtcMedia).toBe(RtcCommandRouter.claimsMedia(target, () => parent));
    if (typeof deviceType === "number" && deviceType > 0) expect(result.parentDeviceType).toBe(deviceType);
    else expect(result.parentDeviceType).toBeUndefined();
  });

  it("reports a self station and missing default-self as self-or-unknown", () => {
    const target = cached(targetSn, "T9000", 10005, targetSn);
    const fixture = client([target]);
    expect(fixture.eufy.getCachedDeviceContext({ sn: targetSn, stationSn: targetSn })).toEqual({
      targetCached: true,
      parentCached: false,
      targetDeviceType: 10005,
      topology: "self-or-unknown",
      parentLink: "consistent",
      rtcDevice: true,
      rtcMedia: false,
    });
    expect(fixture.internals.rtcDevice(targetSn)).toBe(target);
    target.stationSn = undefined;
    expect(fixture.eufy.getCachedDeviceContext({ sn: targetSn, stationSn: targetSn }).parentLink).toBe("consistent");
  });

  it("keeps missing parent and missing target explicit without fetching", () => {
    const fixture = client([cached(targetSn, "T8214", 94, parentSn)]);
    expect(fixture.eufy.getCachedDeviceContext({ sn: targetSn, stationSn: parentSn })).toEqual({
      targetCached: true,
      parentCached: false,
      targetDeviceType: 94,
      topology: "attached",
      parentLink: "consistent",
      rtcDevice: false,
      rtcMedia: false,
    });
    fixture.list.mockReturnValue([]);
    expect(fixture.eufy.getCachedDeviceContext({ sn: targetSn, stationSn: parentSn })).toEqual({
      targetCached: false,
      parentCached: false,
      topology: "attached",
      parentLink: "unknown",
      rtcDevice: false,
      rtcMedia: false,
    });
    expect(fixture.getDevices).not.toHaveBeenCalled();
    expect(fixture.getDevice).not.toHaveBeenCalled();
  });

  it("exposes a held-versus-roster parent conflict without choosing the held relation", () => {
    const fixture = client([cached(targetSn, "T8214", 94, parentSn), cached(parentSn, "T9000", 10005)]);
    expect(fixture.eufy.getCachedDeviceContext({ sn: targetSn, stationSn: "T8000P0000000002" })).toMatchObject({
      parentLink: "conflict",
      parentCached: true,
      parentDeviceType: 10005,
      rtcMedia: true,
    });
  });

  it("uses exactly one snapshot even when the registry would change on a second call", () => {
    const fixture = client([]);
    fixture.list
      .mockReturnValueOnce([cached(targetSn, "T8214", 94, parentSn), cached(parentSn, "T9000", 10005)])
      .mockReturnValue([]);
    expect(fixture.eufy.getCachedDeviceContext({ sn: targetSn, stationSn: parentSn }).rtcMedia).toBe(true);
    expect(fixture.list).toHaveBeenCalledOnce();
  });

  it.each([NaN, Infinity, -1, 0, 1.5, "94", Number.MAX_SAFE_INTEGER + 1])(
    "does not export invalid numeric families %j",
    (type) => {
      const fixture = client([cached(targetSn, "synthetic", type, parentSn), cached(parentSn, "synthetic", type)]);
      const result = fixture.eufy.getCachedDeviceContext({ sn: targetSn, stationSn: parentSn });
      expect(result.targetDeviceType).toBeUndefined();
      expect(result.parentDeviceType).toBeUndefined();
    },
  );

  it("does not export identities, raw records or command-target history and returns detached results", () => {
    const fixture = client([cached(targetSn, "T8214", 94, parentSn), cached(parentSn, "T9000", 10005)]);
    const commandContext = vi.spyOn(fixture.eufy, "getRtcObservationContext");
    const result = fixture.eufy.getCachedDeviceContext({ sn: targetSn, stationSn: parentSn });
    const text = JSON.stringify(result);
    for (const marker of [targetSn, parentSn, "T8214", "T9000", "synthetic-private-name", "synthetic-private-session"])
      expect(text).not.toContain(marker);
    (result as { targetDeviceType?: number }).targetDeviceType = 1;
    expect(fixture.eufy.getCachedDeviceContext({ sn: targetSn, stationSn: parentSn }).targetDeviceType).toBe(94);
    expect(commandContext).not.toHaveBeenCalled();
  });
});
