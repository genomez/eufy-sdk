/**
 * Example 09 — control a standalone eufy Life SMART LIGHT and read its state back.
 *
 * This is the `smartLight` capability: the standalone lighting line (e.g. the Permanent Outdoor Lights),
 * a different product line from a camera's built-in spotlight — that one is `light()`, see example 05. A
 * device has one or the other, never both, so the accessor you get tells you which line you're on.
 *
 * Unlike most devices, a smart light has no pollable cloud state: everything is reported over realtime.
 * The SDK asks for a snapshot as soon as the light's channel is up and `getDevice` waits for the
 * answer, so the getters are populated on return. They stay optional — a device that never answers
 * leaves them `undefined` rather than blocking the lookup — and `smartLightState` is what tells you the
 * moment state changes.
 *
 *   EUFY_EMAIL=… EUFY_PASSWORD=… node examples/09-smart-light.ts <serial> [on|off] [brightness 0-100]
 *
 * Requires `npm run build` first.
 */
import { loginClient } from "./_client.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const sn = process.argv[2];
  const state = (process.argv[3] || "on").toLowerCase();
  const brightness = process.argv[4] ? Number(process.argv[4]) : undefined;
  if (!sn) throw new Error("usage: node examples/09-smart-light.ts <serial> [on|off] [brightness 0-100]");
  if (state !== "on" && state !== "off") throw new Error(`bad state "${state}" — one of on|off`);

  const eufy = await loginClient();

  // Every report arrives as this event. Fields are optional: a report carries only what the device
  // sent, so an absent field is silence about it rather than a change to it.
  eufy.on("smartLightState", (e) => {
    console.log(`  [report] power=${e.power} brightness=${e.brightness} running=${e.cloudEffectId}`);
  });

  const dev = await eufy.getDevice(sn);
  const light = dev.smartLight?.();
  if (!light) throw new Error(`${sn} has no smart_light capability (is it a eufy Life light?)`);

  const show = (label: string): void => {
    console.log(
      `${label}: power=${light.power} brightness=${light.brightness} ` +
        `selected=${light.effectId} running=${light.cloudEffectId} segments=${light.lightLength}`,
    );
  };

  // Populated already: the snapshot request goes out as soon as the light's channel is up, and
  // getDevice waits for the answer. `undefined` here only if the device never answered.
  show("state at connect");

  console.log(`turning ${state} …`);
  await (state === "on" ? light.on() : light.off());

  if (brightness !== undefined) {
    if (brightness < 0 || brightness > 100) throw new Error("brightness must be 0–100");
    console.log(`setting brightness ${brightness} …`);
    await light.setBrightness(brightness);
  }

  // Writes are answered with a fresh report; give it a moment to land, then read the getters again.
  await sleep(4000);
  show("state after writes");

  // `brightness` is the CONFIGURED level and survives `off` — pair it with `power`, don't read 0 as off.
  // `effectId` is what's selected; `cloudEffectId` is what's actually running (0 when nothing is).
  if (light.power === false && light.brightness) {
    console.log(`(off, but still configured for brightness ${light.brightness})`);
  }

  // Re-ask on demand. Resolves once the request is sent — the answer arrives as a report.
  await light.refreshState();
  await sleep(3000);
  show("state after refreshState()");

  await eufy.disconnect();
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
