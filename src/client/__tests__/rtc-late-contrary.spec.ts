import { afterEach, describe, expect, it, vi } from "vitest";
import { observeCommand } from "../../core/contracts.js";
import { CommandIntentRegistry } from "../command-intents.js";
import { RtcLateContraryObserver, type LateContraryEffect } from "../rtc-late-contrary.js";

function fixture(desired = false) {
  const intents = new CommandIntentRegistry();
  const events: LateContraryEffect[] = [];
  let seq = 0;
  let busy = false;
  const reads: {
    signal: AbortSignal;
    timeoutMs: number;
    notBefore: number;
    resolve: (value: unknown) => void;
  }[] = [];
  const observer = new RtcLateContraryObserver({
    now: () => Date.now(),
    intents,
    canRead: () => true,
    read: (_station, signal, timeoutMs, options) => {
      const promise = Promise.withResolvers<unknown>();
      reads.push({ signal, timeoutMs, notBefore: options.notBeforeMonotonicMs, resolve: promise.resolve });
      return promise.promise;
    },
    recoveryBusy: () => busy,
    event: (event) => events.push(event),
  });
  const owner = intents.acceptValidated("station", "camera", intents.allocate(), "light")!;
  const watch = observer.begin(
    "station",
    "camera",
    observeCommand(
      { kind: "set-json", param: 1400, data: { value: Number(desired) }, channel: 1 },
      {
        event: "property changed",
        param: 1400,
        property: "light",
        expected: Number(desired),
        passiveReadback: true,
        replaceableState: true,
        lateEffectReadback: true,
        timeoutMs: 14_000,
      },
    ),
    owner,
  );
  observer.finish(watch, {
    status: "acknowledged",
    sendAttempted: true,
    effect: "unconfirmed",
    sentAtMonotonicMs: Date.now(),
    sessionGeneration: 1,
  });
  const report = (value: boolean, generation = 1) => {
    const sequence = ++seq;
    observer.observe(
      "camera",
      { 1400: String(Number(value)) },
      {
        sequence,
        sessionGeneration: generation,
        receivedAtMonotonicMs: Date.now(),
      },
    );
    return sequence;
  };
  const response = (value: boolean, overrides: Record<string, unknown> = {}) => ({
    attempt: reads.length,
    sentAtMonotonicMs: reads.at(-1)!.notBefore,
    completedAtMonotonicMs: Date.now(),
    currentAtArrival: true,
    sessionGeneration: 1,
    receivedSequence: ++seq,
    deviceParams: { camera: { 1400: String(Number(value)) } },
    ...overrides,
  });
  return { observer, intents, events, owner, report, reads, response, setBusy: (value: boolean) => (busy = value) };
}

afterEach(() => vi.useRealTimers());

describe("bounded contrary observation evidence", () => {
  it.each([false, true])(
    "keeps watching after first match and confirms opposite %s with two messages",
    async (desired) => {
      vi.useFakeTimers();
      const f = fixture(desired);
      f.report(desired);
      await vi.advanceTimersByTimeAsync(32_000);
      f.report(!desired);
      expect(f.events.map((e) => e.state)).toEqual(["matched"]);
      expect(f.reads).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      f.reads[0]!.resolve(f.response(!desired));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.at(-1)).toMatchObject({ state: "contrary", desiredValue: desired, observedValue: !desired });
      f.observer.close();
    },
  );

  it.each([
    { currentAtArrival: false },
    { sessionGeneration: 2 },
    { attempt: 0 },
    { receivedSequence: 1 },
    { deviceParams: { other: { 1400: "1" } } },
    { deviceParams: { camera: { 1400: "yes" } } },
    { sentAtMonotonicMs: -1 },
    { completedAtMonotonicMs: Infinity },
  ])("rejects unqualified confirmation %j", async (override) => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(16_000);
    f.report(true);
    await vi.advanceTimersByTimeAsync(1);
    f.reads[0]!.resolve(f.response(true, override));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events).toEqual([]);
    f.observer.close();
  });

  it("ignores an early or different-session contrary report and cancels candidate on matching", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.report(true);
    await vi.advanceTimersByTimeAsync(16_000);
    f.report(true, 2);
    expect(f.reads).toHaveLength(0);
    f.report(true);
    f.report(false);
    expect(f.reads[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    f.reads[0]!.resolve(f.response(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.map((e) => e.state)).toEqual(["matched"]);
    f.observer.close();
  });

  it("caps reads, preserves spacing, and never starts a second subscriber", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(16_000);
    for (let i = 0; i < 16; i++) {
      const work = f.observer.confirm("camera", f.owner.ordinal);
      const duplicate = await f.observer.confirm("camera", f.owner.ordinal);
      expect(duplicate.confirmed).toBe(false);
      await vi.advanceTimersByTimeAsync(5_001);
      f.reads[i]!.resolve(f.response(true));
      expect((await work).confirmed).toBe(true);
    }
    expect((await f.observer.confirm("camera", f.owner.ordinal)).confirmed).toBe(false);
    expect(f.reads).toHaveLength(16);
    expect(f.observer.diagnostics()).toMatchObject({ reads: 16, readLimited: 1 });
    f.observer.close();
  });

  it("aborts and discards on newer explicit ownership, close and exclusive ten-minute expiry", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(16_000);
    f.report(true);
    f.intents.acceptValidated("station", "camera", f.intents.allocate(), "light");
    expect(f.reads[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    f.reads[0]!.resolve(f.response(true));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.events.map((e) => e.state)).toEqual(["superseded"]);
    expect(f.observer.diagnostics().active).toBe(0);
    await expect(f.observer.confirm("camera", f.owner.ordinal)).rejects.toThrow("unavailable");
  });

  it("waits for reserved recovery without reading and emits its settled lifecycle", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setBusy(true);
    expect(await f.observer.confirm("camera", f.owner.ordinal)).toMatchObject({ confirmed: false, recoveryBusy: true });
    expect(f.reads).toHaveLength(0);
    f.setBusy(false);
    f.observer.recoverySettled("camera", f.owner.ordinal);
    expect(f.events.at(-1)?.state).toBe("recovery_settled");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.events.at(-1)?.state).toBe("expired");
    expect(f.reads).toHaveLength(0);
  });

  it("cannot confirm an old intent when a same-value correction migrates ownership during its read", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const work = f.observer.confirm("camera", f.owner.ordinal);
    const next = f.intents.allocate();
    f.observer.prepareCorrection("camera", next, false);
    f.intents.acceptValidated("station", "camera", next, "light");
    await vi.advanceTimersByTimeAsync(1);
    f.reads[0]!.resolve(f.response(true));
    expect((await work).confirmed).toBe(false);
    f.observer.close();
  });
  it("reserves confirmations after detection exhaustion and reports each new contrary episode", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(16_000);
    for (let count = 0; count < 8; count++) {
      f.report(true);
      await vi.advanceTimersByTimeAsync(1);
      f.reads[count]!.resolve(f.response(false));
      await vi.advanceTimersByTimeAsync(0);
      f.report(false);
      await vi.advanceTimersByTimeAsync(5_001);
    }
    f.report(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reads).toHaveLength(8);
    expect(f.events.filter((event) => event.state === "detection_exhausted")).toHaveLength(1);
    f.report(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.filter((event) => event.state === "detection_exhausted")).toHaveLength(1);
    const matching = f.observer.confirm("camera", f.owner.ordinal);
    await vi.advanceTimersByTimeAsync(1);
    f.reads[8]!.resolve(f.response(false));
    expect(await matching).toMatchObject({ confirmed: true, observedValue: false });
    f.report(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.filter((event) => event.state === "detection_exhausted")).toHaveLength(2);
    for (let count = 1; count < 16; count++) {
      await vi.advanceTimersByTimeAsync(5_001);
      const confirmation = f.observer.confirm("camera", f.owner.ordinal);
      await vi.advanceTimersByTimeAsync(1);
      f.reads[count + 8]!.resolve(f.response(true));
      expect(await confirmation).toMatchObject({ confirmed: true, observedValue: true });
    }
    expect(await f.observer.confirm("camera", f.owner.ordinal)).toMatchObject({
      confirmed: false,
      reason: "read_budget_exhausted",
    });
    expect(await f.observer.confirm("camera", f.owner.ordinal)).toMatchObject({
      confirmed: false,
      reason: "read_budget_exhausted",
    });
    expect(f.events.filter((event) => event.state === "verification_exhausted")).toHaveLength(1);
    expect(f.reads).toHaveLength(24);
    f.observer.close();
  });

  it("suspension rejects outstanding old-session evidence and preserves read counts and original expiry", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(16_000);
    const old = f.observer.confirm("camera", f.owner.ordinal);
    f.observer.closeStation("station");
    f.intents.invalidateStation("station");
    expect(f.reads[0]!.signal.aborted).toBe(true);
    f.reads[0]!.resolve(f.response(true));
    expect(await old).toMatchObject({ confirmed: false });
    await vi.advanceTimersByTimeAsync(5_001);
    const fresh = f.observer.confirm("camera", f.owner.ordinal, undefined, true);
    await vi.advanceTimersByTimeAsync(1);
    f.reads[1]!.resolve(f.response(true, { sessionGeneration: 2 }));
    expect(await fresh).toMatchObject({ confirmed: true, observedValue: true });
    expect(f.observer.diagnostics()).toMatchObject({ active: 1, reads: 2 });
    f.report(false, 1);
    expect(f.events.filter((event) => event.state === "matched")).toHaveLength(0);
    f.report(false, 2);
    expect(f.events.at(-1)?.state).toBe("matched");
    await vi.advanceTimersByTimeAsync(600_000 - 21_002);
    expect(f.events.at(-1)?.state).toBe("expired");
  });

  it("new explicit authority retires a suspended watch even after station registry invalidation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.observer.closeStation("station");
    f.intents.invalidateStation("station");
    f.intents.acceptValidated("station", "camera", f.intents.allocate(), "light");
    expect(f.events.map((event) => event.state)).toEqual(["suspended", "superseded"]);
    await expect(f.observer.confirm("camera", f.owner.ordinal, undefined, true)).rejects.toThrow("unavailable");
  });
});
