import { describe, expect, it } from "vitest";
import { normalizePushEvent } from "../push-client.js";

describe("push availability evidence", () => {
  it("does not interpret the unverified m field as device, station, or transport availability", () => {
    const event = normalizePushEvent({
      payload: {
        device_sn: "T8000P0000000000",
        station_sn: "T8000P0000000001",
        m: 0,
      },
    } as never);

    expect(event?.payload.m).toBe(0);
    expect(event).not.toHaveProperty("availability");
    expect(event).not.toHaveProperty("scope");
  });
});
