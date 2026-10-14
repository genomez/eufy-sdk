/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { StoredSnapshotUnavailableError } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { StoredImageCache } from "../stored-image-cache.js";

const jpeg = (body = "image") =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(body), Buffer.from([0xff, 0xd9])]);
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function logger() {
  const warnings: Array<[string, ...unknown[]]> = [];
  const log: Logger = {
    debug() {},
    info() {},
    warn: (message, ...args) => warnings.push([message, ...args]),
    error() {},
  };
  return { log, warnings };
}

async function reasonOf(cache: StoredImageCache, deviceKey: string) {
  try {
    await cache.snapshotStored(deviceKey);
  } catch (error) {
    expect(error).toBeInstanceOf(StoredSnapshotUnavailableError);
    return (error as StoredSnapshotUnavailableError).reason;
  }
  throw new Error("expected snapshotStored to reject");
}

describe("StoredImageCache", () => {
  it("reports whether no candidate was observed or an eager download is pending", async () => {
    const pending = deferred<Buffer>();
    let downloads = 0;
    const cache = new StoredImageCache(() => {
      downloads += 1;
      return pending.promise;
    }, logger().log);

    expect(await reasonOf(cache, "device-a")).toBe("not-observed");
    expect(downloads).toBe(0);
    cache.observe("device-a", "https://media.example/one");
    expect(downloads).toBe(1);
    expect(await reasonOf(cache, "device-a")).toBe("pending");
    expect(downloads).toBe(1);

    pending.resolve(jpeg());
    await pending.promise;
    await flush();
    await expect(cache.snapshotStored("device-a")).resolves.toEqual({ jpeg: jpeg() });
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["too large", Buffer.alloc(10 * 1024 * 1024 + 1)],
    ["without the JPEG prefix", Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9])],
    ["without the JPEG suffix", Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xd9, 0x00])],
  ])("rejects an invalid image that is %s", async (_case, image) => {
    const cache = new StoredImageCache(async () => image, logger().log);

    cache.observe("device-a", "https://media.example/invalid");
    await flush();

    expect(await reasonOf(cache, "device-a")).toBe("invalid-image");
  });

  it("accepts a structurally valid JPEG at the 10 MiB limit", async () => {
    const image = Buffer.alloc(10 * 1024 * 1024);
    image.set([0xff, 0xd8, 0xff], 0);
    image.set([0xff, 0xd9], image.length - 2);
    const cache = new StoredImageCache(async () => image, logger().log);

    cache.observe("device-a", "https://media.example/maximum");
    await flush();

    expect((await cache.snapshotStored("device-a")).jpeg).toBe(image);
  });

  it("classifies downloader rejection without retrying", async () => {
    let calls = 0;
    const cache = new StoredImageCache(async () => {
      calls += 1;
      throw new Error("request failed");
    }, logger().log);

    cache.observe("device-a", "https://media.example/failure");
    await flush();

    expect(await reasonOf(cache, "device-a")).toBe("download-failed");
    expect(calls).toBe(1);
  });

  it("preserves lifecycle failures instead of classifying them as stored-image absence", async () => {
    const lifecycle = new Error("session expired");
    const cache = new StoredImageCache(
      async () => {
        throw lifecycle;
      },
      logger().log,
      Date.now,
      (error) => error === lifecycle,
    );

    cache.observe("device-a", "https://media.example/failure");
    await flush();

    await expect(cache.snapshotStored("device-a")).rejects.toBe(lifecycle);
  });

  it("surfaces a lifecycle failure even when an older image is retained", async () => {
    const lifecycle = new Error("session expired");
    const cache = new StoredImageCache(
      async (url) => {
        if (url.endsWith("old")) return jpeg("old");
        throw lifecycle;
      },
      logger().log,
      Date.now,
      (error) => error === lifecycle,
    );

    cache.observe("device-a", "https://media.example/old");
    await flush();
    cache.observe("device-a", "https://media.example/new");
    await flush();

    await expect(cache.snapshotStored("device-a")).rejects.toBe(lifecycle);
  });

  it("limits downloads to two globally and one per device", async () => {
    const downloads = new Map<string, ReturnType<typeof deferred<Buffer>>>();
    const started: string[] = [];
    const cache = new StoredImageCache((url) => {
      started.push(url);
      const download = deferred<Buffer>();
      downloads.set(url, download);
      return download.promise;
    }, logger().log);

    cache.observe("device-a", "https://media.example/a1");
    cache.observe("device-a", "https://media.example/a2");
    cache.observe("device-b", "https://media.example/b1");
    cache.observe("device-c", "https://media.example/c1");
    expect(started).toEqual(["https://media.example/a1", "https://media.example/b1"]);

    downloads.get("https://media.example/b1")!.resolve(jpeg("b1"));
    await flush();
    expect(started).toEqual(["https://media.example/a1", "https://media.example/b1", "https://media.example/c1"]);

    downloads.get("https://media.example/a1")!.resolve(jpeg("a1"));
    await flush();
    expect(started.at(-1)).toBe("https://media.example/a2");
  });

  it("replaces older queued work and ignores duplicate device-and-URL observations", async () => {
    const first = deferred<Buffer>();
    const started: string[] = [];
    const cache = new StoredImageCache((url) => {
      started.push(url);
      return url.endsWith("one") ? first.promise : Promise.resolve(jpeg(url));
    }, logger().log);

    cache.observe("device-a", "https://media.example/one");
    cache.observe("device-a", "https://media.example/two");
    cache.observe("device-a", "https://media.example/two");
    cache.observe("device-a", "https://media.example/three");
    first.resolve(jpeg("one"));
    await flush();

    expect(started).toEqual(["https://media.example/one", "https://media.example/three"]);
    await expect(cache.snapshotStored("device-a")).resolves.toEqual({ jpeg: jpeg("https://media.example/three") });
  });

  it("keeps an older success when a newer candidate fails", async () => {
    const { log, warnings } = logger();
    const cache = new StoredImageCache(async (url) => {
      if (url.endsWith("new")) throw new Error("request failed");
      return jpeg("old");
    }, log);

    cache.observe("device-a", "https://media.example/old");
    await flush();
    cache.observe("device-a", "https://media.example/new");
    await flush();

    await expect(cache.snapshotStored("device-a")).resolves.toEqual({ jpeg: jpeg("old") });
    expect(warnings[0]?.[1]).toMatchObject({ class: "download-failed", retained: true });
  });

  it("never lets an older completion replace a newer retained success", async () => {
    const old = deferred<Buffer>();
    const cache = new StoredImageCache(
      (url) => (url.endsWith("old") ? old.promise : Promise.resolve(jpeg("new"))),
      logger().log,
    );

    cache.observe("device-a", "https://media.example/old");
    cache.clear();
    cache.observe("device-a", "https://media.example/new");
    old.resolve(jpeg("old"));
    await flush();

    await expect(cache.snapshotStored("device-a")).resolves.toEqual({ jpeg: jpeg("new") });
  });

  it("clear invalidates retained state and stale completions", async () => {
    const pending = deferred<Buffer>();
    const cache = new StoredImageCache(() => pending.promise, logger().log);

    cache.observe("device-a", "https://media.example/one");
    cache.clear();
    pending.resolve(jpeg());
    await flush();

    expect(await reasonOf(cache, "device-a")).toBe("not-observed");
  });

  it("logs only sanitized diagnostics and rate-limits identical classes per device", async () => {
    const { log, warnings } = logger();
    let now = 1234;
    const cache = new StoredImageCache(
      async (url) => {
        if (url.includes("invalid")) return Buffer.from("not a jpeg");
        throw new Error(`secret response from ${url}`);
      },
      log,
      () => now,
    );

    cache.observe("device-secret", "https://secret.example/first");
    await flush();
    now = 5678;
    cache.observe("device-secret", "https://secret.example/second");
    await flush();
    cache.observe("device-secret", "https://secret.example/invalid");
    await flush();
    cache.observe("other-secret", "https://secret.example/third");
    await flush();

    expect(warnings).toEqual([
      ["[stored-snapshot-cache] candidate failed", { class: "download-failed", observedAt: 1234, retained: false }],
      ["[stored-snapshot-cache] candidate failed", { class: "invalid-image", observedAt: 5678, retained: false }],
      ["[stored-snapshot-cache] candidate failed", { class: "download-failed", observedAt: 5678, retained: false }],
    ]);
    expect(JSON.stringify(warnings)).not.toMatch(/secret|response|https|device/);
  });

  it("names the download failure when the error carries this SDK's own tag", async () => {
    const { log, warnings } = logger();
    const cache = new StoredImageCache(async () => {
      throw Object.assign(new Error("Media download failed"), { mediaFailure: "http-status", status: 403 });
    }, log);

    cache.observe("device-a", "https://media.example/missing");
    await flush();

    expect(warnings[0]?.[1]).toMatchObject({ class: "download-failed", cause: "http-status", status: 403 });
  });

  it("names a decode failure as a decode failure, not as a network one", async () => {
    const { log, warnings } = logger();
    const cache = new StoredImageCache(async () => {
      throw Object.assign(new Error("Push image could not be decoded"), { mediaFailure: "decode-failed" });
    }, log);

    cache.observe("device-a", "https://media.example/undecodable");
    await flush();

    expect(warnings[0]?.[1]).toMatchObject({ class: "download-failed", cause: "decode-failed" });
    expect(warnings[0]?.[1]).not.toHaveProperty("status");
  });

  it("drops a tag that is not one of this SDK's terms, however it is dressed up", async () => {
    const { log, warnings } = logger();
    const cache = new StoredImageCache(async (url) => {
      throw Object.assign(new Error("boom"), { mediaFailure: `secret response from ${url}`, status: "404" });
    }, log);

    cache.observe("device-a", "https://secret.example/first");
    await flush();

    expect(warnings[0]?.[1]).toEqual({ class: "download-failed", observedAt: expect.any(Number), retained: false });
    expect(JSON.stringify(warnings)).not.toMatch(/secret|response|https/);
  });

  it("remembers a bounded window of attempted URLs rather than every URL forever", async () => {
    const attempts: string[] = [];
    const cache = new StoredImageCache(async (url) => {
      attempts.push(url);
      return jpeg(url);
    }, logger().log);

    // One more than the window, so the first URL is the one pushed out of it.
    for (let i = 0; i < 65; i++) {
      cache.observe("device-a", `https://media.example/${i}`);
      await flush();
    }
    const beforeRepeat = attempts.length;

    // Still inside the window: a repeat is recognised and not downloaded again.
    cache.observe("device-a", "https://media.example/64");
    await flush();
    expect(attempts).toHaveLength(beforeRepeat);

    // Pushed out of it: forgotten, so it is attempted again rather than remembered forever.
    cache.observe("device-a", "https://media.example/0");
    await flush();
    expect(attempts).toHaveLength(beforeRepeat + 1);
  });

  it("emits the same failure class again after the diagnostic interval", async () => {
    const { log, warnings } = logger();
    let now = 0;
    const cache = new StoredImageCache(
      async () => Buffer.from("not a jpeg"),
      log,
      () => now,
    );

    cache.observe("device-a", "https://media.example/one");
    await flush();
    now = 60_000;
    cache.observe("device-a", "https://media.example/two");
    await flush();

    expect(warnings).toHaveLength(2);
  });
});

describe("retained image event pairing", () => {
  const time = 1790000000000;
  it("keeps the old image and time while a new download is pending or fails", async () => {
    const pending = deferred<Buffer>();
    const cache = new StoredImageCache(
      (url) => (url.endsWith("old") ? Promise.resolve(jpeg("old")) : pending.promise),
      logger().log,
    );
    cache.observe("camera", "https://example.test/old", time);
    await flush();
    cache.observe("camera", "https://example.test/new", time + 1000);
    await expect(cache.snapshotStored("camera")).resolves.toEqual({ jpeg: jpeg("old"), eventTime: time });
    pending.reject(new Error("synthetic failure"));
    await flush();
    await expect(cache.snapshotStored("camera")).resolves.toEqual({ jpeg: jpeg("old"), eventTime: time });
  });
  it("does not relabel a reused URL or roll back to a delayed older event", async () => {
    const download = vi.fn(async (url: string) => jpeg(url));
    const cache = new StoredImageCache(download, logger().log);
    cache.observe("camera", "https://example.test/new", time);
    await flush();
    cache.observe("camera", "https://example.test/new", time + 1000);
    cache.observe("camera", "https://example.test/old", time - 1000);
    await flush();
    expect(download).toHaveBeenCalledTimes(1);
    await expect(cache.snapshotStored("camera")).resolves.toEqual({
      jpeg: jpeg("https://example.test/new"),
      eventTime: time,
    });
  });
  it("does not let an older arrival displace a newer queued event", async () => {
    const pending = deferred<Buffer>();
    const cache = new StoredImageCache(
      (url) => (url.endsWith("first") ? pending.promise : Promise.resolve(jpeg(url))),
      logger().log,
    );
    cache.observe("camera", "https://example.test/first", time);
    cache.observe("camera", "https://example.test/new", time + 2000);
    cache.observe("camera", "https://example.test/middle", time + 1000);
    pending.resolve(jpeg("first"));
    await flush();
    await flush();
    await expect(cache.snapshotStored("camera")).resolves.toEqual({
      jpeg: jpeg("https://example.test/new"),
      eventTime: time + 2000,
    });
  });
  it("clears old metadata when a new image has no event time", async () => {
    const cache = new StoredImageCache(async (url) => jpeg(url), logger().log);
    cache.observe("camera", "https://example.test/dated", time);
    await flush();
    cache.observe("camera", "https://example.test/undated");
    await flush();
    await expect(cache.snapshotStored("camera")).resolves.toEqual({ jpeg: jpeg("https://example.test/undated") });
  });
});
