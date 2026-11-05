import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { packetize } from "../ptcs-framer.js";

it("replays private capture framing and prints only sanitized diagnostics", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "playback-replay-test-"));
  const file = path.join(dir, "capture-1.bin");
  const packet = packetize(Buffer.from("private-synthetic-invalid-zstd"), { channel: 4, frameId: 1 })[0]!;
  packet.writeUInt16LE(packet.readUInt16LE(18) | 0x0800, 18);
  const record = Buffer.alloc(9);
  record.writeUInt32LE(25, 1);
  record.writeUInt32LE(packet.length, 5);
  writeFileSync(file, Buffer.concat([Buffer.from("EPCAP001"), record, packet]), { mode: 0o600, flag: "wx" });
  const output = execFileSync(process.execPath, ["scripts/replay-playback-capture.mjs", file], { encoding: "utf8" });
  expect(output).not.toContain("private-synthetic");
  expect(output).not.toContain(file);
  expect(JSON.parse(output)).toEqual({
    firstRejectionReason: "zstd-header",
    firstRejectedClass: "playback",
    compressionState: "flagged",
    declaredSizeBucket: "le8KiB",
    assembledSizeBucket: "le8KiB",
    outputSizeBucket: "unknown",
    zstdWindowBucket: "unknown",
    rejectionCount: 1,
    assemblerDecompression: 1,
    assemblerInvalidMetadata: 0,
  });
});
