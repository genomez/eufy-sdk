import { describe, expect, it } from "vitest";
import { renewalFailure } from "../renewal-diagnostics.js";

describe("finite renewal failure classification", () => {
  it.each([
    ["RTC scall 486 after 0 retries", "signaling_486"],
    ["RTC scall 408 after 0 retries", "signaling_408"],
    ["rtc: synthetic-private-marker did not come up within 12000ms", "connect_timeout"],
    ["RTC information response timed out", "information_timeout"],
    ["RTC information request rejected", "request_rejected"],
    ["RTC information session closed", "session_closed"],
    ["RTC session closed while opening", "session_closed"],
    ["rtc: synthetic-private-marker session closed before the command channel opened", "session_closed"],
    ["RTC session replacement timed out", "replacement_timeout"],
    ["RTC session replacement cancelled", "cancelled"],
    ["RTC session replacement superseded", "superseded"],
  ])("classifies %s without retaining the exception", (message, kind) => {
    expect(renewalFailure(new Error(message))).toBe(kind);
  });

  it("does not expose arbitrary error values", () => {
    for (const error of [
      undefined,
      null,
      "synthetic-private-marker",
      { message: "RTC scall 486 after 0 retries" },
      new Error("synthetic-private-marker"),
    ])
      expect(renewalFailure(error)).toBe("other");
  });
});
