import type { InboundSignal } from "../model/capabilities/types.js";
import { stationOf } from "../transport/p2p/station-channels.js";
import { RtcCommandRouter } from "../transport/rtc/command-router.js";
import type { PortalResponse } from "../transport/rtc/portal-packet.js";
import { inspectRtcPushPayload, type RtcPushDecodeDecision } from "../transport/rtc/push-notification.js";
import type { DeviceRegistry } from "./device-registry.js";

/** Finite station/device qualification outcomes, separate from model dispatch. */
export type RtcPushDecision =
  | RtcPushDecodeDecision
  | "unknown_station"
  | "non_rtc_station"
  | "missing_device"
  | "invalid_event_type"
  | "unknown_device"
  | "wrong_station"
  | "invalid_channel"
  | "channel_conflict"
  | "channel_mismatch"
  | "qualified";

/** Internal routing inspection; raw input is never included in a diagnostic snapshot. */
export interface RtcPushSignalInspection {
  decision: RtcPushDecision;
  payload?: Record<string, unknown>;
  model?: string;
  signal?: Extract<InboundSignal, { source: "push" }>;
}

/** Scope a decoded notification using explicit device ownership and unambiguous payload channels. */
export function inspectRtcPushSignal(
  stationSn: string,
  frame: PortalResponse,
  registry: Pick<DeviceRegistry, "list" | "serialForFrame">,
): RtcPushSignalInspection {
  const envelope = inspectRtcPushPayload(stationSn, frame);
  if (envelope.decision !== "decoded") return envelope;
  const payload = envelope.payload!;
  const devices = registry.list();
  const station = devices.find((device) => device.sn === stationSn);
  if (!station) return { decision: "unknown_station", payload };
  if (!RtcCommandRouter.claimsDevice(station)) return { decision: "non_rtc_station", payload };
  if (typeof payload.device_sn !== "string") return { decision: "missing_device", payload };
  if (!Number.isSafeInteger(payload.event_type)) return { decision: "invalid_event_type", payload };
  const deviceSn = payload.device_sn;
  const known = devices.find((item) => item.sn === deviceSn);
  if (!known) return { decision: "unknown_device", payload };
  const device = devices.find((item) => item.sn === deviceSn && stationOf(item) === stationSn);
  if (!device) return { decision: "wrong_station", payload, model: known.model };
  const model = device.model;
  const channels = [payload.channel, payload.device_channel].filter((value) => value !== undefined);
  if (channels.some((value) => !Number.isSafeInteger(value) || (value as number) < 0))
    return { decision: "invalid_channel", payload, model };
  if (new Set(channels).size > 1) return { decision: "channel_conflict", payload, model };
  if (channels.length && registry.serialForFrame(stationSn, channels[0] as number) !== deviceSn)
    return { decision: "channel_mismatch", payload, model };
  return {
    decision: "qualified",
    payload,
    model,
    signal: {
      source: "push",
      eventType: payload.event_type as number,
      deviceSn,
      stationSn,
      payload: { ...payload, deviceSn, stationSn },
    },
  };
}
