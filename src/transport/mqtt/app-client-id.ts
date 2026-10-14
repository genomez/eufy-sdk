/**
 * The real app's MQTT `client_id` shape. `SecureMqtt` defaults to `clientId = thing_name =
 * "{uid}-{appName}"`, a completely different shape; some broker-side behavior may key off this string
 * (session/ACL tracking), so anything trying to look like the real app for reachability testing should
 * use this builder instead of the SDK default.
 *
 * Shape, with a redacted sample:
 * `android-eufy_security-0000000000000000000000000000000000000000-a7115bb62400710b-1784124496`
 * — the trailing segment is a plain connect-time Unix timestamp. One reading of the app appends a
 * dash-stripped endpoint address there instead; the two disagree and were never reconciled. This
 * builder follows the timestamp form, the one that actually earned a granted SUBSCRIBE.
 */
import { createHash } from "node:crypto";

export interface AppClientIdInput {
  /** Topic scope, e.g. "eufy_security". */
  appName: string;
  /** The logged-in user id (40-hex) — NOT necessarily the device owner if it's a shared device. */
  uid: string;
  /** Stable per-install identifier (`AIOTDeviceSdk.getMqttUUID()` on the real app). Any stable 16-hex
   * string works for our purposes — generate once and persist it, don't re-randomize per connect. */
  mqttUuid: string;
  /** Connect-time unix SECONDS. Defaults to now; inject for deterministic tests. */
  timestamp?: number;
}

/** Build a client_id shaped like `android-{appName}-{uid}-{mqttUuid}-{timestamp}`. */
export function buildAppShapedClientId(input: AppClientIdInput): string {
  const ts = input.timestamp ?? Math.floor(Date.now() / 1000);
  return `android-${input.appName}-${input.uid}-${input.mqttUuid}-${ts}`;
}

/**
 * The `mqttUuid` segment for a client bound to `installId`, hashed to the 16-hex shape
 * {@link buildAppShapedClientId} expects. Deterministic, so a client keeps its id across restarts and
 * takes its own stale session over rather than doubling up beside it; one-way, so the id it is derived
 * from is not recoverable from a client_id that travels the wire in clear.
 *
 * Two clients are distinguished exactly as far as their `installId` is: equal ids in, equal ids out.
 */
export function mqttUuidFrom(installId: string): string {
  return createHash("sha256").update(installId).digest("hex").slice(0, 16);
}
