import { describe, it, expect } from "vitest";
import { parseAiotDpReport } from "../dp-codec.js";

/**
 * The AIoT realtime report unwrap — the Clean line's device→app leg. Envelope shape per
 * `docs/clean/aiot-transport.md`: `{head, payload}` where `payload` is `{t, protocol, account_id,
 * device_sn, data}` and `data` is the data-point map. All fixtures synthesized; no captured values.
 */
const envelope = (payload: unknown) => ({ head: { cmd: 65537 }, payload });
const report = (data: Record<string, unknown>) =>
  JSON.stringify({ t: 1730000000000, protocol: 1, account_id: "<id>", device_sn: "<sn>", data });

describe("parseAiotDpReport", () => {
  it("reads the data-point map out of a stringified payload", () => {
    expect(parseAiotDpReport(envelope(report({ "151": true, "163": 88 })))).toEqual({ 151: "1", 163: "88" });
  });

  it("accepts a payload that already arrived as an object", () => {
    const payload = { t: 1, protocol: 1, account_id: "<id>", device_sn: "<sn>", data: { "161": 80 } };
    expect(parseAiotDpReport(envelope(payload))).toEqual({ 161: "80" });
  });

  it("keeps a structured point as the base64 it arrived as, undecoded", () => {
    const b64 = Buffer.from([2, 0x10, 3]).toString("base64");
    expect(parseAiotDpReport(envelope(report({ "153": b64 })))).toEqual({ 153: b64 });
  });

  it("normalises booleans to the same 1/0 text the cloud record uses", () => {
    expect(parseAiotDpReport(envelope(report({ "151": false, "159": true })))).toEqual({ 151: "0", 159: "1" });
  });

  it("reads a report that flattens its points beside the envelope keys", () => {
    const flat = { t: 1, protocol: 1, account_id: "<id>", device_sn: "<sn>", "163": 55 };
    expect(parseAiotDpReport(envelope(flat))).toEqual({ 163: "55" });
  });

  it("drops non-numeric keys and structured values rather than inventing points", () => {
    expect(parseAiotDpReport(envelope(report({ note: "hi", "153": { nested: 1 }, "163": 40 })))).toEqual({ 163: "40" });
  });

  it("returns undefined for a report carrying no points", () => {
    expect(parseAiotDpReport(envelope(report({})))).toBeUndefined();
  });

  it("returns undefined for an unrelated message on the same connection", () => {
    expect(parseAiotDpReport(envelope("not json"))).toBeUndefined();
    expect(parseAiotDpReport({ head: { cmd: 16 } })).toBeUndefined();
    expect(parseAiotDpReport(undefined)).toBeUndefined();
    expect(parseAiotDpReport({})).toBeUndefined();
  });
});
