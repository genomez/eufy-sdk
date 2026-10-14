import { describe, expect, it } from "vitest";
import { CommandEvidenceRecorder, commandOutcome, type CommandHeaderSample } from "../command-diagnostics.js";

function header(receivedAtMs: number): CommandHeaderSample {
  return {
    receivedAtMs,
    linkType: 1,
    envelope: 1700,
    segment: 7,
    channel: 2,
    response: 1,
    innerCommand: null,
    errorCode: 0,
    matchesSegment: false,
    matchesChannel: true,
    matchesLink: true,
    matchesEnvelope: true,
    matchesResponse: true,
    matchesInnerCommand: false,
  };
}

describe("control evidence retention", () => {
  it("bounds headers, ignores undeclared payload and detaches finish and snapshot collections", () => {
    const recorder = new CommandEvidenceRecorder();
    const row = recorder.begin("synthetic-private-target", "attached", 1400, 1700);
    for (let i = 0; i < 24; i++) {
      const sample = Object.assign(header(i), { payload: "synthetic-secret-payload" });
      recorder.recordHeader(row, sample);
      sample.segment = 999;
    }
    expect(row.headerSamples).toHaveLength(16);
    expect(row.headerSamplesEvicted).toBe(8);
    expect(row.headerSamples[0]!.receivedAtMs).toBe(8);
    recorder.finish(row, "ack_timeout");
    row.headerSamples[0]!.segment = 888;
    row.headerSamples.length = 0;
    const snapshot = recorder.snapshot();
    expect(snapshot.recent[0]!.headerSamples).toHaveLength(16);
    expect(snapshot.lastFailure!.headerSamples[0]!.segment).toBe(7);
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-private-target|synthetic-secret-payload|payload/);
    snapshot.recent[0]!.headerSamples[0]!.segment = 777;
    expect(snapshot.lastFailure!.headerSamples[0]!.segment).toBe(7);
    snapshot.lastFailure!.headerSamples[0]!.channel = 666;
    expect(recorder.snapshot().recent[0]!.headerSamples[0]!.segment).toBe(7);
    expect(recorder.snapshot().lastFailure!.headerSamples[0]!.channel).toBe(2);
  });

  it("looks up only existing commanded targets without allocating or refreshing retention", () => {
    const recorder = new CommandEvidenceRecorder();
    expect(recorder.lookupTarget("synthetic-untouched")).toBeUndefined();
    expect(recorder.snapshot().attempts).toBe(0);
    const first = recorder.begin("synthetic-first", "attached", 1400, 1700);
    expect(recorder.lookupTarget("synthetic-first")).toEqual({ target: first.target, latestCommandAttempt: 1 });
    const detached = recorder.lookupTarget("synthetic-first")!;
    detached.target = 999;
    detached.latestCommandAttempt = 999;
    expect(recorder.lookupTarget("synthetic-first")).toEqual({ target: first.target, latestCommandAttempt: 1 });
    for (let i = 0; i < 32; i++) {
      recorder.lookupTarget("synthetic-first");
      recorder.begin(`synthetic-other-${i}`, "attached", 1400, 1700);
    }
    expect(recorder.lookupTarget("synthetic-first")).toBeUndefined();
    const later = recorder.begin("synthetic-first", "attached", 1400, 1700);
    expect(later.target).toBeGreaterThan(first.target);
    expect(recorder.lookupTarget("synthetic-first")!.latestCommandAttempt).toBe(later.attempt);
  });

  it("bounds completed rows, preserves failures and detaches snapshots", () => {
    const recorder = new CommandEvidenceRecorder();
    const failed = recorder.begin("synthetic-private-target", "attached", 1400, 1700);
    failed.rejectionCode = -17;
    recorder.finish(failed, "rejected");
    for (let i = 0; i < 40; i++)
      recorder.finish(recorder.begin("synthetic-private-target", "attached", 1400, 1700), "success");
    const got = recorder.snapshot();
    expect(got).toMatchObject({ attempts: 41, completed: 41, failures: 1, evicted: 9 });
    expect(got.recent).toHaveLength(32);
    expect(got.lastFailure?.rejectionCode).toBe(-17);
    expect(new Set(got.recent.map((r) => r.target)).size).toBe(1);
    expect(JSON.stringify(got)).not.toContain("synthetic-private-target");
    got.recent[0]!.matchedAcks = 999;
    got.lastFailure!.rejectionCode = 999;
    expect(recorder.snapshot().recent[0]!.matchedAcks).toBe(0);
    expect(recorder.snapshot().lastFailure!.rejectionCode).toBe(-17);
  });

  it("evicts private target associations without reusing an ordinal for a different target", () => {
    const recorder = new CommandEvidenceRecorder();
    const first = recorder.begin("synthetic-0", "station", 1100, 1350);
    recorder.finish(first, "success");
    for (let i = 1; i <= 32; i++) recorder.finish(recorder.begin(`synthetic-${i}`, "attached", 1400, 1700), "success");
    const later = recorder.begin("synthetic-0", "station", 1100, 1350);
    expect(later.target).toBeGreaterThan(first.target);
    expect(recorder.begin("synthetic-0", "station", 1100, 1350).target).toBe(later.target);
    expect(recorder.begin("synthetic-other", "station", Infinity, 1350).command).toBeNull();
  });

  it.each([
    ["RTC command ACK timed out; outcome unknown", "ack_timeout"],
    ["RTC command timed out before send", "expired_before_send"],
    ["RTC command timed out after send; outcome unknown", "expired_after_send"],
    ["rtc: synthetic rejected cmd 1400 (err -17)", "rejected"],
    ["rtc: synthetic session closed while waiting for cmd 1400 ACK", "closed"],
    ["rtc: synthetic command channel not open, cmd 1400 not sent", "not_sent"],
    ["rtc: synthetic did not come up within 100ms", "connect_timeout"],
    ["synthetic-private-message", "other"],
  ])("classifies %s without retaining text", (message, outcome) => {
    expect(commandOutcome(new Error(message))).toBe(outcome);
  });
});
