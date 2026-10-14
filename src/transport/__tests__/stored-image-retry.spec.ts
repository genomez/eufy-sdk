import { StoredSnapshotUnavailableError } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { StoredImageCache } from "../stored-image-cache.js";
import { ThumbnailDiagnostics } from "../thumbnail-diagnostics.js";

const jpeg = (body: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(body), Buffer.from([0xff, 0xd9])]);
const missing = () =>
  Object.assign(new Error("synthetic media unavailable"), { mediaFailure: "http-status", status: 404 });
const time = 1_790_737_853_140;
function logger() {
  const warnings: unknown[] = [];
  const log: Logger = { debug() {}, info() {}, warn: (...args) => warnings.push(args), error() {} };
  return { warnings, log };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function reason(cache: StoredImageCache) {
  try {
    await cache.snapshotStored("camera-a");
  } catch (error) {
    expect(error).toBeInstanceOf(StoredSnapshotUnavailableError);
    return (error as StoredSnapshotUnavailableError).reason;
  }
  throw new Error("expected no retained image");
}

describe("stored thumbnail 404 retry boundaries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("retains a transient 404 in evidence and retries the exact image/time pair after two seconds", async () => {
    const evidence = new ThumbnailDiagnostics();
    const { log, warnings } = logger();
    const download = vi.fn().mockRejectedValueOnce(missing()).mockResolvedValue(jpeg("fresh"));
    const cache = new StoredImageCache(download, log, Date.now, () => false, evidence);
    cache.observe("camera-a", "https://media.example/fresh", time);
    await vi.advanceTimersByTimeAsync(0);
    expect(await reason(cache)).toBe("pending");
    expect(evidence.failures()).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(download).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(download.mock.calls).toEqual([
      ["https://media.example/fresh", "camera-a"],
      ["https://media.example/fresh", "camera-a"],
    ]);
    await expect(cache.snapshotStored("camera-a")).resolves.toEqual({ jpeg: jpeg("fresh"), eventTime: time });
    expect(evidence.diagnostics().download_failed).toBe(0);
  });

  it("can succeed on the third attempt at six seconds without inventing an absent event time", async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(missing())
      .mockResolvedValue(jpeg("fresh"));
    const cache = new StoredImageCache(download, logger().log);
    cache.observe("camera-a", "https://media.example/fresh");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(download).toHaveBeenCalledTimes(2);
    expect(await reason(cache)).toBe("pending");
    await vi.advanceTimersByTimeAsync(3_999);
    expect(download).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(cache.snapshotStored("camera-a")).resolves.toEqual({ jpeg: jpeg("fresh") });
    expect(download).toHaveBeenCalledTimes(3);
  });

  it("bounds permanent 404s to three attempts, one terminal warning and three failure records", async () => {
    const evidence = new ThumbnailDiagnostics();
    const { log, warnings } = logger();
    const download = vi.fn().mockRejectedValue(missing());
    const cache = new StoredImageCache(download, log, Date.now, () => false, evidence);
    cache.observe("camera-a", "https://media.example/missing", time);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await reason(cache)).toBe("download-failed");
    expect(download).toHaveBeenCalledTimes(3);
    expect(warnings).toHaveLength(1);
    expect(evidence.failures().map((r) => r.status)).toEqual([404, 404, 404]);
    expect(evidence.diagnostics().download_started).toBe(3);
    expect(evidence.diagnostics().download_failed).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    cache.observe("camera-a", "https://media.example/missing", time);
    expect(download).toHaveBeenCalledTimes(3);
  });

  it.each([
    Object.assign(new Error("denied"), { mediaFailure: "http-status", status: 403 }),
    Object.assign(new Error("unavailable"), { mediaFailure: "http-status", status: 503 }),
    Object.assign(new Error("timeout"), { mediaFailure: "timeout", status: 404 }),
    Object.assign(new Error("untrusted tag"), { mediaFailure: "http-status", status: "404" }),
    new Error("untagged failure"),
  ])("does not retry other downloader failures", async (error) => {
    const download = vi.fn().mockRejectedValue(error);
    const cache = new StoredImageCache(download, logger().log);
    cache.observe("camera-a", "https://media.example/failure");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(download).toHaveBeenCalledTimes(1);
    expect(await reason(cache)).toBe("download-failed");
  });

  it("keeps lifecycle invalidation authoritative even when the error also has a 404 tag", async () => {
    const error = missing();
    const download = vi.fn().mockRejectedValue(error);
    const cache = new StoredImageCache(download, logger().log, Date.now, (e) => e === error);
    cache.observe("camera-a", "https://media.example/failure");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(download).toHaveBeenCalledTimes(1);
    await expect(cache.snapshotStored("camera-a")).rejects.toBe(error);
  });

  it("does not retry an invalid JPEG", async () => {
    const download = vi.fn().mockResolvedValue(Buffer.from("invalid"));
    const cache = new StoredImageCache(download, logger().log);
    cache.observe("camera-a", "https://media.example/invalid");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(download).toHaveBeenCalledTimes(1);
    expect(await reason(cache)).toBe("invalid-image");
  });

  it("allows passive reads of the old pair while retrying without adding downloads or changing its date", async () => {
    const download = vi
      .fn()
      .mockResolvedValueOnce(jpeg("old"))
      .mockRejectedValueOnce(missing())
      .mockResolvedValue(jpeg("new"));
    const cache = new StoredImageCache(download, logger().log);
    cache.observe("camera-a", "https://media.example/old", time - 10_000);
    await vi.advanceTimersByTimeAsync(0);
    cache.observe("camera-a", "https://media.example/new", time);
    await vi.advanceTimersByTimeAsync(0);
    for (let n = 0; n < 5; n++)
      await expect(cache.snapshotStored("camera-a")).resolves.toEqual({ jpeg: jpeg("old"), eventTime: time - 10_000 });
    expect(download).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(cache.snapshotStored("camera-a")).resolves.toEqual({ jpeg: jpeg("new"), eventTime: time });
  });

  it("cancels a waiting retry when a newer candidate arrives", async () => {
    const download = vi.fn().mockRejectedValueOnce(missing()).mockResolvedValue(jpeg("newer"));
    const cache = new StoredImageCache(download, logger().log);
    cache.observe("camera-a", "https://media.example/old", time);
    await vi.advanceTimersByTimeAsync(0);
    cache.observe("camera-a", "https://media.example/newer", time + 1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(download.mock.calls.map((r) => r[0])).toEqual(["https://media.example/old", "https://media.example/newer"]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(cache.snapshotStored("camera-a")).resolves.toEqual({ jpeg: jpeg("newer"), eventTime: time + 1 });
  });

  it("rejects an older dated candidate without cancelling the pending retry", async () => {
    const download = vi.fn().mockRejectedValueOnce(missing()).mockResolvedValue(jpeg("fresh"));
    const cache = new StoredImageCache(download, logger().log);
    cache.observe("camera-a", "https://media.example/fresh", time);
    await vi.advanceTimersByTimeAsync(0);
    cache.observe("camera-a", "https://media.example/stale", time - 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(download.mock.calls.map((r) => r[0])).toEqual([
      "https://media.example/fresh",
      "https://media.example/fresh",
    ]);
    await expect(cache.snapshotStored("camera-a")).resolves.toEqual({ jpeg: jpeg("fresh"), eventTime: time });
  });

  it("keeps a duplicate URL from replacing the pending pair or its original timestamp", async () => {
    const download = vi.fn().mockRejectedValueOnce(missing()).mockResolvedValue(jpeg("fresh"));
    const cache = new StoredImageCache(download, logger().log);
    cache.observe("camera-a", "https://media.example/fresh", time);
    await vi.advanceTimersByTimeAsync(0);
    cache.observe("camera-a", "https://media.example/fresh", time + 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(download).toHaveBeenCalledTimes(2);
    await expect(cache.snapshotStored("camera-a")).resolves.toEqual({ jpeg: jpeg("fresh"), eventTime: time });
  });

  it("cancels timers and failure evidence on cache/account-generation invalidation", async () => {
    const evidence = new ThumbnailDiagnostics();
    const download = vi.fn().mockRejectedValueOnce(missing()).mockResolvedValue(jpeg("new account"));
    const cache = new StoredImageCache(download, logger().log, Date.now, () => false, evidence);
    cache.observe("camera-a", "https://media.example/old", time);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    cache.clear();
    expect(vi.getTimerCount()).toBe(0);
    expect(evidence.failures()).toHaveLength(0);
    expect(await reason(cache)).toBe("not-observed");
    cache.observe("camera-a", "https://media.example/new-account", time + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(download).toHaveBeenCalledTimes(2);
    await expect(cache.snapshotStored("camera-a")).resolves.toEqual({ jpeg: jpeg("new account"), eventTime: time + 1 });
  });

  it("does not revive an invalidated candidate whose first download fails later", async () => {
    const old = deferred<Buffer>();
    const download = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(jpeg("new"));
    const cache = new StoredImageCache(download, logger().log);
    cache.observe("camera-a", "https://media.example/old", time);
    cache.clear();
    cache.observe("camera-a", "https://media.example/new", time + 1);
    old.reject(missing());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(download).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await expect(cache.snapshotStored("camera-a")).resolves.toEqual({ jpeg: jpeg("new"), eventTime: time + 1 });
  });

  it("does not retry an in-flight failed candidate when a newer candidate is already queued", async () => {
    const old = deferred<Buffer>();
    const download = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(jpeg("new"));
    const cache = new StoredImageCache(download, logger().log);
    cache.observe("camera-a", "https://media.example/old", time);
    cache.observe("camera-a", "https://media.example/new", time + 1);
    old.reject(missing());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(download.mock.calls.map((r) => r[0])).toEqual(["https://media.example/old", "https://media.example/new"]);
    await expect(cache.snapshotStored("camera-a")).resolves.toEqual({ jpeg: jpeg("new"), eventTime: time + 1 });
  });

  it("releases waiting retries and enforces global/device limits when a retry becomes due", async () => {
    const heldB = deferred<Buffer>(),
      heldC = deferred<Buffer>(),
      retryA = deferred<Buffer>();
    const started: string[] = [];
    let active = 0,
      maximum = 0,
      aCalls = 0;
    const download = (url: string) => {
      started.push(url);
      active++;
      maximum = Math.max(maximum, active);
      const result = url.endsWith("a")
        ? ++aCalls === 1
          ? Promise.reject(missing())
          : retryA.promise
        : url.endsWith("b")
          ? heldB.promise
          : heldC.promise;
      return result.finally(() => {
        active--;
      });
    };
    const cache = new StoredImageCache(download, logger().log);
    for (const key of ["a", "b", "c"]) cache.observe(`camera-${key}`, `https://media.example/${key}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["https://media.example/a", "https://media.example/b", "https://media.example/c"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(aCalls).toBe(1);
    heldB.resolve(jpeg("b"));
    await vi.advanceTimersByTimeAsync(0);
    expect(aCalls).toBe(2);
    expect(maximum).toBe(2);
    cache.observe("camera-a", "https://media.example/new-a");
    expect(aCalls).toBe(2);
    retryA.resolve(jpeg("a"));
    heldC.resolve(jpeg("c"));
    await vi.advanceTimersByTimeAsync(0);
    expect(maximum).toBe(2);
    expect(aCalls).toBe(3);
  });
});
