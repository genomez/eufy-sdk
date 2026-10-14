/**
 * Example 04 — pan-tilt (PTZ) a camera.
 *
 * Resolves a PT camera and steps it in a direction via the fluent `ptz()` accessor. Movement
 * is command-driven (the camera has no "go to angle" write; it steps): `rotate(dir, zoom)`, or the
 * shorthands `left()/right()/up()/down()`. The accessor is `undefined` on a device without PTZ, so
 * guard with `?.` (or check `dev.has("ptz")`).
 *
 * Stored **presets** live under the `preset()` sub-API — `preset().goto(id)` / `preview(id)` /
 * `save(id)` (save the current position into a slot) / `setDefault(id)` / `delete(id)`, plus the
 * live-only reads `preset().list?()` and `preset().image?(id)` (request/reply over P2P, present only
 * when the device is client-bound — call with `?.`).
 *
 *   EUFY_EMAIL=… EUFY_PASSWORD=… node examples/04-ptz.ts <serial> [left|right|up|down] [zoom]
 *   EUFY_EMAIL=… EUFY_PASSWORD=… node examples/04-ptz.ts <serial> preset [id]
 *
 * Requires `npm run build` first.
 */
import { PtzDirection } from "../dist/index.js";
import { loginClient } from "./_client.ts";

// `PtzDirection` is the exported direction constant + companion type — the CLI whitelist derives
// from it, so it can't drift from what `rotate()` accepts.
const isDirection = (v: string): v is PtzDirection => v in PtzDirection;

async function main(): Promise<void> {
  const sn = process.argv[2];
  const mode = process.argv[3] || PtzDirection.left;
  if (!sn) throw new Error("usage: node examples/04-ptz.ts <serial> [left|right|up|down|preset] [zoom|id]");

  const eufy = await loginClient();

  const dev = await eufy.getDevice(sn);
  const ptz = dev.ptz?.();
  if (!ptz) throw new Error(`${sn} has no pan-tilt capability`);

  if (mode === "preset") {
    // Preset workflow via the `preset()` namespace.
    const preset = ptz.preset();
    const id = process.argv[4] ? Number(process.argv[4]) : 1;

    // Reads are live-only — guard with `?.`. `list()` returns [{ id, raw }].
    const presets = (await preset.list?.()) ?? [];
    console.log(`${presets.length} stored preset(s): ${presets.map((p) => p.id).join(", ") || "(none)"}`);

    console.log(`going to preset ${id} …`);
    // Fire-and-forget: goto/preview/setDefault/delete on an empty slot are a silent no-op (no ack).
    await preset.goto(id); // move to a stored preset
    // await preset.save(id);        // save the CURRENT position into slot `id` (create/overwrite)
    // await preset.setDefault(id);  // make preset `id` the home position
    // await preset.delete(id);      // remove preset `id`
    const img = await preset.image?.(id); // thumbnail (live-only), base64 JPEG in `img.data`
    if (img) console.log(`preset ${img.index} thumbnail: ${img.data.length} bytes`);
  } else {
    if (!isDirection(mode)) throw new Error(`bad direction "${mode}" — one of ${Object.keys(PtzDirection).join("|")}`);
    const zoom = process.argv[4] ? Number(process.argv[4]) : 1.0;
    console.log(`rotating ${mode} (zoom ${zoom}) …`);
    await ptz.rotate(mode, zoom);
    // equivalent shorthands: await ptz.left(); await ptz.up(); …
    // digital zoom without moving (dual-lens cams only, so it's optional): await ptz.zoom?.(2);
  }

  console.log("sent — watch the camera");
  await eufy.disconnect();
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
