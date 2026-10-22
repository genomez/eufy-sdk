import { describe, expect, it, vi } from "vitest";
import { StationWorkScheduler } from "../station-work-scheduler.js";

/** Drain scheduling microtasks without advancing admission deadlines. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("StationWorkScheduler", () => {
  it("rotates hot targets after waiting siblings and preserves per-target FIFO", async () => {
    const scheduler = new StationWorkScheduler();
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const enqueue = (target: string, label: string, run = async () => {}) =>
      scheduler.enqueue({
        target,
        kind: "write",
        sendByMs: performance.now() + 1000,
        run: async () => {
          order.push(label);
          await run();
        },
      });
    const first = enqueue("a", "a1", () => gate.promise);
    await flush();
    const pending = [enqueue("b", "b1"), enqueue("a", "a2"), enqueue("a", "a3"), enqueue("c", "c1")];
    gate.resolve();
    await Promise.all([first, ...pending]);
    expect(order).toEqual(["a1", "b1", "c1", "a2", "a3"]);
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("coalesces only declared keys and rejects capacity without evicting writes", async () => {
    const scheduler = new StationWorkScheduler();
    const gate = Promise.withResolvers<void>();
    const first = scheduler.enqueue({
      target: "active",
      kind: "write",
      sendByMs: performance.now() + 1000,
      run: () => gate.promise,
    });
    await flush();
    const called: string[] = [];
    const enqueue = (key?: string) =>
      scheduler.enqueue({
        target: "a",
        kind: "write",
        replacementKey: key,
        sendByMs: performance.now() + 1000,
        run: async () => {
          called.push(key ?? "fixed");
        },
      });
    const old = enqueue("state").catch((error) => error.reason);
    const latest = enqueue("state");
    const rest = Array.from({ length: 31 }, () => enqueue());
    await expect(enqueue()).rejects.toMatchObject({ reason: "queue_full" });
    expect(await old).toBe("superseded_before_send");
    gate.resolve();
    await Promise.all([first, latest, ...rest]);
    expect(called).toHaveLength(32);
    expect(scheduler.snapshot()).toMatchObject({ coalesced: 1, queueFull: 1, highWater: 32 });
  });

  it("gives a waiting read one turn per four writes and fresh work precedes retry", async () => {
    const scheduler = new StationWorkScheduler();
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = scheduler.enqueue({
      target: "active",
      kind: "write",
      sendByMs: performance.now() + 1000,
      run: () => gate.promise,
    });
    await flush();
    const enqueue = (
      label: string,
      kind: "write" | "read",
      origin?: "caller" | "retry",
      priority?: "late-check" | "routine",
    ) =>
      scheduler.enqueue({
        target: label,
        kind,
        origin,
        priority,
        sendByMs: performance.now() + 1000,
        run: async () => {
          order.push(label);
        },
      });
    const pending = [
      enqueue("retry", "write", "retry"),
      enqueue("routine", "read", undefined, "routine"),
      enqueue("urgent", "read", undefined, "late-check"),
      ...Array.from({ length: 8 }, (_, index) => enqueue(`fresh${index}`, "write")),
    ];
    gate.resolve();
    await Promise.all([first, ...pending]);
    expect(order.indexOf("urgent")).toBe(3);
    expect(order.indexOf("routine")).toBe(8);
    expect(order.at(-1)).toBe("retry");
  });

  it("cancels a shared read subscriber without aborting another subscriber", async () => {
    const scheduler = new StationWorkScheduler();
    const gate = Promise.withResolvers<void>();
    const first = scheduler.enqueue({
      target: "active",
      kind: "write",
      sendByMs: performance.now() + 1000,
      run: () => gate.promise,
    });
    await flush();
    const controller = new AbortController();
    const run = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return 42;
    });
    const read = (signal?: AbortSignal) =>
      scheduler.enqueue({
        target: "station",
        kind: "read",
        mergeKey: "info",
        signal,
        sendByMs: performance.now() + 1000,
        run,
      });
    const cancelled = read(controller.signal).catch((error) => error.reason);
    const survivor = read();
    controller.abort();
    expect(await cancelled).toBe("cancelled_before_send");
    gate.resolve();
    await first;
    expect(await survivor).toBe(42);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("settles queued expiry promptly and close never migrates queued work", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new StationWorkScheduler(() => Date.now());
      const gate = Promise.withResolvers<void>();
      const first = scheduler.enqueue({
        target: "a",
        kind: "write",
        sendByMs: Date.now() + 1000,
        run: () => gate.promise,
      });
      await flush();
      const run = vi.fn(async () => {});
      const expired = scheduler
        .enqueue({ target: "b", kind: "write", sendByMs: Date.now() + 10, run })
        .catch((error) => error.reason);
      await vi.advanceTimersByTimeAsync(10);
      expect(await expired).toBe("expired_before_send");
      const closed = scheduler
        .enqueue({ target: "c", kind: "write", sendByMs: Date.now() + 100, run })
        .catch((error) => error.reason);
      scheduler.close();
      expect(await closed).toBe("closed_before_send");
      gate.resolve();
      await first;
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("serves a sibling arriving during an active target before that target's existing backlog", async () => {
  const scheduler = new StationWorkScheduler();
  const gate = Promise.withResolvers<void>();
  const order: string[] = [];
  const enqueue = (target: string, label: string, wait?: Promise<void>) =>
    scheduler.enqueue({
      target,
      kind: "write",
      sendByMs: performance.now() + 1000,
      run: async () => {
        order.push(label);
        await wait;
      },
    });
  const first = enqueue("a", "a1", gate.promise);
  const backlog = enqueue("a", "a2");
  await flush();
  const sibling = enqueue("b", "b1");
  gate.resolve();
  await Promise.all([first, backlog, sibling]);
  expect(order).toEqual(["a1", "b1", "a2"]);
});

it("preserves legacy FIFO and replaces across an explicit bounded profile barrier", async () => {
  const scheduler = new StationWorkScheduler();
  const gate = Promise.withResolvers<void>();
  const order: string[] = [];
  const active = scheduler.enqueue({
    target: "active",
    kind: "write",
    sendByMs: performance.now() + 1000,
    run: () => gate.promise,
  });
  await flush();
  const enqueue = (label: string, replaceUnsent: boolean, replacementKey = "state") =>
    scheduler.enqueue({
      target: "a",
      kind: "write",
      replacementKey,
      replaceUnsent,
      sendByMs: performance.now() + 1000,
      run: async () => {
        order.push(label);
      },
    });
  const legacyOne = enqueue("legacy-one", false, "legacy-only");
  const legacyTwo = enqueue("legacy-two", false, "legacy-only");
  const oldLegacy = enqueue("old-legacy", false).catch((error) => error.reason);
  const profile = enqueue("bounded", true).catch((error) => error.reason);
  expect(await oldLegacy).toBe("superseded_before_send");
  const newLegacy = enqueue("new-legacy", false);
  expect(await profile).toBe("superseded_before_send");
  const sameLegacy = enqueue("same-legacy", false);
  gate.resolve();
  await Promise.all([active, legacyOne, legacyTwo, newLegacy, sameLegacy]);
  expect(order).toEqual(["legacy-one", "legacy-two", "new-legacy", "same-legacy"]);
  expect(scheduler.snapshot().supersededBeforeSend).toBe(2);
});
