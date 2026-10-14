import { describe, expect, it } from "vitest";
import { decodeUsableVacuumSceneCount, decodeVacuumSceneCount, decodeVacuumScenes } from "../vacuum-scenes.js";
import { byteCodec, frame, int, str, sub } from "../../model/capabilities/__tests__/proto-bytes.js";

/**
 * `SceneResponse` on DP 180 — the saved-scene list.
 *
 * Real bytes rather than a stubbed field list, for the same reason the schedules decode needs them:
 * three of the readings here turn on a field being ABSENT, and one turns on a sentinel that a `uint32`
 * makes unrecognisable unless it is encoded the way the device encodes it.
 */

// SceneResponse.infos = 4, each a SceneInfo.
const report = (...infos: number[][]): string => frame(infos.flatMap((i) => sub(4, i)));

/** SceneInfo: id 1 { value 1 }, valid 2, invalid_reason 3, name 4, mapid 5, estimate 6, index 7, type 8. */
const scene = (o: {
  id?: number;
  valid?: boolean;
  reason?: number;
  name?: string;
  mapId?: number;
  estimate?: number;
  index?: number;
  type?: number;
}): number[] => [
  ...sub(1, int(1, o.id ?? 0)),
  ...int(2, o.valid === false ? 0 : 1),
  ...int(3, o.reason ?? 0),
  ...(o.name === undefined ? [] : str(4, o.name)),
  ...int(5, o.mapId ?? 0),
  ...int(6, o.estimate ?? 0),
  ...int(7, o.index ?? 1),
  ...int(8, o.type ?? 0),
];

describe("decodeVacuumScenes (SceneResponse → scenes)", () => {
  it("reads a scene in full", () => {
    const payload = report(scene({ id: 4, name: "After dinner", mapId: 2, estimate: 900, index: 3, type: 3 }));

    expect(decodeVacuumScenes(payload, byteCodec)).toEqual([
      {
        id: 4,
        name: "After dinner",
        valid: true,
        invalidReason: "none",
        mapId: 2,
        estimatedRuntime: 900,
        order: 3,
        type: "afterDinner",
      },
    ]);
  });

  it("reads several scenes out of one report", () => {
    const payload = report(
      scene({ id: 1, name: "Kitchen", mapId: 1, index: 1 }),
      scene({ id: 2, name: "Upstairs", mapId: 2, index: 2 }),
    );

    expect(decodeVacuumScenes(payload, byteCodec)?.map((s) => [s.id, s.name, s.mapId])).toEqual([
      [1, "Kitchen", 1],
      [2, "Upstairs", 2],
    ]);
  });

  it("answers an empty list for a robot with no scenes, not undefined", () => {
    expect(decodeVacuumScenes(frame([]), byteCodec)).toEqual([]);
  });

  it("keeps an invalid scene and says why", () => {
    // The device does not delete a scene whose map went away — it reports it unusable so the app can
    // explain itself. Dropping it here would lose the only account of why a scene stopped working.
    const payload = report(scene({ id: 5, name: "Old floor", valid: false, reason: 1, mapId: 9 }));

    expect(decodeVacuumScenes(payload, byteCodec)?.[0]).toMatchObject({
      valid: false,
      invalidReason: "mapMissing",
    });
  });

  it("names the vendor's retired DEFAULT reason rather than dropping it", () => {
    // `DEFAULT = 5` is retired by the vendor's own comment in favour of `type`, but a device still
    // sending it must not read as a decode failure.
    const payload = report(scene({ id: 6, reason: 5 }));
    expect(decodeVacuumScenes(payload, byteCodec)?.[0]?.invalidReason).toBe("legacyDefault");
  });

  it("calls an unknown scene type custom rather than throwing", () => {
    expect(decodeVacuumScenes(report(scene({ id: 7, type: 99 })), byteCodec)?.[0]?.type).toBe("custom");
  });
});

describe("decodeVacuumScenes — the map id", () => {
  it("reports the vendor's -2 sentinel as no map at all", () => {
    // `mapid` is a uint32 and the vendor documents -2 as invalid, so it arrives as 4294967294. Passing
    // that through as a map id would let a caller send an area-select frame naming a floor that does
    // not exist.
    const payload = report(scene({ id: 8, mapId: 0xff_ff_ff_fe }));
    expect(decodeVacuumScenes(payload, byteCodec)?.[0]?.mapId).toBeUndefined();
  });

  it("reports an omitted map as no map", () => {
    // proto3 omits a zero, so "tied to map 0" and "said nothing about a map" are the same bytes.
    expect(decodeVacuumScenes(report(scene({ id: 9 })), byteCodec)?.[0]?.mapId).toBeUndefined();
  });

  it("hands back a real map id, which is the point of this read", () => {
    // The plan expected map ids from B3 on DP 172. `multi_maps.proto` sends a map list over p2p
    // instead, leaving this — and a scheduled rooms-clean — as the DP-side sources.
    expect(decodeVacuumScenes(report(scene({ id: 10, mapId: 3 })), byteCodec)?.[0]?.mapId).toBe(3);
  });
});

describe("decodeVacuumScenes — absent fields", () => {
  it("reports an unnamed scene as having no name rather than an empty one", () => {
    expect(decodeVacuumScenes(report(scene({ id: 11 })), byteCodec)?.[0]?.name).toBeUndefined();
    expect(decodeVacuumScenes(report(scene({ id: 12, name: "" })), byteCodec)?.[0]?.name).toBeUndefined();
  });

  it("reports the vendor's zero estimate as unknown, not as instant", () => {
    expect(decodeVacuumScenes(report(scene({ id: 13 })), byteCodec)?.[0]?.estimatedRuntime).toBeUndefined();
    expect(decodeVacuumScenes(report(scene({ id: 14, estimate: 60 })), byteCodec)?.[0]?.estimatedRuntime).toBe(60);
  });

  it("refuses a payload it cannot read", () => {
    expect(decodeVacuumScenes(report(scene({ id: 1 })), undefined)).toBeUndefined();
    expect(decodeVacuumScenes(42, byteCodec)).toBeUndefined();
    expect(decodeVacuumScenes(undefined, byteCodec)).toBeUndefined();

    const good = Buffer.from(report(scene({ id: 1 })), "base64");
    expect(decodeVacuumScenes(good.subarray(0, good.length - 2).toString("base64"), byteCodec)).toBeUndefined();
  });
});

describe("the scene counts", () => {
  const payload = report(
    scene({ id: 1, name: "Kitchen", mapId: 1 }),
    scene({ id: 2, name: "Old floor", valid: false, reason: 2 }),
    scene({ id: 3, name: "Pets", mapId: 1, type: 4 }),
  );

  it("counts every scene the robot holds", () => {
    expect(decodeVacuumSceneCount(payload, byteCodec)).toBe(3);
  });

  it("counts only the scenes that can still run", () => {
    expect(decodeUsableVacuumSceneCount(payload, byteCodec)).toBe(2);
  });

  it("reports zero scenes rather than none at all", () => {
    expect(decodeVacuumSceneCount(frame([]), byteCodec)).toBe(0);
    expect(decodeUsableVacuumSceneCount(frame([]), byteCodec)).toBe(0);
  });

  it("carries the unreadable case through as undefined", () => {
    expect(decodeVacuumSceneCount("nonsense", byteCodec)).toBeUndefined();
    expect(decodeUsableVacuumSceneCount(undefined, byteCodec)).toBeUndefined();
  });
});
