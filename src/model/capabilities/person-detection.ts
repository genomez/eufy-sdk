/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { DoorbellPushEvent, HB3PairedDevicePushEvent } from "../push-events.js";
import type { CapabilityModule, InboundSignal } from "./types.js";

/** The explicit person name or recognition nickname carried by a person-event payload. */
function personIdentity(signal: InboundSignal): Record<string, unknown> {
  const payload = signal.source === "push" ? signal.payload : undefined;
  const name = [payload?.person_name, payload?.nick_name].find((value) => typeof value === "string" && value.trim());
  return { person_name: typeof name === "string" ? name.trim() : undefined };
}

/**
 * `person_detection` — human/AI detection.
 *
 * Push events are the whole read surface: a person arrives as an event, and no owned camera reports a
 * detection-enable or detected-state parameter, so there is nothing for a state table to project.
 */
export const PERSON_DETECTION: CapabilityModule = {
  capability: "person_detection",
  description: "AI human detection enable switch and live detected state.",
  properties: [],
  /** Camera push traffic emits these semantic events even when no person-detection state param is reported. */
  detection: { codecs: ["camera"] },
  /**
   * Inbound AI person events. A face or an identified person is `personDetected`; an explicitly
   * UNRECOGNISED person is `strangerDetected`.
   *
   * The two are split because they mean opposite things — "someone known is at the door" versus
   * "someone unrecognised" — and collapsing them loses the distinction the device went to the trouble
   * of making.
   */
  events: [
    { source: "push", match: DoorbellPushEvent.FACE_DETECTION, emit: "personDetected", derive: personIdentity },
    {
      source: "push",
      match: HB3PairedDevicePushEvent.IDENTITY_PERSON_DETECTION,
      emit: "personDetected",
      derive: personIdentity,
    },
    { source: "push", match: HB3PairedDevicePushEvent.STRANGER_PERSON_DETECTION, emit: "strangerDetected" },
  ],
};
