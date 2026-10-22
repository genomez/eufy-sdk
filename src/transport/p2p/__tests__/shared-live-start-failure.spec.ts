import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { LiveStreamStartError } from "../../../core/contracts.js";
import { LIVE_TRACE_MESSAGE, type LiveTrace } from "../live-trace.js";
import { LiveStream } from "../live-stream.js";
import type { P2PSession } from "../p2p-session.js";
import { SharedLiveSource } from "../shared-live-source.js";
import { FakeP2PSession, H264, p2pAudioFrame, streamFactory, unit, videoFrame } from "./live-source-fixtures.js";

/**
 * A live start that never delivers a frame is reported to consumers and the stream is torn down, but the
 * source is rebuildable in place — so the next attach builds another stream over the SAME underlying
 * session. When it is that session (or its per-device state) that has gone bad, every later attempt fails
 * the same way and only a client restart clears it. The source cannot fix that itself: it holds a stream
 * factory, not a session. It has to say that a start failed, so whoever owns the session can act.
 */
const frame = () => videoFrame(unit(H264.sps, H264.idr));

function mk(opts: Record<string, unknown> = {}) {
  const { makeStream, streams } = streamFactory();
  const debug = vi.fn();
  const onStartFailed = vi.fn();
  const onIdle = vi.fn();
  const onActive = vi.fn();
  const source = new SharedLiveSource({
    makeStream,
    warmRetryMs: 2000,
    warmTimeoutMs: 6000,
    lingerMs: 5000,
    onStartFailed,
    onActive,
    onIdle,
    logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...opts,
  });
  return { source, streams, onStartFailed, onActive, onIdle, debug };
}

function startFailures(debug: ReturnType<typeof vi.fn>) {
  return debug.mock.calls
    .filter(([message, trace]) => message === LIVE_TRACE_MESSAGE && trace.phase === "start-failed")
    .map(([, trace]) => trace as Extract<LiveTrace, { phase: "start-failed" }> & { source: string });
}

describe("SharedLiveSource — reporting a failed start", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports a failed start once the warm window elapses with no keyframe", () => {
    const { source, onStartFailed } = mk();
    const consumer = source.attach();
    const errors: Error[] = [];
    consumer.on("error", (e) => errors.push(e));

    vi.advanceTimersByTime(6000);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(LiveStreamStartError);
    expect(errors[0]).toMatchObject({
      reason: "warm-timeout",
      stage: "awaiting-first-frame",
      timeoutMs: 6000,
      attempts: 3,
    });
    expect(onStartFailed).toHaveBeenCalledTimes(1);
    expect(source.state).toBe("stopped");
  });

  it("keeps the warm-up bounded until a keyframe arrives", () => {
    const { source, onStartFailed, streams } = mk();
    const errors: Error[] = [];
    source.attach().on("error", (error) => errors.push(error));

    streams[0].video(videoFrame(unit(H264.delta), { keyframe: false }));
    vi.advanceTimersByTime(6000);

    expect(errors[0]).toMatchObject({
      reason: "warm-timeout",
      stage: "awaiting-keyframe",
      timeoutMs: 6000,
      attempts: 3,
    });
    expect(onStartFailed).toHaveBeenCalledTimes(1);
    expect(source.state).toBe("stopped");
  });

  /**
   * A camera that is switched off keeps its session, takes the media start, and streams audio for the
   * whole window without ever sending a video frame — measured on a mains-powered own-session camera
   * whose reported enablement was off, and which streamed 217 video access units once it was on. That
   * outcome is indistinguishable from a dead transport under one `awaiting-first-frame` stage, so the two
   * are staged apart: `audio-only` says the source answered and has no picture to give.
   */
  it("stages a start that carried audio but never a video frame apart from a silent one", () => {
    const { source, streams } = mk();
    const errors: Error[] = [];
    source.attach().on("error", (error) => errors.push(error));

    streams[0].audio();
    streams[0].audio();
    vi.advanceTimersByTime(6000);

    expect(errors[0]).toMatchObject({ reason: "warm-timeout", stage: "audio-only" });
  });

  it("stages a source that delivered nothing at all as awaiting-first-frame, not audio-only", () => {
    const { source } = mk();
    const errors: Error[] = [];
    source.attach().on("error", (error) => errors.push(error));

    vi.advanceTimersByTime(6000);

    expect(errors[0]).toMatchObject({ stage: "awaiting-first-frame" });
  });

  /** Video is the stage that matters once it arrives: audio alongside it never downgrades the answer. */
  it("prefers the video stage over audio-only when both arrived", () => {
    const { source, streams } = mk();
    const errors: Error[] = [];
    source.attach().on("error", (error) => errors.push(error));

    streams[0].audio();
    streams[0].video(videoFrame(unit(H264.delta), { keyframe: false }));
    vi.advanceTimersByTime(6000);

    expect(errors[0]).toMatchObject({ stage: "awaiting-keyframe" });
  });

  /** Each warm generation is staged on its own evidence — the previous stream's audio is not carried in. */
  it("does not carry a previous generation's audio into the next start's stage", () => {
    const { source, streams } = mk();
    source.attach().on("error", () => {});
    streams[0].audio();
    vi.advanceTimersByTime(6000);

    const errors: Error[] = [];
    source.attach().on("error", (error) => errors.push(error));
    vi.advanceTimersByTime(6000);

    expect(errors[0]).toMatchObject({ stage: "awaiting-first-frame" });
  });

  it("counts one attempt per media start actually issued", () => {
    const { source, streams } = mk({ warmRetryMs: 2000, warmTimeoutMs: 5000 });
    const errors: Error[] = [];
    source.attach().on("error", (error) => errors.push(error));

    vi.advanceTimersByTime(5000);

    expect(streams[0].nudged).toBe(2);
    expect(errors[0]).toMatchObject({ attempts: 3 });
  });

  it("tells consumers before reporting it, so the report can dispose the source", () => {
    const order: string[] = [];
    const { source } = mk({ onStartFailed: () => order.push("reported") });
    source.attach().on("error", () => order.push("consumer"));

    vi.advanceTimersByTime(6000);

    expect(order).toEqual(["consumer", "reported"]);
  });

  it("reports a start the CALLER gave up on before the deadline — the deadline is then cancelled", () => {
    const { source, onStartFailed } = mk();
    const consumer = source.attach();

    consumer.detach();
    vi.advanceTimersByTime(5000);

    expect(source.state).toBe("stopped");
    expect(onStartFailed).toHaveBeenCalledTimes(1);
  });

  it("reports an upstream error that arrives before the first keyframe", () => {
    const { source, onStartFailed, streams } = mk();
    const errors: Error[] = [];
    source.attach().on("error", (error) => errors.push(error));
    const cause = new Error("upstream gone");

    streams[0].emit("error", cause);

    expect(errors[0]).toMatchObject({ reason: "source-error", cause });
    expect(onStartFailed).toHaveBeenCalledTimes(1);
  });

  it("reports an upstream stop that arrives before the first keyframe", () => {
    const { source, onStartFailed, streams } = mk();
    const errors: Error[] = [];
    source.attach().on("error", (error) => errors.push(error));

    streams[0].emit("stop");

    expect(errors[0]).toMatchObject({ reason: "source-ended", stage: "awaiting-first-frame" });
    expect(onStartFailed).toHaveBeenCalledTimes(1);
  });

  it("explains an upstream stop before the first keyframe, then closes the consumer", () => {
    const { source, streams } = mk();
    const signals: string[] = [];
    const consumer = source.attach();
    consumer.on("error", (error) => signals.push(`error:${(error as LiveStreamStartError).reason}`));
    consumer.on("stop", () => signals.push("stop"));

    streams[0].emit("stop");

    expect(signals).toEqual(["error:source-ended", "stop"]);
  });

  it("reports it exactly once, though stopping the stream re-enters teardown", () => {
    const { source, onStartFailed, streams } = mk();
    source.attach().on("error", () => {});

    vi.advanceTimersByTimeAsync(6000);
    vi.advanceTimersByTime(6000);

    expect(streams[0].stopped).toBe(1);
    expect(onStartFailed).toHaveBeenCalledTimes(1);
  });

  it("reports it exactly once, not again from a later timer", () => {
    const { source, onStartFailed } = mk();
    source.attach().on("error", () => {});

    vi.advanceTimersByTime(6000);
    vi.advanceTimersByTime(20000);

    expect(onStartFailed).toHaveBeenCalledTimes(1);
  });

  it("does NOT report an ordinary linger teardown — nothing failed there", () => {
    const { source, onStartFailed, streams } = mk();
    const consumer = source.attach();
    streams[0].video(frame());
    consumer.detach();

    vi.advanceTimersByTime(5000);

    expect(source.state).toBe("stopped");
    expect(onStartFailed).not.toHaveBeenCalled();
  });

  it("does NOT report a rebuilt stream's health against the previous one's failure", () => {
    const { source, onStartFailed, streams } = mk();
    source.attach().on("error", () => {});
    vi.advanceTimersByTime(6000);
    expect(onStartFailed).toHaveBeenCalledTimes(1);

    const revived = source.attach();
    streams[1].video(frame());
    revived.detach();
    vi.advanceTimersByTime(5000);

    expect(onStartFailed).toHaveBeenCalledTimes(1);
  });

  it("does NOT report an upstream stop after a healthy start", () => {
    const { source, onStartFailed, streams } = mk();
    source.attach();
    streams[0].video(frame());

    streams[0].emit("stop");

    expect(onStartFailed).not.toHaveBeenCalled();
  });

  it("does NOT report a caller's own dispose", () => {
    const { source, onStartFailed, streams } = mk();
    source.attach();
    streams[0].video(frame());

    source.dispose();

    expect(onStartFailed).not.toHaveBeenCalled();
  });

  it("closes a consumer that never listened for errors, and every consumer behind it", () => {
    const { source, streams, onStartFailed } = mk();
    const silent = source.attach();
    const watching = source.attach();
    const signals: string[] = [];
    silent.on("stop", () => signals.push("silent:stop"));
    watching.on("error", () => signals.push("watching:error"));
    watching.on("stop", () => signals.push("watching:stop"));

    streams[0].emit("stop");

    expect(signals).toEqual(["watching:error", "silent:stop", "watching:stop"]);
    expect(source.state).toBe("stopped");
    expect(streams[0].stopped).toBe(1);
    expect(onStartFailed).toHaveBeenCalledTimes(1);
  });

  it("tears the stream down even when a consumer's listener throws", () => {
    const { source, streams, onStartFailed } = mk();
    source.attach().on("error", () => {
      throw new Error("consumer listener");
    });

    expect(() => streams[0].emit("error", new Error("upstream gone"))).toThrow("consumer listener");

    expect(source.state).toBe("stopped");
    expect(streams[0].stopped).toBe(1);
    expect(onStartFailed).toHaveBeenCalledTimes(1);
  });

  it("releases the session user when disposed while consumers are still attached", () => {
    const { source, onActive, onIdle, streams } = mk();
    source.attach();
    streams[0].video(frame());
    expect(onActive).toHaveBeenCalledTimes(1);
    expect(onIdle).not.toHaveBeenCalled();

    source.dispose();

    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does not release a session user it never took", () => {
    const { source, onIdle } = mk();
    source.dispose();
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe("SharedLiveSource — bounded failed-start traces", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const reason of ["warm-timeout", "source-error", "source-ended"] as const) {
    it.each(["awaiting-first-frame", "audio-only", "awaiting-keyframe"] as const)(
      `traces ${reason} at %s once for all consumers`,
      (stage) => {
        const { source, streams, debug, onStartFailed } = mk({ label: "T8000P0000000000:2" });
        const failures: Error[] = [];
        source.attach().on("error", (error) => failures.push(error));
        source.attach().on("error", (error) => failures.push(error));
        if (stage !== "awaiting-first-frame") streams[0].audio();
        if (stage === "awaiting-keyframe") {
          streams[0].video(videoFrame(unit(H264.delta), { keyframe: false }));
        }
        const cause = new TypeError("synthetic upstream detail", { cause: new Error("synthetic nested detail") });

        if (reason === "warm-timeout") vi.advanceTimersByTime(6000);
        else if (reason === "source-error") streams[0].emit("error", cause);
        else streams[0].emit("stop");
        vi.advanceTimersByTime(20000);

        expect(failures).toHaveLength(2);
        expect(failures[0]).toBeInstanceOf(LiveStreamStartError);
        expect(failures[1]).toBe(failures[0]);
        expect(failures[0]).toMatchObject({ reason, stage, timeoutMs: 6000 });
        expect(failures[0].cause).toBe(reason === "source-error" ? cause : undefined);
        expect(startFailures(debug)).toEqual([
          {
            phase: "start-failed",
            reason,
            stage,
            attempts: reason === "warm-timeout" ? 3 : 1,
            ...(reason === "source-error" ? { errorName: "TypeError" } : {}),
            source: expect.stringMatching(/^pull-\d+$/),
          },
        ]);
        expect(JSON.stringify(startFailures(debug))).not.toMatch(/synthetic|T8000P0000000000/);
        expect(streams[0].stopped).toBe(1);
        expect(onStartFailed).toHaveBeenCalledTimes(1);
        expect(source.state).toBe("stopped");
      },
    );
  }

  it.each([
    new Error("synthetic detail"),
    new EvalError("synthetic detail"),
    new RangeError("synthetic detail"),
    new ReferenceError("synthetic detail"),
    new SyntaxError("synthetic detail"),
    new TypeError("synthetic detail"),
    new URIError("synthetic detail"),
    new AggregateError([], "synthetic detail"),
  ])("retains the standard name $name without its message", (cause) => {
    const { source, streams, debug } = mk();
    source.attach();

    streams[0].emit("error", cause);

    expect(startFailures(debug)).toHaveLength(1);
    expect(startFailures(debug)[0].errorName).toBe(cause.name);
    expect(JSON.stringify(startFailures(debug))).not.toContain("synthetic detail");
  });

  it.each(["CustomTransportError", "T8000P0000000000:<cam-lan-ip>", "TypeError\nsynthetic secret", "", "toString"])(
    "omits arbitrary upstream name %j while preserving the cause",
    (name) => {
      const { source, streams, debug } = mk();
      const cause = new Error("synthetic detail");
      cause.name = name;
      const failures: Error[] = [];
      source.attach().on("error", (error) => failures.push(error));

      streams[0].emit("error", cause);

      expect(startFailures(debug)).toHaveLength(1);
      expect(startFailures(debug)[0]).not.toHaveProperty("errorName");
      expect(failures[0].cause).toBe(cause);
    },
  );

  it("does not invoke an upstream name accessor", () => {
    const { source, streams, debug } = mk();
    const cause = new Error("synthetic detail");
    const name = vi.fn(() => {
      throw new Error("synthetic accessor detail");
    });
    Object.defineProperty(cause, "name", { get: name });
    const failures: Error[] = [];
    source.attach().on("error", (error) => failures.push(error));

    expect(() => streams[0].emit("error", cause)).not.toThrow();

    expect(name).not.toHaveBeenCalled();
    expect(startFailures(debug)[0]).not.toHaveProperty("errorName");
    expect(failures[0].cause).toBe(cause);
    expect(source.state).toBe("stopped");
  });

  it("omits a subclass's arbitrary prototype name", () => {
    class CustomError extends Error {}
    Object.defineProperty(CustomError.prototype, "name", { value: "synthetic custom detail" });
    const { source, streams, debug } = mk();
    source.attach();

    streams[0].emit("error", new CustomError("synthetic detail"));

    expect(startFailures(debug)[0]).not.toHaveProperty("errorName");
  });

  it("resets attempts and stage on a rebuilt source while retaining the source handle", () => {
    const { source, streams, debug } = mk();
    source.attach();
    streams[0].audio();
    vi.advanceTimersByTime(6000);
    source.attach();
    streams[1].emit("stop");

    expect(startFailures(debug)).toMatchObject([
      { reason: "warm-timeout", stage: "audio-only", attempts: 3 },
      { reason: "source-ended", stage: "awaiting-first-frame", attempts: 1 },
    ]);
    expect(startFailures(debug)[1].source).toBe(startFailures(debug)[0].source);
  });

  it("leaves healthy-stream errors unchanged and emits no start failure", () => {
    const { source, streams, debug } = mk();
    const failures: Error[] = [];
    source.attach().on("error", (error) => failures.push(error));
    streams[0].video(frame());
    const cause = new TypeError("synthetic detail");

    streams[0].emit("error", cause);
    vi.advanceTimersByTime(20000);

    expect(failures).toEqual([cause]);
    expect(failures[0]).toBe(cause);
    expect(startFailures(debug)).toEqual([]);
  });

  it("emits no failure for a caller disposing a warming source", () => {
    const { source, debug } = mk();
    source.attach();

    source.dispose();
    vi.advanceTimersByTime(20000);

    expect(startFailures(debug)).toEqual([]);
  });

  it.each([false, true])(
    "traces real P2P stream timeout with attached=%s and unchanged retry count",
    (homeBaseAttached) => {
      const session = new FakeP2PSession();
      const debug = vi.fn();
      const source = new SharedLiveSource({
        makeStream: () =>
          new LiveStream(session as unknown as P2PSession, {
            channel: 2,
            homeBaseAttached,
            keepAliveMs: 0,
          }),
        warmRetryMs: 2000,
        warmTimeoutMs: 6000,
        logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const failures: Error[] = [];
      source.attach().on("error", (error) => failures.push(error));
      session.push(p2pAudioFrame(0, Buffer.alloc(8), 2));

      vi.advanceTimersByTime(6000);

      expect(startFailures(debug)).toEqual([
        {
          phase: "start-failed",
          reason: "warm-timeout",
          stage: "audio-only",
          attempts: 3,
          source: expect.stringMatching(/^pull-\d+$/),
        },
      ]);
      expect(failures[0]).toMatchObject({ reason: "warm-timeout", stage: "audio-only", attempts: 3 });
      expect(session.starts).toEqual([2, 2, 2]);
      expect(session.stops).toEqual([2]);
      expect(session.listenerCount("data")).toBe(0);
      expect(session.listenerCount("liveStartUnacknowledged")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
