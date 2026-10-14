import { describe, expect, it } from "vitest";
import { blob, byteCodec, frame, int, sint, str, sub } from "../capabilities/__tests__/proto-bytes.js";
import {
  decodeVacuumMap,
  decodeVacuumMapBackup,
  decodeVacuumMapDescription,
  decodeVacuumMapGeometry,
  decodeVacuumPose,
  decodeVacuumRestrictedZones,
  decodeVacuumRoomOutline,
  decodeVacuumRoomParams,
} from "../vacuum-map.js";

/**
 * The `stream.proto` map messages, decoded from real bytes.
 *
 * Fixtures are built with the byte-level double rather than a stubbed codec, because most of what
 * these decodes get right is about what is ABSENT: proto3 omits a zero, so "map 0" and "no map" are
 * the same bytes, and so are "resolution 0" and "no resolution". A flat field list cannot express that
 * and would let a wrong decode pass.
 */

/** A `Point`, whose x and y are `sint32` — zig-zag, and routinely negative on a real map. */
const point = (field: number, x: number, y: number): number[] => sub(field, [...sint(1, x), ...sint(2, y)]);
const pose = (field: number, x: number, y: number, theta: number): number[] =>
  sub(field, [...sint(1, x), ...sint(2, y), ...sint(3, theta)]);

/** A `MapInfo` big enough to be usable: 8×4 cells at 5 cm, origin south-west of zero. */
const mapInfo = (extra: number[] = []): number[] =>
  sub(6, [...int(2, 8), ...int(3, 4), ...int(4, 5), ...point(5, -150, -200), ...int(7, 2), ...int(9, 90), ...extra]);

/** Eight by four cells is 32 cells, four to the byte: exactly 8 bytes, uncompressed. */
const CELLS = Buffer.from([0x1b, 0x00, 0xff, 0x55, 0xaa, 0x01, 0x02, 0x03]);

const aMap = (over: { cells?: Buffer; size?: number; info?: number[] } = {}): string => {
  const cells = over.cells ?? CELLS;
  return frame([
    ...int(3, 0), // frame: I = full, which proto3 omits
    ...blob(4, cells),
    ...int(5, over.size ?? cells.length),
    ...(over.info ?? mapInfo()),
    ...str(7, "Ground floor"),
    ...int(8, 3),
    ...int(9, 12),
    ...sub(10, int(1, 5)),
  ]);
};

describe("decodeVacuumMap", () => {
  it("reads a frame, its geometry and its plane", () => {
    const map = decodeVacuumMap(aMap(), byteCodec);

    expect(map).toMatchObject({
      frame: "full",
      mapId: 3,
      name: "Ground floor",
      releases: 12,
      index: 5,
      geometry: {
        width: 8,
        height: 4,
        resolution: 5,
        origin: { x: -150, y: -200 },
        angle: 90,
        quality: "effective",
        docks: [],
      },
    });
    expect(map?.cells).toEqual(CELLS);
  });

  it("reads negative coordinates as negative", () => {
    // The trap this whole decoder turns on. Point.x is `sint32`, the codec reads every varint
    // unsigned, and left un-zigzagged -150 comes back as 299 — an origin on the wrong side of the
    // robot, and every wall and room label placed against it.
    expect(decodeVacuumMap(aMap(), byteCodec)?.geometry.origin).toEqual({ x: -150, y: -200 });
  });

  it("decompresses a plane whose length disagrees with pixel_size", () => {
    // There is no compression flag: the two disagreeing IS the flag. This block is liblz4's output for
    // 32 zero bytes — one literal, then a match at offset 1 running over bytes that do not exist yet.
    const compressed = Buffer.from("1f00010007500000000000", "hex");
    const map = decodeVacuumMap(aMap({ cells: compressed, size: 32 }), byteCodec);

    expect(map?.cells).toEqual(Buffer.alloc(32));
  });

  it("refuses a plane too short for the grid it claims", () => {
    // 8×4 needs 8 bytes. Seven would answer a lookup near the end out of whatever followed in memory,
    // which is a map that draws and draws wrongly.
    expect(decodeVacuumMap(aMap({ cells: CELLS.subarray(0, 7) }), byteCodec)).toBeUndefined();
  });

  it("accepts a plane longer than the grid, which is padding", () => {
    const padded = Buffer.concat([CELLS, Buffer.alloc(4)]);
    expect(decodeVacuumMap(aMap({ cells: padded }), byteCodec)?.cells).toEqual(padded);
  });

  it("refuses a frame with no usable dimensions", () => {
    // proto3 omits a zero, so a width of 0 and no width at all are the same bytes — and neither can be
    // indexed. Reporting the geometry anyway pushes the discovery downstream.
    expect(decodeVacuumMap(aMap({ info: sub(6, [...int(3, 4), ...int(4, 5)]) }), byteCodec)).toBeUndefined();
    expect(decodeVacuumMap(aMap({ info: [] }), byteCodec)).toBeUndefined();
  });

  it("refuses a frame whose plane will not decompress", () => {
    expect(decodeVacuumMap(aMap({ cells: Buffer.from([0xff, 0xff]), size: 32 }), byteCodec)).toBeUndefined();
  });

  it("declines anything that is not a payload", () => {
    expect(decodeVacuumMap(undefined, byteCodec)).toBeUndefined();
    expect(decodeVacuumMap("not base64 at all", byteCodec)).toBeUndefined();
    expect(decodeVacuumMap(aMap(), undefined)).toBeUndefined();
  });

  it("reports no resolution rather than inventing one", () => {
    // The reference integration substitutes 5 here without saying why. A guessed scale misplaces every
    // zone and every room label, silently.
    const noRes = sub(6, [...int(2, 8), ...int(3, 4)]);
    expect(decodeVacuumMap(aMap({ info: noRes }), byteCodec)?.geometry.resolution).toBeUndefined();
  });
});

describe("docks", () => {
  const v1 = [...pose(6, 10, 20, 157), ...pose(6, 30, 40, 0)];
  const v2 = [...sub(10, [...int(1, 1), ...pose(2, 50, 60, 314)])];

  it("reads the older list as plain chargers", () => {
    const docks = decodeVacuumMapGeometry(frame(mapInfoBody(v1)), byteCodec)?.docks;
    expect(docks).toEqual([
      { kind: "charger", pose: { x: 10, y: 20, theta: 157 } },
      { kind: "charger", pose: { x: 30, y: 40, theta: 0 } },
    ]);
  });

  it("prefers the newer list, and does not report both", () => {
    // A device that sends docks_v2 sends docks too. Reading both reports every dock twice — once
    // without its kind — which a host would draw as two bases in one room.
    const docks = decodeVacuumMapGeometry(frame(mapInfoBody([...v1, ...v2])), byteCodec)?.docks;
    expect(docks).toEqual([{ kind: "station", pose: { x: 50, y: 60, theta: 314 } }]);
  });
});

/** A `MapInfo` as a top-level message rather than nested inside a `Map`. */
function mapInfoBody(extra: number[]): number[] {
  return [...int(2, 8), ...int(3, 4), ...int(4, 5), ...extra];
}

describe("decodeVacuumRoomOutline", () => {
  const ROOM_CELLS = Buffer.from([0x04, 0x04, 0x08, 0x08, 0x0c, 0x0c, 0x00, 0x00]);
  const outline = (cells: Buffer = ROOM_CELLS, size = cells.length): string =>
    frame([
      ...int(1, 7),
      ...int(2, 3),
      ...int(3, 4),
      ...int(4, 2),
      ...int(5, 5),
      ...point(6, -100, -100),
      ...blob(7, cells),
      ...int(8, size),
    ]);

  it("reads the plane and its own origin", () => {
    // Its OWN origin, which is not the map's: a consumer looking up the room under a map cell has to
    // convert through world coordinates rather than reusing the index.
    expect(decodeVacuumRoomOutline(outline(), byteCodec)).toEqual({
      mapId: 7,
      releases: 3,
      width: 4,
      height: 2,
      resolution: 5,
      origin: { x: -100, y: -100 },
      cells: ROOM_CELLS,
    });
  });

  it("needs one byte per cell, not one bit", () => {
    // A different packing from the map plane, and the vendor states each separately. Sizing this one
    // like the other would accept a plane a quarter too short.
    expect(decodeVacuumRoomOutline(outline(ROOM_CELLS.subarray(0, 7)), byteCodec)).toBeUndefined();
  });
});

describe("decodeVacuumRoomParams", () => {
  const room = (id: number, body: number[]): number[] => sub(2, [...int(1, id), ...body]);
  const params = frame([
    ...int(1, 1), // custom_enable
    ...room(1, [...str(2, "Kitchen"), ...sub(3, int(1, 3)), ...sub(4, [...int(1, 4), ...sub(2, int(1, 1))])]),
    ...room(2, [
      ...sub(4, [...int(1, 2), ...sub(2, int(1, 2))]),
      ...sub(6, int(1, 3)),
      ...sub(7, [...sub(1, int(1, 2)), ...sub(2, int(1, 4)), ...sub(3, int(1, 1)), ...int(5, 2)]),
    ]),
    ...int(3, 7),
    ...int(4, 3),
    ...sub(6, int(1, 1)),
  ]);

  it("reads the room list", () => {
    const decoded = decodeVacuumRoomParams(params, byteCodec);

    expect(decoded).toMatchObject({ mapId: 7, releases: 3, customEnabled: true, smartMode: true });
    expect(decoded?.rooms).toHaveLength(2);
    expect(decoded?.rooms[0]).toMatchObject({
      id: 1,
      name: "Kitchen",
      floor: "tile",
      scene: "kitchen",
      sceneIndex: 1,
    });
  });

  it("reports an unnamed room as unnamed, with what the app would name it from", () => {
    // The vendor's own comment says the app labels an unnamed room from its type and index —
    // "Bedroom 2", in the user's language. A host can only do the same if the absence is reported.
    expect(decodeVacuumRoomParams(params, byteCodec)?.rooms[1]).toMatchObject({
      name: undefined,
      scene: "bedroom",
      sceneIndex: 2,
    });
  });

  it("reads a room's own clean settings on the vendor's suction scale, not DP 158's", () => {
    // `Fan.suction` 4 is Max+ here; on DP 158's scale 4 is BoostIQ. Naming this one through that scale
    // reports a mode the user never chose.
    expect(decodeVacuumRoomParams(params, byteCodec)?.rooms[1].settings).toEqual({
      cleanType: "sweepAndMop",
      suction: "maxPlus",
      mopLevel: "middle",
      cleanExtent: undefined,
      cleanTimes: 2,
    });
  });

  it("leaves a setting unset when its wrapper is absent, and zero when it is present-but-empty", () => {
    // The one place these can be told apart: an absent wrapper says nothing, a present empty one says
    // the enum's zero member.
    const only = frame([...sub(2, [...int(1, 9), ...sub(7, sub(1, []))])]);
    const settings = decodeVacuumRoomParams(only, byteCodec)?.rooms[0].settings;

    expect(settings?.cleanType).toBe("sweep");
    expect(settings?.suction).toBeUndefined();
    expect(settings?.mopLevel).toBeUndefined();
  });
});

describe("decodeVacuumRestrictedZones", () => {
  const quad = (field: number): number[] =>
    sub(field, [...point(1, -10, -10), ...point(2, 10, -10), ...point(3, 10, 10), ...point(4, -10, 10)]);
  const zones = frame([
    ...sub(1, [...point(1, 0, 0), ...point(2, -50, 120)]),
    ...quad(2),
    ...quad(3),
    ...quad(3),
    ...int(4, 7),
    ...int(5, 2),
    // A `suggestion`, which is deliberately not read — see below.
    ...sub(7, sub(1, [...int(1, 1), ...sub(2, [...point(1, 500, 500), ...point(2, 600, 600)])])),
  ]);

  it("reads walls and both kinds of zone", () => {
    const decoded = decodeVacuumRestrictedZones(zones, byteCodec);

    expect(decoded).toMatchObject({ mapId: 7, releases: 2 });
    expect(decoded?.virtualWalls).toEqual([{ from: { x: 0, y: 0 }, to: { x: -50, y: 120 } }]);
    expect(decoded?.noGoZones).toHaveLength(1);
    expect(decoded?.noMopZones).toHaveLength(2);
    expect(decoded?.noGoZones[0].corners[2]).toEqual({ x: 10, y: 10 });
  });

  it("does not fold suggested zones in with real ones", () => {
    // A suggestion is a zone the robot PROPOSED and the user has not accepted. Reporting it alongside
    // the accepted ones claims a restriction the robot is not enforcing.
    const decoded = decodeVacuumRestrictedZones(zones, byteCodec);
    expect(decoded?.virtualWalls).toHaveLength(1);
  });
});

describe("decodeVacuumMapDescription", () => {
  it("reads a map's identity", () => {
    const desc = frame([...str(2, "Upstairs"), ...int(3, 1), ...int(4, 1_700_000_000), ...int(6, 4), ...int(7, 9)]);

    expect(decodeVacuumMapDescription(desc, byteCodec)).toEqual({
      mapId: 4,
      releases: 9,
      name: "Upstairs",
      createCause: 1,
      createdAt: 1_700_000_000,
      lastUsedAt: undefined,
    });
  });
});

describe("decodeVacuumPose", () => {
  it("reads where the robot is", () => {
    expect(decodeVacuumPose(frame(pose(1, -320, 145, -157)), byteCodec)).toEqual({ x: -320, y: 145, theta: -157 });
  });

  it("declines a message with no pose in it", () => {
    expect(decodeVacuumPose(frame(int(2, 1)), byteCodec)).toBeUndefined();
  });
});

describe("decodeVacuumMapBackup", () => {
  it("reads each part through the same decoder that reads it alone", () => {
    const inner = (payload: string): number[] => [...Buffer.from(payload, "base64").subarray(1)];
    const backup = frame([
      ...sub(1, inner(frame([...str(2, "Upstairs"), ...int(6, 4)]))),
      ...sub(4, inner(frame([...sub(2, [...int(1, 1), ...str(2, "Hall")]), ...int(3, 4)]))),
    ]);
    const decoded = decodeVacuumMapBackup(backup, byteCodec);

    expect(decoded?.description).toMatchObject({ mapId: 4, name: "Upstairs" });
    expect(decoded?.rooms?.rooms[0]).toMatchObject({ id: 1, name: "Hall" });
  });

  it("leaves an absent part absent rather than making an empty one", () => {
    // A backup carrying only a description is a rename. Reading its missing `map` as an empty map
    // would erase the map a host is holding.
    const renameOnly = frame([...sub(1, [...Buffer.from(frame(str(2, "Attic")), "base64").subarray(1)])]);
    const decoded = decodeVacuumMapBackup(renameOnly, byteCodec);

    expect(decoded?.description?.name).toBe("Attic");
    expect(decoded?.map).toBeUndefined();
    expect(decoded?.outline).toBeUndefined();
    expect(decoded?.rooms).toBeUndefined();
    expect(decoded?.zones).toBeUndefined();
  });
});
