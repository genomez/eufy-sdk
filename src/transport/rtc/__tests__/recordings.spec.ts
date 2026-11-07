import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRecordingTime, chicagoInstant } from "../event-time.js";
import { normalizeRecordingRows, projectRecordingRow, verifyRecordingSelector } from "../recordings.js";
import { cameras, row, scope, recordingFixture, sent } from "./recordings-fixture.js";
import type { RtcCommandRouter } from "../command-router.js";
import { COMMAND_CHANNEL, RtcPeer } from "../peer.js";

const collision = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return {
    ...original,
    createHmac: (...args: Parameters<typeof original.createHmac>) => {
      const hmac = original.createHmac(...args);
      const update = hmac.update.bind(hmac);
      const digest = hmac.digest.bind(hmac);
      let event = false;
      Object.defineProperty(hmac, "update", {
        value: (data: Parameters<typeof update>[0]) => {
          if (data === "recordings.event.v1" || (Buffer.isBuffer(data) && data.toString() === "recordings.event.v1"))
            event = true;
          update(data);
          return hmac;
        },
      });
      Object.defineProperty(hmac, "digest", {
        value: (encoding?: import("node:crypto").BinaryToTextEncoding) => {
          const value = encoding ? digest(encoding) : digest();
          return collision.enabled && event && encoding === "hex" && typeof value === "string"
            ? "00".repeat(17) + value.slice(34)
            : value;
        },
      });
      return hmac;
    },
  };
});

const routers: RtcCommandRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) r.close();
  collision.enabled = false;
  vi.restoreAllMocks();
});
const normalize = (rows: unknown[]) => {
  const result = normalizeRecordingRows(rows, scope, scope.identityKey, 1_800_000_000_000);
  if (result.status !== "ok") throw new Error("synthetic normalization failed");
  return result;
};

describe("strict Chicago recording times", () => {
  it.each([
    ["2026-01-02 03:04:05", "2026-01-02T09:04:05.000Z", "-06:00"],
    ["2026-07-02 03:04:05", "2026-07-02T08:04:05.000Z", "-05:00"],
  ])("converts %s without using host timezone", (value, utc, offset) => {
    const parsed = parseRecordingTime(value);
    expect(parsed).toMatchObject({ timeStatus: "valid", utc });
    expect(parsed.local).toBe(value.replace(" ", "T") + offset);
    expect(chicagoInstant(value)).toBe(parsed.atMs! / 1000);
  });
  it.each([
    ["2026-11-01 01:30:00", "ambiguous"],
    ["2026-03-08 02:30:00", "invalid"],
    ["2026-02-30 12:00:00", "invalid"],
    ["1999-01-01 00:00:00", "invalid"],
    ["2026-07-02T03:04:05Z", "unknown_format"],
    [1800000000, "unknown_format"],
    ["20260702030405", "unknown_format"],
    ["vendor-canary", "unknown_format"],
  ])("keeps unsupported or non-unique %s explicit", (value, status) => {
    expect(parseRecordingTime(value)).toMatchObject({ timeStatus: status, atMs: null, utc: null, local: null });
    expect(chicagoInstant(value)).toBeUndefined();
  });
});

describe("internal normalization and privacy", () => {
  it("retains private shared-path fingerprints for persistent ambiguity checks", () => {
    const entries = normalize([row(), row({ record_id: 2 })]).rows;
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.coverSelector === null)).toBe(true);
    expect(entries[0]!.coverPathKey).toMatch(/^[a-f0-9]{64}$/);
    expect(entries[0]!.coverPathKey).toBe(entries[1]!.coverPathKey);
    expect(normalize([row({ record_id: 3 })]).rows[0]!.coverPathKey).toBe(entries[0]!.coverPathKey);
    expect(projectRecordingRow(entries[0]!)).not.toHaveProperty("coverPathKey");
    const other = normalizeRecordingRows([row()], { ...scope, accountNamespace: "synthetic-other-namespace" });
    expect(other.status).toBe("ok");
    if (other.status === "ok") expect(other.rows[0]!.coverPathKey).not.toBe(entries[0]!.coverPathKey);
    expect(normalize([row({ thumb_path: "../invalid" })]).rows[0]!.coverPathKey).toBeNull();
  });
  it("detects a forced truncated-ID collision by retaining the distinct full hashes", () => {
    collision.enabled = true;
    const result = normalize([row(), row({ record_id: 2 })]);
    expect(result.rows).toEqual([]);
    expect(result.diagnostics.identity_conflict).toBe(1);
  });
  it("maps all five enrolled cameras, dropping every unknown row before producing selectors", () => {
    const result = normalize([
      ...cameras.map((device_sn, i) => row({ device_sn, record_id: i + 1, thumb_path: `/synthetic/${i}.jpg` })),
      row({ device_sn: "excluded-canary" }),
    ]);
    expect(result.rows).toHaveLength(5);
    expect(new Set(result.rows.map((r) => r.cameraId)).size).toBe(5);
    expect(result.diagnostics.rejected).toBe(1);
  });
  it("keeps identities stable through order, mutable metadata, and a fresh key copy", () => {
    const first = normalize([row()]).rows[0]!;
    const changed = normalizeRecordingRows(
      [row({ end_time: "2026-10-20 12:01:00", duration: 60, thumb_path: "/synthetic/new.jpg", name: "renamed" })],
      { ...scope, identityKey: Uint8Array.from(scope.identityKey) },
    );
    expect(changed.status).toBe("ok");
    if (changed.status === "ok")
      expect(changed.rows[0]).toMatchObject({
        sourceKey: first.sourceKey,
        eventId: first.eventId,
        cameraId: first.cameraId,
        scopeId: first.scopeId,
      });
    expect(normalize([row({ record_id: 2 }), row()]).rows.find((r) => r.sourceKey === first.sourceKey)).toBeDefined();
  });
  it("distinguishes changed starts and typed unknown starts without exposing vendor tokens", () => {
    const result = normalize([
      row(),
      row({ start_time: "2026-10-20 12:00:01" }),
      row({ record_id: 2, start_time: "1800000000" }),
      row({ record_id: 2, start_time: 1800000000 }),
    ]);
    expect(new Set(result.rows.map((r) => r.eventId)).size).toBe(4);
    expect(result.diagnostics.identity_conflict).toBe(2);
    expect(result.rows.filter((r) => r.timeStatus === "unknown_format").every((r) => r.sourceStartLocal === null)).toBe(
      true,
    );
  });
  it("trims only surrounding ASCII whitespace for identity and dedupes identical rows", () => {
    const result = normalize([row(), row({ start_time: "\t2026-10-20 12:00:00 \r" })]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.identityStartBasis).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects both conflicting duplicates instead of selecting an arbitrary cover", () => {
    expect(normalize([row(), row({ thumb_path: "/synthetic/conflict.jpg" }), row()])).toMatchObject({
      rows: [],
      diagnostics: { identity_conflict: 1 },
    });
  });
  it.each(["1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null])(
    "rejects noncanonical record selector %s",
    (record_id) => {
      expect(normalize([row({ record_id })]).rows).toEqual([]);
    },
  );
  it.each([null, {}, [], "x".repeat(65), "", true])("rejects unsupported identity start %s", (start_time) => {
    expect(normalize([row({ start_time })]).rows).toEqual([]);
  });
  it("refuses missing keys and more than the requested station window", () => {
    expect(normalizeRecordingRows([], { ...scope, identityKey: new Uint8Array() })).toEqual({
      status: "unavailable",
      reason: "store_unavailable",
    });
    expect(
      normalizeRecordingRows(
        Array.from({ length: 21 }, () => row()),
        scope,
      ),
    ).toEqual({ status: "unavailable", reason: "invalid_reply" });
  });
  it.each([
    "../secret.jpg",
    "/synthetic/../secret.jpg",
    "https://canary/image.jpg",
    "//host/image.jpg",
    "\\host\\image.jpg",
    "bad\npath",
    "/a/%2e%2e/file",
    "x".repeat(2049),
  ])("lists events with invalid paths but no cover: %s", (thumb_path) => {
    expect(normalize([row({ thumb_path })]).rows[0]!.coverSelector).toBeNull();
  });
  it("refuses shared paths across distinct source events", () => {
    expect(normalize([row(), row({ record_id: 2 })]).rows.every((r) => r.coverSelector === null)).toBe(true);
  });
  it("verifies every sealed selector component and rejects key, scope and source substitution", () => {
    const selector = normalize([row()]).rows[0]!.coverSelector!;
    expect(verifyRecordingSelector(scope, selector)).toBe(true);
    for (const patch of [
      { sourceKey: "0".repeat(64) },
      { cameraSn: cameras[1]! },
      { stationBinding: "other" },
      { thumbPath: "/synthetic/other.jpg" },
      { observedAtMs: selector.observedAtMs + 1 },
      { selectorMac: "a".repeat(64) },
    ])
      expect(verifyRecordingSelector(scope, { ...selector, ...patch })).toBe(false);
    expect(verifyRecordingSelector({ ...scope, identityKey: new Uint8Array(32) }, selector)).toBe(false);
    expect(verifyRecordingSelector({ ...scope, accountNamespace: "a_other" }, selector)).toBe(false);
  });
  it("does not qualify duration units or guess type labels", () => {
    const result = normalize([row({ end_time: "unknown", duration: 12, event_type: "Motion", detect_type: 9 })])
      .rows[0]!;
    expect(result).toMatchObject({
      durationSeconds: null,
      durationBasis: "unknown",
      eventType: { code: null, label: "Event unknown" },
      detectType: { code: 9, label: "Detection 9" },
    });
    expect(normalize([row()]).rows[0]).toMatchObject({ durationSeconds: 12, durationBasis: "end_minus_start" });
    expect(normalize([row({ end_time: "2026-10-22 12:00:00" })]).rows[0]!.durationSeconds).toBeNull();
  });
  it("sorts known instants newest first and unknowns last with stable opaque tie breaks", () => {
    const rows = normalize([
      row({ record_id: 3, start_time: "unknown" }),
      row(),
      row({ record_id: 2, start_time: "2026-10-21 12:00:00" }),
    ]).rows;
    expect(rows.map((r) => r.timeStatus)).toEqual(["valid", "valid", "unknown_format"]);
    expect(rows[0]!.startedAtMs).toBeGreaterThan(rows[1]!.startedAtMs!);
    const ties = normalize([row(), row({ record_id: 2 }), row({ record_id: 3 })]).rows.map((r) => r.eventId);
    expect(ties).toEqual([...ties].sort());
  });
  it("projects only safe fields even when raw fields contain synthetic sensitive canaries", () => {
    const canary = "SENSITIVE_SYNTHETIC_CANARY";
    const result = normalize([
      row({
        record_id: 73927491,
        video_path: canary,
        arbitrary: canary,
        event_type: canary,
        thumb_path: `/synthetic/${canary}.jpg`,
        start_time: canary,
      }),
    ]);
    expect(JSON.stringify(result.rows.map(projectRecordingRow))).not.toContain(canary);
    expect(JSON.stringify({ rows: result.rows, diagnostics: result.diagnostics })).not.toContain("73927491");
    expect(result.rows[0]!.identityStartBasis).not.toContain(canary);
  });
});

describe("production bounded reads", () => {
  it("rejects wrong ACK segments and ACK-only replies without accepting a matching table alone", async () => {
    const f = await recordingFixture();
    routers.push(f.router);
    f.session.ack = false;
    const read = f.router.readRecordingCatalog(scope, { timeoutMs: 20 });
    await sent(f.session);
    f.session.ackPacket(f.session.sent[0]!, 244);
    f.session.table([row()]);
    expect(await read).toEqual({ status: "unavailable", reason: "timeout" });
  });
  it.each(["table", "cover"])("preserves the decoded %s cap with value-free failures", async (kind) => {
    const f = await recordingFixture();
    routers.push(f.router);
    const selected = normalize([row()]).rows[0]!.coverSelector!;
    const pending =
      kind === "table" ? f.router.readRecordingCatalog(scope) : f.router.readRecordingCover(scope, selected);
    await sent(f.session);
    if (kind === "table") f.session.table([row()], { unused: "x".repeat(262145) });
    else f.session.notify({ file: selected.thumbPath, content: "x".repeat(524289) }, 1308);
    expect(await pending).toEqual({ status: "unavailable", reason: "invalid_reply" });
  });
  it("suppresses native send exception text before it reaches a logger", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const peer = new RtcPeer({ logger });
    const privatePeer = peer as unknown as { channels: Map<string, unknown>; commandOpen: boolean; framer: unknown };
    privatePeer.channels.set(COMMAND_CHANNEL, { isOpen: () => true });
    privatePeer.commandOpen = true;
    privatePeer.framer = {
      isReady: () => true,
      sendFrame: () => {
        throw new Error("SYNTHETIC_PATH_ACCOUNT_CANARY");
      },
    };
    expect(peer.sendCommand(Buffer.alloc(16))).toBe(false);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("[rtc] command send failed");
    expect(JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls))).not.toContain(
      "SYNTHETIC_PATH_ACCOUNT_CANARY",
    );
  });
  it.each([true, false])("accepts exact transaction plus ACK in either order, ACK first=%s", async (ackFirst) => {
    const f = await recordingFixture();
    routers.push(f.router);
    f.session.ack = ackFirst;
    const pending = f.router.readRecordingCatalog(scope);
    await sent(f.session);
    const request = JSON.parse(f.session.sent[0]!.subarray(16).toString());
    expect(request).toMatchObject({
      cmd: 1306,
      payload: {
        cmd: 10000,
        table: "history_record_info",
        payload: { count: 20, start_date: "", end_date: "", start_id: 0, end_id: 1, res_unzip: 1 },
      },
    });
    f.session.table([row()], { transaction: "wrong-canary" });
    f.session.table([row()], { table: "wrong" });
    f.session.table([row()]);
    if (!ackFirst) f.session.ackPacket(f.session.sent[0]!);
    expect(await pending).toMatchObject({ status: "ok", rows: [{ durationSeconds: 12 }] });
    expect(f.session.sent).toHaveLength(1);
    expect(JSON.stringify(f.logger)).not.toContain("wrong-canary");
  });
  it.each([{ rows: [] }, { rows: Array.from({ length: 21 }, (_, i) => row({ record_id: i + 1 })) }])(
    "accepts empty but refuses oversized window",
    async ({ rows }) => {
      const f = await recordingFixture();
      routers.push(f.router);
      const pending = f.router.readRecordingCatalog(scope);
      await sent(f.session);
      f.session.table(rows);
      expect(await pending).toMatchObject(
        rows.length ? { status: "unavailable", reason: "invalid_reply" } : { status: "ok", rows: [] },
      );
    },
  );
  it("fetches the selected older event path only, with no catalog reread and no raw fallback", async () => {
    const f = await recordingFixture();
    routers.push(f.router);
    const selector = normalize([row({ thumb_path: "/synthetic/old.jpg" })]).rows[0]!.coverSelector!;
    const pending = f.router.readRecordingCover(scope, selector);
    await sent(f.session);
    expect(JSON.parse(f.session.sent[0]!.subarray(16).toString())).toMatchObject({
      cmd: 1308,
      payload: [{ file: selector.thumbPath }],
    });
    f.session.notify({ file: "/synthetic/new.jpg", content: "/9j/2Q==" }, 1308);
    f.session.notify({ file: selector.thumbPath, content: "/9j/2Q==" }, 1308);
    expect(await pending).toEqual({ status: "ok", jpeg: Buffer.from([255, 216, 255, 217]) });
    f.advance(5001);
    expect(await f.router.readRecordingCover(scope, selector)).toEqual({
      status: "deferred",
      reason: "selector_reserved",
    });
    expect(f.session.sent).toHaveLength(1);
  });
  it("returns a fixed invalid_reply for invalid JPEG, with sensitive content absent", async () => {
    const f = await recordingFixture();
    routers.push(f.router);
    const selector = normalize([row()]).rows[0]!.coverSelector!;
    const pending = f.router.readRecordingCover(scope, selector);
    await sent(f.session);
    f.session.notify(
      { file: selector.thumbPath, content: "SYNTHETIC_CONTENT_CANARY", msg: "SYNTHETIC_ERROR_CANARY" },
      1308,
    );
    expect(await pending).toEqual({ status: "unavailable", reason: "invalid_reply" });
    expect(f.logger.warn).not.toHaveBeenCalled();
  });
});

describe("catalog continuation metadata", () => {
  it("preserves existing camera and event identities when enrollment grows", () => {
    const before = normalizeRecordingRows([row()], scope);
    const after = normalizeRecordingRows([row()], {
      ...scope,
      cameraSns: new Set([...scope.cameraSns, "synthetic-battery"]),
    });
    expect(before.status).toBe("ok");
    expect(after.status).toBe("ok");
    if (before.status === "ok" && after.status === "ok") {
      expect(after.rows[0]!.cameraId).toBe(before.rows[0]!.cameraId);
      expect(after.rows[0]!.eventId).toBe(before.rows[0]!.eventId);
    }
  });
  it("counts rejection reasons and exports only masked unknown time shapes", () => {
    const result = normalizeRecordingRows(
      [
        row({ start_time: "SECRET_CANARY123!?" }),
        row({ device_sn: "outside" }),
        row({ record_id: "bad" }),
        row({ start_time: null }),
        null,
      ],
      scope,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.diagnostics.rejectedByReason).toEqual({
        not_in_scope: 1,
        bad_record_id: 1,
        bad_start_time: 1,
        other: 1,
      });
      expect(result.diagnostics.unknownStartTimeShapes).toEqual([{ shape: "aaaaaa?aaaaaa999??", count: 1 }]);
      expect(JSON.stringify(result.diagnostics)).not.toContain("SECRET");
      expect(result.page.consistent).toBe(false);
    }
  });
});

describe("bounded catalog page admission", () => {
  it("requires the preceding cursor and completion gap beyond four pages and 60 seconds", async () => {
    const f = await recordingFixture();
    routers.push(f.router);
    expect(await f.router.readRecordingCatalog(scope, { beforeRecordId: 101 })).toEqual({
      status: "unavailable",
      reason: "invalid_options",
    });
    const page = async (start: number, beforeRecordId?: number) => {
      const count = f.session.sent.length;
      const read = f.router.readRecordingCatalog(scope, { beforeRecordId });
      await sent(f.session, count + 1);
      const rows = Array.from({ length: 20 }, (_, i) => row({ record_id: start - i, thumb_path: "" }));
      f.session.table(rows, { version: "1", count: 20, start_id: start, end_id: start - 19 });
      expect((await read).status).toBe("ok");
    };
    await page(1000);
    expect(await f.router.readRecordingCatalog(scope, { beforeRecordId: 981 })).toEqual({
      status: "deferred",
      reason: "quiet_period",
    });
    for (let i = 1; i <= 14; i++) {
      f.advance(5_000);
      expect(await f.router.readRecordingCatalog(scope, { beforeRecordId: 200 })).toEqual({
        status: "unavailable",
        reason: "invalid_options",
      });
      await page(1000 - i * 20, 1001 - i * 20);
      const packet = JSON.parse(f.session.sent.at(-1)!.subarray(16).toString());
      expect(packet.payload.payload).toMatchObject({ count: 20, start_id: 1000 - i * 20, end_id: 1 });
    }
    f.advance(5_000);
    expect(await f.router.readRecordingCatalog(scope, { beforeRecordId: 1 })).toEqual({
      status: "unavailable",
      reason: "invalid_options",
    });
    expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "deferred", reason: "rate_limited" });
  });
});
