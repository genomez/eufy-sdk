import type { CapabilityModule } from "./types.js";

/**
 * `video` — live/recorded streaming. Its value is *behaviour* (start/stop livestream,
 * P2P media path), not reported state, so it contributes no state properties here.
 */
export const VIDEO: CapabilityModule = {
  capability: "video",
  description:
    "Live and recorded H.264/H.265 streaming over P2P. Behaviour-only capability; " +
    "streaming commands attach in a later phase, so no state properties.",
  properties: [],
  // Any camera-codec device has video; a live-view enable param (1056) also proves it.
  detection: { evidenceParams: [1056], codecs: ["camera"] },
};
