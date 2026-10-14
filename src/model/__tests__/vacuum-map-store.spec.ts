import { describe, expect, it } from "vitest";
import { VacuumMapStore } from "../vacuum-map-store.js";
import type { VacuumMapPlane, VacuumRoomOutline, VacuumRoomParams } from "../vacuum-map.js";

/**
 * Holding five separately-delivered pieces of one map, and knowing when they stop belonging together.
 *
 * The failure this exists to stop is not a crash. It is answering a room lookup by indexing one map's
 * room outline with another map's coordinates — a wrong answer indistinguishable from a right one,
 * which is why the stamping rules below are pinned rather than left to read as bookkeeping.
 */

const plane = (mapId: number | undefined, releases: number): VacuumMapPlane => ({
  frame: "full",
  mapId,
  name: "Ground floor",
  releases,
  index: 0,
  geometry: {
    width: 4,
    height: 2,
    resolution: 10,
    origin: { x: 0, y: 0 },
    angle: 0,
    quality: "effective",
    docks: [],
  },
  cells: Buffer.from([0xaa, 0xaa]),
});

const outline = (mapId: number | undefined, releases: number, id = 1): VacuumRoomOutline => ({
  mapId,
  releases,
  width: 4,
  height: 2,
  resolution: 10,
  origin: { x: 0, y: 0 },
  cells: Buffer.from(Array.from({ length: 8 }, () => id << 2)),
});

const rooms = (mapId: number | undefined, releases: number, name = "Kitchen"): VacuumRoomParams => ({
  mapId,
  releases,
  customEnabled: false,
  smartMode: false,
  rooms: [
    {
      id: 1,
      name,
      scene: "kitchen",
      sceneIndex: 1,
      floor: "tile",
      order: 1,
      settings: {
        cleanType: undefined,
        suction: undefined,
        mopLevel: undefined,
        cleanExtent: undefined,
        cleanTimes: undefined,
      },
    },
  ],
});

describe("assembling a map", () => {
  it("starts empty and answers nothing", () => {
    const store = new VacuumMapStore();
    expect(store.snapshot.mapId).toBeUndefined();
    expect(store.currentRoom).toBeUndefined();
  });

  it("keeps each piece as it arrives", () => {
    const store = new VacuumMapStore();
    store.apply({ kind: "plane", value: plane(4, 1) });
    store.apply({ kind: "outline", value: outline(4, 1) });

    expect(store.snapshot.mapId).toBe(4);
    expect(store.snapshot.plane?.name).toBe("Ground floor");
    expect(store.snapshot.outline?.width).toBe(4);
    expect(store.snapshot.rooms).toBeUndefined();
  });

  it("says whether a piece changed anything", () => {
    // The robot republishes its map throughout a clean. A caller emitting per change needs the store
    // to answer, or every listener wakes for a map it already has.
    const store = new VacuumMapStore();
    expect(store.apply({ kind: "rooms", value: rooms(4, 3) })).toBe(true);
    expect(store.apply({ kind: "rooms", value: rooms(4, 2) })).toBe(false);
  });

  it("drops an older revision and keeps the newer one", () => {
    const store = new VacuumMapStore();
    store.apply({ kind: "rooms", value: rooms(4, 3, "Kitchen") });
    store.apply({ kind: "rooms", value: rooms(4, 2, "Keuken") });

    expect(store.snapshot.rooms?.rooms[0].name).toBe("Kitchen");
  });

  it("accepts the same revision again, because a repeat is not a regression", () => {
    const store = new VacuumMapStore();
    store.apply({ kind: "rooms", value: rooms(4, 3, "Kitchen") });
    expect(store.apply({ kind: "rooms", value: rooms(4, 3, "Kitchen") })).toBe(true);
  });

  it("tracks revisions per piece, not across them", () => {
    // A room list at revision 9 must not make a cell plane at revision 2 look stale — they count
    // their own edits.
    const store = new VacuumMapStore();
    store.apply({ kind: "rooms", value: rooms(4, 9) });
    expect(store.apply({ kind: "plane", value: plane(4, 2) })).toBe(true);
    expect(store.snapshot.plane).toBeDefined();
  });
});

describe("switching maps", () => {
  it("throws away every piece of the old map", () => {
    // The whole point. A room outline from map 4 read with map 7's coordinates gives a confident wrong
    // answer, so nothing from the old map survives the switch.
    const store = new VacuumMapStore();
    store.apply({ kind: "plane", value: plane(4, 1) });
    store.apply({ kind: "outline", value: outline(4, 1) });
    store.apply({ kind: "rooms", value: rooms(4, 1) });

    store.apply({ kind: "plane", value: plane(7, 1) });

    expect(store.snapshot.mapId).toBe(7);
    expect(store.snapshot.plane?.mapId).toBe(7);
    expect(store.snapshot.outline).toBeUndefined();
    expect(store.snapshot.rooms).toBeUndefined();
  });

  it("does not let the old map's revisions hold back the new one's", () => {
    // Revision counters restart per map. Carrying them over would drop the new map's first frames as
    // stale and leave the store empty for as long as the counter took to catch up.
    const store = new VacuumMapStore();
    store.apply({ kind: "rooms", value: rooms(4, 40) });
    store.apply({ kind: "plane", value: plane(7, 1) });

    expect(store.apply({ kind: "rooms", value: rooms(7, 1) })).toBe(true);
    expect(store.snapshot.rooms?.mapId).toBe(7);
  });

  it("keeps the pose across a switch, because a position is not part of a map", () => {
    const store = new VacuumMapStore();
    store.apply({ kind: "pose", value: { x: 15, y: 5, theta: 0 } });
    store.apply({ kind: "plane", value: plane(4, 1) });
    store.apply({ kind: "plane", value: plane(7, 1) });

    expect(store.snapshot.pose).toEqual({ x: 15, y: 5, theta: 0 });
  });

  it("takes a piece that names no map without discarding anything", () => {
    // proto3 omits a zero, so "no map id" is a thing a real message says. Treating that as a different
    // map would clear the store on every such frame.
    const store = new VacuumMapStore();
    store.apply({ kind: "plane", value: plane(4, 1) });
    store.apply({ kind: "outline", value: outline(undefined, 1) });

    expect(store.snapshot.mapId).toBe(4);
    expect(store.snapshot.plane).toBeDefined();
    expect(store.snapshot.outline).toBeDefined();
  });
});

describe("currentRoom", () => {
  const ready = (): VacuumMapStore => {
    const store = new VacuumMapStore();
    store.apply({ kind: "outline", value: outline(4, 1) });
    store.apply({ kind: "rooms", value: rooms(4, 1) });
    return store;
  };

  it("names the room the robot is standing in", () => {
    const store = ready();
    store.apply({ kind: "pose", value: { x: 10, y: 0, theta: 0 } });

    expect(store.currentRoom).toMatchObject({ id: 1, name: "Kitchen" });
  });

  it("answers nothing while a piece it needs is missing", () => {
    // Four honest reasons for no answer, and none of them is an error worth guessing past.
    const noPose = ready();
    expect(noPose.currentRoom).toBeUndefined();

    const noRooms = new VacuumMapStore();
    noRooms.apply({ kind: "outline", value: outline(4, 1) });
    noRooms.apply({ kind: "pose", value: { x: 10, y: 0, theta: 0 } });
    expect(noRooms.currentRoom).toBeUndefined();
  });

  it("answers nothing for a robot outside the mapped area", () => {
    const store = ready();
    store.apply({ kind: "pose", value: { x: 5000, y: 5000, theta: 0 } });

    expect(store.currentRoom).toBeUndefined();
  });
});

describe("a MapBackup", () => {
  it("installs each part through the same path a lone piece takes", () => {
    const store = new VacuumMapStore();
    store.apply({
      kind: "backup",
      value: {
        description: { mapId: 4, releases: 1, name: "Ground floor", createCause: 0, createdAt: 1, lastUsedAt: 2 },
        map: plane(4, 1),
        outline: outline(4, 1),
        rooms: rooms(4, 1),
        zones: undefined,
      },
    });

    expect(store.snapshot).toMatchObject({ mapId: 4 });
    expect(store.snapshot.description?.name).toBe("Ground floor");
    expect(store.snapshot.zones).toBeUndefined();
  });

  it("does not clear what it does not carry", () => {
    // A backup with only a description is a rename. Reading its absent map as an empty one erases the
    // map the caller is holding.
    const store = new VacuumMapStore();
    store.apply({ kind: "plane", value: plane(4, 1) });
    store.apply({
      kind: "backup",
      value: {
        description: { mapId: 4, releases: 2, name: "Upstairs", createCause: 0, createdAt: 1, lastUsedAt: 2 },
        map: undefined,
        outline: undefined,
        rooms: undefined,
        zones: undefined,
      },
    });

    expect(store.snapshot.description?.name).toBe("Upstairs");
    expect(store.snapshot.plane).toBeDefined();
  });
});

describe("clear", () => {
  it("forgets everything, revisions included", () => {
    const store = new VacuumMapStore();
    store.apply({ kind: "rooms", value: rooms(4, 9) });
    store.clear();

    expect(store.snapshot.rooms).toBeUndefined();
    expect(store.apply({ kind: "rooms", value: rooms(4, 1) })).toBe(true);
  });
});
