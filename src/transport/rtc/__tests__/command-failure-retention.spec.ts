import { describe, expect, it } from "vitest";
import { CommandEvidenceRecorder, type CommandOutcome } from "../command-diagnostics.js";

function finish(recorder: CommandEvidenceRecorder, outcome: CommandOutcome) {
  const row = recorder.begin("synthetic-target", "attached", 1400, 1700);
  recorder.finish(row, outcome);
  return row;
}

describe("command failure retention", () => {
  it.each<Exclude<CommandOutcome, "success">>([
    "ack_timeout",
    "expired_before_send",
    "expired_after_send",
    "rejected",
    "closed",
    "not_sent",
    "connect_timeout",
    "other",
    "queue_full",
    "superseded_before_send",
    "cancelled_before_send",
    "cancelled_after_send",
    "closed_before_send",
    "closed_after_send",
  ])("retains the non-success outcome %s", (outcome) => {
    const recorder = new CommandEvidenceRecorder();
    finish(recorder, outcome);
    const snapshot = recorder.snapshot();
    expect(snapshot.failureRetention).toEqual({ recentFailures: snapshot.recent, evictedFailures: 0 });
    expect(snapshot.failureRetention.recentFailures[0]!.outcome).toBe(outcome);
  });

  it("keeps failures when subsequent successes evict the mixed recent history", () => {
    const recorder = new CommandEvidenceRecorder();
    finish(recorder, "rejected");
    finish(recorder, "ack_timeout");
    const failures = recorder.snapshot().failureRetention;
    for (let index = 0; index < 40; index++) finish(recorder, "success");
    const snapshot = recorder.snapshot();
    expect(snapshot.recent).toHaveLength(32);
    expect(snapshot.recent.every((row) => row.outcome === "success")).toBe(true);
    expect(snapshot.evicted).toBe(10);
    expect(snapshot.lastFailure).toEqual(failures.recentFailures[1]);
    expect(snapshot.failureRetention).toEqual(failures);
  });

  it("keeps the last thirty-two failures in completion order and counts only failure evictions", () => {
    const recorder = new CommandEvidenceRecorder();
    const attempts = [];
    for (let index = 0; index < 35; index++) {
      const row = finish(recorder, "other");
      attempts.push(row.attempt);
      recorder.finish(row, "rejected");
      finish(recorder, "success");
    }
    const snapshot = recorder.snapshot();
    expect(snapshot.failures).toBe(35);
    expect(snapshot.completed).toBe(70);
    expect(snapshot.failureRetention.evictedFailures).toBe(3);
    expect(snapshot.failureRetention.recentFailures.map((row) => row.attempt)).toEqual(attempts.slice(-32));
  });

  it("leaves failure history empty for successful operations", () => {
    const recorder = new CommandEvidenceRecorder();
    for (let index = 0; index < 40; index++) finish(recorder, "success");
    expect(recorder.snapshot().failureRetention).toEqual({ recentFailures: [], evictedFailures: 0 });
    expect(recorder.snapshot().lastFailure).toBeNull();
  });

  it("detaches producer rows and nested snapshots while preserving late passive evidence", () => {
    const recorder = new CommandEvidenceRecorder(() => 1);
    const row = recorder.begin("synthetic-target", "attached", 1400, 1700);
    row.postTimeout = {
      startedAtMs: 1,
      deadlineAtMs: 30001,
      finishedAtMs: null,
      status: "observing",
      receivedFrames: 0,
      invalidFrames: 0,
      headerSamples: [],
      headerSamplesOmitted: 0,
      transportAtFinish: null,
    };
    recorder.finish(row, "ack_timeout");
    const before = recorder.snapshot();
    row.postTimeout.receivedFrames = 2;
    row.command = 999;
    expect(recorder.snapshot().failureRetention).toEqual(before.failureRetention);
    recorder.updatePostTimeout(row);
    const after = recorder.snapshot();
    expect(after.failureRetention.recentFailures[0]!.postTimeout!.receivedFrames).toBe(2);
    expect(after.failureRetention.recentFailures[0]!.command).toBe(1400);
    expect(before.failureRetention.recentFailures[0]!.postTimeout!.receivedFrames).toBe(0);
    after.failureRetention.recentFailures[0]!.postTimeout!.receivedFrames = 999;
    after.failureRetention.recentFailures[0]!.stageTiming!.startedAtMicros = 999;
    expect(recorder.snapshot().failureRetention.recentFailures[0]!.stageTiming!.startedAtMicros).toBe(1000);
    expect(recorder.snapshot().failureRetention.recentFailures[0]!.postTimeout!.receivedFrames).toBe(2);
  });

  it("records passive cleanup after mixed-history eviction in the retained failure", () => {
    const recorder = new CommandEvidenceRecorder();
    const row = finish(recorder, "ack_timeout");
    let cleanups = 0;
    recorder.observe(row, (reason) => {
      cleanups++;
      row.postTimeout = {
        startedAtMs: 1,
        deadlineAtMs: 30001,
        finishedAtMs: 2,
        status: reason,
        receivedFrames: 0,
        invalidFrames: 0,
        headerSamples: [],
        headerSamplesOmitted: 0,
        transportAtFinish: null,
      };
      recorder.updatePostTimeout(row);
    });
    for (let index = 0; index < 33; index++) finish(recorder, "success");
    expect(cleanups).toBe(1);
    expect(recorder.snapshot().failureRetention.recentFailures[0]!.postTimeout!.status).toBe("evicted");
  });

  it("starts each recorder with empty volatile history and zero evictions", () => {
    const recorder = new CommandEvidenceRecorder();
    for (let index = 0; index < 33; index++) finish(recorder, "other");
    expect(recorder.snapshot().failureRetention.evictedFailures).toBe(1);
    expect(new CommandEvidenceRecorder().snapshot().failureRetention).toEqual({
      recentFailures: [],
      evictedFailures: 0,
    });
  });
});
