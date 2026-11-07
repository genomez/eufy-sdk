import { afterEach, describe, expect, it, vi } from "vitest";
import type { RtcCommandRouter } from "../command-router.js";
import { normalizeRecordingRows } from "../recordings.js";
import { recordingFixture, row, scope, sent, station, control, cameras } from "./recordings-fixture.js";

const routers: RtcCommandRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) r.close();
  vi.restoreAllMocks();
});
type Internal = {
  sessions: Map<string, any>;
  lives: Map<string, unknown>;
  eventTableProbes: Map<string, unknown>;
  playbackProbes: Map<string, unknown>;
  playbackUnresolved: boolean;
  eventTableReplies: Map<string, unknown>;
  eventThumbReplies: Map<string, unknown>;
};
const internal = (router: RtcCommandRouter) => router as unknown as Internal;
async function fixture(extra: Record<string, unknown> = {}) {
  const f = await recordingFixture(extra);
  routers.push(f.router);
  return f;
}
const selector = (id = 1) => {
  const result = normalizeRecordingRows([row({ record_id: id, thumb_path: `/synthetic/cover-${id}.jpg` })], scope);
  if (result.status !== "ok") throw new Error("synthetic fixture invalid");
  return result.rows[0]!.coverSelector!;
};

describe("recording admission without station side effects", () => {
  it.each([false, true])("admits metadata two seconds after a cover, continuation %s", async (continuation) => {
    const f = await fixture();
    if (continuation) {
      const read = f.router.readRecordingCatalog(scope);
      await sent(f.session);
      f.session.table(
        Array.from({ length: 20 }, (_, i) => row({ record_id: 100 - i })),
        {
          version: "1",
          count: 20,
          start_id: 100,
          end_id: 81,
        },
      );
      expect((await read).status).toBe("ok");
      f.advance(5_000);
    }
    const selected = selector();
    const cover = f.router.readRecordingCover(scope, selected);
    await sent(f.session, continuation ? 2 : 1);
    f.session.notify({ file: selected.thumbPath, content: "/9j/2Q==" }, 1308);
    expect((await cover).status).toBe("ok");
    const opts = continuation ? { beforeRecordId: 81 } : {};
    f.advance(1_999);
    expect(await f.router.readRecordingCatalog(scope, opts)).toEqual({ status: "deferred", reason: "quiet_period" });
    f.advance(1);
    expect(await f.router.readRecordingCover(scope, selector(2))).toEqual({
      status: "deferred",
      reason: "quiet_period",
    });
    const catalog = f.router.readRecordingCatalog(scope, opts);
    await sent(f.session, continuation ? 3 : 2);
    f.session.table([row({ record_id: 80 })]);
    expect((await catalog).status).toBe("ok");
  });

  it("updates cover pacing atomically without weakening foreground or catalog quiet", async () => {
    const f = await fixture();
    expect(f.router.setRecordingPacing({ coverGapMs: 0, coverRatePerMinute: null, coverQuietMs: 0 })).toEqual({
      coverGapMs: 0,
      coverRatePerMinute: 0,
      coverQuietMs: 0,
    });
    for (let n = 1; n <= 8; n++) {
      const selected = selector(n);
      const read = f.router.readRecordingCover(scope, selected);
      await sent(f.session, n);
      f.session.notify({ file: selected.thumbPath, content: "/9j/2Q==" }, 1308);
      expect((await read).status).toBe("ok");
    }
    expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "deferred", reason: "quiet_period" });
    f.router.preemptRecordingReads(station);
    expect(await f.router.readRecordingCover(scope, selector(9))).toEqual({
      status: "deferred",
      reason: "quiet_period",
    });
    f.advance(2_000);
    f.router.setRecordingPacing({ coverRatePerMinute: 2 });
    expect(await f.router.readRecordingCover(scope, selector(9))).toEqual({
      status: "deferred",
      reason: "rate_limited",
    });
    expect(f.router.setRecordingPacing()).toEqual({ coverGapMs: 5_000, coverRatePerMinute: 6, coverQuietMs: 2_000 });
  });
  it("keeps the configurable cover quiet independent of the start gap", async () => {
    const f = await fixture();
    f.router.setRecordingPacing({ coverGapMs: 0, coverRatePerMinute: 0, coverQuietMs: 2_000 });
    f.session.accept = false;
    expect(await f.router.readRecordingCover(scope, selector())).toMatchObject({ reason: "send_refused" });
    expect(await f.router.readRecordingCover(scope, selector(2))).toEqual({
      status: "deferred",
      reason: "quiet_period",
    });
    f.advance(2_000);
    expect(await f.router.readRecordingCover(scope, selector(2))).toMatchObject({ reason: "send_refused" });
  });
  it.each([-1, NaN, Infinity, "0", undefined])("rejects invalid pacing %s atomically", async (value) => {
    const f = await fixture();
    expect(() => f.router.setRecordingPacing({ coverGapMs: 0, coverQuietMs: value } as never)).toThrow(TypeError);
    expect(f.router.setRecordingPacing({})).toEqual({ coverGapMs: 5_000, coverRatePerMinute: 6, coverQuietMs: 2_000 });
  });
  it("accepts large pacing values without low upper limits", async () => {
    const f = await fixture();
    expect(f.router.setRecordingPacing({ coverGapMs: 1e12, coverRatePerMinute: 1e9, coverQuietMs: 1e12 })).toEqual({
      coverGapMs: 1e12,
      coverRatePerMinute: 1e9,
      coverQuietMs: 1e12,
    });
    expect(() => f.router.setRecordingPacing({ coverRatePerMinute: 0.5 })).toThrow(TypeError);
  });
  it.each([
    [
      "information taint",
      (s: any) => {
        s.informationTainted = true;
      },
    ],
    [
      "missing qualified read",
      (s: any) => {
        s.lastInformationRead = undefined;
      },
    ],
    [
      "owner observation",
      (s: any) => {
        s.connectedAtMonotonicMs = performance.now();
      },
    ],
    [
      "lease",
      (s: any) => {
        s.leases++;
      },
    ],
    [
      "exchange",
      (s: any) => {
        s.pendingExchanges++;
      },
    ],
    [
      "replacement",
      (s: any) => {
        s.replacement = { controller: new AbortController() };
      },
    ],
    [
      "refresh pending",
      (s: any) => {
        s.refreshPending = true;
      },
    ],
    [
      "retry deadline",
      (s: any) => {
        s.refreshRetryAtMs = s.connectedAtMs + performance.now() - s.connectedAtMonotonicMs + 13_000;
      },
    ],
    [
      "busy cooldown deadline",
      (s: any) => {
        s.refreshBusyCooldownAtMs = s.connectedAtMs + performance.now() - s.connectedAtMonotonicMs + 12_999;
      },
    ],
  ] as const)("refuses %s with zero send", async (_name, mutate) => {
    const f = await fixture();
    f.router.setRecordingPacing({ coverGapMs: 0, coverQuietMs: 0, coverRatePerMinute: 0 });
    const s = internal(f.router).sessions.get(station);
    mutate(s);
    expect((await f.router.readRecordingCatalog(scope)).status).not.toBe("ok");
    expect(f.session.sent).toHaveLength(0);
  });
  it.each(["playback", "unresolved", "live", "probe"])(
    "refuses %s independently of an active feature",
    async (kind) => {
      const f = await fixture();
      f.router.setRecordingPacing({ coverGapMs: 0, coverQuietMs: 0, coverRatePerMinute: 0 });
      const i = internal(f.router);
      if (kind === "unresolved") i.playbackUnresolved = true;
      if (kind === "playback") i.playbackProbes.set(station, {});
      if (kind === "live") i.lives.set(station, {});
      if (kind === "probe") i.eventTableProbes.set(station, {});
      expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "deferred", reason: "busy" });
      expect(f.session.sent).toHaveLength(0);
      i.playbackProbes.clear();
      i.lives.clear();
      i.eventTableProbes.clear();
    },
  );
  it("refuses full combined issued-reply bookkeeping without discarding correlations", async () => {
    const f = await fixture();
    f.router.setRecordingPacing({ coverGapMs: 0, coverQuietMs: 0, coverRatePerMinute: 0 });
    const i = internal(f.router);
    const s = i.sessions.get(station);
    for (let n = 0; n < 8; n++) {
      i.eventTableReplies.set(String(n), { owner: s, expiresAtMs: Infinity });
      i.eventThumbReplies.set(String(n), { owner: s, expiresAtMs: Infinity });
    }
    expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "deferred", reason: "reply_capacity" });
    expect(i.eventTableReplies.size + i.eventThumbReplies.size).toBe(16);
  });
  it.each(["parent", "excluded", "station", "account", "key", "expanded"])(
    "refuses invalid %s scope with zero send",
    async (kind) => {
      const f = await fixture();
      f.router.setRecordingPacing({ coverGapMs: 0, coverQuietMs: 0, coverRatePerMinute: 0 });
      let input = scope;
      if (kind === "parent") f.devices.get(cameras[0]!)!.stationSn = "unbound";
      if (kind === "excluded") f.devices.get(cameras[0]!)!.name = "J Safe";
      if (kind === "station") f.devices.get(cameras[0]!)!.stationSn = "other";
      if (kind === "account") f.changeAccount();
      if (kind === "key") input = { ...scope, identityKey: new Uint8Array(31) };
      if (kind === "expanded") input = { ...scope, cameraSns: new Set([...cameras, "unknown"]) };
      expect((await f.router.readRecordingCatalog(input)).status).toBe("unavailable");
      expect(f.session.sent).toHaveLength(0);
    },
  );
  it.each([0, -1, 8001, 0.5, NaN, Infinity])("bounds the whole operation timeout %s", async (timeoutMs) => {
    const f = await fixture();
    expect(await f.router.readRecordingCatalog(scope, { timeoutMs })).toEqual({
      status: "unavailable",
      reason: "invalid_options",
    });
    expect(f.session.sent).toHaveLength(0);
  });
  it("checks the full eight-second renewal reserve even when the requested timeout is shorter", async () => {
    const f = await fixture({ sessionRefreshMs: 70_000 });
    expect(await f.router.readRecordingCatalog(scope, { timeoutMs: 1 })).toEqual({
      status: "deferred",
      reason: "renewal_due",
    });
    expect(f.session.sent).toHaveLength(0);
  });
  it("denies cached lifecycle, scheduled sweep, correction and report-refresh holds", async () => {
    const f = await fixture();
    f.forbid();
    expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "deferred", reason: "busy" });
    expect(f.session.sent).toHaveLength(0);
  });
  it("enforces sixty-second attempt spacing on failed attempts", async () => {
    const f = await fixture();
    f.session.accept = false;
    expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "unavailable", reason: "send_refused" });
    f.advance(2_000);
    expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "deferred", reason: "rate_limited" });
    f.advance(57_999);
    expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "deferred", reason: "rate_limited" });
    f.advance(1);
    expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "unavailable", reason: "send_refused" });
    expect(f.session.sent).toHaveLength(2);
  });
  it("admits a fresh catalog sixty seconds after a successful attempt", async () => {
    const f = await fixture();
    const read = f.router.readRecordingCatalog(scope);
    await sent(f.session);
    f.session.table([row()]);
    expect((await read).status).toBe("ok");
    f.advance(59_999);
    expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "deferred", reason: "rate_limited" });
    f.advance(1);
    f.session.accept = false;
    expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "unavailable", reason: "send_refused" });
    expect(f.session.sent).toHaveLength(2);
  });
});

describe("feature preemption and local release", () => {
  it("keeps a due report read admissible while the canceled optional lease is being released", async () => {
    const f = await fixture();
    const pending = f.router.readRecordingCatalog(scope);
    await sent(f.session);
    expect(f.router.informationRefreshReady(station)).toBe(false);
    f.router.preemptRecordingReads(station);
    expect(f.router.informationRefreshReady(station)).toBe(true);
    expect((await pending).status).not.toBe("ok");
  });
  it("foreground before the scheduler turn discards unsent feature work", async () => {
    const f = await fixture();
    const pending = f.router.readRecordingCatalog(scope);
    f.router.preemptRecordingReads(station);
    expect(await pending).toEqual({ status: "unavailable", reason: "aborted" });
    expect(f.session.sent).toHaveLength(0);
    expect(internal(f.router).sessions.get(station)).toMatchObject({ leases: 0, pendingExchanges: 0 });
  });
  it("foreground queued before send wins the idle-only recheck", async () => {
    const f = await fixture();
    const s = internal(f.router).sessions.get(station);
    const pending = f.router.readRecordingCatalog(scope);
    let release!: () => void;
    const ordinary = s.scheduler.enqueue({
      target: station,
      kind: "read",
      priority: "report",
      sendByMs: performance.now() + 1000,
      run: () =>
        new Promise<number>((resolve) => {
          release = () => resolve(7);
        }),
    });
    expect((await pending).status).not.toBe("ok");
    expect(f.session.sent).toHaveLength(0);
    await vi.waitFor(() => expect(release).toBeDefined(), { interval: 1 });
    release();
    expect(await ordinary).toBe(7);
    expect(f.session.sent).toHaveLength(0);
  });
  it.each(["command", "information", "queue", "cancel", "topology", "hold", "owner"])(
    "releases locally on %s and suppresses late replies",
    async (kind) => {
      const f = await fixture();
      const s = internal(f.router).sessions.get(station);
      const abort = new AbortController();
      const pending = f.router.readRecordingCatalog(scope, { signal: abort.signal });
      await sent(f.session);
      const startedAt = Date.now();
      let foreground: Promise<unknown> | undefined;
      if (kind === "command") foreground = f.router.dispatchCommand(station, control);
      if (kind === "information") foreground = f.router.refreshInformation(station);
      if (kind === "queue")
        foreground = s.scheduler.enqueue({
          target: station,
          kind: "write",
          sendByMs: performance.now() + 1000,
          run: async () => 1,
        });
      if (kind === "cancel") abort.abort();
      if (kind === "topology") f.changeTopology();
      if (kind === "hold") f.forbid();
      if (kind === "owner") f.changeAccount();
      expect((await pending).status).not.toBe("ok");
      await foreground;
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect(s.leases).toBe(0);
      expect(s.pendingExchanges).toBe(0);
      expect(s.informationTainted).toBeFalsy();
      expect(f.session.isConnected).toBe(true);
      f.onFrame.mockClear();
      f.session.table([row()]);
      expect(f.onFrame).not.toHaveBeenCalled();
      expect(f.router.getPlaybackSafetyDiagnostics()).toMatchObject({ unresolved: false, active: false });
    },
  );
  it("cover cancellation leaves its path reserved and late JPEG cannot satisfy a different event", async () => {
    const f = await fixture();
    const old = selector();
    const abort = new AbortController();
    const pending = f.router.readRecordingCover(scope, old, { signal: abort.signal });
    await sent(f.session);
    abort.abort();
    expect(await pending).toEqual({ status: "unavailable", reason: "aborted" });
    f.advance(5001);
    expect(await f.router.readRecordingCover(scope, old)).toEqual({ status: "deferred", reason: "selector_reserved" });
    const next = selector(2);
    const nextRead = f.router.readRecordingCover(scope, next);
    await sent(f.session, 2);
    f.session.notify({ file: old.thumbPath, content: "/9j/2Q==" }, 1308);
    f.session.notify({ file: next.thumbPath, content: "/9j/2Q==" }, 1308);
    expect(await nextRead).toMatchObject({ status: "ok" });
  });
  it("enforces post-cover gap and six attempts per sliding minute", async () => {
    const f = await fixture();
    for (let n = 1; n <= 6; n++) {
      const selected = selector(n);
      const read = f.router.readRecordingCover(scope, selected);
      await sent(f.session, n);
      f.session.notify({ file: selected.thumbPath, content: "/9j/2Q==" }, 1308);
      expect((await read).status).toBe("ok");
      expect(await f.router.readRecordingCatalog(scope)).toEqual({ status: "deferred", reason: "quiet_period" });
      f.advance(5001);
    }
    expect(await f.router.readRecordingCover(scope, selector(7))).toEqual({
      status: "deferred",
      reason: "rate_limited",
    });
    f.advance(60_000);
    const last = selector(7);
    const read = f.router.readRecordingCover(scope, last);
    await sent(f.session, 7);
    f.session.notify({ file: last.thumbPath, content: "/9j/2Q==" }, 1308);
    expect((await read).status).toBe("ok");
  });
  it("times out ACK-only reads with detached collectors and fixed errors", async () => {
    const f = await fixture();
    const baseline = f.session.listenerCount("commandData");
    const read = f.router.readRecordingCatalog(scope, { timeoutMs: 15 });
    await sent(f.session);
    expect(await read).toEqual({ status: "unavailable", reason: "timeout" });
    expect(f.session.listenerCount("commandData")).toBe(baseline);
    expect(internal(f.router).sessions.get(station)).toMatchObject({ leases: 0, pendingExchanges: 0 });
  });
});
