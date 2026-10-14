import type { CapabilityModule } from "./types.js";

/**
 * `snapshot` — still-image capture / thumbnail. Behaviour-only (a capture command);
 * the resulting image is delivered out-of-band, not as a state param.
 */
export const SNAPSHOT: CapabilityModule = {
  capability: "snapshot",
  description:
    "On-demand still capture / latest thumbnail. Behaviour-only; the image is delivered " +
    "out-of-band rather than as a reported param, so no state properties.",
  properties: [],
  // Any camera-codec device can snapshot; a cover-image param (1004) also proves it.
  detection: { evidenceParams: [1004], codecs: ["camera"] },
};
