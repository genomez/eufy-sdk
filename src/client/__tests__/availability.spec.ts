import { describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { AvailabilityObservation } from "../../core/types.js";

const topic = "synq/eufy_life/T8000/T8000P0000000000/state_info";

function message(availability: AvailabilityObservation["availability"], observedAt: number, sequence?: number) {
  return {
    head: { timestamp: observedAt / 1_000, ...(sequence === undefined ? {} : { msg_seq: sequence }) },
    payload: JSON.stringify({ status: availability === "available" }),
  };
}

function observe(
  eufy: EufyMega,
  availability: AvailabilityObservation["availability"],
  observedAt: number,
  sequence?: number,
) {
  (eufy as any).processAvailabilityMessage(topic, message(availability, observedAt, sequence));
}

describe("explicit device availability", () => {
  it("retains and emits available-to-unavailable-to-available transitions", () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });
    const seen: AvailabilityObservation[] = [];
    eufy.on("availability", (value) => seen.push(value));

    observe(eufy, "available", 1_000);
    observe(eufy, "unavailable", 2_000);
    observe(eufy, "available", 3_000);

    expect(seen.map((value) => value.availability)).toEqual(["available", "unavailable", "available"]);
    expect(eufy.deviceAvailability("T8000P0000000000")).toMatchObject({
      entity: { kind: "device", sn: "T8000P0000000000" },
      availability: "available",
      source: { transport: "smqtt", signal: "state-info" },
      scope: "device",
      observedAt: 3_000,
      receivedAt: expect.any(Number),
    });
  });

  it("coalesces a duplicate state while retaining its later explicit observation", () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });
    const seen: AvailabilityObservation[] = [];
    eufy.on("availability", (value) => seen.push(value));

    observe(eufy, "unavailable", 1_000);
    observe(eufy, "unavailable", 2_000);

    expect(seen).toHaveLength(1);
    expect(eufy.deviceAvailability("T8000P0000000000")?.observedAt).toBe(2_000);
  });

  it("does not let an older observation clear newer explicit evidence", () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });

    observe(eufy, "unavailable", 2_000);
    observe(eufy, "available", 1_000);

    expect(eufy.deviceAvailability("T8000P0000000000")?.availability).toBe("unavailable");
  });

  it("uses the supplied sequence to order observations with the same vendor time", () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });

    observe(eufy, "unavailable", 1_000, 2);
    observe(eufy, "available", 1_000, 1);

    expect(eufy.deviceAvailability("T8000P0000000000")?.availability).toBe("unavailable");
  });

  it("uses a same-source sequence when only one observation supplies vendor time", () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });

    observe(eufy, "unavailable", 1_000, 2);
    (eufy as any).applyAvailabilityObservation({
      entity: { kind: "device", sn: "T8000P0000000000" },
      availability: "available",
      source: { transport: "smqtt", signal: "state-info" },
      scope: "device",
      sequence: 1,
      receivedAt: 2_000,
    });

    expect(eufy.deviceAvailability("T8000P0000000000")?.availability).toBe("unavailable");
  });

  it("does not clear unavailable evidence with a contradictory duplicate ordering tuple", () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });

    observe(eufy, "unavailable", 1_000, 2);
    observe(eufy, "available", 1_000, 2);

    expect(eufy.deviceAvailability("T8000P0000000000")?.availability).toBe("unavailable");
  });

  it("uses handler arrival order when the vendor supplies no comparable sequence", () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });

    observe(eufy, "unavailable", 1_000, undefined);
    observe(eufy, "available", 1_000, undefined);

    expect(eufy.deviceAvailability("T8000P0000000000")?.availability).toBe("available");
  });

  it("returns no observation for silence, last-seen facts, or transport lifecycle", () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });
    vi.spyOn((eufy as any).registry, "list").mockReturnValue([
      { sn: "T8000P0000000000", stationSn: "T8000P0000000001", lastSeenMs: 1 },
    ]);

    expect(eufy.deviceState("T8000P0000000000").lastSeenMs).toBe(1);
    expect(eufy.deviceAvailability("T8000P0000000000")).toBeUndefined();
  });

  it("does not treat an idle vacuum's MQTT silence or ordinary DP reports as availability", () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });

    (eufy as any).processAvailabilityMessage("cmd/eufy_home/T2000/T2000P0000000000/res", {
      head: { timestamp: 1, msg_seq: 1 },
      payload: JSON.stringify({ status: false }),
    });

    expect(eufy.deviceAvailability("T2000P0000000000")).toBeUndefined();
  });
});
