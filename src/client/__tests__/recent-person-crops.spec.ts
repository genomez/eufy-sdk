import { expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";

it("exposes crop reads through the supported client method", async () => {
  const readRecentPersonCrops = vi.fn().mockResolvedValue({ outcome: "empty", rows: [] });
  const client = Object.create(EufyMega.prototype) as EufyMega;
  Reflect.set(client, "rtc", { readRecentPersonCrops });
  const options = { count: 10, timeoutMs: 1000 };
  expect(await client.readRecentPersonCrops("synthetic-station", options)).toEqual({ outcome: "empty", rows: [] });
  expect(readRecentPersonCrops).toHaveBeenCalledExactlyOnceWith("synthetic-station", options);
});
