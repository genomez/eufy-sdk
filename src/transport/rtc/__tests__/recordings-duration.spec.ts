import { describe, expect, it } from "vitest";
import { normalizeRecordingRows } from "../recordings.js";
import { row, scope } from "./recordings-fixture.js";

function normalized(extra: Record<string, unknown>) {
  const result = normalizeRecordingRows([row({ thumb_path: null, ...extra })], scope);
  expect(result.status).toBe("ok");
  if (result.status !== "ok" || !result.rows[0]) throw new Error("Missing synthetic catalog row");
  return result.rows[0];
}

describe("catalog duration qualification", () => {
  it.each([
    ["2026-10-20 11:59:59", null],
    ["2026-10-20 12:00:00", 0],
    ["2026-10-20 12:00:01", 1],
    ["2026-10-20 12:00:02", 2],
    ["2026-10-20 12:00:03", 3],
    ["2026-10-20 12:00:04", 4],
    ["2026-10-20 12:00:12", 12],
    ["2026-10-21 12:00:00", 86400],
    ["2026-10-21 12:00:01", null],
  ])("qualifies end %s as %s seconds without treating a playback selector as video evidence", (end_time, duration) => {
    const entry = normalized({ end_time, duration: 999999 });
    expect(entry.durationSeconds).toBe(duration);
    expect(entry.durationBasis).toBe(duration === null ? "unknown" : "end_minus_start");
    expect(entry.coverSelector).toBeNull();
    expect(entry.coverPathKey).toBeNull();
    if (duration !== null && duration > 0)
      expect(entry.playbackSelector).toMatchObject({ expectedMs: duration * 1000 });
    else expect(entry.playbackSelector).toBeNull();
  });

  it.each([
    undefined,
    null,
    "",
    0,
    -1,
    1800000000,
    1800000000000,
    "1800000000",
    "2026-10-20 12:00:03.000",
    "2026-10-20 12:00:03.001",
    "2026-10-20 12:00:03.999",
    "2026-10-20T12:00:04Z",
    "2026-02-30 12:00:04",
    "2026-11-01 01:30:00",
    "2026-03-08 02:30:00",
  ])("does not infer duration units or round unsupported end %s", (end_time) => {
    const entry = normalized({ end_time, duration: 12 });
    expect(entry.durationSeconds).toBeNull();
    expect(entry.durationBasis).toBe("unknown");
    expect(entry.playbackSelector).toBeNull();
  });

  it.each(["unknown", 1800000000, "2026-10-20 12:00:00.001", "2026-11-01 01:30:00"])(
    "does not derive duration from unqualified start %s",
    (start_time) => {
      const entry = normalized({ start_time });
      expect(entry.startedAtMs).toBeNull();
      expect(entry.durationSeconds).toBeNull();
      expect(entry.playbackSelector).toBeNull();
    },
  );

  it("retains authenticated cover evidence independently of invalid duration", () => {
    const entry = normalized({ end_time: null, thumb_path: "/synthetic/cover-duration.jpg" });
    expect(entry.durationSeconds).toBeNull();
    expect(entry.playbackSelector).toBeNull();
    expect(entry.coverSelector).not.toBeNull();
    expect(entry.coverPathKey).toMatch(/^[a-f0-9]{64}$/);
  });
});
