/**
 * The cleaning scenes a robot holds — `SceneResponse` on DP 180, decoded.
 *
 * A scene is a saved routine: which rooms or zones, in what order, with which clean parameters. The
 * robot reports the LIST over this DP — ids, names, the map each belongs to, whether each still works
 * — while the tasks inside a scene are only ever sent, never reported. So this reads what the device
 * publishes and does not pretend to the rest.
 *
 * **A real `mapId` is on this DP.** Multi-map management on DP 172 cannot supply one:
 * `multi_maps.proto` states outright that a `MAP_GET_ALL` or `MAP_GET_ONE` response travels over p2p
 * rather than the data point, leaving DP 172 carrying only the method, sequence and result of an
 * operation. `SceneInfo.mapid` is on the DP, and so is a scheduled rooms-clean's `map_id` — two reads
 * that carry the id the area-select frames need, with no p2p transfer and no default invented for them.
 *
 * @module model/vacuum-scenes
 */
import type { RawDpCodec, RawDpField } from "../core/contracts.js";
import { each, flag, int, sub, text } from "./proto-read.js";

/**
 * Why the device considers a scene unusable. `"none"` is the healthy case — the vendor's `NORMAL`,
 * which every working scene reports.
 *
 * `"legacyDefault"` is the vendor's own dead value: its comment retires `DEFAULT = 5` in favour of the
 * `type` field, so a device still sending it is naming a default scene the old way. Kept named rather
 * than dropped, because a value that arrives and has no name reads as a decode failure.
 */
export const SCENE_INVALID_REASONS = [
  "none",
  "mapMissing",
  "mapUnavailable",
  "mapMismatch",
  "other",
  "legacyDefault",
] as const;
export type SceneInvalidReason = (typeof SCENE_INVALID_REASONS)[number];

/** The vendor's four built-in scenes, and `"custom"` for one a user made. */
export const SCENE_TYPES = ["custom", "wholeHouseDaily", "wholeHouseDeep", "afterDinner", "petArea"] as const;
export type SceneType = (typeof SCENE_TYPES)[number];

/** One saved scene, as the robot reports it. */
export interface VacuumScene {
  /** The device's own id for this scene — what `encodeSceneClean` takes to run it. */
  readonly id: number;
  /** The scene's name. `undefined` when the device sent none, which a built-in scene does. */
  readonly name: string | undefined;
  /** Whether the scene can still run. A scene whose map was deleted is kept and reported invalid. */
  readonly valid: boolean;
  /** Why it cannot run. `"none"` while {@link valid} — the vendor reports both fields either way. */
  readonly invalidReason: SceneInvalidReason | undefined;
  /**
   * The map this scene's rooms belong to, and one of the two real map ids the device reports — the
   * other being a scheduled rooms-clean's.
   *
   * `undefined` when the device sends its no-map sentinel, which is `-2` written into a `uint32`, and
   * `undefined` for a zero as well: proto3 omits a zero-valued field, so a scene tied to map 0 and one
   * that said nothing about a map are the same bytes. Reporting "no map" for both is the reading that
   * cannot send a clean at the wrong floor.
   */
  readonly mapId: number | undefined;
  /**
   * How long the device expects a run to take, as it reports it. `undefined` for the vendor's `0`,
   * which its own comment marks invalid rather than instant.
   *
   * **The unit is not stated anywhere.** Every other duration on this line is seconds, which is a
   * reason to expect seconds and not a reason for this SDK to claim it — so the number is reported as
   * sent and named for what it is.
   */
  readonly estimatedRuntime: number | undefined;
  /** Where the scene sits in the list the app shows, counting from 1. */
  readonly order: number;
  /** Whether this is one of the vendor's built-in scenes, and which. */
  readonly type: SceneType;
}

/** Field numbers inside `SceneResponse` (DP 180). */
const RESPONSE_FIELD = { METHOD: 1, SEQ: 2, RESULT: 3, INFOS: 4 } as const;

/** Field numbers inside `SceneInfo`, and its `Id` wrapper. */
const SCENE_FIELD = {
  ID: 1,
  VALID: 2,
  INVALID_REASON: 3,
  NAME: 4,
  MAP_ID: 5,
  ESTIMATE_TIME: 6,
  INDEX: 7,
  TYPE: 8,
} as const;
const ID_FIELD = { VALUE: 1 } as const;

/**
 * The device's "this scene has no map" sentinel: the vendor's documented `-2`, and the field is a
 * `uint32`, so it arrives as `-2` reinterpreted rather than as a negative number.
 *
 * Reported as `undefined` rather than passed through. Four billion is not a map id, and taken for one
 * it would name a floor that does not exist in an area-select frame.
 */
const NO_MAP = 0xff_ff_ff_fe;

/** Decode one `SceneInfo`. */
function sceneOf(codec: RawDpCodec, info: readonly RawDpField[]): VacuumScene {
  const mapId = int(info, SCENE_FIELD.MAP_ID);
  const estimate = int(info, SCENE_FIELD.ESTIMATE_TIME);

  return {
    id: int(sub(codec, info, SCENE_FIELD.ID), ID_FIELD.VALUE),
    name: text(info, SCENE_FIELD.NAME),
    valid: flag(info, SCENE_FIELD.VALID),
    invalidReason: SCENE_INVALID_REASONS[int(info, SCENE_FIELD.INVALID_REASON)],
    // Both the sentinel and the proto3 zero mean "no usable map here" — see `VacuumScene.mapId`.
    mapId: mapId === NO_MAP || mapId === 0 ? undefined : mapId,
    estimatedRuntime: estimate === 0 ? undefined : estimate,
    order: int(info, SCENE_FIELD.INDEX),
    type: SCENE_TYPES[int(info, SCENE_FIELD.TYPE)] ?? "custom",
  };
}

/**
 * Decode a `SceneResponse` (DP 180) to the scenes it reports, or `undefined`.
 *
 * `undefined` means the payload could not be read — no codec, not a Raw-DP value, malformed bytes. An
 * **empty array** is a different answer: the device reports its scenes in full on boot and after any
 * change, so a report carrying none says this robot has no scenes saved.
 */
export function decodeVacuumScenes(raw: unknown, codec: RawDpCodec | undefined): readonly VacuumScene[] | undefined {
  if (typeof raw !== "string" || !codec) return undefined;
  const report = codec.decode(raw);
  if (!report) return undefined;
  return each(codec, report, RESPONSE_FIELD.INFOS).map((info) => sceneOf(codec, info));
}

/** How many scenes the robot holds, or `undefined` when the payload could not be read. */
export function decodeVacuumSceneCount(raw: unknown, codec: RawDpCodec | undefined): number | undefined {
  return decodeVacuumScenes(raw, codec)?.length;
}

/** How many of the reported scenes can still run. */
export function decodeUsableVacuumSceneCount(raw: unknown, codec: RawDpCodec | undefined): number | undefined {
  return decodeVacuumScenes(raw, codec)?.filter((s) => s.valid).length;
}
