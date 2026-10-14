import { propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/**
 * Every `keypad` feature, declared once. Only `rssi` is a verified read.
 *
 * The battery pair is `unexposed`: both ids are placeholders, and the keypad's real battery state is
 * reported under model-specific params (`keypadBatteryCapState` / `keypadBatteryChargerState`, seen
 * live) whose low/charging semantics are not confirmed. They stay in the schema so a diagnosis can
 * reach them through `getProperty`, with no typed getter asserting a meaning this SDK cannot back.
 * A live probe of the fleet's T8960 confirms neither is reported at all today.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const KEYPAD_MEMBERS = {
  /**
   * `unexposed`, so it reaches a diagnosis through `getProperty` but gets no typed getter. 1103 is a
   * placeholder AND a likely collision — the app's own param table names 1103 GET_CAMERA_INFO — so a
   * getter here would be asserting a meaning nothing backs. The keypad's real battery state arrives
   * under `keypadBatteryCapState`, whose low/charging semantics are not confirmed.
   */
  batteryLow: {
    param: 1103,
    type: "bool",
    kind: "boolean",
    provenance: "guessed",
    unexposed: true,
    description:
      "Keypad low-battery flag. UNVERIFIED: placeholder id pending verification — and the app's own " +
      "param table names 1103 GET_CAMERA_INFO, so the id is very likely wrong here.",
  },
  /**
   * The charging half of the battery pair, `unexposed` for the same reason as `batteryLow`: 1102 is a
   * placeholder id, and the state the keypad actually reports (`keypadBatteryChargerState`) has no
   * confirmed value space. In the schema for `getProperty`, absent from the typed surface.
   */
  charging: {
    param: 1102,
    type: "bool",
    kind: "boolean",
    provenance: "guessed",
    unexposed: true,
    description: "Keypad charging flag. UNVERIFIED: placeholder id pending verification.",
  },
  /**
   * The keypad's link quality in dBm — the one verified read in this table, on the same param 1141 the
   * other sub-1G sensors report signal strength on. Reported as the device measures it: raw dBm, never
   * normalised to a bar count.
   */
  rssi: {
    param: 1141,
    type: "number",
    unit: "dBm",
    kind: "dbm",
    provenance: "verified",
    description: "Keypad signal strength (verified: param 1141 = RSSI).",
  },
} as const satisfies Members;

/** Bound keypad reads — the object returned by `dev.keypad()`. Read-only. */
export type KeypadActions = Surface<typeof KEYPAD_MEMBERS>;

/** `keypad` — security keypad. Battery low/charging and signal. Param ids here are placeholders apart from RSSI. */
export const KEYPAD: CapabilityModule = {
  capability: "keypad",
  description: "Security keypad battery and signal state.",
  members: KEYPAD_MEMBERS,
  properties: propertiesOf(KEYPAD_MEMBERS),
  detection: { codecs: ["keypad"] },
};
