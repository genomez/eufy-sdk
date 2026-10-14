import { describe, expect, it } from "vitest";
import {
  decodeActiveVacuumScheduleCount,
  decodeVacuumScheduleCount,
  decodeVacuumSchedules,
} from "../vacuum-schedules.js";
import { byteCodec, frame, int, str, sub } from "../../model/capabilities/__tests__/proto-bytes.js";

/**
 * `TimerResponse` on DP 164 — the schedules read.
 *
 * Built from real bytes rather than a stubbed field list, because almost every question this decode
 * answers is about what is ABSENT. proto3 omits a zero, and three of this message's defaults are
 * zero-valued enums whose omission means something specific: a timer that fires once, a timer that runs
 * an auto-clean, a timer that is switched off.
 */

// TimerResponse.timers = 4, each a TimerInfo.
const report = (...timers: number[][]): string => frame(timers.flatMap((t) => sub(4, t)));

// TimerInfo: id 1 { value 1 }, status 2 { valid 1, opened 2 }, desc 3, action 5.
const id = (n: number): number[] => sub(1, int(1, n));
const status = (valid: boolean, opened: boolean): number[] =>
  sub(2, [...int(1, valid ? 1 : 0), ...int(2, opened ? 1 : 0)]);

/** Desc: trigger 1, timing 2 { user_tz 1, summer 2, hours 3, minutes 4 }, cycle 3 { week_bits 1 }. */
const desc = (o: {
  cycle?: boolean;
  hours?: number;
  minutes?: number;
  tz?: number;
  summer?: boolean;
  weekBits?: number;
}): number[] =>
  sub(3, [
    ...int(1, o.cycle ? 1 : 0),
    ...sub(2, [...int(1, o.tz ?? 0), ...int(2, o.summer ? 1 : 0), ...int(3, o.hours ?? 0), ...int(4, o.minutes ?? 0)]),
    ...sub(3, int(1, o.weekBits ?? 0)),
  ]);

/** Action: type 1, then the Param oneof — auto 3, rooms 4, cruise 5, scene 6. */
const action = (type: number, branch: number[] = []): number[] => sub(5, [...int(1, type), ...branch]);

/** ScheduleRoomsClean.Custom (3): map_id 1, rooms 3 { id 1, order 2 } — the X10-era layout. */
const customRooms = (mapId: number, ...rooms: number[]): number[] =>
  sub(4, sub(3, [...int(1, mapId), ...rooms.flatMap((r, i) => sub(3, [...int(1, r), ...int(2, i + 1)]))]));

/** ScheduleRoomsClean.General (2): map_id 1, rooms 6 — the X9-era layout, kept and still sent. */
const generalRooms = (mapId: number, ...rooms: number[]): number[] =>
  sub(4, sub(2, [...int(1, mapId), ...rooms.flatMap((r, i) => sub(6, [...int(1, r), ...int(2, i + 1)]))]));

describe("decodeVacuumSchedules (TimerResponse → schedules)", () => {
  it("reads a weekly rooms-clean in full", () => {
    const payload = report([
      ...id(7),
      ...status(true, true),
      ...desc({ cycle: true, hours: 9, minutes: 30, tz: 3600, summer: true, weekBits: 0b0101010 }),
      ...action(1, customRooms(2, 11, 12)),
    ]);

    expect(decodeVacuumSchedules(payload, byteCodec)).toEqual([
      {
        id: 7,
        enabled: true,
        valid: true,
        repeats: true,
        hour: 9,
        minute: 30,
        weekdays: ["monday", "wednesday", "friday"],
        utcOffsetSeconds: 3600,
        daylightSaving: true,
        action: "roomsClean",
        mapId: 2,
        roomIds: [11, 12],
      },
    ]);
  });

  it("reads several timers out of one report", () => {
    const payload = report(
      [...id(1), ...status(true, true), ...desc({ cycle: true, hours: 8, weekBits: 0b0000010 })],
      [...id(2), ...status(true, false), ...desc({ hours: 22, minutes: 15 })],
    );
    const schedules = decodeVacuumSchedules(payload, byteCodec);

    expect(schedules?.map((s) => [s.id, s.hour, s.minute, s.enabled])).toEqual([
      [1, 8, 0, true],
      [2, 22, 15, false],
    ]);
  });

  it("answers an empty list for a robot with no schedules, not undefined", () => {
    // A real and different answer from "could not read this": the device reports its timers in full
    // every time, so a report with none in it says there are none.
    expect(decodeVacuumSchedules(frame([]), byteCodec)).toEqual([]);
  });

  it("gives no weekdays to a one-shot timer, even when the mask is populated", () => {
    // `trigger` decides; `week_bits` is left over from an edit and does not fire the timer.
    const payload = report([...id(3), ...status(true, true), ...desc({ hours: 7, weekBits: 0b1111111 })]);
    expect(decodeVacuumSchedules(payload, byteCodec)?.[0]?.weekdays).toEqual([]);
  });

  it("puts Sunday at bit 0, as the vendor's mask does", () => {
    const payload = report([...id(4), ...status(true, true), ...desc({ cycle: true, weekBits: 0b1000001 })]);
    expect(decodeVacuumSchedules(payload, byteCodec)?.[0]?.weekdays).toEqual(["sunday", "saturday"]);
  });

  it("reads midnight as 00:00 rather than as a missing time", () => {
    // Both halves are the proto3 zero and so are absent from the wire. A timer set for midnight is the
    // case where "omitted" and "zero" have to be the same reading.
    const payload = report([...id(5), ...status(true, true), ...desc({ cycle: true, weekBits: 0b0000010 })]);
    const first = decodeVacuumSchedules(payload, byteCodec)?.[0];

    expect(first?.hour).toBe(0);
    expect(first?.minute).toBe(0);
  });
});

describe("decodeVacuumSchedules — which run the timer starts", () => {
  it("takes the action from the oneof branch, not from the type beside it", () => {
    // The trap: `SCHEDULE_AUTO_CLEAN = 0` is the enum's first member, so `Action.type` is omitted on
    // every auto-clean timer there is. Reading it alone would report a scene timer as an auto-clean
    // whenever a firmware left the type out.
    const payload = report([
      ...id(6),
      ...status(true, true),
      ...desc({}),
      ...action(0, sub(6, [...int(1, 42), ...str(2, "After dinner")])),
    ]);

    expect(decodeVacuumSchedules(payload, byteCodec)?.[0]).toMatchObject({
      action: "sceneClean",
      sceneId: 42,
      sceneName: "After dinner",
    });
  });

  it("reads an auto-clean whose branch is omitted entirely", () => {
    const payload = report([...id(8), ...status(true, true), ...desc({}), ...action(0)]);
    expect(decodeVacuumSchedules(payload, byteCodec)?.[0]?.action).toBe("autoClean");
  });

  it("reads a cruise's map", () => {
    const payload = report([...id(9), ...status(true, true), ...desc({}), ...action(2, sub(5, int(1, 3)))]);
    expect(decodeVacuumSchedules(payload, byteCodec)?.[0]).toMatchObject({ action: "cruise", mapId: 3 });
  });

  it("reads rooms out of the older General layout too", () => {
    // X9-era hardware numbers the room list 6 inside `General`; X10-era numbers it 3 inside `Custom`.
    // Neither is a fallback for the other — a device sends whichever its generation uses.
    const payload = report([...id(10), ...status(true, true), ...desc({}), ...action(1, generalRooms(1, 21, 22, 23))]);

    expect(decodeVacuumSchedules(payload, byteCodec)?.[0]).toMatchObject({
      action: "roomsClean",
      mapId: 1,
      roomIds: [21, 22, 23],
    });
  });

  it("keeps the room order the timer lists", () => {
    const payload = report([...id(11), ...status(true, true), ...desc({}), ...action(1, customRooms(1, 5, 3, 9))]);
    expect(decodeVacuumSchedules(payload, byteCodec)?.[0]?.roomIds).toEqual([5, 3, 9]);
  });

  it("names an action a later firmware adds as an auto-clean rather than throwing", () => {
    const payload = report([...id(12), ...status(true, true), ...desc({}), ...action(99)]);
    expect(decodeVacuumSchedules(payload, byteCodec)?.[0]?.action).toBe("autoClean");
  });
});

describe("decodeVacuumSchedules — what it refuses to read", () => {
  it("answers undefined without a codec", () => {
    expect(decodeVacuumSchedules(report([...id(1), ...status(true, true)]), undefined)).toBeUndefined();
  });

  it("answers undefined for a value that is not a Raw-DP payload", () => {
    expect(decodeVacuumSchedules(42, byteCodec)).toBeUndefined();
    expect(decodeVacuumSchedules(undefined, byteCodec)).toBeUndefined();
    expect(decodeVacuumSchedules("not base64 at all !!", byteCodec)).toBeUndefined();
  });

  it("answers undefined when the length prefix disagrees with the body", () => {
    // Truncated in flight: the codec rejects the whole payload rather than reporting a partial list,
    // so a caller never sees three of a robot's five schedules and takes that for all of them.
    const good = Buffer.from(report([...id(1), ...status(true, true)]), "base64");
    expect(decodeVacuumSchedules(good.subarray(0, good.length - 2).toString("base64"), byteCodec)).toBeUndefined();
  });
});

describe("the schedule counts", () => {
  const payload = report(
    [...id(1), ...status(true, true), ...desc({ cycle: true, hours: 8, weekBits: 0b0000010 })],
    [...id(2), ...status(true, false), ...desc({ hours: 9 })],
    [...id(3), ...status(false, true), ...desc({ hours: 10 })],
  );

  it("counts every schedule the robot holds", () => {
    expect(decodeVacuumScheduleCount(payload, byteCodec)).toBe(3);
  });

  it("counts only the schedules that will actually fire", () => {
    // Timer 2 is switched off; timer 3 is on but no longer valid — the device keeps a timer whose scene
    // or map was deleted so the app can explain itself, and it will not run.
    expect(decodeActiveVacuumScheduleCount(payload, byteCodec)).toBe(1);
  });

  it("reports zero schedules rather than none at all", () => {
    expect(decodeVacuumScheduleCount(frame([]), byteCodec)).toBe(0);
    expect(decodeActiveVacuumScheduleCount(frame([]), byteCodec)).toBe(0);
  });

  it("carries the unreadable case through as undefined", () => {
    expect(decodeVacuumScheduleCount("nonsense", byteCodec)).toBeUndefined();
    expect(decodeActiveVacuumScheduleCount(undefined, byteCodec)).toBeUndefined();
  });
});
