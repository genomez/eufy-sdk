import { isUtf8 } from "node:buffer";
import { commandObservation, type Command } from "../core/contracts.js";
import { decodeState } from "../model/capabilities/index.js";
import { stationOf } from "../transport/p2p/station-channels.js";
import { RtcCommandRouter } from "../transport/rtc/command-router.js";
import { informationPayload } from "../transport/rtc/camera-info.js";
import { PortalLinkType, type PortalResponse } from "../transport/rtc/portal-packet.js";
import type { DeviceRegistry } from "./device-registry.js";

/** Decode a qualified information entry value without changing parameter semantics. */
function parameterValue(value: unknown, base64: boolean): string | undefined {
  if (base64) {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return undefined;
    const bytes = Buffer.from(text, "base64");
    if (bytes.toString("base64") !== text || !isUtf8(bytes)) return undefined;
    return bytes.toString("utf8").replace(/\0+$/, "").trim();
  }
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return String(value);
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Preserve direct information and admit only the exact passive wrapped information envelope. */
function statePayload(frame: PortalResponse): Record<string, unknown> | undefined {
  if (frame.isResponse !== 0) return undefined;
  if (frame.commandId === 1103) return informationPayload(frame.data);
  if (frame.commandId !== 1351 || frame.linkType !== PortalLinkType.NOTIFY || frame.cmd !== 1103) return undefined;
  if (!frame.data || typeof frame.data !== "object" || Array.isArray(frame.data)) return undefined;
  const envelope = frame.data as Record<string, unknown>;
  if (
    !Object.hasOwn(envelope, "cmd") ||
    typeof envelope.cmd !== "number" ||
    !Number.isSafeInteger(envelope.cmd) ||
    envelope.cmd !== frame.cmd ||
    !Object.hasOwn(envelope, "payload") ||
    Object.hasOwn(envelope, "params") ||
    Object.hasOwn(envelope, "db_bypass_str")
  )
    return undefined;
  const selected = envelope.payload;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) return undefined;
  if (["params", "db_bypass_str"].some((key) => key in selected && !Object.hasOwn(selected, key))) return undefined;
  const payload = informationPayload(selected);
  return payload === selected ? payload : undefined;
}

/**
 * Qualified RTC information parameters grouped by known owner. The information payload's station channel markers
 * are 255 and 1000; a packet header's channel never supplies ownership for an entry. Every supplied
 * ownership alias must agree, and a channel shared by attached devices has no inferred owner.
 */
export function rtcStateParameters(
  stationSn: string,
  frame: PortalResponse,
  registry: Pick<DeviceRegistry, "list" | "serialForFrame" | "capabilitiesForDevice">,
): Map<string, Record<number, string>> {
  const updates = new Map<string, Record<number, string>>();
  const devices = registry.list();
  const station = devices.find((device) => device.sn === stationSn);
  if (!station || !RtcCommandRouter.claimsDevice(station)) return updates;
  const owners = new Set(devices.filter((device) => stationOf(device) === stationSn).map((device) => device.sn));
  const payload = statePayload(frame);
  if (!payload) return updates;
  for (const key of ["params", "db_bypass_str"] as const) {
    if (!Array.isArray(payload[key])) continue;
    for (const entry of payload[key]) {
      const param = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(param.param_type) || (param.param_type as number) < 0) continue;
      const serials = [param.device_sn, param.dev_sn].filter((value) => value !== undefined);
      if (serials.some((value) => typeof value !== "string" || !owners.has(value)) || new Set(serials).size > 1)
        continue;
      const channels = [param.channel, param.device_channel, param.dev_type].filter((value) => value !== undefined);
      if (channels.some((value) => !Number.isSafeInteger(value) || (value as number) < 0) || new Set(channels).size > 1)
        continue;
      const channel = channels[0] as number | undefined;
      const channelOwner =
        channel === undefined
          ? undefined
          : channel === 255 || channel === 1000
            ? stationSn
            : registry.serialForFrame(stationSn, channel);
      const serial = serials[0] as string | undefined;
      if (channel !== undefined && (!channelOwner || (serial !== undefined && serial !== channelOwner))) continue;
      const owner = serial ?? channelOwner;
      if (!owner || !owners.has(owner)) continue;
      const value = parameterValue(param.param_value, key === "db_bypass_str");
      if (value === undefined) continue;
      const params = updates.get(owner) ?? {};
      params[param.param_type as number] = value;
      updates.set(owner, params);
    }
  }
  return updates;
}

/** Recognize scoped command reports as read triggers, never as authoritative parameter updates. */
export function rtcReportParameters(
  stationSn: string,
  frame: PortalResponse,
  registry: Pick<DeviceRegistry, "list" | "serialForFrame" | "capabilitiesForDevice">,
): Map<string, Record<number, string>> {
  const updates = new Map<string, Record<number, string>>();
  if (frame.channel >= 255 || (frame.linkType !== PortalLinkType.NOTIFY && frame.linkType !== PortalLinkType.COMMAND))
    return updates;
  const owner = registry.serialForFrame(stationSn, frame.channel);
  if (!owner || owner === stationSn) return updates;
  const caps = registry.capabilitiesForDevice(owner);
  if (!caps) return updates;
  let commandId = frame.commandId;
  let value = frame.data;
  if (commandId === 1700) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return updates;
    const reply = value as Record<string, unknown>;
    commandId = Number(reply.commandType ?? reply.cmd);
  } else if (frame.linkType !== PortalLinkType.NOTIFY || frame.isResponse !== 0 || frame.segment !== 0) {
    return updates;
  }
  const states = decodeState({ source: "command-report", commandId, value }, caps);
  if (states.length) updates.set(owner, Object.assign({}, ...states.map((state) => state.params)));
  return updates;
}

/** A report of the target parameter requests a read regardless of the reported value. */
export function rtcCommandReadbackRequested(
  stationSn: string,
  deviceSn: string,
  command: Command,
  frame: PortalResponse,
  registry: Pick<DeviceRegistry, "list" | "serialForFrame" | "capabilitiesForDevice">,
): boolean {
  const observation = commandObservation(command);
  return (
    !!observation?.passiveReadback &&
    Object.hasOwn(rtcReportParameters(stationSn, frame, registry).get(deviceSn) ?? {}, observation.param)
  );
}

/** Only the target's qualified information parameter can confirm its declared expected value. */
export function rtcCommandConfirmed(
  stationSn: string,
  deviceSn: string,
  command: Command,
  frame: PortalResponse,
  registry: Pick<DeviceRegistry, "list" | "serialForFrame" | "capabilitiesForDevice">,
): boolean {
  const observation = commandObservation(command);
  return (
    !!observation?.passiveReadback &&
    rtcStateParameters(stationSn, frame, registry).get(deviceSn)?.[observation.param] === String(observation.expected)
  );
}
