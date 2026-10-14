import { describe, it, expect } from "vitest";
import { buildCleanDpEnvelope } from "../clean-codec.js";

/**
 * `buildCleanDpEnvelope` — AIoT MQTT command envelope for clean-line DP writes. The injectable
 * `opts` params pin the non-deterministic fields (timestamp / UUID) so the wire constants
 * (`head.cmd`, `head.cmd_status`, `head.sign_code`, `payload.protocol`) can be asserted exactly
 * against the values confirmed from a live T2351 capture.
 */
const FIXED = { timestamp: 1700000000000, uuid: "test-uuid-1234" };

describe("buildCleanDpEnvelope", () => {
  it("sets the head constants confirmed from the T2351 capture", () => {
    const outer = JSON.parse(buildCleanDpEnvelope("<acct>", "<sn>", 151, true, FIXED));
    expect(outer.head.cmd).toBe(65537);
    expect(outer.head.cmd_status).toBe(2);
    expect(outer.head.sign_code).toBe(0);
    expect(outer.head.timestamp).toBe(FIXED.timestamp);
  });

  it("encodes the DP map inside a stringified payload", () => {
    const outer = JSON.parse(buildCleanDpEnvelope("<acct>", "<sn>", 163, 88, FIXED));
    const inner = JSON.parse(outer.payload);
    expect(inner.account_id).toBe("<acct>");
    expect(inner.device_sn).toBe("<sn>");
    expect(inner.protocol).toBe(2);
    expect(inner.t).toBe(FIXED.uuid);
    expect(inner.data).toEqual({ "163": 88 });
  });

  it("encodes boolean, number, and base64-string DP values as-is", () => {
    const b64 = Buffer.from([0x08, 0x06, 0x10, 0x70]).toString("base64");
    const parsePayload = (raw: string) => JSON.parse(JSON.parse(raw).payload);

    expect(parsePayload(buildCleanDpEnvelope("<a>", "<s>", 151, true, FIXED)).data).toEqual({ "151": true });
    expect(parsePayload(buildCleanDpEnvelope("<a>", "<s>", 161, 80, FIXED)).data).toEqual({ "161": 80 });
    expect(parsePayload(buildCleanDpEnvelope("<a>", "<s>", 152, b64, FIXED)).data).toEqual({ "152": b64 });
  });

  it("keys the DP map on the numeric DP id as a string", () => {
    const inner = JSON.parse(JSON.parse(buildCleanDpEnvelope("<a>", "<s>", 152, true, FIXED)).payload);
    expect(Object.keys(inner.data)).toEqual(["152"]);
  });

  it("defaults to live timestamp and UUID when opts are omitted", () => {
    const outer = JSON.parse(buildCleanDpEnvelope("<a>", "<s>", 151, true));
    const inner = JSON.parse(outer.payload);
    expect(typeof outer.head.timestamp).toBe("number");
    expect(typeof inner.t).toBe("string");
  });
});
