import type { CapabilityModule } from "./types.js";

/**
 * `storage` — on-device storage (SD card / eMMC / HDD).
 *
 * A station-codec baseline capability, since hubs own recordings. It contributes no state properties:
 * no owned station reports a capacity or SD-card parameter, and the one id a table here could point at
 * (1131) is `deviceStatus` in the param dictionary — reported by ten devices with an unrelated meaning,
 * so a capacity getter over it would install widely and answer a device-status code as megabytes.
 * Capacity earns a member when a station is captured reporting one.
 */
export const STORAGE: CapabilityModule = {
  capability: "storage",
  description: "Local storage (SD card / eMMC / HDD). Behaviour-only until a capacity param is captured.",
  properties: [],
  detection: { codecs: ["station"] },
};
