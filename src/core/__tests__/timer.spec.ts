import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Timer } from "../util.js";

describe("Timer — restartable single-shot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once after the delay", () => {
    const t = new Timer();
    const fn = vi.fn();
    t.arm(100, fn);
    expect(t.pending).toBe(true);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
    expect(t.pending).toBe(false);
  });

  it("re-arm replaces a pending fire (only the latest runs)", () => {
    const t = new Timer();
    const first = vi.fn();
    const second = vi.fn();
    t.arm(100, first);
    t.arm(100, second);
    vi.advanceTimersByTime(100);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("cancel prevents the fire", () => {
    const t = new Timer();
    const fn = vi.fn();
    t.arm(100, fn);
    t.cancel();
    expect(t.pending).toBe(false);
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it("pending is false inside the callback (handle self-clears before firing)", () => {
    const t = new Timer();
    let pendingDuringFire: boolean | undefined;
    t.arm(100, () => (pendingDuringFire = t.pending));
    vi.advanceTimersByTime(100);
    expect(pendingDuringFire).toBe(false);
  });

  it("cancel on an unarmed timer is a no-op", () => {
    const t = new Timer();
    expect(() => t.cancel()).not.toThrow();
    expect(t.pending).toBe(false);
  });
});
