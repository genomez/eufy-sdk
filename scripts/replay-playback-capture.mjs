import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Offline test helper; EPCAP001 framing is shared with the private capture writer. No raw data is printed. */
export async function replayPlaybackCapture(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw Error();
    bytes = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (bytes.subarray(0, 8).toString() !== "EPCAP001") throw Error();
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "playback-replay-"));
  const entry = path.join(temp, "replay.mjs");
  await build({
    stdin: {
      contents:
        'export { PlaybackIngress } from "./src/transport/rtc/playback-ingress.ts"; export { PtcsFramer } from "./src/transport/rtc/ptcs-framer.ts"; export { parsePortalHeader } from "./src/transport/rtc/portal-packet.ts";',
      resolveDir: root,
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  const { PlaybackIngress, PtcsFramer, parsePortalHeader } = await import(pathToFileURL(entry));
  let now = 0,
    previous = 0;
  const ingress = new PlaybackIngress({ now: () => now, end: () => {}, media: () => {} });
  ingress.reserve(6, 7);
  ingress.capturing = true;
  const framer = new PtcsFramer({ now: () => now });
  const outbound = new PtcsFramer();
  await framer.init(
    () => {},
    (frame, link) => ingress.decoded(frame, link),
  );
  await outbound.init(
    () => {},
    (frame) => {
      const h = parsePortalHeader(frame);
      if (h?.commandId === 1700 && h.isResponse >= 6 && h.isResponse < 249) {
        const body = JSON.parse(frame.subarray(16).toString());
        if (body?.data?.cmd === 0) ingress.reserve(h.isResponse, h.isResponse + 1);
      }
    },
  );
  try {
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 9 > bytes.length) throw Error();
      const kind = bytes[offset],
        ms = bytes.readUInt32LE(offset + 1),
        length = bytes.readUInt32LE(offset + 5);
      offset += 9;
      if (kind > 2 || ms < previous || offset + length > bytes.length) throw Error();
      now = ms;
      previous = ms;
      const payload = bytes.subarray(offset, offset + length);
      offset += length;
      if (kind === 1) {
        outbound.recvPacket(payload);
        continue;
      }
      const message = kind === 2 ? payload.toString("utf8") : payload;
      if (ingress.native(message)) ingress.received(framer.recvPacket(payload));
    }
    const keys = [
      "firstRejectionReason",
      "firstRejectedClass",
      "compressionState",
      "declaredSizeBucket",
      "assembledSizeBucket",
      "outputSizeBucket",
      "zstdWindowBucket",
      "rejectionCount",
      "assemblerDecompression",
      "assemblerInvalidMetadata",
    ];
    return Object.fromEntries(keys.map((key) => [key, ingress.evidence[key]]));
  } finally {
    framer.destroy();
    outbound.destroy();
    ingress.stopExpiry();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(await replayPlaybackCapture(process.argv[2])));
  } catch {
    console.log(JSON.stringify({ replayOutcome: "invalid_capture" }));
    process.exitCode = 1;
  }
}
