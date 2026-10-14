import { buildAppShapedClientId } from "../transport/mqtt/app-client-id.js";
import { mergeCandidateIps, rankResults, type ProbeResult } from "../transport/mqtt/broker-discovery.js";

describe("buildAppShapedClientId", () => {
  it("matches the live-captured shape android-{appName}-{uid}-{mqttUuid}-{timestamp}", () => {
    const id = buildAppShapedClientId({
      appName: "eufy_security",
      uid: "0000000000000000000000000000000000000000",
      mqttUuid: "a7115bb62400710b",
      timestamp: 1784124496,
    });
    expect(id).toBe("android-eufy_security-0000000000000000000000000000000000000000-a7115bb62400710b-1784124496");
  });

  it("defaults timestamp to now (seconds, not ms)", () => {
    const before = Math.floor(Date.now() / 1000);
    const id = buildAppShapedClientId({ appName: "eufy_security", uid: "u", mqttUuid: "m" });
    const ts = Number(id.split("-").at(-1));
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(before + 2);
  });
});

describe("mergeCandidateIps", () => {
  it("de-dupes DNS results and extras, DNS first", () => {
    expect(mergeCandidateIps(["1.1.1.1", "2.2.2.2"], ["2.2.2.2", "3.3.3.3"])).toEqual([
      "1.1.1.1",
      "2.2.2.2",
      "3.3.3.3",
    ]);
  });

  it("handles no extras", () => {
    expect(mergeCandidateIps(["1.1.1.1"])).toEqual(["1.1.1.1"]);
  });
});

describe("rankResults", () => {
  it("sorts granted instances first without mutating the input", () => {
    const results: ProbeResult[] = [
      { ip: "1.1.1.1", granted: false, ms: 5 },
      { ip: "2.2.2.2", granted: true, ms: 5 },
      { ip: "3.3.3.3", granted: false, ms: 5 },
    ];
    const ranked = rankResults(results);
    expect(ranked.map((r) => r.ip)).toEqual(["2.2.2.2", "1.1.1.1", "3.3.3.3"]);
    expect(results.map((r) => r.ip)).toEqual(["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
  });
});
