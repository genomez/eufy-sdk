import { describe, expect, it } from "vitest";
import { connectionDeadline, consumeConnectionDeadline } from "../connection-deadline.js";

describe("local connection deadline identity", () => {
  it("preserves wording and consumes only the exact error once", () => {
    const error = connectionDeadline("T8000P0000000000", 12_000);
    expect(error.message).toBe("rtc: T8000P0000000000 did not come up within 12000ms");
    expect(consumeConnectionDeadline(new Error(error.message))).toBe(false);
    expect(consumeConnectionDeadline(error)).toBe(true);
    expect(consumeConnectionDeadline(error)).toBe(false);
    expect(consumeConnectionDeadline(null)).toBe(false);
  });
});
