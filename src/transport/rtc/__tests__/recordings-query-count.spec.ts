import { afterEach, expect, it, vi } from "vitest";
import { CATALOG_QUERY_COUNT_MAX, normalizeRecordingRows } from "../recordings.js";
import { CATALOG_QUERY_COUNT_MAX as publicCountMax } from "../../../index.js";
import { EVENT_TABLE_BYTE_CAP } from "../event-table-candidate.js";
import { recordingFixture, row, scope, sent } from "./recordings-fixture.js";
import type { RtcCommandRouter } from "../command-router.js";
const routers: RtcCommandRouter[] = [];
afterEach(() => {
  for (const router of routers.splice(0)) router.close();
  vi.restoreAllMocks();
});
it("derives the row domain from the existing decoded reply packet bound", () => {
  expect(publicCountMax).toBe(CATALOG_QUERY_COUNT_MAX);
  expect(CATALOG_QUERY_COUNT_MAX).toBe(Math.floor((EVENT_TABLE_BYTE_CAP - 1) / 3));
});
it.each([undefined, 1, 20, 50, 100, CATALOG_QUERY_COUNT_MAX])(
  "sends requested count %s without changing other query fields",
  async (queryCount) => {
    const f = await recordingFixture();
    routers.push(f.router);
    const read = f.router.readRecordingCatalog(scope, { queryCount });
    await sent(f.session);
    const packet = JSON.parse(f.session.sent[0]!.subarray(16).toString());
    expect(packet.payload.payload).toEqual({
      count: queryCount ?? 20,
      start_date: "",
      end_date: "",
      start_id: 0,
      end_id: 1,
      flag: 0,
      need_ai: 1,
      res_unzip: 1,
      update_time: "0",
      start_time: "0",
      alarm_id: "",
    });
    const count = Math.min(queryCount ?? 20, 100);
    f.session.table(
      Array.from({ length: count }, (_, i) => row({ record_id: i + 1, thumb_path: "" })),
      { version: "1", count, start_id: count, end_id: 1 },
    );
    const result = await read;
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.page.count).toBe(count);
  },
);
it.each([0, -1, 1.5, NaN, Infinity, CATALOG_QUERY_COUNT_MAX + 1])(
  "rejects invalid count %s before sending",
  async (queryCount) => {
    const f = await recordingFixture();
    routers.push(f.router);
    expect(await f.router.readRecordingCatalog(scope, { queryCount })).toEqual({
      status: "unavailable",
      reason: "invalid_options",
    });
    expect(f.session.sent).toHaveLength(0);
  },
);
it("retains the default 20-row reply boundary and accepts larger explicitly requested pages", () => {
  const rows = Array.from({ length: 50 }, (_, i) => row({ record_id: i + 1 }));
  expect(normalizeRecordingRows(rows, scope)).toEqual({ status: "unavailable", reason: "invalid_reply" });
  expect(normalizeRecordingRows(rows, scope, scope.identityKey, Date.now(), "America/Chicago", 50).status).toBe("ok");
  expect(normalizeRecordingRows(rows, scope, scope.identityKey, Date.now(), "America/Chicago", 49)).toEqual({
    status: "unavailable",
    reason: "invalid_reply",
  });
});
