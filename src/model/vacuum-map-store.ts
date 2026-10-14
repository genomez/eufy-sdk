/**
 * One robot's map, assembled from the pieces the device sends separately.
 *
 * The map is not one message. Its geometry and cells arrive on one channel, which cell belongs to
 * which room on a second, the rooms' names and settings on a third, the user's virtual walls on a
 * fourth, and the robot's own position on a fifth — each on its own schedule, and each a whole
 * replacement for the last of its kind rather than a patch. Holding "the map" therefore means holding
 * five things and knowing when they stop belonging together.
 *
 * **That is the entire job here, and it is not bookkeeping.** Every piece carries the `mapId` it
 * belongs to and a `releases` counter that advances whenever the map is edited. A store that ignored
 * them would happily answer a room lookup by indexing last week's room outline with this week's
 * coordinates — a wrong answer that looks exactly like a right one. So a piece from a different map
 * replaces everything, and a piece from an older revision of the same map is dropped.
 *
 * Pure and synchronous: no transport, no clock, no I/O. What arrives is decided by the caller.
 *
 * @module model/vacuum-map-store
 */
import { roomAtPoint } from "./map-pixels.js";
import type {
  MapPose,
  VacuumMapBackup,
  VacuumMapDescription,
  VacuumMapPlane,
  VacuumRestrictedZones,
  VacuumRoom,
  VacuumRoomOutline,
  VacuumRoomParams,
} from "./vacuum-map.js";

/** Everything the store currently holds about one map. Any piece may be absent until it arrives. */
export interface VacuumMapSnapshot {
  /**
   * Which map these pieces describe, or `undefined` when nothing carrying an id has arrived yet.
   *
   * A robot with several floors saved sends whichever is loaded. When this changes, every piece below
   * is from the new map — the store does not merge across maps.
   */
  readonly mapId: number | undefined;
  readonly plane: VacuumMapPlane | undefined;
  readonly outline: VacuumRoomOutline | undefined;
  readonly rooms: VacuumRoomParams | undefined;
  readonly zones: VacuumRestrictedZones | undefined;
  readonly description: VacuumMapDescription | undefined;
  /**
   * Where the robot was when it last said so.
   *
   * Kept across a map switch, unlike everything else: a pose is a position in the world and does not
   * belong to a map. It may fall outside the new map's bounds, in which case a lookup answers nothing.
   */
  readonly pose: MapPose | undefined;
}

/** A piece the store can be given, tagged by which one it is. */
export type VacuumMapPiece =
  | { readonly kind: "plane"; readonly value: VacuumMapPlane }
  | { readonly kind: "outline"; readonly value: VacuumRoomOutline }
  | { readonly kind: "rooms"; readonly value: VacuumRoomParams }
  | { readonly kind: "zones"; readonly value: VacuumRestrictedZones }
  | { readonly kind: "description"; readonly value: VacuumMapDescription }
  | { readonly kind: "pose"; readonly value: MapPose }
  | { readonly kind: "backup"; readonly value: VacuumMapBackup };

/** The pieces that name a map and a revision — everything except a pose, which belongs to the world. */
type StampedKind = "plane" | "outline" | "rooms" | "zones" | "description";

const EMPTY: VacuumMapSnapshot = {
  mapId: undefined,
  plane: undefined,
  outline: undefined,
  rooms: undefined,
  zones: undefined,
  description: undefined,
  pose: undefined,
};

/**
 * Holds the current map for one device, and answers questions about it.
 *
 * Created empty and filled by {@link VacuumMapStore.apply}. Every getter answers `undefined` until the
 * pieces it needs have arrived, rather than answering from a partial map.
 */
export class VacuumMapStore {
  private current: VacuumMapSnapshot = EMPTY;

  /** The highest revision seen per piece, so an out-of-order repeat cannot overwrite a newer one. */
  private readonly revisions = new Map<StampedKind, number>();

  /** What the store holds right now. A new object whenever anything changed, the same one when not. */
  get snapshot(): VacuumMapSnapshot {
    return this.current;
  }

  /**
   * Take one piece, and say whether it changed anything.
   *
   * `false` means the piece was stale — an older revision of a map already held — and was dropped. The
   * device repeats its map frequently, so the return is what tells a repeat from a change.
   */
  apply(piece: VacuumMapPiece): boolean {
    switch (piece.kind) {
      case "backup":
        return this.applyBackup(piece.value);
      case "pose":
        // A pose belongs to the world, not to a map. It carries no stamp and resets nothing.
        this.current = { ...this.current, pose: piece.value };
        return true;
      case "plane":
        return this.put("plane", piece.value, piece.value.mapId, piece.value.releases);
      case "outline":
        return this.put("outline", piece.value, piece.value.mapId, piece.value.releases);
      case "rooms":
        return this.put("rooms", piece.value, piece.value.mapId, piece.value.releases);
      case "zones":
        return this.put("zones", piece.value, piece.value.mapId, piece.value.releases);
      case "description":
        return this.put("description", piece.value, piece.value.mapId, piece.value.releases);
    }
  }

  /** Forget everything. For a device going away, or a caller starting over. */
  clear(): void {
    this.current = EMPTY;
    this.revisions.clear();
  }

  /**
   * Which room the robot is standing in, or `undefined`.
   *
   * `undefined` covers every honest reason there is no answer: no pose yet, no room outline yet, no
   * room list yet, a robot outside the mapped area, or a cell belonging to no room. None of those is
   * an error, and none should be reported as a guess.
   */
  get currentRoom(): VacuumRoom | undefined {
    const { pose, outline, rooms } = this.current;
    if (!pose || !outline || !rooms) return undefined;
    return roomAtPoint(outline, rooms, pose);
  }

  /**
   * Apply a whole `MapBackup` as the several pieces it contains.
   *
   * Each part goes through the same path a lone piece takes, so a backup cannot install something a
   * live frame would have rejected. Parts the device omitted are skipped rather than clearing what is
   * held: a backup carrying only a description is a rename.
   */
  private applyBackup(backup: VacuumMapBackup): boolean {
    let changed = false;
    for (const piece of piecesOf(backup)) changed = this.apply(piece) || changed;
    return changed;
  }

  /**
   * Store one stamped piece, dropping it when it is older than the piece of its kind already held.
   *
   * The map-switch check comes first and is the important one: a piece naming a different map is not
   * an update, it is a different map. Everything held describes the old one, and a room outline read
   * with the new map's coordinates gives a wrong answer that looks exactly like a right one.
   */
  private put<K extends StampedKind>(
    kind: K,
    value: NonNullable<VacuumMapSnapshot[K]>,
    mapId: number | undefined,
    releases: number,
  ): boolean {
    if (mapId !== undefined && this.current.mapId !== undefined && mapId !== this.current.mapId) {
      this.current = { ...EMPTY, pose: this.current.pose, mapId };
      this.revisions.clear();
    }

    const seen = this.revisions.get(kind);
    if (seen !== undefined && releases < seen) return false;
    this.revisions.set(kind, releases);

    this.current = { ...this.current, mapId: mapId ?? this.current.mapId, [kind]: value };
    return true;
  }
}

/** The parts of a backup the device actually sent, as pieces. */
function piecesOf(backup: VacuumMapBackup): VacuumMapPiece[] {
  const out: VacuumMapPiece[] = [];
  if (backup.description) out.push({ kind: "description", value: backup.description });
  if (backup.map) out.push({ kind: "plane", value: backup.map });
  if (backup.outline) out.push({ kind: "outline", value: backup.outline });
  if (backup.rooms) out.push({ kind: "rooms", value: backup.rooms });
  if (backup.zones) out.push({ kind: "zones", value: backup.zones });
  return out;
}
