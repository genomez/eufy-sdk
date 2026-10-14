/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import {
  StoredSnapshotUnavailableError,
  type StoredSnapshot,
  type StoredSnapshotUnavailableReason,
} from "../core/contracts.js";
import type { Logger } from "../core/logger.js";
import { mediaFailureTag } from "./media-failure.js";

import { ThumbnailDiagnostics } from "./thumbnail-diagnostics.js";

const MAX_JPEG_BYTES = 10 * 1024 * 1024;

/**
 * How many candidate URLs per device are remembered as already attempted.
 *
 * The set exists so the same thumbnail is not downloaded twice â€” one event arrives as several pushes
 * (motion, then a person, then a face) carrying one URL between them. That is a question about the last
 * few seconds, so a bounded window answers it exactly as well as an unbounded one, and unbounded is a
 * leak: a signed media URL is a few hundred bytes, a busy camera produces hundreds a day, and a host
 * that caps an app's memory does not care that each one is small.
 */
const MAX_REMEMBERED_URLS = 64;

/** Retry only a media-host 404, at most twice after the initial attempt. */
const THUMBNAIL_404_RETRY_MS = [2_000, 4_000] as const;

type Candidate = {
  deviceKey: string;
  url: string;
  sequence: number;
  observedAt: number;
  eventTime?: number;
  generation: number;
  retries: number;
};

type DeviceState = {
  deviceKey: string;
  nextSequence: number;
  seenUrls: Set<string>;
  loggedFailures: Map<StoredSnapshotUnavailableReason, number>;
  queued?: Candidate;
  inFlight?: Candidate;
  retrying?: { candidate: Candidate; timer: ReturnType<typeof setTimeout> };
  retained?: { sequence: number; snapshot: StoredSnapshot };
  reason?: StoredSnapshotUnavailableReason;
  lifecycleError?: unknown;
};

const DIAGNOSTIC_INTERVAL_MS = 60_000;

/** In-memory state for push thumbnails acquired before a caller passively reads them. */
export class StoredImageCache {
  private readonly devices = new Map<string, DeviceState>();
  private readonly activeDevices = new Set<string>();
  private activeDownloads = 0;
  private generation = 0;

  constructor(
    private readonly downloader: (url: string, deviceKey: string) => Promise<Buffer>,
    private readonly logger: Logger,
    private readonly clock: () => number = Date.now,
    private readonly isLifecycleError: (error: unknown) => boolean = () => false,
    private readonly evidence = new ThumbnailDiagnostics(),
  ) {}

  /**
   * Observe a normalized thumbnail URL and start acquisition eagerly.
   *
   * A URL already inside this device's window of recent attempts is ignored, so one event arriving as
   * several pushes downloads one thumbnail. The window is a `Set`, which iterates in insertion order,
   * so the entry evicted once it is full is the oldest attempt.
   */
  observe(deviceKey: string, url: string, eventTime?: number): void {
    this.evidence.time("cache_input", eventTime);
    let state = this.devices.get(deviceKey);
    if (!state) {
      state = {
        deviceKey,
        nextSequence: 0,
        seenUrls: new Set(),
        loggedFailures: new Map(),
      };
      this.devices.set(deviceKey, state);
    }
    const newestTime = [
      state.retained?.snapshot.eventTime,
      state.inFlight?.eventTime,
      state.queued?.eventTime,
      state.retrying?.candidate.eventTime,
    ]
      .filter((time): time is number => time !== undefined)
      .reduce((latest, time) => Math.max(latest, time), 0);
    if (eventTime !== undefined && eventTime < newestTime) {
      this.evidence.decision("older_rejected");
      return;
    }
    if (state.seenUrls.has(url)) {
      this.evidence.decision("duplicate");
      return;
    }
    this.cancelRetry(state);
    state.seenUrls.add(url);
    while (state.seenUrls.size > MAX_REMEMBERED_URLS) {
      const oldest = state.seenUrls.values().next();
      if (oldest.done) break;
      state.seenUrls.delete(oldest.value);
    }
    this.evidence.decision(state.queued ? "queue_replaced" : "queued");
    state.queued = {
      deviceKey,
      url,
      sequence: ++state.nextSequence,
      observedAt: this.clock(),
      ...(eventTime === undefined ? {} : { eventTime }),
      generation: this.generation,
      retries: 0,
    };
    this.pump();
  }

  /** Return retained bytes without starting or awaiting network work. */
  snapshotStored(deviceKey: string): Promise<StoredSnapshot> {
    const state = this.devices.get(deviceKey);
    const reason = state?.queued || state?.inFlight || state?.retrying ? "pending" : (state?.reason ?? "not-observed");
    if (reason !== "pending" && state?.lifecycleError) return Promise.reject(state.lifecycleError);
    if (state?.retained) {
      this.evidence.time("cache_read", state.retained.snapshot.eventTime);
      return Promise.resolve({ ...state.retained.snapshot });
    }
    return Promise.reject(new StoredSnapshotUnavailableError(reason, "No stored snapshot is available"));
  }

  /** Invalidate all retained and candidate state. */
  clear(): void {
    this.generation += 1;
    for (const state of this.devices.values()) this.cancelRetry(state);
    this.devices.clear();
    this.evidence.clear();
  }

  private pump(): void {
    while (this.activeDownloads < 2) {
      const state = [...this.devices.values()].find(
        (candidateState) => candidateState.queued && !this.activeDevices.has(candidateState.deviceKey),
      );
      if (!state?.queued) return;
      const candidate = state.queued;
      state.queued = undefined;
      state.inFlight = candidate;
      this.activeDownloads += 1;
      this.activeDevices.add(candidate.deviceKey);
      this.evidence.decision("download_started");
      void this.downloader(candidate.url, candidate.deviceKey).then(
        (image) => this.complete(candidate, image),
        (error: unknown) => this.complete(candidate, undefined, error),
      );
    }
  }

  private complete(candidate: Candidate, image: Buffer | undefined, error?: unknown): void {
    this.activeDownloads -= 1;
    this.activeDevices.delete(candidate.deviceKey);
    const state = this.devices.get(candidate.deviceKey);
    if (candidate.generation === this.generation && state?.inFlight === candidate) {
      state.inFlight = undefined;
      if (error !== undefined && this.isLifecycleError(error)) {
        this.evidence.decision("lifecycle_error");
        state.lifecycleError = error;
        state.reason = undefined;
      } else if (image === undefined && this.retryLater(state, candidate, error)) {
        state.lifecycleError = undefined;
        this.evidence.downloadFailure(error);
      } else if (image === undefined) {
        state.lifecycleError = undefined;
        this.evidence.decision("download_failed");
        this.evidence.downloadFailure(error);
        state.reason = "download-failed";
        this.diagnose(state, candidate, "download-failed", error);
      } else if (!this.isValidJpeg(image)) {
        state.lifecycleError = undefined;
        this.evidence.decision("invalid_image");
        state.reason = "invalid-image";
        this.diagnose(state, candidate, "invalid-image");
      } else if (!state.retained || candidate.sequence > state.retained.sequence) {
        state.retained = {
          sequence: candidate.sequence,
          snapshot: { jpeg: image, ...(candidate.eventTime === undefined ? {} : { eventTime: candidate.eventTime }) },
        };
        state.lifecycleError = undefined;
        state.reason = undefined;
        this.evidence.time("cache_retained", state.retained.snapshot.eventTime);
        this.evidence.transfer("retention", candidate.eventTime, state.retained.snapshot.eventTime);
      }
    } else {
      this.evidence.decision("generation_discarded");
    }
    this.pump();
  }

  private cancelRetry(state: DeviceState): void {
    if (state.retrying) clearTimeout(state.retrying.timer);
    state.retrying = undefined;
  }

  /** A waiting retry consumes neither a global download slot nor a device slot. */
  private retryLater(state: DeviceState, candidate: Candidate, error: unknown): boolean {
    const delay = THUMBNAIL_404_RETRY_MS[candidate.retries];
    const tag = mediaFailureTag(error);
    if (delay === undefined || tag.cause !== "http-status" || tag.status !== 404 || state.queued) return false;
    const retry = {
      candidate,
      timer: setTimeout(() => {
        if (
          this.generation !== candidate.generation ||
          this.devices.get(candidate.deviceKey) !== state ||
          state.retrying !== retry
        )
          return;
        state.retrying = undefined;
        state.queued = { ...candidate, retries: candidate.retries + 1 };
        this.pump();
      }, delay),
    };
    retry.timer.unref?.();
    state.retrying = retry;
    return true;
  }

  private isValidJpeg(image: Buffer): boolean {
    return (
      Buffer.isBuffer(image) &&
      image.length > 0 &&
      image.length <= MAX_JPEG_BYTES &&
      image.length >= 5 &&
      image[0] === 0xff &&
      image[1] === 0xd8 &&
      image[2] === 0xff &&
      image[image.length - 2] === 0xff &&
      image[image.length - 1] === 0xd9
    );
  }

  private diagnose(
    state: DeviceState,
    candidate: Candidate,
    failure: "download-failed" | "invalid-image",
    error?: unknown,
  ): void {
    const now = this.clock();
    const last = state.loggedFailures.get(failure);
    if (last !== undefined && now - last < DIAGNOSTIC_INTERVAL_MS) return;
    state.loggedFailures.set(failure, now);
    this.logger.warn("[stored-snapshot-cache] candidate failed", {
      class: failure,
      ...mediaFailureTag(error),
      observedAt: candidate.observedAt,
      retained: state.retained !== undefined,
    });
  }
}
