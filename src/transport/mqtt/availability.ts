import { parseSecureTopic } from "./topics.js";
import { jsonObject } from "../../core/util.js";

/** Verified fields decoded from the `state_info` wire, before the client assigns domain semantics. */
export interface StateInfoSignal {
  readonly deviceSn: string;
  readonly status: boolean;
  readonly observedAt?: number;
  readonly sequence?: number;
}

/**
 * Decode the verified `eufy_life` device-availability wire. The current app handles only
 * `synq/eufy_life/{model}/{deviceSn}/state_info`, parses the envelope's string `payload`, and applies
 * its boolean `status` to the light identified by the topic serial. No station or transport scope is
 * projected from this signal, and non-boolean values are not interpreted.
 */
export function parseStateInfoSignal(topic: string, raw: unknown): StateInfoSignal | undefined {
  const parsedTopic = parseSecureTopic(topic);
  if (parsedTopic?.root !== "synq" || parsedTopic.category !== "eufy_life" || parsedTopic.tail !== "state_info") {
    return undefined;
  }

  const envelope = raw as { head?: Record<string, unknown>; payload?: unknown } | undefined;
  const payload = jsonObject(envelope?.payload);
  if (typeof payload?.status !== "boolean") return undefined;

  const timestamp = envelope?.head?.timestamp;
  const sequence = envelope?.head?.msg_seq;
  return {
    deviceSn: parsedTopic.sn,
    status: payload.status,
    ...(typeof timestamp === "number" && Number.isFinite(timestamp) ? { observedAt: timestamp * 1_000 } : {}),
    ...(typeof sequence === "number" && Number.isFinite(sequence) ? { sequence } : {}),
  };
}
