import { describe, expect, it, vi } from "vitest";
import {
  copyRtcReceiveTimingDiagnostics,
  copyRtcTransportDiagnostics,
  TransportEvidenceRecorder,
} from "../transport-diagnostics.js";
import { PortalLinkType } from "../portal-packet.js";

describe("finite transport recorder", () => {
  it("saturates packet byte totals and preserves independent native outcomes", () => {
    const recorder = new TransportEvidenceRecorder();
    recorder.init();
    recorder.nativeSend("framed", Number.MAX_SAFE_INTEGER, "accepted");
    recorder.nativeSend("framed", Number.MAX_SAFE_INTEGER, "refused");
    recorder.nativeSend("raw", 4, "thrown");
    recorder.nativeReceive("__proto__", Number.MAX_SAFE_INTEGER);
    recorder.nativeReceive("synthetic-other-label", 3);
    recorder.logicalFrame(99, Number.MAX_SAFE_INTEGER);
    recorder.logicalFrame(100, 8);
    const snapshot = recorder.snapshot(true, false);
    expect(snapshot.outbound.framed).toEqual({
      packets: 2,
      bytes: Number.MAX_SAFE_INTEGER,
      accepted: 1,
      refused: 1,
      thrown: 0,
    });
    expect(snapshot.outbound.raw).toEqual({ packets: 1, bytes: 4, accepted: 0, refused: 0, thrown: 1 });
    expect(snapshot.inbound.other).toEqual({ packets: 2, bytes: Number.MAX_SAFE_INTEGER });
    expect(snapshot.logicalFrames.other).toEqual({ frames: 2, bytes: Number.MAX_SAFE_INTEGER });
    expect(JSON.stringify(snapshot)).not.toMatch(/__proto__|synthetic-other-label/);
    recorder.init();
    expect(recorder.snapshot(false, false)).toMatchObject({ transportEpoch: 2, outbound: snapshot.outbound });
  });

  it("copies only declared fields into detached finite counter objects", () => {
    const row = new TransportEvidenceRecorder().snapshot(false, false);
    row.outbound.framed.bytes = Number.POSITIVE_INFINITY;
    row.outbound.raw.bytes = -8;
    row.inbound.audio.bytes = Number.NaN;
    Object.assign(row, { remoteLabel: "synthetic-private-channel" });
    Object.assign(row.logicalFrames.other, { payload: "synthetic-private-payload" });
    const copied = copyRtcTransportDiagnostics(row);
    expect(Number.isSafeInteger(copied.outbound.framed.bytes)).toBe(true);
    expect(copied.outbound.raw.bytes).toBe(0);
    expect(copied.inbound.audio.bytes).toBe(0);
    copied.inbound.command.packets = 5;
    expect(row.inbound.command.packets).toBe(0);
    expect(JSON.stringify(copied)).not.toMatch(/synthetic-private|remoteLabel|payload/);
  });
});

describe("fixed passive receive timing", () => {
  it("returns unknown timing without losing counters when the snapshot timestamp hook throws", () => {
    const recorder = new TransportEvidenceRecorder(() => 1);
    recorder.init();
    recorder.nativeReceive("audio", 8);
    const fault = vi.spyOn(recorder, "receiveTimestamp").mockImplementation(() => {
      throw new Error("synthetic-snapshot-clock-error");
    });
    try {
      expect(recorder.snapshot(false, false)).toMatchObject({
        inbound: { audio: { packets: 1, bytes: 8 } },
        receiveTiming: null,
      });
    } finally {
      fault.mockRestore();
    }
    expect(recorder.snapshot(false, false).receiveTiming).toBeNull();
    recorder.init();
    expect(recorder.snapshot(false, false).receiveTiming).not.toBeNull();
  });
  it("rejects contradictory known framing epochs while preserving explicit unknown and historical epochs", () => {
    const recorder = new TransportEvidenceRecorder(() => 1);
    recorder.init();
    recorder.initFramingTiming();
    const current = recorder.snapshot(false, false);
    current.framingEpoch = 2;
    expect(copyRtcTransportDiagnostics(current).receiveTiming).toBeNull();
    current.framingEpoch = null;
    expect(copyRtcTransportDiagnostics(current).receiveTiming).toMatchObject({ transportEpoch: 1, framingEpoch: 1 });
    recorder.init();
    const fresh = recorder.snapshot(false, false);
    fresh.framingEpoch = 1;
    expect(copyRtcTransportDiagnostics(fresh).receiveTiming).toMatchObject({ transportEpoch: 2, framingEpoch: null });
    recorder.initFramingTiming();
    const contradictory = recorder.snapshot(false, false);
    contradictory.framingEpoch = 1;
    expect(copyRtcTransportDiagnostics(contradictory).receiveTiming).toBeNull();
  });
  it("copies detached whitelisted timing slots and retains only the latest bounded observations", () => {
    let now = 1;
    const recorder = new TransportEvidenceRecorder(() => now);
    recorder.init();
    recorder.initFramingTiming();
    for (let i = 0; i < 1000; i++) {
      const scope = recorder.beginNativeCallback("synthetic-private-channel", recorder.receiveTimestamp(), true);
      now += 1;
      recorder.logicalCompletion(PortalLinkType.NOTIFY);
      recorder.finishNativeCallback(scope);
    }
    const snapshot = recorder.snapshot(false, false);
    const timing = snapshot.receiveTiming!;
    expect(Object.keys(timing.nativeCallbacks)).toHaveLength(7);
    expect(Object.keys(timing.logicalFrames)).toHaveLength(5);
    expect(timing.nativeCallbacks.other.latest!.sequence).toBe(1000);
    expect(timing.nativeCallbacks.other.processing).toEqual({ lastMicros: 1000, maxMicros: 1000, samples: 1000 });
    Object.assign(timing, { label: "synthetic-private-label", payload: "synthetic-private-payload" });
    Object.assign(timing.logicalFrames.notify!.source!, { credential: "synthetic-private-credential" });
    const copied = copyRtcReceiveTimingDiagnostics(timing)!;
    expect(JSON.stringify(copied)).not.toMatch(/synthetic-private|payload|credential|label/);
    copied.nativeCallbacks.other.latest!.entryMicros = 0;
    copied.nativeCallbacks.other.processing.maxMicros = 9000;
    copied.logicalFrames.notify!.source!.sequence = 1;
    expect(timing.nativeCallbacks.other.latest!.entryMicros).not.toBe(0);
    expect(recorder.snapshot(false, false).receiveTiming!.nativeCallbacks.other.processing.maxMicros).toBe(1000);
    expect(timing.logicalFrames.notify!.source!.sequence).toBe(1000);
  });

  it("rejects missing, malformed, contradictory or throwing timing without inventing zeros", () => {
    const recorder = new TransportEvidenceRecorder(() => 2);
    recorder.init();
    recorder.initFramingTiming();
    const scope = recorder.beginNativeCallback("WebrtcDataChannel", recorder.receiveTimestamp(), true);
    recorder.logicalCompletion(PortalLinkType.COMMAND);
    recorder.finishNativeCallback(scope);
    const row = recorder.snapshot(false, false);
    const mutations = [
      (timing: NonNullable<typeof row.receiveTiming>) => {
        timing.sampledAtMicros = Number.NaN;
      },
      (timing: NonNullable<typeof row.receiveTiming>) => {
        timing.transportEpoch = -1;
      },
      (timing: NonNullable<typeof row.receiveTiming>) => {
        timing.framingEpoch = 9;
      },
      (timing: NonNullable<typeof row.receiveTiming>) => {
        timing.nativeCallbacks.command.latest!.entryMicros = Number.POSITIVE_INFINITY;
      },
      (timing: NonNullable<typeof row.receiveTiming>) => {
        timing.nativeCallbacks.command.latest!.sequence = 0;
      },
      (timing: NonNullable<typeof row.receiveTiming>) => {
        timing.nativeCallbacks.command.processing.lastMicros = 1;
      },
      (timing: NonNullable<typeof row.receiveTiming>) => {
        timing.logicalFrames.command!.callbackToFrameMicros = 8;
      },
      (timing: NonNullable<typeof row.receiveTiming>) => {
        timing.logicalFrames.command!.completionMicros = 3000;
      },
      (timing: NonNullable<typeof row.receiveTiming>) => {
        timing.logicalFrames.command!.source = null;
        timing.logicalFrames.command!.callbackToFrameMicros = 0;
      },
      (timing: NonNullable<typeof row.receiveTiming>) => {
        Object.defineProperty(timing, "nativeCallbacks", {
          get() {
            throw new Error("synthetic-accessor");
          },
        });
      },
    ];
    for (const mutate of mutations) {
      const malformed = recorder.snapshot(false, false).receiveTiming!;
      mutate(malformed);
      expect(copyRtcReceiveTimingDiagnostics(malformed)).toBeNull();
    }
    delete row.receiveTiming;
    expect(copyRtcTransportDiagnostics(row).receiveTiming).toBeNull();
    row.receiveTiming = recorder.snapshot(false, false).receiveTiming;
    row.transportEpoch = 2;
    expect(copyRtcTransportDiagnostics(row).receiveTiming).toBeNull();
    expect(copyRtcReceiveTimingDiagnostics(undefined)).toBeNull();
    expect(copyRtcReceiveTimingDiagnostics({})).toBeNull();
    Object.defineProperty(row, "receiveTiming", {
      get() {
        throw new Error("synthetic-outer-accessor");
      },
    });
    expect(copyRtcTransportDiagnostics(row).receiveTiming).toBeNull();
  });

  it("omits invalid or backwards clock samples without overwriting valid processing maxima", () => {
    let now: unknown = 1;
    const recorder = new TransportEvidenceRecorder(() => now as number);
    recorder.init();
    recorder.initFramingTiming();
    const first = recorder.beginNativeCallback("audio", recorder.receiveTimestamp(), true);
    now = 5;
    recorder.finishNativeCallback(first);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER, "6", 4]) {
      now = invalid;
      expect(recorder.receiveTimestamp()).toBeNull();
      const scope = recorder.beginNativeCallback("audio", recorder.receiveTimestamp(), true);
      recorder.logicalCompletion(PortalLinkType.LIVE);
      recorder.finishNativeCallback(scope);
      const timing = recorder.snapshot(false, false).receiveTiming!;
      expect(timing.nativeCallbacks.audio.latest).toBeNull();
      expect(timing.logicalFrames.media).toBeNull();
      expect(timing.nativeCallbacks.audio.processing).toEqual({ lastMicros: 4000, maxMicros: 4000, samples: 1 });
    }
    now = 6;
    const second = recorder.beginNativeCallback("audio", recorder.receiveTimestamp(), true);
    now = Number.NaN;
    recorder.finishNativeCallback(second);
    expect(recorder.snapshot(false, false).receiveTiming!.nativeCallbacks.audio.processing.samples).toBe(1);
  });

  it("never restores an old transport scope or attributes a replacement framer to an old callback", () => {
    let now = 1;
    const recorder = new TransportEvidenceRecorder(() => now);
    recorder.init();
    recorder.initFramingTiming();
    const old = recorder.beginNativeCallback("audio", recorder.receiveTimestamp(), true);
    recorder.initFramingTiming();
    now = 2;
    recorder.logicalCompletion(PortalLinkType.LIVE);
    expect(recorder.snapshot(false, false).receiveTiming!.logicalFrames.media!.source).toBeNull();
    recorder.init();
    recorder.initFramingTiming();
    const current = recorder.beginNativeCallback("video", recorder.receiveTimestamp(), true);
    now = 3;
    recorder.finishNativeCallback(old);
    recorder.logicalCompletion(PortalLinkType.LIVE);
    expect(recorder.snapshot(false, false).receiveTiming!.logicalFrames.media!.source).toEqual({
      role: "video",
      sequence: 1,
      entryMicros: 2000,
    });
    recorder.finishNativeCallback(current);
    now = 4;
    recorder.logicalCompletion(PortalLinkType.LIVE);
    expect(recorder.snapshot(false, false).receiveTiming!.logicalFrames.media!.source).toBeNull();
    expect(recorder.snapshot(false, false).receiveTiming!.nativeCallbacks.audio.processing.samples).toBe(0);
  });
});
