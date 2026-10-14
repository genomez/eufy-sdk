/**
 * Reading a single cell out of a map — the last step between the decoded planes and an answer.
 *
 * {@link VacuumMapPlane} and {@link VacuumRoomOutline} hand back their planes packed, because a large
 * map is a megabyte once every cell is its own byte. These are the lookups into them.
 *
 * **The two planes do not share a grid.** Each carries its own `origin` and its own `resolution`, and
 * nothing says they agree — so a cell index from one is not a cell index in the other. Everything here
 * converts through world coordinates for that reason, which costs two divisions and removes a class of
 * bug that would otherwise show up as room labels sliding a few cells off the rooms they name.
 *
 * @module model/map-pixels
 */
import { MAP_CELL_VALUES } from "./vacuum-map.js";
import type {
  MapCellValue,
  MapPoint,
  VacuumMapPlane,
  VacuumRoom,
  VacuumRoomOutline,
  VacuumRoomParams,
} from "./vacuum-map.js";

/** A cell's position in a plane, counting from the plane's own origin corner. */
export interface MapCell {
  readonly col: number;
  readonly row: number;
}

/**
 * What both planes have in common: a grid of a known size, anchored somewhere in the world.
 *
 * `VacuumMapGeometry` and `VacuumRoomOutline` both satisfy this, which is what lets one set of
 * conversions serve both without either knowing about the other.
 */
export interface PlacedPlane {
  readonly width: number;
  readonly height: number;
  /** Centimetres per cell. `undefined` when the device omitted it, and then nothing here can convert. */
  readonly resolution: number | undefined;
  /** Where cell `(0, 0)` is anchored, in centimetres. */
  readonly origin: MapPoint;
}

/**
 * Which cell covers a world position, or `undefined` when the position falls outside the plane.
 *
 * Both axes count UP: a larger `y` is a larger `row`. The vendor's own renderer flips the image
 * vertically before drawing it, which is a display choice and not a property of the data — reading the
 * flip back into the coordinates would put every lookup in the wrong half of the map.
 *
 * `undefined` also when the plane has no `resolution`, because there is then no scale to divide by and
 * a guessed one silently misplaces every lookup.
 */
export function cellAtPoint(plane: PlacedPlane, point: MapPoint): MapCell | undefined {
  if (!plane.resolution) return undefined;
  const col = Math.round((point.x - plane.origin.x) / plane.resolution);
  const row = Math.round((point.y - plane.origin.y) / plane.resolution);
  if (col < 0 || row < 0 || col >= plane.width || row >= plane.height) return undefined;
  return { col, row };
}

/**
 * Where a cell sits in the world, in centimetres — the inverse of {@link cellAtPoint}.
 *
 * The point returned is what the cell is anchored at, and `cellAtPoint` rounds to the nearest cell, so
 * the two round-trip. `undefined` for a cell outside the plane or a plane with no resolution.
 */
export function pointAtCell(plane: PlacedPlane, cell: MapCell): MapPoint | undefined {
  if (!plane.resolution) return undefined;
  if (cell.col < 0 || cell.row < 0 || cell.col >= plane.width || cell.row >= plane.height) return undefined;
  return { x: plane.origin.x + cell.col * plane.resolution, y: plane.origin.y + cell.row * plane.resolution };
}

/**
 * What one cell of the map is — floor, wall, carpet or unexplored.
 *
 * The plane packs four cells to a byte, two bits each, low bits first, in one run with no row padding:
 * the cell at `(col, row)` is at bit `(i & 3) * 2` of byte `i >> 2`, where `i = row * width + col`.
 * `undefined` for a cell outside the map.
 */
export function mapCellValue(map: VacuumMapPlane, cell: MapCell): MapCellValue | undefined {
  const { width, height } = map.geometry;
  if (cell.col < 0 || cell.row < 0 || cell.col >= width || cell.row >= height) return undefined;
  const i = cell.row * width + cell.col;
  const byte = map.cells[i >> 2];
  if (byte === undefined) return undefined;
  return MAP_CELL_VALUES[(byte >> ((i & 3) * 2)) & 3];
}

/** What the map says about a world position. */
export function mapCellValueAt(map: VacuumMapPlane, point: MapPoint): MapCellValue | undefined {
  const cell = cellAtPoint(map.geometry, point);
  return cell && mapCellValue(map, cell);
}

/**
 * Which room a cell of the ROOM OUTLINE belongs to, or `undefined` where none does.
 *
 * That plane is one byte per cell, and the byte is not the room id on its own: its low two bits carry
 * a sub-type and the id is what remains above them. A reader taking the whole byte reports room 4 as
 * room 19 and finds no such room in the list.
 *
 * A resulting id of `0` reads as `undefined`. Unmapped space and the gaps between rooms carry zero, and
 * there is no room 0 to look up — reporting it as an id would have a caller searching the room list for
 * something that was never in it.
 */
export function roomIdAt(outline: VacuumRoomOutline, cell: MapCell): number | undefined {
  if (cell.col < 0 || cell.row < 0 || cell.col >= outline.width || cell.row >= outline.height) return undefined;
  const byte = outline.cells[cell.row * outline.width + cell.col];
  if (byte === undefined) return undefined;
  const id = byte >> 2;
  return id === 0 ? undefined : id;
}

/** Which room covers a world position. */
export function roomIdAtPoint(outline: VacuumRoomOutline, point: MapPoint): number | undefined {
  const cell = cellAtPoint(outline, point);
  return cell && roomIdAt(outline, cell);
}

/**
 * The room at a world position, named — the join of the outline's room id with the room list.
 *
 * Takes the outline and the room list separately because the device sends them separately, on two
 * channels that arrive at different times: a caller holding one without the other gets `undefined`
 * rather than a wrong answer.
 */
export function roomAtPoint(
  outline: VacuumRoomOutline,
  rooms: VacuumRoomParams,
  point: MapPoint,
): VacuumRoom | undefined {
  const id = roomIdAtPoint(outline, point);
  return id === undefined ? undefined : rooms.rooms.find((r) => r.id === id);
}
