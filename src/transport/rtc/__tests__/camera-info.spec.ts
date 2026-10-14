import { describe, expect, it } from "vitest";
import { informationPayload } from "../camera-info.js";

describe("informationPayload", () => {
  it.each(["params", "db_bypass_str"])("recognizes bounded %s arrays at the root and immediate payload", (key) => {
    const body = { [key]: [{ param_type: 1, param_value: "synthetic" }] };
    for (const input of [body, JSON.stringify(body), { payload: body }, { payload: JSON.stringify(body) }])
      expect(informationPayload(input)).toEqual(body);
    expect(informationPayload({ [key]: Array.from({ length: 4096 }, () => ({})) })).toBeDefined();
  });

  it.each([
    null,
    [],
    "bad",
    1,
    true,
    {},
    { params: null },
    { params: [null] },
    { params: [[]] },
    { params: [1] },
    { params: Array.from({ length: 4097 }, () => ({})) },
    { params: [], db_bypass_str: [null] },
    { params: [], db_bypass_str: "bad" },
    { params: [], db_bypass_str: Array.from({ length: 4097 }, () => ({})) },
    { db_bypass_str: [], params: [null] },
    { payload: { payload: { params: [] } } },
    { payload: "[]" },
  ])("rejects unrelated or malformed envelopes %#", (input) => {
    expect(informationPayload(input)).toBeUndefined();
  });
});
