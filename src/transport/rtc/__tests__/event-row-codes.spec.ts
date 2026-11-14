import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventRowCodeDiagnostic } from "../event-row-codes.js";

beforeEach(() => vi.stubEnv("EUFY_EVENT_DIAGNOSTICS", "1"));
afterEach(() => vi.unstubAllEnvs());

const row = (extra: Record<string, unknown> = {}) => ({
  record_id: 1,
  start_time: 1800000000,
  device_sn: "synthetic-camera-a",
  ...extra,
});

function fixture() {
  const lines: string[] = [];
  const diagnostic = new EventRowCodeDiagnostic((line) => lines.push(line));
  return { diagnostic, lines, parsed: () => lines.map((line) => JSON.parse(line)) };
}

describe("event row code diagnostic", () => {
  it.each([undefined, "0", "true", ""])("writes nothing unless explicitly enabled (setting=%s)", (setting) => {
    vi.stubEnv("EUFY_EVENT_DIAGNOSTICS", setting);
    const f = fixture();
    f.diagnostic.writeRows([row()]);
    expect(f.lines).toEqual([]);
    vi.stubEnv("EUFY_EVENT_DIAGNOSTICS", "1");
    f.diagnostic.writeRows([row()]);
    expect(f.lines).toHaveLength(1);
  });

  it("writes exact numeric fields while excluding identity, paths, names and text", () => {
    const f = fixture();
    f.diagnostic.writeRows([
      row({
        record_id: "7",
        start_time: "1800000000",
        trigger_type: "3102",
        video_type: 2,
        vision: 1,
        self_learning: 0,
        int_extra: "-3",
        int_reserve: "4.0",
        another_int: 15,
        device_type: 9000,
        event_status: " 1e2 ",
        duration: 12,
        frame_count: "30",
        storage_size: 1024,
        fractional: 1.5,
        unsafe: "9007199254740992",
        boolean: true,
        empty: "",
        blank: " ",
        nil: null,
        mixed: "3tail",
        station_sn: "1234567",
        station_id: 100,
        user_id: 101,
        name: "123",
        nickname: "124",
        thumb_path: "125",
        video_url: "126",
        free_text: "127",
        "bad/key": 128,
        UPPER: 129,
        serial123456: 130,
        str_extra: JSON.stringify({
          detect_type: "3111",
          event_flag: -2,
          fraction: 2.5,
          name: "131",
          face_name: "132",
          url: 133,
          device_sn: "134",
          Safe: 135,
          "bad key": 136,
          x12345: 137,
          nested: { code: 138 },
          list: [139],
          text: "synthetic-private-text",
        }),
      }),
    ]);
    expect(f.parsed()).toEqual([
      {
        record_id: 7,
        start_time: 1800000000,
        camera_index: 0,
        codes: {
          trigger_type: 3102,
          video_type: 2,
          vision: 1,
          self_learning: 0,
          int_extra: -3,
          int_reserve: 4,
          device_type: 9000,
          event_status: 100,
          duration: 12,
          frame_count: 30,
          storage_size: 1024,
        },
        str_extra: { detect_type: 3111, event_flag: -2 },
      },
    ]);
    expect(f.lines[0]).toMatch(/\n$/);
    expect(f.lines.join("")).not.toMatch(/synthetic|1234567|private/);
  });

  it.each([
    "person_id",
    "face_id",
    "ai_face_id",
    "family_id",
    "member_id",
    "owner_id",
    "uid",
    "mobile",
    "tel",
    "pin",
    "passcode",
    "pwd",
    "ssid",
    "ip",
    "mac",
    "id",
    "did",
    "person_type",
    "face_status",
    "member_mode",
    "family_flag",
    "owner_type",
    "pass_status",
    "id_type",
    "uid_status",
    "did_mode",
    "pin_flag",
    "pwd_type",
    "mac_status",
    "ip_mode",
    "ssid_flag",
    "mobile_type",
    "tel_status",
    "event_id_type",
    "unknown_integer",
  ])("rejects numeric identity or unapproved column %s in both row and str_extra", (key) => {
    const f = fixture();
    f.diagnostic.writeRows([row({ [key]: 4242, str_extra: JSON.stringify({ [key]: "4242", trigger_type: 3 }) })]);
    expect(f.parsed()[0].codes).toEqual({});
    expect(f.parsed()[0].str_extra).toEqual({ trigger_type: 3 });
    expect(f.lines[0]).not.toContain("4242");
  });

  it.each([true, false, "", " ", "3tail", null, 1.5, "9007199254740992"])("rejects non-integer code %s", (value) => {
    const f = fixture();
    f.diagnostic.writeRows([row({ trigger_type: value, str_extra: JSON.stringify({ video_type: value }) })]);
    expect(f.parsed()[0].codes).toEqual({});
    expect(f.parsed()[0].str_extra).toEqual({});
  });

  it("keeps first-seen camera ordinals stable across calls and distinguishes channels", () => {
    const f = fixture();
    f.diagnostic.writeRows([row(), row({ record_id: 2, device_sn: "synthetic-camera-b" })]);
    f.diagnostic.writeRows([
      row({ record_id: 3 }),
      row({ record_id: 4, device_sn: "synthetic-camera-b" }),
      row({ record_id: 5, channel: 2 }),
      row({ record_id: 6, channel: "2" }),
      row({ record_id: 7, device_sn: undefined, device_channel: 3 }),
    ]);
    expect(f.parsed().map((line) => line.camera_index)).toEqual([0, 1, 0, 1, 2, 2, 3]);
  });

  it("skips unchanged records across reads and rewrites a record whose integers changed", () => {
    const f = fixture();
    f.diagnostic.writeRows([row(), row({ record_id: "1" }), row({ record_id: 2 })]);
    f.diagnostic.writeRows([row(), row({ record_id: 2 })]);
    expect(f.parsed().map((line) => line.record_id)).toEqual([1, 2]);
    f.diagnostic.writeRows([row({ record_id: "1", trigger_type: 3111 }), row({ record_id: 2 })]);
    f.diagnostic.writeRows([row({ record_id: 1, trigger_type: 3111 })]);
    expect(f.parsed().map((line) => line.record_id)).toEqual([1, 2, 1]);
    expect(f.parsed().at(-1).codes.trigger_type).toBe(3111);
  });

  it("keeps channel-only cameras on different stations distinct without writing either station", () => {
    const f = fixture();
    f.diagnostic.writeRows([row({ device_sn: undefined, channel: 1 })], undefined, "synthetic-station-a");
    f.diagnostic.writeRows([row({ record_id: 2, device_sn: undefined, channel: 1 })], undefined, "synthetic-station-b");
    expect(f.parsed().map((line) => line.camera_index)).toEqual([0, 1]);
    expect(f.lines.join("")).not.toContain("synthetic");
  });

  it("deduplicates overlapping record ids independently across stations", () => {
    const f = fixture();
    for (let repeat = 0; repeat < 3; repeat++) {
      f.diagnostic.writeRows([row({ trigger_type: 3 })], undefined, "synthetic-station-a");
      f.diagnostic.writeRows([row({ trigger_type: 4 })], undefined, "synthetic-station-b");
    }
    expect(f.parsed().map((line) => [line.record_id, line.camera_index, line.codes.trigger_type])).toEqual([
      [1, 0, 3],
      [1, 1, 4],
    ]);
    f.diagnostic.writeRows([row({ trigger_type: 5 })], undefined, "synthetic-station-a");
    f.diagnostic.writeRows([row({ trigger_type: 4 })], undefined, "synthetic-station-b");
    expect(f.lines).toHaveLength(3);
    expect(f.lines.join("")).not.toContain("synthetic");
  });

  it("bounds remembered ids to the most recent 2000 writes", () => {
    const f = fixture();
    f.diagnostic.writeRows(Array.from({ length: 2001 }, (_, i) => row({ record_id: i + 1 })));
    f.diagnostic.writeRows([row({ record_id: 2 }), row()]);
    expect(f.lines).toHaveLength(2002);
    expect(f.parsed().at(-1).record_id).toBe(1);
  });

  it("stops at 5000 successful lines across multiple reads", () => {
    const f = fixture();
    f.diagnostic.writeRows(Array.from({ length: 5002 }, (_, i) => row({ record_id: i + 1 })));
    f.diagnostic.writeRows([row({ record_id: 9000 })]);
    expect(f.lines).toHaveLength(5000);
    expect(f.parsed().at(-1).record_id).toBe(5000);
  });

  it("converts unambiguous station timestamps to epoch seconds using the configured timezone", () => {
    const f = fixture();
    f.diagnostic.writeRows([row({ start_time: "2026-07-02 03:04:05" })], "UTC");
    expect(f.parsed()[0].start_time).toBe(Date.UTC(2026, 6, 2, 3, 4, 5) / 1000);
    f.diagnostic.writeRows([row({ record_id: 2, start_time: "2026-11-01 01:30:00" })], "America/Chicago");
    expect(f.lines).toHaveLength(1);
  });

  it("drops invalid metadata and tolerates malformed, scalar and nested extra JSON", () => {
    const f = fixture();
    f.diagnostic.writeRows([
      null,
      [],
      "private",
      row({ record_id: "private" }),
      row({ record_id: 0 }),
      row({ start_time: 0 }),
      row({ start_time: "not a time" }),
      row({ device_sn: undefined }),
      row({ str_extra: "{bad" }),
      row({ record_id: 2, str_extra: "[]" }),
      row({ record_id: 3, str_extra: '{"nested":{"code":7}}' }),
    ]);
    expect(f.parsed().map((line) => line.str_extra)).toEqual([{}, {}, {}]);
  });

  it("never throws on a failed append and remembers only successfully written ids and cameras", () => {
    const lines: string[] = [];
    let fail = true;
    const diagnostic = new EventRowCodeDiagnostic((line) => {
      if (fail) throw new Error("synthetic write failure");
      lines.push(line);
    });
    expect(() => diagnostic.writeRows([row()])).not.toThrow();
    fail = false;
    diagnostic.writeRows([row({ record_id: 2, device_sn: "synthetic-camera-b" }), row()]);
    expect(lines.map((line) => JSON.parse(line).camera_index)).toEqual([0, 1]);
  });
});
