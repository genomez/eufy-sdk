/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeCommand } from "../../core/contracts.js";
import { RtcLateEffectReconciler, type LateEffectEvent } from "../rtc-late-effect.js";

const lightCommand = (value: number, channel = 1) =>
  observeCommand(
    { kind: "set-json", param: 1400, data: { value }, channel },
    {
      event: "property changed",
      param: 1400,
      property: "light",
      expected: value,
      passiveReadback: true,
      lateEffectReadback: true,
      timeoutMs: 14_000,
    },
  );

function fixture() {
  let allowed = true;
  const events: LateEffectEvent[] = [];
  const reads: {
    station: string;
    signal: AbortSignal;
    timeoutMs: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  const reconciler = new RtcLateEffectReconciler({
    canRead: () => allowed,
    read: (station, signal, timeoutMs) => {
      const pending = Promise.withResolvers<void>();
      reads.push({ station, signal, timeoutMs, resolve: pending.resolve, reject: pending.reject });
      return pending.promise;
    },
    event: (event) => events.push(event),
  });
  const start = (device = "synthetic-camera", value = 1, channel = 1) => {
    const intent = reconciler.begin("synthetic-station", device, lightCommand(value, channel));
    reconciler.sent(intent, Date.now());
    reconciler.finish(intent, true);
    return intent;
  };
  return { reconciler, events, reads, start, hold: () => (allowed = false) };
}

afterEach(() => vi.useRealTimers());

describe("RTC late effect station scheduling", () => {
  it("accepts pending only while the transmitted generation owns a bounded job", () => {
    vi.useFakeTimers();
    const f = fixture();
    const intent = f.reconciler.begin("synthetic-station", "synthetic-camera", lightCommand(0));
    expect(f.reconciler.finish(intent, true, true)).toBe(false);
    expect(f.reconciler.diagnostics().pendingAccepted).toBe(0);
    const sent = f.reconciler.begin("synthetic-station", "synthetic-camera", lightCommand(0));
    f.reconciler.sent(sent, Date.now());
    expect(f.reconciler.finish(sent, true, true)).toBe(true);
    expect(f.reconciler.diagnostics()).toMatchObject({ scheduled: 1, pendingAccepted: 1 });
    expect(f.events).toEqual(["scheduled", "pending_accepted"]);
    const superseding = f.reconciler.begin("synthetic-station", "synthetic-camera", lightCommand(1));
    expect(f.reconciler.finish(sent, true, true)).toBe(false);
    f.reconciler.sent(superseding, Date.now() - 45000);
    expect(f.reconciler.finish(superseding, true, true)).toBe(false);
    expect(f.reconciler.diagnostics().pendingAccepted).toBe(1);
    f.reconciler.close();
    expect(f.reconciler.diagnostics().pendingAccepted).toBe(0);
  });

  it("coalesces nearby target deadlines into one station read and confirms each from information", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.start("synthetic-camera-a", 1, 1);
    await vi.advanceTimersByTimeAsync(500);
    f.start("synthetic-camera-b", 0, 2);
    await vi.advanceTimersByTimeAsync(14_500);
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0]).toMatchObject({ station: "synthetic-station", timeoutMs: 8_000 });
    f.reconciler.observe("synthetic-camera-a", { 1400: "1" });
    f.reconciler.observe("synthetic-camera-b", { 1400: "0" });
    f.reads[0]!.resolve();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.reads).toHaveLength(1);
    expect(f.reconciler.diagnostics()).toMatchObject({ scheduled: 2, confirmed: 2, expired: 0 });
    f.reconciler.close();
  });

  it("supersedes an intent during its read without confirming or scheduling more reads for it", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(15_000);
    const newer = f.reconciler.begin("synthetic-station", "synthetic-camera", lightCommand(0));
    f.reconciler.observe("synthetic-camera", { 1400: "1" });
    f.reconciler.finish(newer, false);
    f.reads[0]!.resolve();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.reads).toHaveLength(1);
    expect(f.reconciler.diagnostics()).toMatchObject({ scheduled: 1, superseded: 1, confirmed: 0 });
    expect(f.reconciler.has("synthetic-station")).toBe(false);
    f.reconciler.close();
  });

  it.each(["station", "disconnect"])("aborts an in-flight read on %s close", async (reason) => {
    vi.useFakeTimers();
    const f = fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(15_000);
    if (reason === "station") f.reconciler.closeStation("synthetic-station");
    else f.reconciler.close();
    expect(f.reads[0]!.signal.aborted).toBe(true);
    f.reads[0]!.reject(f.reads[0]!.signal.reason);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.reads).toHaveLength(1);
    expect(f.reconciler.has("synthetic-station")).toBe(false);
    expect(f.reconciler.diagnostics().readFailures).toBe(0);
  });

  it("caps the last read at five seconds and aborts it at the 45-second expiry", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(15_000);
    f.reads[0]!.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    f.reads[1]!.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.reads.map((read) => read.timeoutMs)).toEqual([8_000, 8_000, 5_000]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.reads[2]!.signal.aborted).toBe(true);
    f.reads[2]!.reject(f.reads[2]!.signal.reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.reconciler.diagnostics()).toMatchObject({ expired: 1, confirmed: 0, readFailures: 0 });
    expect(f.events).toEqual(["scheduled", "expired"]);
    expect(f.reads).toHaveLength(3);
    f.reconciler.close();
  });

  it("charges a read failure once and consumes later opportunities while backoff holds", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(15_000);
    f.hold();
    f.reads[0]!.reject(new Error("synthetic read failed"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.reads).toHaveLength(1);
    expect(f.reconciler.diagnostics()).toMatchObject({ readFailures: 1, expired: 1 });
    expect(f.events).toEqual(["scheduled", "read_failed", "expired"]);
    f.reconciler.close();
  });
});
