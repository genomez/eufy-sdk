import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingFixture, station, sent, control } from "./recordings-fixture.js";
import type { RtcCommandRouter } from "../command-router.js";
import { clockShape, projectPersonCrop } from "../recent-person-crops.js";

let router: RtcCommandRouter;
beforeEach(() => {
  vi.stubEnv("EUFY_EVENT_PERSON_PROBE", undefined);
  vi.stubEnv("EUFY_EVENT_DIAGNOSTICS", undefined);
});
afterEach(() => {
  router?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const crop = (extra = {}) => ({
  record_id: 71,
  crop_id: 4,
  picture_id: 8,
  person_id: 0,
  person_recog_flag: 0,
  detection_type: 1,
  device_sn: "synthetic-camera-0",
  start_utc: 1_700_000_000,
  end_utc: 1_700_000_010,
  update_time: 1_700_000_020,
  ...extra,
});
const envelope = (count = 1) => ({
  table: "record_crop_picture_info",
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

describe("recent person crops", () => {
  it("returns only sanitized metadata after the matching reply and ACK", async () => {
    const { session } = await fixture();
    session.ack = false;
    const pending = router.readRecentPersonCrops(station);
    await sent(session);
    const request = JSON.parse(session.sent[0]!.subarray(16).toString());
    expect(request.payload).toMatchObject({ table: "record_crop_picture_info", payload: { count: 20 } });
    session.table([crop()], { ...envelope(), table: "person_basic_info" });
    session.table([crop()], { ...envelope(), transaction: "wrong-transaction" });
    session.table(
      [
        crop({
          person_id: "19",
          person_recog_flag: {},
          update_time: "2020-01-01 00:00:00",
          crop_path: "private-path",
          feature_path: "private-feature",
          bbox_x: 111,
          name: "private-name",
        }),
      ],
      envelope(),
    );
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    session.ackPacket(session.sent[0]!);
    expect(await pending).toEqual({
      outcome: "success",
      rows: [
        {
          ...crop({ person_id: 19, person_recog_flag: null, update_time: "2020-01-01 00:00:00" }),
          start_time: null,
          end_time: null,
          image_cutout_timestamp: null,
          clock_shapes: {
            start_utc: "s",
            end_utc: "s",
            start_time: "missing",
            end_time: "missing",
            image_cutout_timestamp: "missing",
            update_time: "datetime",
          },
        },
      ],
    });
    expect(session.sent).toHaveLength(1);
  });

  it("passes integer clocks through and classifies raw clock formats without values", () => {
    const row = projectPersonCrop(
      crop({
        start_utc: 1_700_000_000.5,
        end_utc: "1700000010123",
        start_time: 1_700_000_000_000,
        end_time: "private-clock-text",
        image_cutout_timestamp: 0,
        update_time: "",
      }),
    );
    expect(row).toMatchObject({ start_utc: null, end_utc: 1_700_000_010_123, start_time: 1_700_000_000_000 });
    expect(row).toMatchObject({ end_time: null, image_cutout_timestamp: 0, update_time: null });
    expect(row.clock_shapes).toEqual({
      start_utc: "float",
      end_utc: "digits13",
      start_time: "ms",
      end_time: "text",
      image_cutout_timestamp: "zero",
      update_time: "empty",
    });
    expect(JSON.stringify(row.clock_shapes)).not.toMatch(/private|1700/);
    for (const [value, expected] of [
      [undefined, "missing"],
      [-5, "negative"],
      [Number.NaN, "nonfinite"],
      ["12.5", "decimal"],
      ["2026-11-13T17:55:00", "datetime"],
      [true, "boolean"],
      [{}, "object"],
    ] as const)
      expect(clockShape(value)).toBe(expected);
  });

  it.each(["count", "length", "version"])("rejects invalid envelope %s", async (kind) => {
    const { session } = await fixture();
    const pending = router.readRecentPersonCrops(station, { count: 1 });
    await sent(session);
    session.table(kind === "length" ? [crop(), crop()] : [crop()], {
      ...envelope(kind === "length" ? 2 : 1),
      ...(kind === "count" ? { count: 2 } : {}),
      ...(kind === "version" ? { version: undefined } : {}),
    });
    expect(await pending).toEqual({ outcome: "invalid_reply" });
  });

  it("accepts a validated empty table", async () => {
    const { session } = await fixture();
    const pending = router.readRecentPersonCrops(station);
    await sent(session);
    session.table([], envelope(0));
    expect(await pending).toEqual({ outcome: "empty", rows: [] });
  });

  it.each(["owner", "deadline"])("discards staged rows on final %s failure", async (kind) => {
    const f = await fixture();
    const pending = router.readRecentPersonCrops(station);
    await sent(f.session);
    f.session.table([crop()], envelope());
    if (kind === "owner") Reflect.get(router, "sessions").get(station).generation++;
    else f.advance(2001);
    expect(await pending).toEqual({ outcome: kind === "owner" ? "owner_changed" : "timeout" });
  });

  it("shares arbitration with schema probes in both directions without preempting them", async () => {
    const { session } = await fixture();
    const invokeProbe = () =>
      Reflect.get(router, "readEventCandidate").call(
        router,
        station,
        { timeoutMs: 2000, queryCount: 20 },
        undefined,
        "person_basic_info",
      );
    const probe = invokeProbe();
    await sent(session);
    expect(await router.readRecentPersonCrops(station)).toEqual({ outcome: "busy/not_admitted" });
    session.table([], { table: "person_basic_info" });
    expect((await probe).outcome).toBe("empty");
    const cropRead = router.readRecentPersonCrops(station);
    await sent(session, 2);
    expect((await invokeProbe()).outcome).toBe("busy/not_admitted");
    session.table([], envelope(0));
    expect((await cropRead).outcome).toBe("empty");
  });

  it("foreground work preempts and waits for collector cleanup", async () => {
    const { session } = await fixture();
    const pending = router.readRecentPersonCrops(station);
    await sent(session);
    await router.dispatchCommand(station, control);
    expect(await pending).toEqual({ outcome: "abandoned" });
    expect(Reflect.get(router, "eventPersonProbes").size).toBe(0);
    expect(Reflect.get(router, "eventTableObservers").has(session)).toBe(false);
    expect(Reflect.get(router, "sessions").get(station).pendingExchanges).toBe(0);
  });

  it("preserves the byte cap and never retries", async () => {
    const { session } = await fixture();
    const pending = router.readRecentPersonCrops(station);
    await sent(session);
    session.table([crop({ crop_path: "x".repeat(270_000) })], envelope());
    expect(await pending).toEqual({ outcome: "receive_rejected" });
    expect(session.sent).toHaveLength(1);
  });

  it("refuses without acquiring an owner and enforces narrow option bounds", async () => {
    const { session } = await fixture();
    expect(await router.readRecentPersonCrops("missing-station")).toEqual({ outcome: "busy/not_admitted" });
    for (const options of [{ count: 101 }, { count: 0 }, { timeoutMs: 2001 }, { timeoutMs: 0 }])
      await expect(router.readRecentPersonCrops(station, options)).rejects.toThrow(RangeError);
    expect(session.sent).toHaveLength(0);
  });

  it("cancels a read through its public signal", async () => {
    const { session } = await fixture();
    const controller = new AbortController();
    const pending = router.readRecentPersonCrops(station, { signal: controller.signal });
    await sent(session);
    controller.abort();
    expect(await pending).toEqual({ outcome: "abandoned" });
  });
});
