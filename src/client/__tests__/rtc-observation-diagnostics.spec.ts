import { describe, expect, it } from "vitest";
import { RtcObservationRecorder } from "../rtc-observation-diagnostics.js";

describe("RTC report observation evidence", () => {
  it("retains only numeric temporal associations, with no input extras or shared rows", () => {
    const recorder = new RtcObservationRecorder();
    const row = {
      attempt: 1,
      target: 2,
      observedAtMs: 1000,
      properties: 3,
      credential: "private-synthetic-marker",
      deviceSn: "T8425P0000000000",
    };
    recorder.record(row);
    row.properties = 9;
    const first = recorder.diagnostics();
    expect(first.recent).toEqual([{ attempt: 1, target: 2, observedAtMs: 1000, properties: 3 }]);
    first.recent[0]!.properties = 88;
    expect(recorder.diagnostics().recent[0]!.properties).toBe(3);
    expect(JSON.stringify(recorder.diagnostics())).not.toContain("private-synthetic-marker");
    expect(JSON.stringify(recorder.diagnostics())).not.toContain("T8425P0000000000");
  });

  it("bounds retained rows and reports eviction without erasing the cumulative count", () => {
    const recorder = new RtcObservationRecorder();
    for (let i = 0; i < 135; i++) recorder.record({ attempt: 1, target: 2, observedAtMs: i, properties: 1 });
    expect(recorder.diagnostics()).toMatchObject({ total: 135, evicted: 7 });
    expect(recorder.diagnostics().recent).toHaveLength(128);
    expect(recorder.diagnostics().recent[0]!.observedAtMs).toBe(7);
  });

  it.each([NaN, Infinity, -1, 0.5])("ignores invalid numeric observations without changing state: %s", (bad) => {
    const recorder = new RtcObservationRecorder();
    for (const key of ["attempt", "target", "observedAtMs", "properties"] as const)
      recorder.record({ attempt: 1, target: 2, observedAtMs: 1000, properties: 3, [key]: bad });
    expect(recorder.diagnostics()).toEqual({ total: 0, evicted: 0, recent: [] });
  });
});
