import { ThumbnailDiagnostics } from "../thumbnail-diagnostics.js";
import { StoredImageCache } from "../stored-image-cache.js";
import { normalizePushEvent } from "../push/push-client.js";
import { noopLogger } from "../../core/logger.js";

const when = 1790000000000;
const jpeg = Buffer.from([255, 216, 255, 1, 255, 217]);
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("thumbnail boundary diagnostics", () => {
  it("separates accepted envelope time, nested-only hints and a broken forwarding boundary", () => {
    const evidence = new ThumbnailDiagnostics();
    const event = normalizePushEvent({
      payload: {
        event_time: "1790000000",
        payload: {
          device_sn: "T8000P0000000000",
          pic_url: "https://example.invalid/synthetic00000",
          event_time: -1,
          create_time: 1790000000,
          trigger_time: undefined,
          person_name: "synthetic00000",
        },
      },
    });
    evidence.push(event);
    expect(evidence.diagnostics()).toMatchObject({
      envelope_valid: 1,
      nested_event_invalid: 1,
      nested_create_valid: 1,
      nested_trigger_missing: 1,
      candidate_valid: 1,
      normalization_preserved: 1,
    });
    evidence.push({ ...event, thumbnailCandidate: { ...event.thumbnailCandidate!, eventTime: undefined } });
    expect(evidence.diagnostics().normalization_lost).toBe(1);
    const nestedOnly = normalizePushEvent({ payload: { payload: event.payload } });
    evidence.push(nestedOnly);
    expect(evidence.diagnostics()).toMatchObject({
      envelope_missing: 1,
      candidate_missing: 2,
      normalization_absent: 1,
    });
    expect(nestedOnly.thumbnailCandidate?.eventTime).toBeUndefined();
    expect(JSON.stringify(evidence.diagnostics())).not.toContain("synthetic00000");
    expect(JSON.stringify(evidence.diagnostics())).not.toContain("1790000000");
  });

  it("keeps fixed detached counters, ignores unknown keys and saturates safely", () => {
    const evidence = new ThumbnailDiagnostics();
    const count = Object.keys(evidence.diagnostics()).length;
    for (let i = 0; i < 1000; i++) evidence.time("cache_input", { secret: "synthetic00000" });
    evidence.decision("synthetic00000" as never);
    evidence.time("synthetic00000" as never, when);
    const snapshot = evidence.diagnostics();
    snapshot.cache_input_invalid = 0;
    expect(evidence.diagnostics().cache_input_invalid).toBe(1000);
    expect(Object.keys(evidence.diagnostics())).toHaveLength(count);
    const internal = evidence as unknown as { counts: Record<string, number> };
    internal.counts.queued = Number.MAX_SAFE_INTEGER;
    evidence.decision("queued");
    expect(evidence.diagnostics().queued).toBe(Number.MAX_SAFE_INTEGER);
    evidence.clear();
    expect(Object.values(evidence.diagnostics()).every((value) => value === 0)).toBe(true);
  });

  it("tracks delayed acquisition, duplicate and old candidates without relabeling the retained image", async () => {
    const evidence = new ThumbnailDiagnostics();
    let release!: (image: Buffer) => void;
    let downloads = 0;
    const cache = new StoredImageCache(
      () => {
        downloads++;
        return new Promise<Buffer>((resolve) => {
          release = resolve;
        });
      },
      noopLogger,
      () => when + 99999,
      () => false,
      evidence,
    );
    cache.observe("private-device", "https://example.invalid/synthetic00000", when);
    expect(evidence.diagnostics()).toMatchObject({
      cache_input_valid: 1,
      download_started: 1,
      cache_retained_valid: 0,
    });
    evidence.diagnostics();
    expect(downloads).toBe(1);
    release(jpeg);
    await tick();
    expect(await cache.snapshotStored("private-device")).toEqual({ jpeg, eventTime: when });
    cache.observe("private-device", "https://example.invalid/synthetic00000", when + 1000);
    cache.observe("private-device", "https://example.invalid/older", when - 1000);
    expect(evidence.diagnostics()).toMatchObject({
      duplicate: 1,
      older_rejected: 1,
      retention_preserved: 1,
      retention_lost: 0,
      cache_read_valid: 1,
    });
    expect(downloads).toBe(1);
    cache.observe("private-device", "https://example.invalid/new-undated");
    release(Buffer.from([255, 216, 255, 2, 255, 217]));
    await tick();
    expect((await cache.snapshotStored("private-device")).eventTime).toBeUndefined();
    expect(evidence.diagnostics()).toMatchObject({
      cache_input_missing: 1,
      cache_retained_missing: 1,
      retention_absent: 1,
    });
    expect(JSON.stringify(evidence.diagnostics())).not.toMatch(/private|https|179000/);
  });

  it("tracks queue replacement, failures and generation discard with no stale retention", async () => {
    const evidence = new ThumbnailDiagnostics();
    let release!: (image: Buffer) => void;
    const cache = new StoredImageCache(
      () =>
        new Promise<Buffer>((resolve) => {
          release = resolve;
        }),
      noopLogger,
      Date.now,
      () => false,
      evidence,
    );
    cache.observe("device-a", "https://example.invalid/1", when);
    cache.observe("device-a", "https://example.invalid/2", when + 1000);
    cache.observe("device-a", "https://example.invalid/3", when + 2000);
    expect(evidence.diagnostics().queue_replaced).toBe(1);
    cache.clear();
    release(jpeg);
    await tick();
    expect(evidence.diagnostics()).toMatchObject({
      generation_discarded: 1,
      cache_retained_valid: 0,
      download_started: 0,
    });
    for (const kind of ["download_failed", "invalid_image", "lifecycle_error"] as const) {
      const diagnostics = new ThumbnailDiagnostics();
      const failed = new StoredImageCache(
        async () => {
          if (kind === "invalid_image") return Buffer.from("synthetic00000");
          throw new Error("synthetic00000");
        },
        noopLogger,
        Date.now,
        () => kind === "lifecycle_error",
        diagnostics,
      );
      failed.observe("device-b", "https://example.invalid/synthetic00000", when);
      await tick();
      expect(diagnostics.diagnostics()[kind]).toBe(1);
      expect(diagnostics.diagnostics().cache_retained_valid).toBe(0);
      expect(JSON.stringify(diagnostics.diagnostics())).not.toContain("synthetic00000");
    }
  });
});
