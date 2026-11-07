import { parseVideoFrameHeader } from "../p2p/video.js";
/** Explicitly experimental command values; unsupported protocol alternatives are excluded. */
export interface PlaybackExperiment {
  mode?: "playback" | "download";
  playSpeed: 1 | 2 | 4 | 8;
  playType: 1;
  clientType: "WEB";
  icePolicy?: "relay" | "all";
  maxClips?: number;
}

/** Validate again at the transport boundary; arbitrary keys never reach the wire or receipts. */
export function playbackExperiment(value: unknown): PlaybackExperiment | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("Playback experiment invalid");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !["mode", "playSpeed", "playType", "clientType", "icePolicy", "maxClips"].includes(k)) ||
    (v.mode !== undefined && v.mode !== "playback" && v.mode !== "download") ||
    ![1, 2, 4, 8].includes(v.playSpeed as number) ||
    v.playType !== 1 ||
    v.clientType !== "WEB" ||
    (v.icePolicy !== undefined && v.icePolicy !== "relay" && v.icePolicy !== "all") ||
    (v.maxClips !== undefined && (!Number.isSafeInteger(v.maxClips) || (v.maxClips as number) < 1))
  )
    throw new RangeError("Playback experiment invalid");
  return {
    ...(v.mode === undefined ? {} : { mode: v.mode }),
    playSpeed: v.playSpeed as PlaybackExperiment["playSpeed"],
    playType: 1,
    clientType: "WEB",
    ...(v.icePolicy === undefined ? {} : { icePolicy: v.icePolicy }),
    ...(v.maxClips === undefined ? {} : { maxClips: v.maxClips as number }),
  };
}

/** Header clocks are transport evidence, never validated presentation timestamps. */
export class PlaybackFrameTiming {
  private histogram = new Map<number, number>();
  private bucket = 0;
  private bucketFrames = 0;
  private zeroBuckets = 0;
  private firstArrival?: number;
  private lastArrival?: number;
  private lastClock?: number;
  private lastSequence?: number;
  private delta = 0;
  private sequenceDelta = 0;
  private maxGap = 0;
  private maxSpacingDifference = 0;
  private timedFrames = 0;
  add(arrival: number, header?: { frameId: number; sequence: number }): void {
    this.firstArrival ??= arrival;
    const bucket = Math.min(2147483, Math.floor((arrival - this.firstArrival) / 1000));
    if (bucket > this.bucket) {
      this.histogram.set(this.bucketFrames, (this.histogram.get(this.bucketFrames) ?? 0) + 1);
      this.zeroBuckets += bucket - this.bucket - 1;
      this.bucket = bucket;
      this.bucketFrames = 0;
    }
    this.bucketFrames++;
    if (header) {
      if (this.lastClock !== undefined && this.lastArrival !== undefined) {
        const gap = (header.frameId - this.lastClock) >>> 0;
        this.delta += gap;
        this.sequenceDelta += (header.sequence - this.lastSequence!) & 0xffff;
        this.maxGap = Math.max(this.maxGap, gap);
        this.maxSpacingDifference = Math.max(this.maxSpacingDifference, Math.abs(gap - (arrival - this.lastArrival)));
      }
      this.lastClock = header.frameId;
      this.lastSequence = header.sequence;
      this.timedFrames++;
    }
    this.lastArrival = arrival;
  }
  snapshot() {
    const histogram = new Map(this.histogram);
    if (this.bucketFrames) histogram.set(this.bucketFrames, (histogram.get(this.bucketFrames) ?? 0) + 1);
    if (this.zeroBuckets) histogram.set(0, this.zeroBuckets);
    const samples = [...histogram].sort(([a], [b]) => a - b);
    const n = this.bucketFrames ? this.bucket + 1 : 0;
    const at = (i: number) => {
      for (const [frames, buckets] of samples) {
        if (i < buckets) return frames;
        i -= buckets;
      }
      return 0;
    };
    return {
      arrivalFps: {
        buckets: n,
        min: at(0),
        median: n ? (at(Math.floor((n - 1) / 2)) + at(Math.floor(n / 2))) / 2 : 0,
        max: samples.at(-1)?.[0] ?? 0,
      },
      frameTiming: {
        source: "ptcs_sender_clock_unverified" as const,
        frames: this.timedFrames,
        timestampDeltaMs: this.delta,
        maxTimestampGapMs: this.maxGap,
        sequenceDelta: this.sequenceDelta,
        maxSpacingDifferenceMs: Math.round(this.maxSpacingDifference),
        spacingDiffers: this.timedFrames >= 2 && this.maxSpacingDifference > 5,
        mediaTimestampValidated: false as const,
      },
    };
  }
}

/** The existing 22-byte video header exposes a timestamp word, without verified RTC clock units. */
export class PlaybackNativeFrameTiming {
  private readonly timing = new PlaybackFrameTiming();
  private lastTimestamp?: number;
  private lastSequence?: number;
  private readonly prefixDeltas: number[] = [];
  private positiveDeltas = 0;
  private deltasWithinSecond = 0;
  private millisecondStep = false;
  private monotonic = true;
  private contiguous = true;
  private positionMs = 0;
  private spanMs = 0;
  private continuous = true;
  add(body: Buffer, arrivalMs: number): void {
    const header = parseVideoFrameHeader(body);
    if (header) {
      if (this.lastTimestamp !== undefined) {
        const gap = (header.timestamp - this.lastTimestamp) >>> 0;
        if (gap === 0 || gap > 1000) this.continuous = false;
        const delta = (header.timestamp - this.lastTimestamp) | 0;
        if (this.prefixDeltas.length < 3) this.prefixDeltas.push(delta);
        if (delta > 0) {
          this.positiveDeltas++;
          if (delta <= 1000) this.deltasWithinSecond++;
          if (delta >= 10 && delta <= 250) this.millisecondStep = true;
        }
        if (delta < -10) this.monotonic = false;
        if (((header.sequence - this.lastSequence!) & 0xffff) !== 1) this.contiguous = false;
        this.positionMs += delta;
        this.spanMs = Math.max(this.spanMs + 1, this.positionMs);
      }
      this.lastTimestamp = header.timestamp;
      this.lastSequence = header.sequence;
      this.timing.add(arrivalMs, { frameId: header.timestamp, sequence: header.sequence });
    } else this.monotonic = false;
  }
  /**
   * Millisecond qualification matches timestamped media: four headers, two advancing steps,
   * a 10..250 ms step anywhere in the clip, an upper median positive step at most 1000 ms,
   * no regression over 10 ms, and a catalog-bounded span.
   * The final presentation interval is one 15 fps output period, independent of recording cadence.
   */
  private qualifiedDurationMs(expectedMs: number): number | undefined {
    if (
      !this.monotonic ||
      this.prefixDeltas.length < 3 ||
      this.prefixDeltas.filter((delta) => delta > 0).length < 2 ||
      !this.millisecondStep ||
      this.deltasWithinSecond * 2 <= this.positiveDeltas ||
      !Number.isSafeInteger(expectedMs) ||
      expectedMs <= 0 ||
      this.spanMs > expectedMs + 1000
    )
      return undefined;
    return this.spanMs + 1000 / 15;
  }
  /**
   * EOF coverage requires catalog agreement and every u16 header sequence step to equal one.
   * Constant sequences and repeated access-unit chunks cannot establish this proof; rollover can.
   */
  completeDurationMs(expectedMs: number): number | undefined {
    const duration = this.qualifiedDurationMs(expectedMs);
    return this.contiguous && duration !== undefined && duration >= expectedMs - 1000
      ? Math.round(duration)
      : undefined;
  }
  /** Experimental millisecond interpretation requires advancing bounded words and catalog agreement. */
  durationMs(expectedMs: number): number | undefined {
    const value = this.timing.snapshot().frameTiming;
    if (!this.continuous || value.frames < 3 || !Number.isSafeInteger(expectedMs) || expectedMs <= 0) return undefined;
    const duration = Math.round((value.timestampDeltaMs * value.frames) / (value.frames - 1));
    return duration > 0 && Math.abs(duration - expectedMs) <= Math.max(250, expectedMs * 0.1) ? duration : undefined;
  }
  /**
   * A continuous native clock clearly shorter than the catalog duration exposes missing media hidden by
   * delivery pauses. Qualified variable cadence uses the one-second catalog window; legacy continuous
   * clocks retain the mean-step (4–50 fps) and arrival-coverage tolerance checks.
   */
  shortOf(expectedMs: number): boolean {
    const nativeDuration = this.qualifiedDurationMs(expectedMs);
    if (!this.continuous && nativeDuration !== undefined && nativeDuration < expectedMs - 1000) return true;
    const value = this.timing.snapshot().frameTiming;
    if (!this.continuous || value.frames < 3 || !Number.isSafeInteger(expectedMs) || expectedMs <= 0) return false;
    const step = value.timestampDeltaMs / (value.frames - 1);
    if (!(step >= 20 && step <= 250)) return false;
    const duration = Math.round((value.timestampDeltaMs * value.frames) / (value.frames - 1));
    return duration > 0 && duration < expectedMs - Math.max(1000, expectedMs * 0.15);
  }
  snapshot() {
    const value = this.timing.snapshot().frameTiming;
    return {
      source: "native_video_header_unverified" as const,
      frames: value.frames,
      timestampDeltaTicks: value.timestampDeltaMs,
      maxTimestampGapTicks: value.maxTimestampGapMs,
      sequenceDelta: value.sequenceDelta,
      maxSpacingDifferenceAssumingMs: value.maxSpacingDifferenceMs,
      spacingDiffersAssumingMs: value.spacingDiffers,
      mediaTimestampValidated: false as const,
    };
  }
}
