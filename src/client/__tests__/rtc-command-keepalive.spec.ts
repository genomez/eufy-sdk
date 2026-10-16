import { describe, expect, it } from "vitest";
import { EufyMega } from "../eufy-mega.js";

describe("command keepalive facade configuration", () => {
  it.each([undefined, 0, 29_000])("passes the interval to the router and exposes passive counters (%s)", (interval) => {
    const client = new EufyMega({
      email: "test@example.com",
      password: "synthetic",
      autoRealtime: false,
      pollMs: 0,
      storedSnapshotCache: false,
      rtc: { commandKeepaliveMs: interval },
    });
    expect(client.getRtcKeepaliveDiagnostics()).toEqual({
      enabled: (interval ?? 0) > 0,
      sent: 0,
      echoed: 0,
      missedEchoDrops: 0,
      sendFailureDrops: 0,
      lastEchoAtMs: 0,
    });
  });
});
