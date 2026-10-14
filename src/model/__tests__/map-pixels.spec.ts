import { describe, expect, it } from "vitest";
import {
  cellAtPoint,
  mapCellValue,
  mapCellValueAt,
  pointAtCell,
  roomAtPoint,
  roomIdAt,
  roomIdAtPoint,
} from "../map-pixels.js";
import type { PlacedPlane } from "../map-pixels.js";
import type { VacuumMapPlane, VacuumRoomOutline, VacuumRoomParams } from "../vacuum-map.js";

/**
 * Cell lookups over hand-built planes.
 *
 * The packing is the whole subject here, so the fixtures below are written as bit and byte patterns
 * with the expected reading stated beside them — a plane built by the same arithmetic the reader uses
 * would agree with any bug it had.
 */

/** A 4×2 map. Cells run `row * width + col`, four to a byte, low bits first. */
const MAP: VacuumMapPlane = {
  frame: "full",
  mapId: 1,
  name: undefined,
  releases: 0,
  index: 0,
  geometry: {
    width: 4,
    height: 2,
    resolution: 5,
    origin: { x: -100, y: -50 },
    angle: 0,
    quality: "effective",
    docks: [],
  },
  // Row 0 = cells 0..3 = unknown, obstacle, free, carpet → 00 11 10 01 read low-first = 0b11_10_01_00.
  // Row 1 = cells 4..7 = free, free, unknown, obstacle    → 0b01_00_10_10.
  cells: Buffer.from([0b11_10_01_00, 0b01_00_10_10]),
};

describe("mapCellValue", () => {
  it("reads the four cells of a byte low bits first", () => {
    expect(mapCellValue(MAP, { col: 0, row: 0 })).toBe("unknown");
    expect(mapCellValue(MAP, { col: 1, row: 0 })).toBe("obstacle");
    expect(mapCellValue(MAP, { col: 2, row: 0 })).toBe("free");
    expect(mapCellValue(MAP, { col: 3, row: 0 })).toBe("carpet");
  });

  it("runs straight on into the next byte, with no row padding", () => {
    // The row boundary is not a byte boundary on a width that does not divide by four; here it happens
    // to be, and the second row still has to come from the second byte's low bits.
    expect(mapCellValue(MAP, { col: 0, row: 1 })).toBe("free");
    expect(mapCellValue(MAP, { col: 3, row: 1 })).toBe("obstacle");
  });

  it("has nothing to say about a cell outside the map", () => {
    expect(mapCellValue(MAP, { col: 4, row: 0 })).toBeUndefined();
    expect(mapCellValue(MAP, { col: 0, row: 2 })).toBeUndefined();
    expect(mapCellValue(MAP, { col: -1, row: 0 })).toBeUndefined();
  });

  it("crosses a byte on a width that does not divide by four", () => {
    // width 3: cell (0,1) is index 3, still in byte 0 — the case a row-padded reader gets wrong.
    const narrow: VacuumMapPlane = {
      ...MAP,
      geometry: { ...MAP.geometry, width: 3, height: 2 },
      cells: Buffer.from([0b01_00_00_00, 0b00_00_00_10]),
    };
    expect(mapCellValue(narrow, { col: 0, row: 1 })).toBe("obstacle");
    expect(mapCellValue(narrow, { col: 1, row: 1 })).toBe("free");
  });
});

describe("cellAtPoint", () => {
  const plane: PlacedPlane = MAP.geometry;

  it("places the origin at cell zero", () => {
    expect(cellAtPoint(plane, { x: -100, y: -50 })).toEqual({ col: 0, row: 0 });
  });

  it("counts rows UP with y, as the data does", () => {
    // The vendor's renderer flips the image before drawing it. That is a display choice; reading the
    // flip back into the coordinates puts every lookup in the wrong half of the map.
    expect(cellAtPoint(plane, { x: -100, y: -45 })).toEqual({ col: 0, row: 1 });
  });

  it("rounds to the nearest cell", () => {
    expect(cellAtPoint(plane, { x: -98, y: -50 })).toEqual({ col: 0, row: 0 });
    expect(cellAtPoint(plane, { x: -97, y: -50 })).toEqual({ col: 1, row: 0 });
  });

  it("refuses a position off the plane rather than clamping to its edge", () => {
    // Clamping would answer "the robot is in the corner room" for a robot that is not on this map.
    expect(cellAtPoint(plane, { x: -200, y: -50 })).toBeUndefined();
    expect(cellAtPoint(plane, { x: 0, y: 0 })).toBeUndefined();
  });

  it("cannot convert without a resolution, and does not invent one", () => {
    expect(cellAtPoint({ ...plane, resolution: undefined }, { x: -100, y: -50 })).toBeUndefined();
  });

  it("round-trips with pointAtCell", () => {
    for (const cell of [
      { col: 0, row: 0 },
      { col: 3, row: 1 },
      { col: 2, row: 0 },
    ]) {
      const point = pointAtCell(plane, cell);
      expect(point, `${cell.col},${cell.row}`).toBeDefined();
      expect(cellAtPoint(plane, point!)).toEqual(cell);
    }
  });
});

describe("the room plane", () => {
  /**
   * A 4×2 outline on its OWN origin and its own resolution — deliberately different from the map's, so
   * a lookup that reused the map's cell index would land somewhere else.
   */
  const OUTLINE: VacuumRoomOutline = {
    mapId: 1,
    releases: 0,
    width: 4,
    height: 2,
    resolution: 10,
    origin: { x: -95, y: -50 },
    // One byte per cell; the low two bits are a sub-type, so the id is the byte shifted down by two.
    cells: Buffer.from([0x00, 0x04, 0x05, 0x08, 0x0c, 0x0c, 0x10, 0x00]),
  };

  const ROOMS: VacuumRoomParams = {
    mapId: 1,
    releases: 0,
    customEnabled: false,
    smartMode: false,
    rooms: [
      { id: 1, name: "Kitchen", scene: "kitchen", sceneIndex: 1, floor: "tile", order: 1, settings: BLANK() },
      { id: 3, name: undefined, scene: "bedroom", sceneIndex: 2, floor: "wood", order: 2, settings: BLANK() },
    ],
  };

  it("takes the id from above the low two bits", () => {
    // 0x05 is room 1 with sub-type 1. A reader taking the whole byte calls it room 5 and then finds no
    // such room in the list.
    expect(roomIdAt(OUTLINE, { col: 1, row: 0 })).toBe(1);
    expect(roomIdAt(OUTLINE, { col: 2, row: 0 })).toBe(1);
    expect(roomIdAt(OUTLINE, { col: 3, row: 0 })).toBe(2);
  });

  it("reports unassigned space as no room, not as room zero", () => {
    // There is no room 0 to look up; returning the id would send a caller searching the list for it.
    expect(roomIdAt(OUTLINE, { col: 0, row: 0 })).toBeUndefined();
    expect(roomIdAt(OUTLINE, { col: 3, row: 1 })).toBeUndefined();
  });

  it("uses the outline's own grid and not the map's", () => {
    // One world position, two planes, two DIFFERENT cell indices — the origins and resolutions differ,
    // so reusing the map's index here would read the wrong cell of the outline. Converting through the
    // world is what keeps a room label on its room.
    const world = { x: -85, y: -50 };
    expect(cellAtPoint(MAP.geometry, world)).toEqual({ col: 3, row: 0 });
    expect(cellAtPoint(OUTLINE, world)).toEqual({ col: 1, row: 0 });
    expect(roomIdAtPoint(OUTLINE, world)).toBe(1);
  });

  it("names the room at a position", () => {
    expect(roomAtPoint(OUTLINE, ROOMS, { x: -85, y: -50 })).toMatchObject({ id: 1, name: "Kitchen" });
    expect(roomAtPoint(OUTLINE, ROOMS, { x: -95, y: -40 })).toMatchObject({ id: 3, scene: "bedroom" });
  });

  it("answers nothing for a room the list does not carry", () => {
    // Cell (2,1) is room 3 by id; cell (0,1) is room 3 too. Room 4 (0x10) is in the plane but absent
    // from the list, which happens while the two channels are out of step.
    expect(roomIdAt(OUTLINE, { col: 2, row: 1 })).toBe(4);
    expect(roomAtPoint(OUTLINE, ROOMS, pointAtCell(OUTLINE, { col: 2, row: 1 })!)).toBeUndefined();
  });
});

describe("mapCellValueAt", () => {
  it("goes from a world position to what the map says is there", () => {
    expect(mapCellValueAt(MAP, { x: -85, y: -50 })).toBe("carpet");
  });

  it("says nothing about a position off the map", () => {
    expect(mapCellValueAt(MAP, { x: 500, y: 500 })).toBeUndefined();
  });
});

function BLANK() {
  return {
    cleanType: undefined,
    suction: undefined,
    mopLevel: undefined,
    cleanExtent: undefined,
    cleanTimes: undefined,
  };
}
