import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { LiveStream } from "../live-stream.js";
import type { P2PSession } from "../p2p-session.js";
import { SharedLiveSource } from "../shared-live-source.js";
import { H264, streamFactory, unit, videoFrame } from "./live-source-fixtures.js";

/**
 * A re-issue on a stream that has delivered NOTHING is a start, not a keepalive.
 *
 * On an own-session camera the two differ: a keepalive (1139) holds a stream the station is already serving,
 * and by this session's own account "holds a stream that was never started and cannot begin one". The station
 * is only told to stream by a real start, and the session sends one only while it does not believe the channel
 * is already started.
 *
 * That belief outlives the evidence for it. Measured on a standalone battery camera: a start acknowledged with
 * no media, the source left lingering with its stream open, and the next attempt inside that linger window
 * re-issuing four keepalives and no start at all — nothing arrived, and only a session rebuilt after the
 * deadline recovered it. Three attempts, then a fourth that worked, with the same request.
 *
 * The source holds the evidence: nothing delivered means the station is not serving this channel, whatever the
 * session believes. So a re-issue forces a start until media arrives, and keeps the keepalive afterwards —
 * which is what the keepalive is for, and why an attached camera, whose start has no keepalive form at all,
 * is unaffected either way.
 */
class FakeSession extends EventEmitter {
  readonly sent: string[] = [];
  /** Whether a start for this channel is still awaiting acknowledgement. */
  outstanding = false;
  private started = false;

  startLiveMedia(_channel: number, _accountId?: string, _attached?: boolean, opts?: { force?: boolean }): void {
    if (opts?.force && this.outstanding) return;
    if (opts?.force) this.started = false;
    this.sent.push(this.started ? "keepalive" : "start");
    this.started = true;
  }

  stopLiveMedia(): void {
    this.started = false;
  }
}

const keyframe = () => videoFrame(unit(H264.sps, H264.pps, H264.idr), { keyframe: true });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a re-issue on an own-session stream", () => {
  it("is a start where nothing has been delivered, the station not having been told to stream", () => {
    const session = new FakeSession();
    const stream = new LiveStream(session as unknown as P2PSession, {
      channel: 0,
      keepAliveMs: 0,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }).start();

    stream.nudge(true);
    stream.nudge(true);

    expect(session.sent).toEqual(["start", "start", "start"]);
    stream.stop();
  });

  it("is a keepalive once media has arrived, which is what a keepalive holds", () => {
    const session = new FakeSession();
    const stream = new LiveStream(session as unknown as P2PSession, {
      channel: 0,
      keepAliveMs: 0,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }).start();

    stream.nudge();
    stream.nudge();

    expect(session.sent).toEqual(["start", "keepalive", "keepalive"]);
    stream.stop();
  });
});

describe("a warming source with nothing delivered", () => {
  it("forces its re-issue, so a reused stream the station never served is started rather than held", async () => {
    const { makeStream, streams } = streamFactory();
    const src = new SharedLiveSource({
      makeStream,
      warmRetryMs: 20,
      warmTimeoutMs: 5_000,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    src.attach().on("error", () => undefined);
    await settle(70);

    expect(streams[0]!.forced).toBeGreaterThan(0);
  });

  it("stops forcing once media has arrived", async () => {
    const { makeStream, streams } = streamFactory();
    const src = new SharedLiveSource({
      makeStream,
      warmRetryMs: 20,
      warmTimeoutMs: 5_000,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const consumer = src.attach();
    consumer.on("error", () => undefined);
    consumer.on("video", () => undefined);
    streams[0]!.video(keyframe());
    const forcedAtDelivery = streams[0]!.forced;
    await settle(70);

    expect(streams[0]!.forced).toBe(forcedAtDelivery);
  });
});

/**
 * A REUSED stream is held, not restarted: the station is serving it, whatever this consumer has yet to see.
 *
 * The watch a join arms resets what the SOURCE has been delivered, because the join is what must be proven
 * still served. That is not evidence about the station: a healthy stream mid-group-of-pictures has delivered
 * plenty and the new consumer simply has not seen it yet. Forcing a start there restarts a working stream —
 * measured on a wired camera as 203/211/211/211 frames becoming 202/15/1/1, the last timing out.
 *
 * So the force is conditioned on what the CURRENT upstream stream has ever delivered, which only a fresh
 * `warm` resets.
 */
describe("a reused stream whose upstream has delivered", () => {
  /**
   * A reuse cannot know yet whether the station is still serving, so its FIRST re-issue is a keepalive: that is
   * correct where it is, and harmless where it is not. Only when a second is due with nothing having arrived
   * since the join is the answer in — no new bound, the retry's own cadence.
   */
  it("is held rather than restarted, however little this consumer has seen", async () => {
    const { makeStream, streams } = streamFactory();
    const src = new SharedLiveSource({
      makeStream,
      lingerMs: 5_000,
      warmRetryMs: 20,
      warmTimeoutMs: 5_000,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const first = src.attach();
    first.on("video", () => undefined);
    streams[0]!.video(keyframe());
    first.detach();

    const rejoined = src.attach();
    rejoined.on("error", () => undefined);
    rejoined.on("video", () => undefined);
    const forcedAtJoin = streams[0]!.forced;
    // Still being served means frames keep arriving, which is the only thing that says so.
    for (let tick = 0; tick < 4; tick++) {
      streams[0]!.video(videoFrame(unit(H264.delta), { keyframe: false }));
      await settle(25);
    }

    expect(streams[0]!.forced).toBe(forcedAtJoin);
    rejoined.detach();
  });
});

/**
 * A forced start yields to one already awaiting acknowledgement, instead of replacing it.
 *
 * The session retains a start and repeats it byte-identically every 150 ms, abandoning it at 3 s — and an
 * abandonment is what tells a source the session is not being heard. A re-issue every 2 s replaces that start
 * with a new sequence before it can reach its deadline, so the abandonment never fires and the recovery it
 * triggers never runs: measured as 7 starts, 89 retransmits, no acknowledgement and no abandonment, ending in
 * the full warm-up timeout.
 *
 * Retransmitting is already exactly the work a forced re-issue wants done, so while a start is outstanding the
 * re-issue does nothing and lets it reach its answer either way.
 */
describe("a forced start while one is outstanding", () => {
  it("does not replace it, so the abandonment that recovers the session can fire", () => {
    const session = new FakeSession();
    const stream = new LiveStream(session as unknown as P2PSession, {
      channel: 0,
      keepAliveMs: 0,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }).start();

    session.outstanding = true;
    stream.nudge(true);
    stream.nudge(true);

    expect(session.sent).toEqual(["start"]);
    stream.stop();
  });
});

/**
 * A reused stream the station has STOPPED serving is started again, after one keepalive has proved fruitless.
 *
 * Its upstream delivered plenty before, so what it delivered is no evidence about now; the retained keyframe
 * replayed to the joining consumer is not either. What settles it is a frame arriving AFTER the join, and its
 * absence across one re-issue interval — measured on a wired camera as eleven keepalives, no start, and one
 * frame in fourteen seconds, ending in the warm-up timeout.
 */
describe("a reused stream the station stopped serving", () => {
  it("forces a start on the second re-issue, the first keepalive having produced nothing", async () => {
    const { makeStream, streams } = streamFactory();
    const src = new SharedLiveSource({
      makeStream,
      lingerMs: 5_000,
      warmRetryMs: 25,
      warmTimeoutMs: 5_000,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const first = src.attach();
    first.on("video", () => undefined);
    streams[0]!.video(keyframe());
    first.detach();

    const rejoined = src.attach();
    rejoined.on("error", () => undefined);
    rejoined.on("video", () => undefined);
    await settle(35);
    const afterFirst = streams[0]!.forced;
    await settle(60);

    expect(afterFirst, "the first re-issue holds").toBe(0);
    expect(streams[0]!.forced, "a later one starts").toBeGreaterThan(0);
    rejoined.detach();
  });
});
