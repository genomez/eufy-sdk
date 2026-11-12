import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "eufy-rtc-diagnostics-"));
const originalCodes = process.env.EUFY_EVENT_ROW_CODES_FILE;
const originalKeys = process.env.EUFY_EVENT_ROW_KEYS_FILE;
process.env.EUFY_EVENT_ROW_CODES_FILE = join(directory, "codes.log");
process.env.EUFY_EVENT_ROW_KEYS_FILE = join(directory, "keys.log");

afterAll(() => {
  if (originalCodes === undefined) delete process.env.EUFY_EVENT_ROW_CODES_FILE;
  else process.env.EUFY_EVENT_ROW_CODES_FILE = originalCodes;
  if (originalKeys === undefined) delete process.env.EUFY_EVENT_ROW_KEYS_FILE;
  else process.env.EUFY_EVENT_ROW_KEYS_FILE = originalKeys;
  rmSync(directory, { recursive: true, force: true });
});
