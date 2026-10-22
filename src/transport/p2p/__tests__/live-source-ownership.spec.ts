import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P2PCommandRouter, type SharedLiveOpts } from "../command-router.js";
import { RequestMessageType } from "../codec.js";
import type { LiveStream } from "../live-stream.js";
import { P2PSession } from "../p2p-session.js";
import type { SessionManager } from "../session-manager.js";
import type { SharedLiveSource } from "../shared-live-source.js";
import { FakeP2PSession } from "./live-source-fixtures.js";

const STATION = "synthetic-station";
const KEY = `${STATION}:0`;

function drainingRouter() {
  const socket = {
    send: vi.fn((_packet: Buffer, _port: number, _host: string, _done?: (error: Error | null) => void) => {}),
    close: vi.fn((done: () => void) => done()),
  };
  const oldSession = new P2PSession({ stationSn: STATION, p2pDid: "XXXXXXX-000000-XXXXX" });
  Object.assign(oldSession, {
    socket,
    connected: true,
    connectAddress: { host: "synthetic-peer.invalid", port: 1234 },
  });
  const nextSession = Object.assign(new FakeP2PSession(), { close: async () => {} });
  const router = new P2PCommandRouter({
    mega: {} as never,
    listDevices: () => [{ sn: STATION, stationSn: STATION, raw: {} }] as never,
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  });
  const internals = router as unknown as {
    manager: SessionManager;
    resolveSession: unknown;
    liveSources: Map<string, SharedLiveSource>;
    liveSourceOpts: Map<string, SharedLiveOpts>;
    liveSessionKeys: Map<string, string>;
  };
  internals.manager.register(STATION, oldSession);
  internals.resolveSession = async () => ({
    session: await internals.manager.acquire(STATION, async () => nextSession as unknown as P2PSession, STATION),
    parentSn: STATION,
    channel: 0,
    accountId: "",
    homeBaseAttached: false,
  });
  const finishEnd = (error: Error | null = null) => {
    const end = socket.send.mock.calls.find(([packet]) => packet.subarray(0, 2).equals(RequestMessageType.END));
    expect(end).toBeDefined();
    expect(end![3]).toBeTypeOf("function");
    end![3]!(error);
  };
  return { router, internals, oldSession, nextSession, socket, finishEnd };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("live source ownership during session close", () => {
  it("keeps a successor's session claim when an earlier media-session open fails", async () => {
    const { router, internals, nextSession } = drainingRouter();
    const pending = Promise.withResolvers<P2PSession>();
    const opening = router as unknown as { openMediaSession: () => Promise<P2PSession> };
    opening.openMediaSession = () => pending.promise;
    internals.manager.register(STATION, nextSession as unknown as P2PSession);
    internals.resolveSession = async () => ({
      session: nextSession,
      parentSn: STATION,
      channel: 0,
      accountId: "",
      homeBaseAttached: true,
    });
    internals.liveSessionKeys.set(`${STATION}:1`, STATION);
    try {
      const first = router.sharedLiveSourceFor(STATION, { keepAliveMs: 0 }, true);
      const failed = expect(first).rejects.toThrow("synthetic media open failure");
      await Promise.resolve();
      const opts = { keepAliveMs: 0 };
      const successor = await router.sharedLiveSourceFor(STATION, opts);
      successor.attach();
      pending.reject(new Error("synthetic media open failure"));
      await failed;
      expect(internals.liveSources.get(KEY)).toBe(successor);
      expect(internals.liveSourceOpts.get(KEY)).toBe(opts);
      expect(internals.liveSessionKeys.get(KEY)).toBe(STATION);
      expect(successor.consumerCount).toBe(1);
      expect(nextSession.stops).toEqual([]);
    } finally {
      await router.closeAll();
    }
  });

  it.each(["sent", "error", "timeout"])(
    "keeps a successor attached when a failed start's END completes by %s",
    async (completion) => {
      const { router, internals, oldSession, nextSession, socket, finishEnd } = drainingRouter();
      try {
        const first = await router.sharedLiveSourceFor(STATION, { keepAliveMs: 0 });
        first.attach().on("error", () => {});
        const firstStream = (first as unknown as { stream: LiveStream }).stream;
        firstStream.emit("error", new Error("synthetic start failure"));
        expect(first.state).toBe("stopped");
        expect(oldSession.isConnected).toBe(false);
        expect(internals.manager.get(STATION)).toBeUndefined();
        expect(socket.close).not.toHaveBeenCalled();

        const opts = { keepAliveMs: 0, lingerMs: 4321 };
        const successor = await router.sharedLiveSourceFor(STATION, opts);
        expect(successor).not.toBe(first);
        const consumer = successor.attach();
        const stopped = vi.fn();
        consumer.on("stop", stopped);
        const stream = (successor as unknown as { stream: LiveStream }).stream;
        const streamStopped = vi.fn();
        stream.on("stop", streamStopped);
        expect(nextSession.starts).toEqual([0]);
        await vi.advanceTimersByTimeAsync(249);
        expect(socket.close).not.toHaveBeenCalled();
        expect(successor.state).toBe("warming");

        if (completion === "timeout") await vi.advanceTimersByTimeAsync(1);
        else finishEnd(completion === "error" ? new Error("synthetic END failure") : null);
        await oldSession.close();
        await vi.advanceTimersByTimeAsync(0);

        expect(socket.close).toHaveBeenCalledTimes(1);
        expect(successor.state).toBe("warming");
        expect(successor.consumerCount).toBe(1);
        expect(stopped).not.toHaveBeenCalled();
        expect(streamStopped).not.toHaveBeenCalled();
        expect(nextSession.stops).toEqual([]);
        expect(nextSession.listenerCount("data")).toBe(1);
        expect(internals.liveSources.get(KEY)).toBe(successor);
        expect(internals.liveSourceOpts.get(KEY)).toBe(opts);
        expect(internals.liveSessionKeys.get(KEY)).toBe(STATION);
        expect(internals.manager.get(STATION)).toBe(nextSession);
        expect(await router.sharedLiveSourceFor(STATION, opts)).toBe(successor);
        const extra = successor.attach();
        extra.detach();
        expect(successor.consumerCount).toBe(1);
      } finally {
        await router.closeAll();
      }
    },
  );

  it.each(["close", "resolve"])("does not rewarm a successor acquired during %s", async (boundary) => {
    const { router, internals, oldSession, nextSession, finishEnd } = drainingRouter();
    try {
      const first = await router.sharedLiveSourceFor(STATION, { keepAliveMs: 0 });
      first.attach().on("error", () => {});
      oldSession.emit("liveStartUnacknowledged", 0);
      const resolveSession = internals.resolveSession as () => Promise<unknown>;
      const pending = Promise.withResolvers<unknown>();
      if (boundary === "resolve") {
        const resolve = vi
          .fn()
          .mockImplementationOnce(() => pending.promise)
          .mockImplementation(resolveSession);
        internals.resolveSession = resolve;
        finishEnd();
        await vi.advanceTimersByTimeAsync(0);
        expect(resolve).toHaveBeenCalledTimes(1);
      }
      first.dispose();
      const successor = await router.sharedLiveSourceFor(STATION, { keepAliveMs: 0 });
      successor.attach();
      const rewarm = vi.spyOn(successor, "rewarm");

      if (boundary === "close") finishEnd();
      else pending.resolve(await resolveSession());
      await oldSession.close();
      await vi.advanceTimersByTimeAsync(0);

      expect(rewarm).not.toHaveBeenCalled();
      expect(successor.state).toBe("warming");
      expect(nextSession.stops).toEqual([]);
    } finally {
      await router.closeAll();
    }
  });

  it("rewarms the original source when it still owns the replacement attempt", async () => {
    const { router, oldSession, nextSession, finishEnd } = drainingRouter();
    try {
      const source = await router.sharedLiveSourceFor(STATION, { keepAliveMs: 0 });
      source.attach().on("error", () => {});
      const rewarm = vi.spyOn(source, "rewarm");
      oldSession.emit("liveStartUnacknowledged", 0);

      finishEnd();
      await oldSession.close();
      await vi.advanceTimersByTimeAsync(0);

      expect(rewarm).toHaveBeenCalledTimes(1);
      expect(source.state).toBe("warming");
      expect(source.consumerCount).toBe(1);
      expect(nextSession.starts).toEqual([0]);
      expect(nextSession.stops).toEqual([]);
      expect(await router.sharedLiveSourceFor(STATION)).toBe(source);
    } finally {
      await router.closeAll();
    }
  });
});
