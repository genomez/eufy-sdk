/**
 * Example 02 — subscribe to typed semantic events.
 *
 * Connects the realtime transports and listens for normalized events (motion, doorbell, person,
 * lock, contact, PTZ) plus the generic `propertyChanged` announcement. Event names autocomplete and
 * payloads are typed.
 *
 *   EUFY_EMAIL=… EUFY_PASSWORD=… node examples/02-listen-events.ts
 *
 * Requires `npm run build` first.
 */
import { loginClient } from "./_client.ts";

async function main(): Promise<void> {
  const eufy = await loginClient();
  eufy.on("error", (e) => console.error("[error]", e.message));

  // Semantic events — same shape regardless of which transport delivered them.
  eufy.on("motion", (e) => console.log("motion", e.deviceSn, e.thumbnailUrl ?? ""));
  eufy.on("personDetected", (e) => console.log("person", e.deviceSn));
  eufy.on("doorbellPress", (e) => console.log("doorbell", e.deviceSn));
  eufy.on("lockState", (e) => console.log("lock", e.deviceSn));
  eufy.on("contactState", (e) => console.log("contact", e.deviceSn, e.to));
  eufy.on("ptzNotify", (e) => console.log("ptz", e.stationSn, e.kind));

  // Any readable property moving — the generic announcement, for the many members no push carries.
  // `property` is the name `dev.getProperty()` takes; `value` is what the getter now answers.
  eufy.on("propertyChanged", (e) => console.log("property", e.deviceSn, e.property, "=", e.value));

  // Catch-all — one listener for every semantic event; `e.eventName` says which. Handy for fanning
  // events to a host's event bus without registering a listener per name.
  eufy.on("event", (e) => console.log("· any:", e.eventName, e.deviceSn ?? e.stationSn ?? ""));

  // `propertyChanged` reports the new VALUE, and the SDK reads that off the Device object it handed you.
  // It does not keep that object alive, so if you drop it the announcements for that serial stop (the SDK
  // warns once when it notices). Hence this Map: hold every Device you want property changes for. The
  // listeners registered above need none of this.
  const held = new Map<string, Awaited<ReturnType<typeof eufy.getDevice>>>();
  for (const d of await eufy.getDevices()) held.set(d.sn, await eufy.getDevice(d.sn));
  console.log(`holding ${held.size} devices for property announcements`);

  console.log("listening 60s — trigger something on a device…");
  await new Promise((r) => setTimeout(r, 60_000));
  await eufy.disconnect();
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
