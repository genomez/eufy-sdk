import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import jpegJs from "jpeg-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rtcSnapshot } from "../snapshot.js";

const decoder = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: decoder.spawn, spawnSync: vi.fn() }));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}
afterEach(() => {
  decoder.spawn.mockReset();
  vi.useRealTimers();
});
describe("RTC snapshot decoder lifetime", () => {
  it("returns encoded geometry and releases all resources on decoder completion", async () => {
    const ff = child();
    decoder.spawn.mockReturnValue(ff);
    const readable = new PassThrough();
    const controller = new AbortController();
    const result = rtcSnapshot(async () => readable, { signal: controller.signal });
    await tick();
    const jpeg = Buffer.from(jpegJs.encode({ width: 2, height: 3, data: Buffer.alloc(24, 128) }, 50).data);
    ff.stdout.emit("data", jpeg);
    ff.emit("close", 0);
    expect(await result).toEqual({ jpeg, width: 2, height: 3 });
    expect(readable.destroyed).toBe(true);
    expect(ff.listenerCount("error")).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(decoder.spawn.mock.calls[0]![1]).toContain("hevc");
  });
  it("bounds session acquisition as part of the snapshot deadline", async () => {
    vi.useFakeTimers();
    const opening = vi.fn(
      (signal: AbortSignal) =>
        new Promise<PassThrough>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    );
    const result = rtcSnapshot(opening, { timeoutMs: 100 });
    const rejected = expect(result).rejects.toMatchObject({ reason: "no-keyframe" });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(decoder.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves cancellation reason and absorbs late child/stdin errors until child close", async () => {
    const ff = child();
    decoder.spawn.mockReturnValue(ff);
    const readable = new PassThrough();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const result = rtcSnapshot(async () => readable, { signal: controller.signal });
    const rejected = expect(result).rejects.toBe(reason);
    await tick();
    controller.abort(reason);
    await rejected;
    expect(readable.destroyed).toBe(true);
    expect(ff.kill).toHaveBeenCalledTimes(1);
    expect(() => ff.emit("error", new Error("late child error"))).not.toThrow();
    expect(() => ff.stdin.emit("error", new Error("late pipe error"))).not.toThrow();
    expect(() => ff.stdout.emit("error", new Error("late output error"))).not.toThrow();
    expect(() => ff.stderr.emit("error", new Error("late diagnostic error"))).not.toThrow();
    ff.emit("close");
    expect(ff.stdout.listenerCount("error")).toBe(0);
    expect(ff.stderr.listenerCount("error")).toBe(0);
    expect(ff.listenerCount("error")).toBe(0);
    expect(ff.stdin.listenerCount("error")).toBe(0);
  });
  it("rejects oversized output and kills the decoder", async () => {
    const ff = child();
    decoder.spawn.mockReturnValue(ff);
    const result = rtcSnapshot(async () => new PassThrough(), {});
    const rejected = expect(result).rejects.toMatchObject({ reason: "undecodable-burst" });
    await tick();
    ff.stdout.emit("data", Buffer.alloc(8 * 1024 * 1024 + 1));
    await rejected;
    expect(ff.kill).toHaveBeenCalledTimes(1);
    ff.emit("close");
  });
  it("decoder error releases the source without waiting for the deadline", async () => {
    const ff = child();
    decoder.spawn.mockReturnValue(ff);
    const readable = new PassThrough();
    const result = rtcSnapshot(async () => readable, {});
    const reason = new Error("synthetic decoder error");
    const rejected = expect(result).rejects.toBe(reason);
    await tick();
    ff.emit("error", reason);
    await rejected;
    expect(readable.destroyed).toBe(true);
    expect(ff.kill).toHaveBeenCalledTimes(1);
    ff.emit("close");
  });
  it.each(["stdout", "stderr"] as const)("%s failure releases the source and decoder", async (pipe) => {
    const ff = child();
    decoder.spawn.mockReturnValue(ff);
    const readable = new PassThrough();
    const result = rtcSnapshot(async () => readable, {});
    const reason = new Error("synthetic output pipe error");
    const rejected = expect(result).rejects.toBe(reason);
    await tick();
    let unhandled: unknown;
    try {
      ff[pipe].emit("error", reason);
    } catch (error) {
      unhandled = error;
      ff.emit("error", reason);
    }
    await rejected;
    expect(readable.destroyed).toBe(true);
    expect(ff.kill).toHaveBeenCalledTimes(1);
    ff.emit("close");
    expect(ff[pipe].listenerCount("error")).toBe(0);
    expect(unhandled).toBeUndefined();
  });
  it.each([0, -1, NaN, Infinity, 60001, 1.5])("rejects invalid timeout %s before opening media", async (timeoutMs) => {
    const open = vi.fn(async () => new PassThrough());
    await expect(rtcSnapshot(open, { timeoutMs })).rejects.toThrow(RangeError);
    expect(open).not.toHaveBeenCalled();
  });
});
