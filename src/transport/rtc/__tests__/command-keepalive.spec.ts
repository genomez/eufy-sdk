import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter, type RtcCommandRouterDeps } from "../command-router.js";
import { PORTAL_KEEPALIVE, PORTAL_KEEPALIVE_MS } from "../portal-keepalive.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";
import type { RtcSession } from "../session.js";

const SN = "T9000P0000000001";

/** Offline command session with synchronous raw echoes and complete information responses. */
class Session extends EventEmitter {
  isConnected = false;
  closed = false;
  closeCalls = 0;
  autoOpen = true;
  echo = true;
  rawResult: "sent" | "false" | "throw" = "sent";
  raw: Buffer[] = [];

  async connect(): Promise<void> {
    if (this.autoOpen) this.open();
  }

  open(): void {
    if (this.closed) return;
    this.isConnected = true;
    this.emit("connected");
  }

  sendRaw(packet: Buffer): boolean {
    if (this.rawResult === "throw") throw new Error("synthetic send failure");
    if (!this.isConnected || this.rawResult === "false") return false;
    this.raw.push(Buffer.from(packet));
    if (this.echo) this.emit("keepaliveEcho");
    return true;
  }

  sendCommand(packet: Buffer): boolean {
    if (!this.isConnected) return false;
    const h = parsePortalHeader(packet)!;
    this.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), Buffer.alloc(4)]),
      1,
    );
    if (h.commandId === 1103) {
      const body = Buffer.from('{"params":[]}');
      this.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 0, 0, 0), body]), 3);
    }
    return true;
  }

  close(): void {
    this.closeCalls++;
    if (this.closed) return;
    this.closed = true;
    this.isConnected = false;
    this.emit("close");
  }
}

const routers: RtcCommandRouter[] = [];

function setup(options: Partial<RtcCommandRouterDeps> = {}, configure?: (session: Session, index: number) => void) {
  const sessions: Session[] = [];
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "synthetic", userId: "synthetic-user" }),
    shard: () => "us-pr",
    accountName: () => "synthetic",
    findDevice: () => ({ sn: SN, model: "T9000", stationSn: SN }) as EufyDevice,
    idleCloseMs: 1_000_000,
    commandKeepaliveMs: PORTAL_KEEPALIVE_MS,
    createSession: () => {
      const session = new Session();
      configure?.(session, sessions.length);
      sessions.push(session);
      return session as unknown as RtcSession;
    },
    ...options,
  });
  routers.push(router);
  return { router, sessions };
}

describe("opt-in current command-session keepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    for (const router of routers.splice(0)) router.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([undefined, 0])("adds no timer, echo listener or raw send when disabled (%s)", async (interval) => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const { router, sessions } = setup({ commandKeepaliveMs: interval });
    expect(vi.getTimerCount()).toBe(0);
    await router.refreshInformation(SN);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS * 4);
    expect(intervals).not.toHaveBeenCalled();
    expect(sessions[0]!.raw).toEqual([]);
    expect(sessions[0]!.listenerCount("keepaliveEcho")).toBe(0);
    expect(router.getKeepaliveDiagnostics()).toEqual({
      enabled: false,
      sent: 0,
      echoed: 0,
      missedEchoDrops: 0,
      sendFailureDrops: 0,
      lastEchoAtMs: 0,
    });
  });

  it.each([-1, 1.5, NaN, Infinity, 999, 120_001, 2_147_483_648])(
    "rejects an invalid timer interval (%s)",
    (interval) => {
      expect(() => setup({ commandKeepaliveMs: interval })).toThrow(RangeError);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("sends exact raw bytes only at the interval, accepting synchronous echoes before the send returns", async () => {
    const { router, sessions } = setup();
    await router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS - 1);
    expect(sessions[0]!.raw).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions[0]!.raw).toEqual([PORTAL_KEEPALIVE]);
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS * 3);
    expect(sessions[0]!.raw).toHaveLength(4);
    expect(sessions[0]!.closed).toBe(false);
    expect(router.getKeepaliveDiagnostics()).toEqual({
      enabled: true,
      sent: 4,
      echoed: 4,
      missedEchoDrops: 0,
      sendFailureDrops: 0,
      lastEchoAtMs: PORTAL_KEEPALIVE_MS * 4,
    });
    router.getKeepaliveDiagnostics().sent = 100;
    expect(router.getKeepaliveDiagnostics().sent).toBe(4);
  });

  it("clears awaitingEcho on a later echo and ignores unsolicited or duplicate echoes", async () => {
    const { router, sessions } = setup({}, (session) => {
      session.echo = false;
    });
    await router.refreshInformation(SN);
    const session = sessions[0]!;
    session.emit("keepaliveEcho");
    expect(router.getKeepaliveDiagnostics().echoed).toBe(0);
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
    await vi.advanceTimersByTimeAsync(100);
    session.emit("keepaliveEcho");
    session.emit("keepaliveEcho");
    expect(router.getKeepaliveDiagnostics()).toMatchObject({ echoed: 1, lastEchoAtMs: 29_100 });
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS - 100);
    expect(session.raw).toHaveLength(2);
    expect(session.closed).toBe(false);
  });

  it("retires an unechoed generation exactly once without reconnecting until the next read", async () => {
    const { router, sessions } = setup({}, (session, index) => {
      session.echo = index !== 0;
    });
    await router.refreshInformation(SN);
    const original = sessions[0]!;
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
    expect(original.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
    expect(original.closeCalls).toBe(1);
    expect(original.listenerCount("keepaliveEcho")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    original.emit("keepaliveEcho");
    expect(original.raw).toHaveLength(1);
    expect(original.closeCalls).toBe(1);
    expect(sessions).toHaveLength(1);
    expect(router.getKeepaliveDiagnostics()).toMatchObject({
      sent: 1,
      echoed: 0,
      missedEchoDrops: 1,
      sendFailureDrops: 0,
      lastEchoAtMs: 0,
    });
    await router.refreshInformation(SN);
    expect(sessions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
    expect(sessions[1]!.raw).toHaveLength(1);
    expect(router.getKeepaliveDiagnostics()).toMatchObject({ sent: 2, echoed: 1, missedEchoDrops: 1 });
  });

  it.each(["false", "throw"] as const)(
    "retires a failed raw send (%s) once and permits the next read",
    async (failure) => {
      const { router, sessions } = setup({}, (session, index) => {
        if (index === 0) session.rawResult = failure;
      });
      await router.refreshInformation(SN);
      await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS * 4);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.closeCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(router.getKeepaliveDiagnostics()).toMatchObject({
        sent: 0,
        echoed: 0,
        missedEchoDrops: 0,
        sendFailureDrops: 1,
      });
      await router.refreshInformation(SN);
      expect(sessions).toHaveLength(2);
    },
  );

  it("moves the timer to the adopted replacement and starts its interval at adoption", async () => {
    const { router, sessions } = setup({ sessionRefreshMs: 60_000 });
    await router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.raw).toHaveLength(2);
    expect(sessions[0]!.closed).toBe(true);
    expect(sessions[0]!.listenerCount("keepaliveEcho")).toBe(0);
    expect(sessions[1]!.raw).toEqual([]);
    expect(router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 1, successes: 1, deferred: 0 });
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS - 1);
    expect(sessions[1]!.raw).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions[1]!.raw).toEqual([PORTAL_KEEPALIVE]);
    expect(sessions[0]!.raw).toHaveLength(2);
    expect(router.getKeepaliveDiagnostics()).toMatchObject({ sent: 3, echoed: 3 });
  });

  it("keeps candidates unarmed while connecting and while verified but waiting for existing leases", async () => {
    const { router, sessions } = setup({ sessionRefreshMs: 30_000, commandKeepaliveMs: 1_000 }, (session, index) => {
      if (index === 1) session.autoOpen = false;
    });
    await router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(30_000);
    const candidate = sessions[1]!;
    expect(candidate.listenerCount("keepaliveEcho")).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(candidate.raw).toEqual([]);
    const lease = await router.sessionFor(SN);
    candidate.open();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(candidate.raw).toEqual([]);
    expect(candidate.listenerCount("keepaliveEcho")).toBe(0);
    expect(sessions[0]!.closed).toBe(false);
    lease.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(candidate.raw).toEqual([PORTAL_KEEPALIVE]);
  });

  it("does not acquire leases or prevent the existing lease deferral from releasing renewal", async () => {
    const { router, sessions } = setup({ sessionRefreshMs: 30_000, commandKeepaliveMs: 1_000 });
    const lease = await router.sessionFor(SN);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.raw).toHaveLength(31);
    expect(router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 0, deferred: 1 });
    lease.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 1, successes: 1, deferred: 1 });
    expect(sessions[0]!.closed).toBe(true);
  });

  it("keeps the original alive beyond ten minutes after a replacement connect timeout", async () => {
    const { router, sessions } = setup({ sessionRefreshMs: 270_000 }, (session, index) => {
      if (index === 1) session.autoOpen = false;
    });
    await router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(610_000);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.closed).toBe(false);
    expect(sessions[0]!.raw).toHaveLength(21);
    expect(sessions[1]!.closed).toBe(true);
    expect(sessions[1]!.raw).toEqual([]);
    expect(router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 1, failures: 1 });
    expect(router.getKeepaliveDiagnostics()).toMatchObject({ sent: 21, echoed: 21, missedEchoDrops: 0 });
  });

  it.each(["idle", "remote", "router"])("clears keepalive timers and listeners on %s closure", async (reason) => {
    const { router, sessions } = setup({ idleCloseMs: 60_000 });
    await router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
    const session = sessions[0]!;
    if (reason === "idle") await vi.advanceTimersByTimeAsync(60_000 - PORTAL_KEEPALIVE_MS);
    else if (reason === "remote") session.close();
    else router.close();
    expect(session.closed).toBe(true);
    expect(session.listenerCount("keepaliveEcho")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const sent = session.raw.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.raw).toHaveLength(sent);
    expect(sessions).toHaveLength(1);
  });

  it("arms nothing when the router is closed during initial connection", async () => {
    const { router, sessions } = setup({}, (session) => {
      session.autoOpen = false;
    });
    const pending = router.refreshInformation(SN).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    router.close();
    expect(await pending).toBeInstanceOf(Error);
    sessions[0]!.open();
    await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS * 2);
    expect(sessions[0]!.raw).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
