import { afterEach, describe, expect, it, vi } from "vitest";
import { observeCommand } from "../../core/contracts.js";
import { CommandIntentRegistry } from "../command-intents.js";
import {
  RtcLateEffectReconciler,
  type LateEffectEvent,
  type LateEffectRead,
  type LateEffectRetry,
} from "../rtc-late-effect.js";

const command = (value = 1, channel = 1) =>
  observeCommand(
    { kind: "set-json", param: 1400, data: { value }, channel },
    {
      event: "property changed",
      param: 1400,
      property: "state",
      expected: value,
      passiveReadback: true,
      lateEffectReadback: true,
      replaceableState: true,
      timeoutMs: 12_000,
    },
  );

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const registry = new CommandIntentRegistry();
  const events: LateEffectEvent[] = [];
  const reads: Array<{
    signal: AbortSignal;
    timeoutMs: number;
    options?: { priority: "late-check"; notBeforeMonotonicMs?: number };
    resolve: (read?: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  const retries: LateEffectRetry[] = [];
  let canRead = true;
  const reconciler = new RtcLateEffectReconciler({
    intents: registry,
    now: () => Date.now(),
    canRead: () => canRead,
    read: (_station, signal, timeoutMs, options) => {
      const deferred = Promise.withResolvers<unknown>();
      reads.push({ signal, timeoutMs, options, resolve: deferred.resolve, reject: deferred.reject });
      return deferred.promise;
    },
    retry: async (request) => {
      retries.push(request);
    },
    event: (event) => events.push(event),
  });
  const start = (
    options: {
      device?: string;
      value?: number;
      totalBy?: number;
      callerExpiry?: number;
      pending?: boolean;
      retry?: boolean;
      signal?: AbortSignal;
      generation?: number;
    } = {},
  ) => {
    const device = options.device ?? "target-a";
    const ownership = registry.acceptValidated("station", device, registry.allocate(), "state")!;
    const intent = reconciler.begin("station", device, command(options.value), {
      intent: ownership,
      ...(options.retry === false
        ? {}
        : {
            retry: {
              totalByMonotonicMs: options.totalBy ?? 72_000,
              callerExpiryMonotonicMs: options.callerExpiry,
              signal: options.signal,
              parentAttempt: 3,
              wallExpiresAtMs: 72_000,
              wallOffsetMs: 0,
              clockUncertaintyMs: 100,
            },
          }),
    });
    reconciler.sent(intent, {
      sentAtMs: Date.now(),
      sentAtMonotonicMs: Date.now(),
      sessionGeneration: options.generation ?? 1,
    });
    reconciler.finish(intent, true, options.pending ?? true);
    return intent;
  };
  const metadata = (patch: Partial<LateEffectRead> = {}): LateEffectRead => ({
    sentAtMonotonicMs: 15_000,
    completedAtMonotonicMs: Date.now(),
    sessionGeneration: 1,
    currentAtArrival: true,
    attempt: 7,
    deviceParams: { "target-a": { 1400: "0" } },
    ...patch,
  });
  const resolve = async (patch: Partial<LateEffectRead> = {}, index = 0) => {
    reads[index]!.resolve(metadata(patch));
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    registry,
    reconciler,
    reads,
    retries,
    events,
    start,
    metadata,
    resolve,
    hold: () => {
      canRead = false;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("one-use pending-rejection recovery", () => {
  it("authorizes exactly one same-value child from the designated authoritative post-15-second read", async () => {
    const f = fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.reads[0]!.options).toEqual({ priority: "late-check", notBeforeMonotonicMs: 15_000 });
    await f.resolve();
    expect(f.retries).toHaveLength(1);
    const child = f.retries[0]!;
    expect(child).toMatchObject({
      parentAttempt: 3,
      authorizingRead: 7,
      originalSentAtMonotonicMs: 0,
      sendByMonotonicMs: 33_000,
      totalByMonotonicMs: 45_000,
      readStartedAgeMs: 15_000,
      readFinishedAgeMs: 15_000,
      wallExpiresAtMs: 72_000,
      wallOffsetMs: 0,
      clockUncertaintyMs: 100,
    });
    expect(child.command).toMatchObject({ kind: "set-json", data: { value: 1 } });
    child.onSent();
    child.onSent();
    f.reconciler.observe("target-a", { 1400: "1" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.retries).toHaveLength(1);
    expect(f.reconciler.diagnostics()).toMatchObject({
      scheduled: 1,
      retryEligible: 1,
      retryQueued: 1,
      retrySent: 1,
      retryConfirmed: 1,
      confirmed: 1,
    });
    f.reconciler.close();
  });

  it.each([{ pending: false }, { retry: false }])(
    "does not give generic ambiguity or legacy pending writes retry authority: %j",
    async (options) => {
      const f = fixture();
      f.start(options);
      await vi.advanceTimersByTimeAsync(15_000);
      await f.resolve();
      expect(f.retries).toHaveLength(0);
      expect(f.reconciler.diagnostics().retryEligible).toBe(0);
      f.reconciler.close();
    },
  );

  it.each<Partial<LateEffectRead>>([
    { sentAtMonotonicMs: 14_999 },
    { sessionGeneration: 2 },
    { currentAtArrival: false },
    { completedAtMonotonicMs: 15_001 },
    { completedAtMonotonicMs: 14_999 },
    { attempt: 0 },
    { deviceParams: {} },
    { deviceParams: { "target-a": {} } },
  ])("rejects early/reused/stale/unqualified or missing-parameter evidence: %j", async (patch) => {
    const f = fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await f.resolve(patch);
    expect(f.retries).toHaveLength(0);
    expect(f.reconciler.diagnostics().retrySkipped.no_qualified_first_read).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await f.resolve({ sentAtMonotonicMs: 25_000 }, 1);
    expect(f.retries).toHaveLength(0);
    f.reconciler.close();
  });

  it("a failed first read cannot use the later successful observation opportunity as a new authorization", async () => {
    const f = fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(15_000);
    f.reads[0]!.reject(new Error("synthetic read failure"));
    await vi.advanceTimersByTimeAsync(10_000);
    await f.resolve({ sentAtMonotonicMs: 25_000 }, 1);
    expect(f.retries).toHaveLength(0);
    expect(f.reconciler.diagnostics()).toMatchObject({ readFailures: 1, retrySkipped: { read_failed: 1 } });
    f.reconciler.close();
  });

  it("a skipped readiness opportunity grants no negative proof even when later reads work", async () => {
    const f = fixture();
    f.start();
    f.hold();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.reads).toHaveLength(0);
    expect(f.retries).toHaveLength(0);
    expect(f.reconciler.diagnostics().retrySkipped.no_qualified_first_read).toBe(1);
    f.reconciler.close();
  });

  it.each([26_999, 27_000])("reserves the full 12-second child exchange within parent expiry %i", async (totalBy) => {
    const f = fixture();
    f.start({ totalBy });
    await vi.advanceTimersByTimeAsync(15_000);
    await f.resolve();
    expect(f.retries).toHaveLength(0);
    expect(f.reconciler.diagnostics().retrySkipped.deadline).toBe(1);
    f.reconciler.close();
  });

  it("does not renew a parent admitted near 60 seconds when its first check falls beyond total expiry", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(59_000);
    f.start({ totalBy: 72_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    await f.resolve({ sentAtMonotonicMs: 74_000 });
    expect(f.retries).toHaveLength(0);
    expect(f.reconciler.diagnostics().retrySkipped.deadline).toBe(1);
    f.reconciler.close();
  });

  it("clamps the child to the original caller expiry and never renews a queued child", async () => {
    const f = fixture();
    f.start({ callerExpiry: 38_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    await f.resolve();
    const child = f.retries[0]!;
    expect(child).toMatchObject({ sendByMonotonicMs: 26_000, totalByMonotonicMs: 38_000 });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(child.isCurrent()).toBe(false);
    expect(child.signal.aborted).toBe(true);
    child.onSent();
    expect(f.reconciler.diagnostics()).toMatchObject({ retrySent: 0, retrySkipped: { deadline: 1 } });
    f.reconciler.observe("target-a", { 1400: "1" });
    expect(f.reconciler.diagnostics()).toMatchObject({ confirmed: 1, retryConfirmed: 0 });
    f.reconciler.close();
  });

  it("matching authoritative evidence cancels an unsent child and supplies no retry confirmation", async () => {
    const f = fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await f.resolve();
    const child = f.retries[0]!;
    f.reconciler.observe("target-a", { 1400: "1" });
    expect(child.isCurrent()).toBe(false);
    expect(child.signal.aborted).toBe(true);
    expect(f.reconciler.diagnostics()).toMatchObject({
      confirmed: 1,
      retrySent: 0,
      retryConfirmed: 0,
      retrySkipped: { already_matches: 1 },
    });
    f.reconciler.close();
  });

  it("retains a sent child's correlated exchange after sendBy and newer intent while explicit cancellation still reaches it", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.start({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(15_000);
    await f.resolve();
    const child = f.retries[0]!;
    child.onSent();
    await vi.advanceTimersByTimeAsync(18_000);
    expect(child.isCurrent()).toBe(true);
    f.registry.acceptValidated("station", "target-a", f.registry.allocate(), "state");
    expect(child.isCurrent()).toBe(false);
    expect(child.signal.aborted).toBe(false);
    controller.abort();
    expect(child.signal.aborted).toBe(true);
    expect(f.reconciler.diagnostics().retrySent).toBe(1);
    f.reconciler.close();
  });

  it("cannot upgrade an already-terminal ambiguous result from a late -108 observation", async () => {
    const f = fixture();
    const intent = f.start({ pending: false });
    expect(f.reconciler.finish(intent, true, true)).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await f.resolve();
    expect(f.retries).toHaveLength(0);
    expect(f.reconciler.diagnostics()).toMatchObject({ pendingAccepted: 0, retryEligible: 0 });
    f.reconciler.close();
  });

  it("a matching designated read confirms without creating a child", async () => {
    const f = fixture();
    f.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await f.resolve({ deviceParams: { "target-a": { 1400: "1" } } });
    expect(f.retries).toHaveLength(0);
    expect(f.reconciler.diagnostics()).toMatchObject({ confirmed: 1, retrySkipped: { already_matches: 1 } });
    f.reconciler.close();
  });

  it.each(["before_finish", "read", "queued", "pre_send"])(
    "newer validated controls cancel recovery at %s",
    async (boundary) => {
      const f = fixture();
      const old = f.start();
      if (boundary !== "before_finish") await vi.advanceTimersByTimeAsync(15_000);
      if (boundary === "queued" || boundary === "pre_send") await f.resolve();
      f.registry.acceptValidated(
        "station",
        "target-a",
        f.registry.allocate(),
        boundary === "queued" ? "brightness" : undefined,
      );
      expect(f.reconciler.finish(old, true, true)).toBe(false);
      if (boundary === "read") await f.resolve();
      for (const child of f.retries) {
        expect(child.signal.aborted).toBe(true);
        expect(child.isCurrent()).toBe(false);
        child.onSent();
      }
      expect(f.reconciler.diagnostics()).toMatchObject({ retrySent: 0, retrySuperseded: 1 });
      f.reconciler.close();
    },
  );

  it.each(["cancel", "disconnect"])(
    "invalidates a queued child on %s and never replays after reconnect",
    async (reason) => {
      const f = fixture();
      const controller = new AbortController();
      f.start({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(15_000);
      await f.resolve();
      if (reason === "cancel") controller.abort();
      else f.reconciler.closeStation("station");
      expect(f.retries[0]!.isCurrent()).toBe(false);
      expect(f.retries[0]!.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.retries).toHaveLength(1);
      expect(f.reconciler.diagnostics().retrySent).toBe(0);
      f.reconciler.close();
    },
  );

  it("coalesces qualifying reads for current intents while cancellation releases only one subscriber", async () => {
    const f = fixture();
    const cancelled = new AbortController();
    f.start({ signal: cancelled.signal });
    f.start({ device: "target-b" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.reads).toHaveLength(1);
    cancelled.abort();
    expect(f.reads[0]!.signal.aborted).toBe(false);
    await f.resolve({ deviceParams: { "target-a": { 1400: "0" }, "target-b": { 1400: "0" } } });
    expect(f.retries).toHaveLength(1);
    expect(f.retries[0]!.device).toBe("target-b");
    f.reconciler.close();
  });

  it("one shared qualifying read authorizes each independent current target once", async () => {
    const f = fixture();
    f.start();
    f.start({ device: "target-b" });
    await vi.advanceTimersByTimeAsync(15_000);
    await f.resolve({ deviceParams: { "target-a": { 1400: "0" }, "target-b": { 1400: "0" } } });
    expect(f.reads).toHaveLength(1);
    expect(f.retries).toHaveLength(2);
    for (const child of f.retries) child.onSent();
    await vi.advanceTimersByTimeAsync(10_000);
    await f.resolve(
      { sentAtMonotonicMs: 25_000, deviceParams: { "target-a": { 1400: "0" }, "target-b": { 1400: "0" } } },
      1,
    );
    expect(f.retries).toHaveLength(2);
    expect(f.reconciler.diagnostics()).toMatchObject({ scheduled: 2, retryQueued: 2, retrySent: 2 });
    f.reconciler.close();
  });
});
