import { ThumbnailDiagnostics } from "../thumbnail-diagnostics.js";
import { StoredImageCache } from "../stored-image-cache.js";
import { noopLogger } from "../../core/logger.js";

describe("bounded thumbnail failure evidence", () => {
  it("classifies failures even with logging disabled, without retrying or retaining raw error data", async () => {
    const evidence = new ThumbnailDiagnostics();
    const error = Object.assign(new Error("private-marker"), {
      mediaFailure: "http-status",
      status: 404,
      url: "private-marker",
    });
    const downloader = vi.fn(async () => {
      throw error;
    });
    const cache = new StoredImageCache(downloader, noopLogger, Date.now, () => false, evidence);
    cache.observe("private-device", "https://example.invalid/private-marker");
    await Promise.resolve();
    await Promise.resolve();
    expect(downloader).toHaveBeenCalledTimes(1);
    expect(evidence.failures()).toEqual([{ observedAtMs: expect.any(Number), cause: "http-status", status: 404 }]);
    expect(JSON.stringify(evidence.failures())).not.toContain("private");
  });
  it.each([
    [{ mediaFailure: "timeout", status: 404 }, "timeout", null],
    [{ mediaFailure: "http-status", status: 403 }, "http-status", 403],
    [{ mediaFailure: "http-status", status: "404" }, "http-status", null],
    [{ mediaFailure: "http-status", status: 600 }, "http-status", null],
    [{ mediaFailure: "private-marker", status: 404 }, null, null],
    [new Error("private-marker"), null, null],
    [undefined, null, null],
  ])("allowlists injected failure tags %#", (error, cause, status) => {
    const evidence = new ThumbnailDiagnostics();
    evidence.downloadFailure(error);
    expect(evidence.failures()[0]).toMatchObject({ cause, status });
  });
  it("bounds, detaches and clears retained rows", () => {
    const evidence = new ThumbnailDiagnostics();
    for (let i = 0; i < 40; i++) evidence.downloadFailure({ mediaFailure: "network" });
    expect(evidence.failures()).toHaveLength(32);
    evidence.failures()[0]!.cause = "timeout";
    expect(evidence.failures()[0]!.cause).toBe("network");
    evidence.clear();
    expect(evidence.failures()).toEqual([]);
  });
  it("does not retain a completion from an invalidated cache generation", async () => {
    const evidence = new ThumbnailDiagnostics();
    let reject!: (e: unknown) => void;
    const cache = new StoredImageCache(
      () =>
        new Promise((_resolve, r) => {
          reject = r;
        }),
      noopLogger,
      Date.now,
      () => false,
      evidence,
    );
    cache.observe("private-device", "https://example.invalid/image");
    cache.clear();
    reject({ mediaFailure: "http-status", status: 404 });
    await Promise.resolve();
    await Promise.resolve();
    expect(evidence.failures()).toEqual([]);
  });
});
