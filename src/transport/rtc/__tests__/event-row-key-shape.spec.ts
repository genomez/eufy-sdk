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
    ).toBe("rows=2 extra:string[<=64]x2 people:objectx2");
  });

  it("shows uniform unknown schema columns across at least two rows", () => {
    expect(eventRowKeyShape([{ face_data: "synthetic-a" }, { face_data: "synthetic-b" }], true)).toBe(
      "rows=2 face_data:string[<=64]x2",
    );
  });

  it("masks unknown column names in a single row while retaining types", () => {
    expect(eventRowKeyShape([{ ada_example: 1, face_data: "synthetic", private_map: {} }], true)).toBe(
      "rows=1 <other>:numberx1 <other>:objectx1 <other>:string[<=64]x1",
    );
  });

  it("masks non-uniform data-keyed columns even when their spelling looks like schema", () => {
    expect(eventRowKeyShape([{ person_id: 1, ada_example: "synthetic-a" }, { person_id: 2 }], true)).toBe(
      "rows=2 <other>:string[<=64]x1 person_id:numberx2",
    );
  });

  it("masks invalid schema spelling and digit runs even in uniform columns", () => {
    const row = { AdaExample: 1, ada_1234: 2, "has space": 3, ["a".repeat(49)]: 4 };
    expect(eventRowKeyShape([row, row], true)).toBe("rows=2 <other>:numberx8");
  });

  it("allows unknown names at 40 distinct keys and masks them above that union across rows", () => {
    const columns = Object.fromEntries(Array.from({ length: 39 }, (_, index) => [`column_${index}`, index]));
    const row = { ...columns, person_id: 1 };
    expect(eventRowKeyShape([row, row], true)).toContain("column_0:numberx2");
    expect(eventRowKeyShape([row, { ...row, private_identity: 2 }], true)).toBe(
      "rows=2 <other>:numberx79 person_id:numberx2",
    );
  });

  it("counts string lengths per bucket at the 64 and 1024 code-unit boundaries without values", () => {
    const rows = [0, 64, 65, 1024, 1025, 4096].map((length) => ({ face_data: "x".repeat(length) }));
    expect(eventRowKeyShape(rows, true)).toBe(
      "rows=6 face_data:string[<=1k]x2 face_data:string[<=64]x2 face_data:string[>1k]x2",
    );
  });
  it("names columns, types and counts without any value", () => {
    const shape = eventRowKeyShape([
      { record_id: 7, device_sn: "SECRETSERIAL1", ai_info: { face_id: 3, nick: "Personfixture" }, extra: '{"person":"Personfixture"}' },
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
    for (const secret of ["SECRETSERIAL", "Personfixture", "7", "bad"])
      expect(shape.replace(/x\d+/g, "").replace("rows=4", "")).not.toContain(secret);
  });

  it("caps the number of listed names", () => {
    const row = Object.fromEntries(Array.from({ length: 170 }, (_, i) => [`k${i}`, i]));
    expect(eventRowKeyShape([row])).toMatch(/\+20 more$/);
  });

  it("never prints data-like nested keys", () => {
    const shape = eventRowKeyShape([
      {
        by_camera: { T9000SYNTHETIC001: 1 },
        people: { Personfixture: 1, personfixture: 2 },
        big: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`n${i}`, i])),
        T8170T1023350: "top-level serial-shaped key",
      },
    ]);
    expect(shape).not.toMatch(/T8214|T8170|Personfixture/);
    expect(shape).toContain("by_camera.<other>x1");
    expect(shape).toContain("people.<other>x1");
    expect(shape).toContain("people.personfixture:numberx1");
    expect(shape).toContain("big.<many>x1");
    expect(shape).toContain("<other>x1");
  });
});
