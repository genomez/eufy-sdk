import { describe, expect, it } from "vitest";
import { parseStateInfoSignal } from "../availability.js";

const topic = "synq/eufy_life/T8000/T8000P0000000000/state_info";

function message(status: unknown, head: Record<string, unknown> = {}) {
  return {
    head,
    payload: JSON.stringify({ status }),
  };
}

describe("state_info availability evidence", () => {
  it("attributes the boolean status to the device serial carried by the verified topic", () => {
    expect(parseStateInfoSignal(topic, message(false))).toEqual({
      deviceSn: "T8000P0000000000",
      status: false,
    });

    expect(parseStateInfoSignal(topic, message(true))).toMatchObject({ status: true });
  });

  it("preserves the envelope's supplied observation time and sequence", () => {
    expect(parseStateInfoSignal(topic, message(true, { timestamp: 1_700_000_000, msg_seq: 42 }))).toMatchObject({
      observedAt: 1_700_000_000_000,
      sequence: 42,
    });
  });

  it.each([0, 1, "true", null, undefined])("ignores unverified status value %j", (status) => {
    expect(parseStateInfoSignal(topic, message(status))).toBeUndefined();
  });

  it("ignores malformed payloads and topics outside the verified device-scoped light channel", () => {
    expect(parseStateInfoSignal(topic, { payload: "not json" })).toBeUndefined();
    expect(
      parseStateInfoSignal("synq/eufy_security/T8000/T8000P0000000000/state_info", message(false)),
    ).toBeUndefined();
    expect(parseStateInfoSignal("cmd/eufy_home/T2000/T2000P0000000000/res", message(false))).toBeUndefined();
    expect(
      parseStateInfoSignal("synq/eufy_life/T8000/T8000P0000000000/transport_info", message(false)),
    ).toBeUndefined();
  });
});
