import { performance } from "node:perf_hooks";
import { copyFramingDiagnostics, type FramingDiagnostics } from "./framer.js";
import { PortalLinkType } from "./portal-packet.js";

/** Fixed native roles; remote channel labels are never retained. */
export type NativeChannelRole = "command" | "audio" | "idr" | "video" | "notify" | "download" | "other";

/** Logical roles come from reassembled link types, independently of native channel roles. */
export type LogicalFrameRole = "command" | "notify" | "media" | "file" | "other";

/** Native calls only; a refused readiness check is not a native send. */
export interface NativeSendDiagnostics {
  packets: number;
  bytes: number;
  accepted: number;
  refused: number;
  thrown: number;
}

export interface NativeReceiveDiagnostics {
  packets: number;
  bytes: number;
}

export interface LogicalFrameDiagnostics {
  frames: number;
  bytes: number;
}

/** Milliseconds on a process monotonic clock; independent of protocol timers. */
export type ReceiveTimingClock = () => number;

/** A callback entry identified only by its native-init epoch's sequence and fixed role. */
export interface NativeCallbackEntry {
  sequence: number;
  entryMicros: number;
}

export interface NativeCallbackTiming {
  latest: NativeCallbackEntry | null;
  processing: { lastMicros: number | null; maxMicros: number | null; samples: number };
}

/** The source is the completion-causing callback, never the first fragment's arrival. */
export interface LogicalCompletionTiming {
  completionMicros: number;
  source: (NativeCallbackEntry & { role: NativeChannelRole }) | null;
  callbackToFrameMicros: number | null;
}

/**
 * Fixed-storage process timestamps; async completions have no synchronous callback source.
 * framingEpoch identifies the current native epoch's timing framer, independent of optional framing
 * getter availability. Null means no timing framer initialized in this epoch. The outer diagnostics'
 * framingEpoch may remain historical after native initialization, or null without a framing getter.
 */
export interface RtcReceiveTimingDiagnostics {
  clock: "process-monotonic-microseconds";
  sampledAtMicros: number | null;
  transportEpoch: number;
  framingEpoch: number | null;
  nativeCallbacks: Record<NativeChannelRole, NativeCallbackTiming>;
  logicalFrames: Record<LogicalFrameRole, LogicalCompletionTiming | null>;
}

interface NativeCallbackScope {
  previous: NativeCallbackScope | null;
  transportEpoch: number;
  framingEpoch: number | null;
  framingGeneration: number;
  role: NativeChannelRole;
  sequence: number;
  entryMicros: number | null;
  current: boolean;
}

/**
 * Detached, finite transport evidence. Native and logical counters accumulate over the peer lifetime;
 * transportEpoch increments on native initialization. Framing counters belong to framingEpoch and may
 * describe the last disposed framer. channelReady records the observed command-channel lifecycle,
 * without probing the native channel. Framing is absent when unavailable or when a retired native
 * channel feeds the current framer; a fresh framer restores it. No packet contents or remote identities
 * are retained. Receive timing is null after retired-channel contamination or a failed optional timing
 * hook; a fresh native initialization or timing framer restores it.
 */
export interface RtcTransportDiagnostics {
  transportEpoch: number;
  framingEpoch: number | null;
  outbound: { framed: NativeSendDiagnostics; raw: NativeSendDiagnostics };
  inbound: Record<NativeChannelRole, NativeReceiveDiagnostics>;
  logicalFrames: Record<LogicalFrameRole, LogicalFrameDiagnostics>;
  channelReady: boolean;
  closed: boolean;
  framing?: FramingDiagnostics;
  receiveTiming?: RtcReceiveTimingDiagnostics | null;
}

const NATIVE_ROLES: readonly NativeChannelRole[] = ["command", "audio", "idr", "video", "notify", "download", "other"];
const LOGICAL_ROLES: readonly LogicalFrameRole[] = ["command", "notify", "media", "file", "other"];

function nativeRole(label: string): NativeChannelRole {
  return label === "WebrtcDataChannel"
    ? "command"
    : label === "audio" || label === "idr" || label === "video" || label === "notify" || label === "download"
      ? label
      : "other";
}

function logicalRole(linkType: number): LogicalFrameRole {
  return linkType === PortalLinkType.COMMAND
    ? "command"
    : linkType === PortalLinkType.NOTIFY
      ? "notify"
      : linkType === PortalLinkType.LIVE || linkType === PortalLinkType.PLAYBACK
        ? "media"
        : linkType === PortalLinkType.FILE
          ? "file"
          : "other";
}

function emptyNativeTiming(): NativeCallbackTiming {
  return { latest: null, processing: { lastMicros: null, maxMicros: null, samples: 0 } };
}

function emptyTiming(transportEpoch: number): RtcReceiveTimingDiagnostics {
  return {
    clock: "process-monotonic-microseconds",
    sampledAtMicros: null,
    transportEpoch,
    framingEpoch: null,
    nativeCallbacks: {
      command: emptyNativeTiming(),
      audio: emptyNativeTiming(),
      idr: emptyNativeTiming(),
      video: emptyNativeTiming(),
      notify: emptyNativeTiming(),
      download: emptyNativeTiming(),
      other: emptyNativeTiming(),
    },
    logicalFrames: { command: null, notify: null, media: null, file: null, other: null },
  };
}

function timingNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validEntry(value: NativeCallbackEntry): boolean {
  return timingNumber(value.sequence) && value.sequence > 0 && timingNumber(value.entryMicros);
}

/** Missing or malformed timing is unknown; only declared, validated fields survive a copy. */
export function copyRtcReceiveTimingDiagnostics(value: unknown): RtcReceiveTimingDiagnostics | null {
  try {
    if (!value || typeof value !== "object") return null;
    const row = value as RtcReceiveTimingDiagnostics;
    if (
      row.clock !== "process-monotonic-microseconds" ||
      !timingNumber(row.transportEpoch) ||
      (row.sampledAtMicros !== null && !timingNumber(row.sampledAtMicros)) ||
      (row.framingEpoch !== null && (!timingNumber(row.framingEpoch) || row.framingEpoch !== row.transportEpoch))
    )
      return null;
    const copied = emptyTiming(row.transportEpoch);
    copied.framingEpoch = row.framingEpoch;
    copied.sampledAtMicros = row.sampledAtMicros;
    for (const role of NATIVE_ROLES) {
      const native = row.nativeCallbacks[role];
      const duration = native.processing;
      if (
        native.latest !== null &&
        (!validEntry(native.latest) ||
          (row.sampledAtMicros !== null && native.latest.entryMicros > row.sampledAtMicros))
      )
        return null;
      if (
        !timingNumber(duration.samples) ||
        (duration.samples === 0
          ? duration.lastMicros !== null || duration.maxMicros !== null
          : !timingNumber(duration.lastMicros) ||
            !timingNumber(duration.maxMicros) ||
            duration.lastMicros > duration.maxMicros)
      )
        return null;
      copied.nativeCallbacks[role] = {
        latest:
          native.latest === null ? null : { sequence: native.latest.sequence, entryMicros: native.latest.entryMicros },
        processing: { lastMicros: duration.lastMicros, maxMicros: duration.maxMicros, samples: duration.samples },
      };
    }
    for (const role of LOGICAL_ROLES) {
      const frame = row.logicalFrames[role];
      if (frame === null) continue;
      if (
        row.framingEpoch === null ||
        !timingNumber(frame.completionMicros) ||
        (row.sampledAtMicros !== null && frame.completionMicros > row.sampledAtMicros)
      )
        return null;
      const source = frame.source;
      if (source === null) {
        if (frame.callbackToFrameMicros !== null) return null;
      } else if (
        !NATIVE_ROLES.includes(source.role) ||
        !validEntry(source) ||
        !timingNumber(frame.callbackToFrameMicros) ||
        frame.completionMicros - source.entryMicros !== frame.callbackToFrameMicros
      )
        return null;
      copied.logicalFrames[role] = {
        completionMicros: frame.completionMicros,
        source:
          source === null ? null : { role: source.role, sequence: source.sequence, entryMicros: source.entryMicros },
        callbackToFrameMicros: frame.callbackToFrameMicros,
      };
    }
    return copied;
  } catch {
    return null;
  }
}

/** Saturation preserves finite integer counters for arbitrarily long lifetimes. */
function count(value: number): number {
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : value > Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : 0;
}

function add(value: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + count(increment));
}

function emptySend(): NativeSendDiagnostics {
  return { packets: 0, bytes: 0, accepted: 0, refused: 0, thrown: 0 };
}

function copySend(row: NativeSendDiagnostics): NativeSendDiagnostics {
  return {
    packets: count(row.packets),
    bytes: count(row.bytes),
    accepted: count(row.accepted),
    refused: count(row.refused),
    thrown: count(row.thrown),
  };
}

function copyReceive(row: NativeReceiveDiagnostics): NativeReceiveDiagnostics {
  return { packets: count(row.packets), bytes: count(row.bytes) };
}

function copyLogical(row: LogicalFrameDiagnostics): LogicalFrameDiagnostics {
  return { frames: count(row.frames), bytes: count(row.bytes) };
}

/** Copy only declared numeric fields and finite flags, including optional framing evidence. */
export function copyRtcTransportDiagnostics(row: RtcTransportDiagnostics): RtcTransportDiagnostics {
  let receiveTiming: RtcReceiveTimingDiagnostics | null = null;
  try {
    receiveTiming = copyRtcReceiveTimingDiagnostics(row.receiveTiming);
  } catch {}
  const snapshot: RtcTransportDiagnostics = {
    transportEpoch: count(row.transportEpoch),
    framingEpoch: row.framingEpoch === null ? null : count(row.framingEpoch),
    outbound: { framed: copySend(row.outbound.framed), raw: copySend(row.outbound.raw) },
    inbound: {
      command: copyReceive(row.inbound.command),
      audio: copyReceive(row.inbound.audio),
      idr: copyReceive(row.inbound.idr),
      video: copyReceive(row.inbound.video),
      notify: copyReceive(row.inbound.notify),
      download: copyReceive(row.inbound.download),
      other: copyReceive(row.inbound.other),
    },
    logicalFrames: {
      command: copyLogical(row.logicalFrames.command),
      notify: copyLogical(row.logicalFrames.notify),
      media: copyLogical(row.logicalFrames.media),
      file: copyLogical(row.logicalFrames.file),
      other: copyLogical(row.logicalFrames.other),
    },
    channelReady: row.channelReady === true,
    closed: row.closed === true,
    receiveTiming,
  };
  if (
    snapshot.receiveTiming &&
    (snapshot.receiveTiming.transportEpoch !== snapshot.transportEpoch ||
      (snapshot.receiveTiming.framingEpoch !== null &&
        snapshot.framingEpoch !== null &&
        snapshot.receiveTiming.framingEpoch !== snapshot.framingEpoch))
  )
    snapshot.receiveTiming = null;
  if (row.framing) snapshot.framing = copyFramingDiagnostics(row.framing);
  return snapshot;
}

/** Fixed-storage counters; all reads return detached, whitelisted objects. */
export class TransportEvidenceRecorder {
  private timing = emptyTiming(0);
  private timingContaminated = false;
  private receiveSequence = 0;
  private framingGeneration = 0;
  private lastClockMicros: number | null = null;
  private callbackScope: NativeCallbackScope | null = null;

  constructor(private readonly receiveTimingNow: ReceiveTimingClock = () => performance.now()) {}

  private readonly evidence: RtcTransportDiagnostics = {
    transportEpoch: 0,
    framingEpoch: null,
    outbound: { framed: emptySend(), raw: emptySend() },
    inbound: {
      command: { packets: 0, bytes: 0 },
      audio: { packets: 0, bytes: 0 },
      idr: { packets: 0, bytes: 0 },
      video: { packets: 0, bytes: 0 },
      notify: { packets: 0, bytes: 0 },
      download: { packets: 0, bytes: 0 },
      other: { packets: 0, bytes: 0 },
    },
    logicalFrames: {
      command: { frames: 0, bytes: 0 },
      notify: { frames: 0, bytes: 0 },
      media: { frames: 0, bytes: 0 },
      file: { frames: 0, bytes: 0 },
      other: { frames: 0, bytes: 0 },
    },
    channelReady: false,
    closed: false,
  };

  init(): void {
    this.evidence.transportEpoch = add(this.evidence.transportEpoch, 1);
    this.evidence.closed = false;
    this.timing = emptyTiming(this.evidence.transportEpoch);
    this.timingContaminated = false;
    this.receiveSequence = 0;
    this.callbackScope = null;
  }

  /** Invalid, throwing or backwards clocks produce unknown timestamps without affecting transport. */
  receiveTimestamp(): number | null {
    try {
      const now = this.receiveTimingNow();
      if (typeof now !== "number") return null;
      const micros = Math.floor(now * 1000);
      if (!timingNumber(micros) || (this.lastClockMicros !== null && micros < this.lastClockMicros)) return null;
      this.lastClockMicros = micros;
      return micros;
    } catch {
      return null;
    }
  }

  /** Scope restoration preserves the completion-causing callback across synchronous reentrancy. */
  beginNativeCallback(label: string, entryMicros: number | null, current: boolean): NativeCallbackScope {
    const role = nativeRole(label);
    if (current) this.receiveSequence = add(this.receiveSequence, 1);
    const scope: NativeCallbackScope = {
      previous: this.callbackScope,
      transportEpoch: this.evidence.transportEpoch,
      framingEpoch: this.timing.framingEpoch,
      framingGeneration: this.framingGeneration,
      role,
      sequence: this.receiveSequence,
      entryMicros,
      current,
    };
    this.callbackScope = scope;
    if (current && !this.timingContaminated) {
      this.timing.nativeCallbacks[role].latest =
        entryMicros === null ? null : { sequence: scope.sequence, entryMicros };
    }
    return scope;
  }

  /** Whole callback duration includes synchronous frame consumers; invalid samples are omitted. */
  finishNativeCallback(scope: NativeCallbackScope): void {
    try {
      const finished = this.receiveTimestamp();
      if (
        !scope.current ||
        scope.transportEpoch !== this.evidence.transportEpoch ||
        this.timingContaminated ||
        scope.entryMicros === null ||
        finished === null ||
        finished < scope.entryMicros
      )
        return;
      const duration = finished - scope.entryMicros;
      const row = this.timing.nativeCallbacks[scope.role].processing;
      row.lastMicros = duration;
      row.maxMicros = row.maxMicros === null ? duration : Math.max(row.maxMicros, duration);
      row.samples = add(row.samples, 1);
    } finally {
      this.restoreNativeCallback(scope);
    }
  }

  /** Idempotent scope cleanup remains independent of optional duration recording. */
  restoreNativeCallback(scope: NativeCallbackScope): void {
    if (this.callbackScope === scope) {
      this.callbackScope = scope.transportEpoch === this.evidence.transportEpoch ? scope.previous : null;
    }
  }

  /** A new framer discards logical timing whose assembly belonged to an older framer. */
  initFramingTiming(): void {
    this.framingGeneration = add(this.framingGeneration, 1);
    this.timingContaminated = false;
    this.timing.framingEpoch = this.evidence.transportEpoch;
    this.timing.logicalFrames = { command: null, notify: null, media: null, file: null, other: null };
  }

  /** Retired-channel fragments or failed optional hooks make timing and callback provenance unknown. */
  contaminateReceiveTiming(): void {
    this.timingContaminated = true;
    this.callbackScope = null;
  }

  /** Record completion before synchronous emission; asynchronous frames retain a null source. */
  logicalCompletion(linkType: number): void {
    const completionMicros = this.receiveTimestamp();
    if (this.timingContaminated || this.timing.framingEpoch === null) return;
    const role = logicalRole(linkType);
    if (completionMicros === null) {
      this.timing.logicalFrames[role] = null;
      return;
    }
    const scope = this.callbackScope;
    const source =
      scope?.current &&
      scope.transportEpoch === this.evidence.transportEpoch &&
      scope.framingEpoch === this.timing.framingEpoch &&
      scope.framingGeneration === this.framingGeneration &&
      scope.entryMicros !== null &&
      scope.entryMicros <= completionMicros
        ? { role: scope.role, sequence: scope.sequence, entryMicros: scope.entryMicros }
        : null;
    this.timing.logicalFrames[role] = {
      completionMicros,
      source,
      callbackToFrameMicros: source === null ? null : completionMicros - source.entryMicros,
    };
  }

  nativeSend(kind: "framed" | "raw", bytes: number, outcome: "accepted" | "refused" | "thrown"): void {
    const row = this.evidence.outbound[kind];
    row.packets = add(row.packets, 1);
    row.bytes = add(row.bytes, bytes);
    row[outcome] = add(row[outcome], 1);
  }

  nativeReceive(label: string, bytes: number): void {
    const role = nativeRole(label);
    const row = this.evidence.inbound[role];
    row.packets = add(row.packets, 1);
    row.bytes = add(row.bytes, bytes);
  }

  logicalFrame(linkType: number, bytes: number): void {
    const role = logicalRole(linkType);
    const row = this.evidence.logicalFrames[role];
    row.frames = add(row.frames, 1);
    row.bytes = add(row.bytes, bytes);
  }

  snapshot(channelReady: boolean, closed: boolean): RtcTransportDiagnostics {
    try {
      this.timing.sampledAtMicros = this.receiveTimestamp();
    } catch {
      this.timing.sampledAtMicros = null;
      this.timingContaminated = true;
      this.callbackScope = null;
    }
    return {
      ...copyRtcTransportDiagnostics(this.evidence),
      channelReady,
      closed,
      receiveTiming: this.timingContaminated ? null : copyRtcReceiveTimingDiagnostics(this.timing),
    };
  }
}
