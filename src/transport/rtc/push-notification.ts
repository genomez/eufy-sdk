import { isUtf8 } from "node:buffer";
import { PortalLinkType, type PortalResponse } from "./portal-packet.js";

/** An object-shaped JSON value, excluding null and arrays. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse one object-shaped JSON notification without logging its contents. */
function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Finite envelope outcomes; payload contents never form a reason. */
export type RtcPushDecodeDecision =
  | "ignored"
  | "response"
  | "wrong_link"
  | "invalid_envelope"
  | "command_conflict"
  | "station_conflict"
  | "invalid_body"
  | "decoded";

/** An envelope decision plus its decoded object, retained only for immediate routing. */
export interface RtcPushInspection {
  decision: RtcPushDecodeDecision;
  payload?: Record<string, unknown>;
}

/** Inspect a supported push envelope without changing its acceptance or logging its contents. */
export function inspectRtcPushPayload(stationSn: string, frame: PortalResponse): RtcPushInspection {
  const envelope = object(frame.data);
  const supported = (value: unknown) => value === 1317 || value === 1318 || value === 2037;
  if (!supported(frame.cmd) && !supported(envelope?.cmd)) return { decision: "ignored" };
  if (frame.isResponse !== 0) return { decision: "response" };
  if (frame.linkType !== PortalLinkType.NOTIFY) return { decision: "wrong_link" };
  if (!envelope) return { decision: "invalid_envelope" };
  if (frame.cmd !== undefined && frame.cmd !== envelope.cmd) return { decision: "command_conflict" };
  const agrees = (value: unknown) => value === undefined || value === stationSn;
  if (!agrees(envelope.station_sn)) return { decision: "station_conflict" };
  let payload: Record<string, unknown> | undefined;
  if (envelope.cmd === 1317 || envelope.cmd === 1318) {
    const wrapper = object(envelope.payload);
    if (!wrapper) return { decision: "invalid_body" };
    if (!agrees(wrapper.station_sn)) return { decision: "station_conflict" };
    if (typeof wrapper.payload !== "string") return { decision: "invalid_body" };
    const bytes = Buffer.from(wrapper.payload, "base64");
    if (bytes.toString("base64") !== wrapper.payload || !isUtf8(bytes)) return { decision: "invalid_body" };
    payload = jsonObject(bytes.toString("utf8"));
  } else if (envelope.cmd === 2037) {
    payload = typeof envelope.payload === "string" ? jsonObject(envelope.payload) : object(envelope.payload);
  }
  if (!payload) return { decision: "invalid_body" };
  if (!agrees(payload.station_sn)) return { decision: "station_conflict" };
  return { decision: "decoded", payload };
}
