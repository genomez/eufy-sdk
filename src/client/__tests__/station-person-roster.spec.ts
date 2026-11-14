import { expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { PersonRosterRow, StationPersonRosterOptions, StationPersonRosterResult } from "../../index.js";

it("exposes roster reads and their types through the supported public surface", async () => {
  const rows: PersonRosterRow[] = [];
  const result: StationPersonRosterResult = { outcome: "empty", rows };
  const readStationPersonRoster = vi.fn().mockResolvedValue(result);
  const client = Object.create(EufyMega.prototype) as EufyMega;
  Reflect.set(client, "rtc", { readStationPersonRoster });
  const options: StationPersonRosterOptions = { count: 10, timeoutMs: 1000, signal: new AbortController().signal };
  expect(await client.readStationPersonRoster("synthetic-station", options)).toEqual(result);
  expect(readStationPersonRoster).toHaveBeenCalledExactlyOnceWith("synthetic-station", options);
});

it("forwards default roster options to the router", async () => {
  const readStationPersonRoster = vi.fn().mockResolvedValue({ outcome: "busy/not_admitted" });
  const client = Object.create(EufyMega.prototype) as EufyMega;
  Reflect.set(client, "rtc", { readStationPersonRoster });
  expect(await client.readStationPersonRoster("synthetic-station")).toEqual({ outcome: "busy/not_admitted" });
  expect(readStationPersonRoster).toHaveBeenCalledExactlyOnceWith("synthetic-station", {});
});
