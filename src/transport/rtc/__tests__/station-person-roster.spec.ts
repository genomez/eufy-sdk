import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingFixture, station, sent, control } from "./recordings-fixture.js";
import type { RtcCommandRouter } from "../command-router.js";
import { projectPersonRosterRow } from "../station-person-roster.js";

let router: RtcCommandRouter;
beforeEach(() => vi.stubEnv("EUFY_EVENT_PERSON_PROBE", "0"));
afterEach(() => {
  router?.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const person = (extra: Record<string, unknown> = {}) => ({
  person_id: 19,
  name: "Synthetic Person",
  ignore_flag: 0,
  update_time: 1_700_000_020,
  ...extra,
});
const envelope = (count = 1) => ({
  table: "person_basic_info",
  version: "1",
  count,
  start_id: 0,
  end_id: count,
});
const fixture = async () => {
  const f = await recordingFixture();
  router = f.router;
  return f;
};

describe("station person roster", () => {
  it("requests the roster with default count and waits for the matching reply and ACK", async () => {
    const { session, logger } = await fixture();
    session.ack = false;
    const pending = router.readStationPersonRoster(station);
    await sent(session);
    const request = JSON.parse(session.sent[0]!.subarray(16).toString());
    expect(request.payload).toMatchObject({ cmd: 10000, table: "person_basic_info", payload: { count: 100 } });
    session.table([person()], { ...envelope(), table: "record_crop_picture_info" });
    session.table([person()], { ...envelope(), transaction: "wrong-transaction" });
    session.ackPacket(session.sent[0]!, 12345);
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    session.table(
      [
        person({
          person_id: "19",
          name: "  Synthetic Person  ",
          ignore_flag: "1",
          update_time: "2020-01-01 00:00:00",
          relation: "private-relation",
          group_id: 11,
          age: 99,
          gender: "private-gender",
          house: "private-house",
          location: "private-location",
          notice: "private-notice",
          face_path: "private-face-path",
          feature: "private-feature",
        }),
      ],
      envelope(),
    );
    await Promise.resolve();
    expect(finished).toBe(false);
    session.ackPacket(session.sent[0]!);
    expect(await pending).toEqual({
      outcome: "success",
      rows: [person({ ignore_flag: 1, update_time: "2020-01-01 00:00:00" })],
    });
    expect(session.sent).toHaveLength(1);
    for (const log of Object.values(logger))
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/Synthetic Person|private-|2020-01-01/);
  });

  it.each([1, 100])("passes the requested count %i to the full-table read", async (count) => {
    const { session } = await fixture();
    const pending = router.readStationPersonRoster(station, { count });
    await sent(session);
    const request = JSON.parse(session.sent[0]!.subarray(16).toString());
    expect(request.payload).toMatchObject({ table: "person_basic_info", payload: { count } });
    session.table([], envelope(0));
    expect(await pending).toEqual({ outcome: "empty", rows: [] });
  });

  it.each([undefined, null, [], 42, "synthetic", {}])("projects malformed rows to null scalars: %j", (raw) => {
    expect(projectPersonRosterRow(raw)).toEqual({ person_id: null, name: null, ignore_flag: null, update_time: null });
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1.5", "1e2", " 19", true, {}])(
    "rejects malformed numeric values: %j",
    (value) => {
      expect(projectPersonRosterRow(person({ person_id: value, ignore_flag: value, update_time: value }))).toEqual(
        person({ person_id: null, ignore_flag: null, update_time: null }),
      );
    },
  );

  it.each([0, -1, Number.MAX_SAFE_INTEGER, "0", "-1", String(Number.MAX_SAFE_INTEGER)])(
    "accepts the same safe integer representations as crops: %j",
    (value) => {
      expect(projectPersonRosterRow(person({ person_id: value, ignore_flag: value, update_time: value }))).toEqual(
        person({ person_id: Number(value), ignore_flag: Number(value), update_time: Number(value) }),
      );
    },
  );

  it.each(["", "   ", "x".repeat(65), 42, null, {}])("rejects invalid or overlong names: %j", (name) => {
    expect(projectPersonRosterRow(person({ name }))).toEqual(person({ name: null }));
  });

  it.each(["x", "x".repeat(64)])("accepts bounded trimmed names", (name) => {
    expect(projectPersonRosterRow(person({ name: `  ${name}  ` }))).toEqual(person({ name }));
  });

  it.each(["2020-01-01 00:00:00", "2020-01-01T00:00:00.123456789Z", "2020-01-01T00:00:00+01:00"])(
    "accepts crop-compatible datetime strings: %s",
    (update_time) => {
      expect(projectPersonRosterRow(person({ update_time }))).toEqual(person({ update_time }));
    },
  );

  it.each(["synthetic-time", "2020-01-01", "2020-01-01T00:00:00.1234567890Z", ""])(
    "rejects malformed update times: %s",
    (update_time) => {
      expect(projectPersonRosterRow(person({ update_time }))).toEqual(person({ update_time: null }));
    },
  );

  it.each(["count", "length", "version", "start_id", "end_id", "mIntRet", "data"])(
    "rejects invalid envelope %s",
    async (kind) => {
      const { session } = await fixture();
      const pending = router.readStationPersonRoster(station, { count: 1 });
      await sent(session);
      session.table(kind === "length" ? [person(), person()] : [person()], {
        ...envelope(kind === "length" ? 2 : 1),
        ...(kind === "count" ? { count: 2 } : {}),
        ...(["version", "start_id", "end_id", "mIntRet"].includes(kind) ? { [kind]: undefined } : {}),
        ...(kind === "data" ? { data: [null] } : {}),
      });
      expect(await pending).toEqual({ outcome: "invalid_reply" });
    },
  );

  it.each(["owner", "deadline"])("discards staged rows on final %s failure", async (kind) => {
    const f = await fixture();
    const pending = router.readStationPersonRoster(station);
    await sent(f.session);
    f.session.table([person()], envelope());
    if (kind === "owner") Reflect.get(router, "sessions").get(station).generation++;
    else f.advance(2001);
    expect(await pending).toEqual({ outcome: kind === "owner" ? "owner_changed" : "timeout" });
  });

  it("shares busy arbitration with crop reads in both directions", async () => {
    const { session } = await fixture();
    const roster = router.readStationPersonRoster(station);
    await sent(session);
    expect(await router.readRecentPersonCrops(station)).toEqual({ outcome: "busy/not_admitted" });
    session.table([], envelope(0));
    expect(await roster).toEqual({ outcome: "empty", rows: [] });
    const crops = router.readRecentPersonCrops(station);
    await sent(session, 2);
    expect(await router.readStationPersonRoster(station)).toEqual({ outcome: "busy/not_admitted" });
    session.table([], { ...envelope(0), table: "record_crop_picture_info" });
    expect(await crops).toEqual({ outcome: "empty", rows: [] });
    expect(session.sent).toHaveLength(2);
  });

  it("foreground work preempts and waits for collector cleanup", async () => {
    const { session } = await fixture();
    const pending = router.readStationPersonRoster(station);
    await sent(session);
    await router.dispatchCommand(station, control);
    expect(await pending).toEqual({ outcome: "abandoned" });
    expect(Reflect.get(router, "eventPersonProbes").size).toBe(0);
    expect(Reflect.get(router, "eventTableObservers").has(session)).toBe(false);
    expect(Reflect.get(router, "sessions").get(station).pendingExchanges).toBe(0);
  });

  it("preserves the byte cap and never retries", async () => {
    const { session } = await fixture();
    const pending = router.readStationPersonRoster(station);
    await sent(session);
    session.table([person({ feature: "x".repeat(270_000) })], envelope());
    expect(await pending).toEqual({ outcome: "receive_rejected" });
    expect(session.sent).toHaveLength(1);
  });

  it("refuses without acquiring an owner and rejects invalid options before sending", async () => {
    const { session } = await fixture();
    expect(await router.readStationPersonRoster("missing-station")).toEqual({ outcome: "busy/not_admitted" });
    for (const key of ["count", "timeoutMs"] as const)
      for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, key === "count" ? 101 : 2001])
        await expect(router.readStationPersonRoster(station, { [key]: value })).rejects.toThrow(RangeError);
    expect(session.sent).toHaveLength(0);
  });

  it("cancels an admitted read and releases its collector", async () => {
    const { session } = await fixture();
    const controller = new AbortController();
    const pending = router.readStationPersonRoster(station, { signal: controller.signal });
    await sent(session);
    controller.abort();
    expect(await pending).toEqual({ outcome: "abandoned" });
    expect(session.sent).toHaveLength(1);
    expect(Reflect.get(router, "eventTableObservers").has(session)).toBe(false);
    expect(Reflect.get(router, "sessions").get(station).pendingExchanges).toBe(0);
  });

  it("refuses an already aborted signal without sending", async () => {
    const { session } = await fixture();
    expect(await router.readStationPersonRoster(station, { signal: AbortSignal.abort() })).toEqual({
      outcome: "busy/not_admitted",
    });
    expect(session.sent).toHaveLength(0);
  });

  it.each([false, true])("honors the custom timeout with ACK=%s and never retries", async (ack) => {
    const f = await fixture();
    f.session.ack = ack;
    vi.useFakeTimers();
    const pending = router.readStationPersonRoster(station, { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.session.sent).toHaveLength(1);
    f.advance(25);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual({ outcome: ack ? "ack_only/timeout" : "timeout" });
    expect(f.session.sent).toHaveLength(1);
  });
});
