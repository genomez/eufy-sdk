import { describe, expect, it } from "vitest";
import { P2P_STATION_WAITS, StationKeyUnavailableError, StationUnreachableError } from "../index.js";

/** Synthetic — never a real station. */
const STATION_SN = "T8010P0000000000";

describe("station reachability at the package entry point", () => {
  it("publishes the waits a caller places its own bound above", () => {
    expect(P2P_STATION_WAITS.connect).toBeGreaterThan(0);
    expect(P2P_STATION_WAITS.level2Grace).toBeGreaterThan(0);
    expect(P2P_STATION_WAITS.level2Settle).toBeGreaterThan(0);
  });

  it("publishes the refusal a caller narrows on", () => {
    const error = new StationUnreachableError(STATION_SN, 20_000);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StationUnreachableError");
    expect(error.retryable).toBe(true);
    expect(error.waitedMs).toBe(20_000);
    expect(error.stationSn).toBe(STATION_SN);
  });

  /**
   * Both refusals name the station, which for an attached camera is its parent — so the serial a caller
   * passed in does not answer which station refused, and several cameras refused together are one outcome.
   */
  it("names the station on both refusals, in the field and in the message", () => {
    for (const error of [new StationUnreachableError(STATION_SN, 1), new StationKeyUnavailableError(STATION_SN)]) {
      expect(error.stationSn).toBe(STATION_SN);
      expect(error.message).toContain(STATION_SN);
    }
  });
});
