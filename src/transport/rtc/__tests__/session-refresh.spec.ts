import { consumeRetiredInformationRead } from "../retired-information-read.js";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter } from "../command-router.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";
import type { RtcSession, RtcSessionOptions } from "../session.js";

const SN = "T9000P0000000001";
class Session extends EventEmitter {
  isConnected = false;
  closed = false;
  autoOpen = true;
  answer = true;
  ackOnly = false;
  sends = 0;
  lastSegment = 0;
  constructor(readonly options: RtcSessionOptions) {
    super();
  }
  async connect() {
    if (this.autoOpen) this.open();
  }
  open() {
    if (!this.closed) {
      this.isConnected = true;
      this.emit("connected");
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.isConnected = false;
      this.emit("close");
    }
  }
  sendCommand(packet: Buffer) {
    if (!this.isConnected) return false;
    this.sends++;
    this.lastSegment = parsePortalHeader(packet)!.segment;
    if (this.answer) {
      const h = parsePortalHeader(packet)!;
      this.emit(
        "commandData",
        Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), Buffer.alloc(4)]),
        1,
      );
      if (this.ackOnly) return true;
      const body = Buffer.from('{"params":[]}');
      this.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 0, 0, 0), body]), 3);
    }
    return true;
  }
}
function setup(options: { enabled?: boolean; idle?: number; configure?: (s: Session, index: number) => void } = {}) {
  const sessions: Session[] = [];
  const onFrame = vi.fn();
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "synthetic", userId: "synthetic-user" }),
    shard: () => "us-pr",
    accountName: () => "synthetic",
    findDevice: () => ({ sn: SN, model: "T9000", stationSn: SN }) as EufyDevice,
    sessionRefreshMs: options.enabled === false ? 0 : 270_000,
    idleCloseMs: options.idle ?? 1_000_000,
    connectTimeoutMs: 12_000,
    onFrame,
    createSession: (o) => {
      const s = new Session(o);
      options.configure?.(s, sessions.length);
      sessions.push(s);
      return s as unknown as RtcSession;
    },
  });
  return { router, sessions, onFrame };
}
const tick = () => vi.advanceTimersByTimeAsync(0);
async function open(router: RtcCommandRouter) {
  const lease = await router.sessionFor(SN);
  lease.release();
}

describe("bounded proactive RTC session replacement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])("marks only a retired timed-out read (other lease: %s)", async (held) => {
    const { router, sessions } = setup({ enabled: false });
    await open(router);
    const other = held ? await router.sessionFor(SN) : undefined;
    sessions[0]!.answer = false;
    const read = router.refreshInformation(SN).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(8_000);
    const error = await read;
    expect(error).toBeInstanceOf(Error);
    expect(consumeRetiredInformationRead(error)).toBe(!held);
    expect(consumeRetiredInformationRead(error)).toBe(false);
    expect(sessions[0]!.closed).toBe(!held);
    other?.release();
    expect(sessions[0]!.closed).toBe(true);
    expect(consumeRetiredInformationRead(error)).toBe(false);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not grant retirement proof after caller cancellation", async () => {
    const { router, sessions } = setup({ enabled: false });
    await open(router);
    sessions[0]!.answer = false;
    const abort = new AbortController();
    const read = router.refreshInformation(SN, { signal: abort.signal }).catch((e: unknown) => e);
    await tick();
    abort.abort(new Error("RTC information response timed out"));
    const error = await read;
    expect(consumeRetiredInformationRead(error)).toBe(false);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is opt-in and leaves an idle-close-only session unchanged", async () => {
    const { router, sessions } = setup({ enabled: false });
    await open(router);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(sessions).toHaveLength(1);
    expect(router.getSessionRefreshDiagnostics().attempts).toBe(0);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("verifies an early ACK and information before adopting, then retires only the old generation", async () => {
    const { router, sessions, onFrame } = setup();
    await open(router);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.closed).toBe(true);
    expect(sessions[1]!.closed).toBe(false);
    expect(sessions[1]!.sends).toBe(1);
    expect(sessions[1]!.options.maxCallRetries).toBe(0);
    expect(router.getSessionRefreshDiagnostics()).toMatchObject({
      attempts: 1,
      successes: 1,
      failures: 0,
      lastSessionAgeMs: 270_000,
      lastOutcome: "success",
    });
    expect(router.getSessionRefreshDiagnostics().lastAttempt).toMatchObject({
      originalSessionGeneration: 1,
      candidateSessionGeneration: 2,
      candidateInformationReceivedAtMs: 270_000,
      adoptedAtMs: 270_000,
      phase: "adoption",
      outcome: "success",
      failure: null,
      informationVerified: true,
    });
    expect(router.getReadDiagnostics().recent[0]).toMatchObject({
      purpose: "replacement",
      sessionGeneration: 2,
      informationReceivedAtMs: 270_000,
      currentAtArrival: false,
    });
    expect(onFrame).not.toHaveBeenCalled();
    const lease = await router.sessionFor(SN);
    expect(lease.session).toBe(sessions[1]);
    lease.release();
    sessions[0]!.emit("close");
    const again = await router.sessionFor(SN);
    expect(again.session).toBe(sessions[1]);
    again.release();
    await router.dispatchCommand(SN, { kind: "set-json", param: 1400, data: { value: 0 }, channel: 255 });
    expect(router.getCommandDiagnostics().recent[0]).toMatchObject({
      sessionGeneration: 2,
      expectedSegment: 2,
      expectedChannel: 255,
      outcome: "success",
    });
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the original after a silent candidate and performs no automatic write replay or repeated replacement", async () => {
    const { router, sessions } = setup({
      configure: (s, index) => {
        if (index) s.answer = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(278_000);
    expect(sessions[0]!.closed).toBe(false);
    expect(sessions[1]!.closed).toBe(true);
    expect(sessions[0]!.sends).toBe(0);
    expect(sessions[1]!.sends).toBe(1);
    expect(router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 1, failures: 1, lastOutcome: "failed" });
    expect(router.getSessionRefreshDiagnostics().lastFailure).toMatchObject({
      originalSessionGeneration: 1,
      candidateSessionGeneration: 2,
      candidateInformationReceivedAtMs: null,
      adoptedAtMs: null,
      phase: "information",
      failure: "information_timeout",
      candidateConnected: true,
      informationVerified: false,
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sessions).toHaveLength(2);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a candidate that never connects and retains the original", async () => {
    const { router, sessions } = setup({
      configure: (s, index) => {
        if (index) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(285_000);
    expect(sessions[1]!.closed).toBe(true);
    expect(sessions[0]!.closed).toBe(false);
    expect(router.getSessionRefreshDiagnostics().failures).toBe(1);
    expect(router.getSessionRefreshDiagnostics().lastFailure).toMatchObject({
      phase: "connect",
      failure: "connect_timeout",
      candidateConnected: false,
    });
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records an ACK-only candidate without inventing information arrival or adoption", async () => {
    const { router, sessions } = setup({
      configure: (session, index) => {
        if (index) session.ackOnly = true;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(278_000);
    expect(router.getReadDiagnostics().lastFailure).toMatchObject({
      sessionGeneration: 2,
      acknowledged: true,
      informationReceived: false,
      informationReceivedAtMs: null,
      currentAtArrival: null,
      outcome: "timeout",
    });
    expect(router.getSessionRefreshDiagnostics().lastFailure).toMatchObject({
      originalSessionGeneration: 1,
      candidateSessionGeneration: 2,
      candidateInformationReceivedAtMs: null,
      adoptedAtMs: null,
      informationVerified: false,
    });
    expect(sessions[0]!.closed).toBe(false);
    expect(sessions[0]!.sends).toBe(0);
    expect(sessions[1]!.sends).toBe(1);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers preparation while a media lease is held and renews after release", async () => {
    const { router, sessions } = setup();
    const lease = await router.sessionFor(SN);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.closed).toBe(false);
    expect(router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 0, deferred: 1 });
    lease.release();
    await tick();
    expect(sessions).toHaveLength(2);
    expect(router.getSessionRefreshDiagnostics().successes).toBe(1);
    expect(router.getSessionRefreshDiagnostics().lastAttempt).toMatchObject({
      originalSessionGeneration: 1,
      candidateSessionGeneration: 2,
      candidateInformationReceivedAtMs: 300_000,
      adoptedAtMs: 300_000,
    });
    router.close();
  });

  it("allows original-session operations during preparation and waits for their leases before adoption", async () => {
    const { router, sessions } = setup({
      configure: (s, index) => {
        if (index) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(270_000);
    const lease = await router.sessionFor(SN);
    expect(lease.session).toBe(sessions[0]);
    sessions[1]!.open();
    await tick();
    expect(sessions[0]!.closed).toBe(false);
    expect(router.getSessionRefreshDiagnostics().successes).toBe(0);
    expect(router.getReadDiagnostics().recent.at(-1)).toMatchObject({
      sessionGeneration: 2,
      informationReceivedAtMs: 270_000,
      currentAtArrival: false,
    });
    await vi.advanceTimersByTimeAsync(100);
    lease.release();
    await tick();
    expect(sessions[0]!.closed).toBe(true);
    expect(router.getSessionRefreshDiagnostics().successes).toBe(1);
    expect(router.getSessionRefreshDiagnostics().lastAttempt).toMatchObject({
      originalSessionGeneration: 1,
      candidateSessionGeneration: 2,
      candidateInformationReceivedAtMs: 270_000,
      adoptedAtMs: 270_100,
    });
    router.close();
  });

  it("abandons a verified candidate if an original-session lease outlasts the whole deadline", async () => {
    const { router, sessions } = setup({
      configure: (s, index) => {
        if (index) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(270_000);
    const lease = await router.sessionFor(SN);
    sessions[1]!.open();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sessions[0]!.closed).toBe(false);
    expect(sessions[1]!.closed).toBe(true);
    expect(router.getSessionRefreshDiagnostics().failures).toBe(1);
    expect(router.getSessionRefreshDiagnostics().lastFailure).toMatchObject({
      phase: "idle",
      failure: "replacement_timeout",
      informationVerified: true,
      originalLeasesAtFinish: 1,
    });
    lease.release();
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([486, 408])("retains signaling %s events separately from the eventual connection timeout", async (status) => {
    const { router, sessions } = setup({
      configure: (s, index) => {
        if (index) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(270_000);
    sessions[1]!.emit("error", new Error(`RTC scall ${status} after 0 retries`));
    expect(router.getSessionRefreshDiagnostics().failures).toBe(0);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(router.getSessionRefreshDiagnostics().lastFailure).toMatchObject({
      phase: "connect",
      failure: "connect_timeout",
      sessionError: `signaling_${status}`,
      elapsedMs: 12_000,
      candidateConnected: false,
      informationVerified: false,
    });
    expect(sessions[0]!.closed).toBe(false);
    expect(sessions[1]!.closed).toBe(true);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a detached last failure after a later successful generation and clears it on close", async () => {
    const { router, sessions } = setup({
      configure: (s, index) => {
        if (index === 1) s.answer = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(278_000);
    const failed = router.getSessionRefreshDiagnostics().lastFailure;
    expect(failed?.failure).toBe("information_timeout");
    sessions[0]!.close();
    await open(router);
    await vi.advanceTimersByTimeAsync(270_000);
    const snapshot = router.getSessionRefreshDiagnostics();
    expect(snapshot.lastOutcome).toBe("success");
    expect(snapshot.lastFailure).toEqual(failed);
    expect(snapshot.recent.map((entry) => entry.outcome)).toEqual(["failed", "success"]);
    snapshot.recent[0]!.elapsedMs = -1;
    snapshot.recent.length = 0;
    expect(router.getSessionRefreshDiagnostics().recent[0]!.elapsedMs).toBe(8000);
    snapshot.lastFailure!.elapsedMs = -1;
    snapshot.lastAttempt!.elapsedMs = -1;
    expect(router.getSessionRefreshDiagnostics().lastFailure!.elapsedMs).toBe(8000);
    expect(router.getSessionRefreshDiagnostics().lastAttempt!.elapsedMs).toBeGreaterThanOrEqual(0);
    router.close();
    expect(router.getSessionRefreshDiagnostics().lastFailure).toBeNull();
    expect(router.getSessionRefreshDiagnostics().lastAttempt).toBeNull();
    expect(router.getSessionRefreshDiagnostics().recent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels preparation on router close without resurrecting state or diagnostics", async () => {
    const { router, sessions } = setup({
      configure: (s, index) => {
        if (index) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(270_000);
    router.close();
    sessions[1]!.open();
    await tick();
    expect(sessions.every((s) => s.closed)).toBe(true);
    expect(router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 0, successes: 0, failures: 0 });
    expect(router.getReadDiagnostics().exchanges).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resurrect a primary that closes while the replacement is being prepared", async () => {
    const { router, sessions } = setup({
      configure: (s, index) => {
        if (index === 1) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(270_000);
    sessions[0]!.close();
    const lease = await router.sessionFor(SN);
    await tick();
    expect(sessions).toHaveLength(3);
    expect(sessions[1]!.closed).toBe(true);
    expect(lease.session).toBe(sessions[2]);
    expect(router.getSessionRefreshDiagnostics().successes).toBe(0);
    lease.release();
    router.close();
  });

  it("cancels proactive work when an unused primary reaches its idle timeout", async () => {
    const { router, sessions } = setup({ idle: 60_000 });
    await open(router);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.closed).toBe(true);
    expect(router.getSessionRefreshDiagnostics().attempts).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    router.close();
  });

  it("retries once after a fresh read and cooldown, then verifies the candidate before adoption", async () => {
    const { router, sessions } = setup({
      configure: (s, i) => {
        if (i === 1) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(282_001);
    await router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(29_998);
    expect(sessions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions).toHaveLength(3);
    expect(sessions[0]!.closed).toBe(true);
    expect(sessions[1]!.closed).toBe(true);
    expect(sessions[2]!.closed).toBe(false);
    expect(sessions.map((s) => s.sends)).toEqual([1, 0, 1]);
    expect(sessions[2]!.options.maxCallRetries).toBe(0);
    expect(router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 2, failures: 1, successes: 1 });
    expect(router.getSessionRefreshDiagnostics().lastFailure?.failure).toBe("connect_timeout");
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not use a successful read from before the failed candidate as retry health", async () => {
    const { router, sessions } = setup({
      configure: (s, i) => {
        if (i) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(275_000);
    await router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(100_000);
    const lease = await router.sessionFor(SN);
    lease.release();
    await tick();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.closed).toBe(false);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not qualify a read begun before failure even if its response arrives afterward", async () => {
    const { router, sessions } = setup({
      configure: (s, i) => {
        if (i) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(281_000);
    sessions[0]!.answer = false;
    const read = router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(2_000);
    sessions[0]!.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(1103, 4, 255, sessions[0]!.lastSegment, 1), Buffer.alloc(4)]),
      1,
    );
    const body = Buffer.from('{"params":[]}');
    sessions[0]!.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 0, 0, 0), body]), 3);
    await read;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.closed).toBe(false);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires a complete retained read rather than ACK alone", async () => {
    const { router, sessions } = setup({
      configure: (s, i) => {
        if (i) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(282_001);
    sessions[0]!.ackOnly = true;
    const read = expect(router.refreshInformation(SN)).rejects.toThrow("information response timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await read;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.closed).toBe(true);
    expect(router.getSessionRefreshDiagnostics().attempts).toBe(1);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exhausts a second connection attempt without closing a still-responsive old session", async () => {
    const { router, sessions } = setup({
      configure: (s, i) => {
        if (i) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(282_001);
    await router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(41_999);
    expect(sessions).toHaveLength(3);
    expect(sessions[1]!.closed).toBe(true);
    expect(sessions[2]!.closed).toBe(true);
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await router.refreshInformation(SN);
    }
    expect(sessions).toHaveLength(3);
    expect(sessions[0]!.closed).toBe(false);
    expect(router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 2, failures: 2, successes: 0 });
    expect(router.getSessionRefreshDiagnostics().lastFailure).toMatchObject({
      attemptOrdinal: 2,
      retryProofStartedAtMs: 282_001,
      retryProofFinishedAtMs: 282_001,
    });
    expect(router.getReadDiagnostics().recent.some((entry) => entry.startedAtMs === 282_001)).toBe(false);
    expect(router.getSessionRefreshDiagnostics().recent.map((entry) => entry.attemptOrdinal)).toEqual([1, 2]);

    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds completed renewal history without changing renewal scheduling", async () => {
    const { router, sessions } = setup();
    await open(router);
    await vi.advanceTimersByTimeAsync(270_000 * 35);
    const snapshot = router.getSessionRefreshDiagnostics();
    expect(snapshot.attempts).toBe(35);
    expect(snapshot.successes).toBe(35);
    expect(snapshot.recent).toHaveLength(32);
    expect(snapshot.evicted).toBe(3);
    expect(snapshot.recent[0]!.startedAtMs).toBe(270_000 * 4);
    expect(snapshot.recent.at(-1)!.startedAtMs).toBe(270_000 * 35);
    expect(sessions).toHaveLength(36);
    router.close();
    expect(router.getSessionRefreshDiagnostics().recent).toEqual([]);
    expect(router.getSessionRefreshDiagnostics().evicted).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks read freshness after a long lease and waits for another complete read", async () => {
    const { router, sessions } = setup({
      configure: (s, i) => {
        if (i === 1) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(282_001);
    await router.refreshInformation(SN);
    const lease = await router.sessionFor(SN);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessions).toHaveLength(2);
    lease.release();
    await tick();
    expect(sessions).toHaveLength(2);
    await router.refreshInformation(SN);
    await tick();
    expect(sessions).toHaveLength(3);
    expect(router.getSessionRefreshDiagnostics().successes).toBe(1);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled retry when an intervening information failure taints the retained generation", async () => {
    const { router, sessions } = setup({
      configure: (s, i) => {
        if (i) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(282_001);
    await router.refreshInformation(SN);
    sessions[0]!.answer = false;
    const read = expect(router.refreshInformation(SN)).rejects.toThrow("information response timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await read;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.closed).toBe(true);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["close", "peer closure"])(
    "cancels the pending cooldown on %s without creating another session",
    async (ending) => {
      const { router, sessions } = setup({
        configure: (s, i) => {
          if (i) s.autoOpen = false;
        },
      });
      await open(router);
      await vi.advanceTimersByTimeAsync(282_001);
      await router.refreshInformation(SN);
      if (ending === "close") router.close();
      else sessions[0]!.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.closed)).toBe(true);
      router.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not let a late retry overwrite a newer command owner", async () => {
    const { router, sessions } = setup({
      configure: (s, i) => {
        if (i === 1 || i === 2) s.autoOpen = false;
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(282_001);
    await router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sessions).toHaveLength(3);
    sessions[0]!.close();
    const lease = await router.sessionFor(SN);
    sessions[2]!.open();
    await tick();
    expect(lease.session).toBe(sessions[3]);
    expect(sessions[3]!.closed).toBe(false);
    expect(sessions[2]!.closed).toBe(true);
    lease.release();
    expect(router.getSessionRefreshDiagnostics().successes).toBe(0);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry an unknown connection error even after a healthy retained read", async () => {
    const { router, sessions } = setup({
      configure: (s, i) => {
        if (i)
          s.connect = async () => {
            throw new Error("synthetic unknown failure");
          };
      },
    });
    await open(router);
    await vi.advanceTimersByTimeAsync(270_001);
    await router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.closed).toBe(false);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
