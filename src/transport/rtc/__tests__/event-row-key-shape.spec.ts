import { describe, expect, it } from "vitest";
import { eventRowKeyShape } from "../event-table-candidate.js";

describe("eventRowKeyShape", () => {
  it("names columns, types and counts without any value", () => {
    const shape = eventRowKeyShape([
      { record_id: 7, device_sn: "SECRETSERIAL1", ai_info: { face_id: 3, nick: "Jason" }, extra: '{"person":"Jason"}' },
      { record_id: 8, device_sn: "SECRETSERIAL2", ai_info: null, extra: "{bad" },
      "not a row",
      { "has space": 1, "x/y": "v" },
    ]);
    expect(shape).toContain("rows=4");
    expect(shape).toContain("record_id:numberx2");
    expect(shape).toContain("device_sn:stringx2");
    expect(shape).toContain("ai_info:objectx1");
    expect(shape).toContain("ai_info:nullx1");
    expect(shape).toContain("ai_info.face_id:numberx1");
    expect(shape).toContain("ai_info.nick:stringx1");
    expect(shape).toContain("extra{json}.person:stringx1");
    expect(shape).toContain("extra{json}:unparsedx1");
    expect(shape).toContain("<non-object row>x1");
    expect(shape).toContain("<other>x2");
    for (const secret of ["SECRETSERIAL", "Jason", "7", "bad"]) expect(shape.replace(/x\d+/g, "").replace("rows=4", "")).not.toContain(secret);
  });

  it("caps the number of listed names", () => {
    const row = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    expect(eventRowKeyShape([row])).toMatch(/\+20 more$/);
  });
});
