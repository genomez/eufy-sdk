import { describe, expect, it } from "vitest";
import { eventRowKeyShape } from "../event-table-candidate.js";

describe("eventRowKeyShape", () => {
  it("omits all nested object and JSON-string keys in top-level-only mode", () => {
    expect(
      eventRowKeyShape(
        [
          { people: { synthetic_person: 42 }, extra: '{"synthetic_name":7}' },
          { people: { another_person: 43 }, extra: "{bad" },
        ],
        true,
      ),
    ).toBe("rows=2 extra:stringx2 people:objectx2");
  });
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
    for (const secret of ["SECRETSERIAL", "Jason", "7", "bad"])
      expect(shape.replace(/x\d+/g, "").replace("rows=4", "")).not.toContain(secret);
  });

  it("caps the number of listed names", () => {
    const row = Object.fromEntries(Array.from({ length: 170 }, (_, i) => [`k${i}`, i]));
    expect(eventRowKeyShape([row])).toMatch(/\+20 more$/);
  });

  it("never prints data-like nested keys", () => {
    const shape = eventRowKeyShape([
      {
        by_camera: { T8214P1234567890: 1 },
        people: { Jason: 1, jason: 2 },
        big: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`n${i}`, i])),
        T8170T1023350: "top-level serial-shaped key",
      },
    ]);
    expect(shape).not.toMatch(/T8214|T8170|Jason/);
    expect(shape).toContain("by_camera.<other>x1");
    expect(shape).toContain("people.<other>x1");
    expect(shape).toContain("people.jason:numberx1");
    expect(shape).toContain("big.<many>x1");
    expect(shape).toContain("<other>x1");
  });
});
