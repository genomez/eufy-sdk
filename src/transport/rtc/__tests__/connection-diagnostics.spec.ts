import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionEvidenceRecorder,
  ConnectionStageRecorder,
  connectionCloseOrigin,
  connectionDiagnosticTime,
} from "../connection-diagnostics.js";
import { RtcCommandRouter, type RtcCommandRouterDeps } from "../command-router.js";
import { RtcSession, type RtcSessionOptions } from "../session.js";
import type { RtcSignalingClient } from "../signaling.js";
import type { RtcPeer } from "../peer.js";
import type { EufyDevice } from "../../../core/types.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";
import { consumeConnectionDeadline } from "../connection-deadline.js";

const SECRET = "synthetic-private-body-token-sdp";
const SN = "T9000P0000000000";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** All operational seams are synchronous or fake promises; no native peer or socket is created. */
function fixture(overrides: Partial<RtcSessionOptions> = {}) {
  const trace: unknown[][] = [];
  const sig = Object.assign(new EventEmitter(), {
    isOpen: true,
    fetchSign: vi.fn(async () => {
      trace.push(["sign"]);
      return SECRET;
    }),
    connect: vi.fn(async () => {
      trace.push(["connect"]);
      sig.emit("message", { action: 1, code: 200 });
    }),
    sendCall: vi.fn((...args: unknown[]) => {
      trace.push(["call", ...args]);
    }),
    sendAck: vi.fn((...args: unknown[]) => {
      trace.push(["ack", ...args]);
    }),
    sendInfoSdp: vi.fn((...args: unknown[]) => {
      trace.push(["answer", ...args]);
    }),
    sendInfoCandidate: vi.fn((...args: unknown[]) => {
      trace.push(["candidate", ...args]);
    }),
    sendHangup: vi.fn((...args: unknown[]) => {
      trace.push(["hangup", ...args]);
    }),
    close: vi.fn(() => {
      trace.push(["sig-close"]);
      sig.isOpen = false;
    }),
  });
  const peer = Object.assign(new EventEmitter(), {
    init: vi.fn(async (...args: unknown[]) => {
      trace.push(["init", ...args]);
    }),
    handleRemoteOffer: vi.fn(async (...args: unknown[]) => {
      trace.push(["offer", ...args]);
      return SECRET;
    }),
    answerAsScallJson: vi.fn((answer: string) => answer),
    addRemoteCandidate: vi.fn((...args: unknown[]) => {
      trace.push(["remote-candidate", ...args]);
    }),
    close: vi.fn(() => {
      trace.push(["peer-close"]);
    }),
  });
  const options: RtcSessionOptions = {
    authToken: SECRET,
    userId: SECRET,
    stationSn: SN,
    adminUserId: SECRET,
    shard: "us-pr",
    country: "US",
    createSignaling: () => sig as unknown as RtcSignalingClient,
    createPeer: () => peer as unknown as RtcPeer,
    sleep: async (ms) => {
      trace.push(["sleep", ms]);
    },
    maxCallRetries: 1,
    ...overrides,
  };
  const session = new RtcSession(options);
  const errors: Error[] = [];
  session.on("error", (error) => {
    errors.push(error);
    trace.push(["error", error]);
  });
  session.on("connected", () => trace.push(["connected"]));
  session.on("close", () => trace.push(["close"]));
  const hub = (dataType: string, data: object) => sig.emit("message", { dataType, data: JSON.stringify(data) });
  return { sig, peer, options, session, errors, trace, hub };
}

function routerFixture(
  configure?: (f: ReturnType<typeof fixture>, index: number) => void,
  overrides: Partial<RtcCommandRouterDeps> = {},
) {
  const sessions: ReturnType<typeof fixture>[] = [];
  const deps: RtcCommandRouterDeps = {
    identity: () => ({ authToken: SECRET, userId: SECRET }),
    shard: () => "us-pr",
    accountName: () => SECRET,
    findDevice: () => ({ sn: SN, stationSn: SN, model: "T9000" }) as EufyDevice,
    idleCloseMs: 1_000_000,
    connectTimeoutMs: 10,
    ...overrides,
    createSession: (options) => {
      const f = fixture({ maxCallRetries: options.maxCallRetries ?? 1 });
      configure?.(f, sessions.length);
      sessions.push(f);
      return f.session;
    },
  };
  return { router: new RtcCommandRouter(deps), sessions };
}

function answerInformation(f: ReturnType<typeof fixture>) {
  const send = vi.fn((packet: Buffer) => {
    const h = parsePortalHeader(packet)!;
    f.peer.emit(
      "data",
      "notify",
      Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), Buffer.alloc(4)]),
      1,
    );
    const body = Buffer.from('{"params":[]}');
    f.peer.emit("data", "notify", Buffer.concat([buildPortalHeader(1103, body.length, 0, 0, 0), body]), 3);
    return true;
  });
  Object.assign(f.peer, { sendCommand: send });
  return send;
}

afterEach(() => vi.restoreAllMocks());

describe("passive RTC connection evidence", () => {
  it("records real busy stages and each terminal generation once across a cooldown cycle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const state = routerFixture(
      (f, index) => {
        f.sig.sendCall.mockImplementation(() => {
          if (index === 0 || index === 3) f.peer.emit("commandChannelOpen");
          else f.hub("scall", { status: 486 });
        });
        answerInformation(f);
      },
      { connectTimeoutMs: 12_000, sessionRefreshMs: 270_000 },
    );
    try {
      const lease = await state.router.sessionFor(SN);
      lease.release();
      await vi.advanceTimersByTimeAsync(282_001);
      await state.router.refreshInformation(SN);
      await vi.advanceTimersByTimeAsync(41_999);
      expect(state.router.getSessionRefreshDiagnostics().failures).toBe(2);
      await vi.advanceTimersByTimeAsync(59_999);
      await state.router.refreshInformation(SN);
      expect(state.sessions).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 3, successes: 1, failures: 2 });
      const evidence = state.router.getConnectionDiagnostics();
      expect(evidence.active).toMatchObject([{ generation: 4, role: "current", outcome: "connected" }]);
      expect(evidence.terminal).toHaveLength(3);
      for (const row of evidence.terminal.filter((row) => row.role === "candidate")) {
        expect(row).toMatchObject({
          outcome: "connect_timeout",
          stages: { lastFailure: { stage: "call_retry", status: "failed" } },
        });
        expect(
          row.stages!.events.filter((event) => event.stage === "call_retry" && event.status === "failed"),
        ).toHaveLength(1);
      }
      expect(new Set(evidence.terminal.map((row) => row.generation)).size).toBe(3);
      expect(JSON.stringify(evidence)).not.toContain(SECRET);
    } finally {
      state.router.close();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it("bounds active, terminal and stage storage, preserves independent failure and returns detached data", () => {
    const recorder = new ConnectionEvidenceRecorder();
    const stages = new ConnectionStageRecorder();
    stages.record("peer_init", "failed");
    for (let i = 0; i < 100; i++) stages.record("grant", "observed");
    stages.record(SECRET as never, "failed");
    stages.record("peer", SECRET as never);
    const rows = Array.from({ length: 100 }, (_, i) => recorder.start(0, i + 1, false, stages));
    const active = recorder.snapshot(1, 0);
    expect(active).toMatchObject({ activeCount: 100, activeEvicted: 36, terminalEvicted: 0 });
    expect(active.active).toHaveLength(64);
    expect(active.active[0]!.stages).toMatchObject({
      evicted: 69,
      lastFailure: { stage: "peer_init", status: "failed" },
    });
    expect(active.active[0]!.stages!.events).toHaveLength(32);
    for (const row of rows) {
      recorder.retire(row, "retired");
      recorder.retire(row, "closed");
    }
    const terminal = recorder.snapshot(1, 1);
    expect(terminal).toMatchObject({ activeCount: 0, terminalEvicted: 68, epoch: 1 });
    expect(terminal.terminal).toHaveLength(32);
    terminal.terminal[0]!.stages!.events.length = 0;
    terminal.terminal[0]!.stages!.lastFailure!.stage = "peer";
    expect(recorder.snapshot(1, 1).terminal[0]!.stages!.events).toHaveLength(32);
    expect(recorder.snapshot(1, 1).terminal[0]!.stages!.lastFailure!.stage).toBe("peer_init");
    expect(JSON.stringify(recorder.snapshot(1, 1))).not.toContain(SECRET);
  });

  it("keeps invalid or throwing clocks and close-origin adapters unknown", () => {
    vi.spyOn(Date, "now").mockReturnValue(NaN);
    expect(connectionDiagnosticTime()).toBeNull();
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw Error(SECRET);
    });
    expect(connectionDiagnosticTime()).toBeNull();
    expect(connectionCloseOrigin({ closeOrigin: SECRET })).toBeNull();
    expect(
      connectionCloseOrigin({
        get closeOrigin() {
          throw Error(SECRET);
        },
      }),
    ).toBeNull();
  });

  it("records actual grant, init, offer, answer and synchronous channel opening with unchanged arguments", async () => {
    const f = fixture();
    await f.session.connect();
    const turn = { turn_addr: SECRET, turn_user: SECRET, turn_password: SECRET, turn_port: 3478 };
    f.hub("scall", { status: 100, turn });
    await flush();
    f.peer.handleRemoteOffer.mockImplementationOnce(async (...args) => {
      f.trace.push(["offer", ...args]);
      f.peer.emit("commandChannelOpen");
      return SECRET;
    });
    f.hub("info", { sdp: SECRET });
    await flush();
    expect(f.trace).toEqual([
      ["sign"],
      ["connect"],
      ["call", 0],
      ["init", turn],
      ["offer", SECRET],
      ["connected"],
      ["answer", SECRET, 0],
    ]);
    const events = f.session.getConnectionDiagnostics().events;
    for (const stage of ["grant", "command_channel"])
      expect(events).toContainEqual({ stage, status: "observed", atMs: expect.any(Number) });
    for (const stage of ["sign", "signaling_transport", "signaling_auth", "peer_init", "offer", "answer"])
      expect(events).toContainEqual({ stage, status: "succeeded", atMs: expect.any(Number) });
    expect(JSON.stringify(f.session.getConnectionDiagnostics())).not.toContain(SECRET);
    f.session.close();
  });

  it.each(["sign", "signaling_transport", "call", "peer_init", "offer", "answer"] as const)(
    "retains actual %s error identity and phase without changing propagation",
    async (stage) => {
      const f = fixture();
      const error = new Error(SECRET);
      if (stage === "sign") f.sig.fetchSign.mockRejectedValueOnce(error);
      if (stage === "signaling_transport") f.sig.connect.mockRejectedValueOnce(error);
      if (stage === "call")
        f.sig.sendCall.mockImplementationOnce(() => {
          throw error;
        });
      if (["sign", "signaling_transport", "call"].includes(stage)) {
        await expect(f.session.connect()).rejects.toBe(error);
        expect(f.errors).toEqual([]);
      } else {
        await f.session.connect();
        if (stage === "peer_init") f.peer.init.mockRejectedValueOnce(error);
        if (stage === "offer") f.peer.handleRemoteOffer.mockRejectedValueOnce(error);
        if (stage === "answer")
          f.sig.sendInfoSdp.mockImplementationOnce(() => {
            throw error;
          });
        if (stage === "peer_init") f.hub("scall", { status: 100, turn: {} });
        else f.hub("info", { sdp: SECRET });
        await flush();
        expect(f.errors).toEqual([error]);
        expect(f.errors[0]).toBe(error);
      }
      expect(f.session.getConnectionDiagnostics().lastFailure).toMatchObject({ stage, status: "failed" });
      expect(JSON.stringify(f.session.getConnectionDiagnostics())).not.toContain(SECRET);
      f.session.close();
    },
  );

  it("records authentication rejection and timeout without inventing a grant", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.sig.connect.mockImplementationOnce(async () => {
        f.sig.emit("message", { action: 1, code: 401, data: SECRET });
      });
      const connecting = f.session.connect().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await connecting).toBeInstanceOf(Error);
      expect(f.session.getConnectionDiagnostics().lastFailure?.stage).toBe("signaling_auth");
      expect(f.session.getConnectionDiagnostics().events.some((event) => event.stage === "grant")).toBe(false);
      f.session.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["peer_init", "offer"] as const)(
    "preserves synchronous %s throws from fake implementations",
    async (stage) => {
      const f = fixture();
      const error = new Error(SECRET);
      await f.session.connect();
      if (stage === "peer_init")
        f.peer.init.mockImplementationOnce(() => {
          throw error;
        });
      else
        f.peer.handleRemoteOffer.mockImplementationOnce(() => {
          throw error;
        });
      f.hub("info", { sdp: SECRET });
      await flush();
      expect(f.errors[0]).toBe(error);
      expect(f.session.getConnectionDiagnostics().lastFailure?.stage).toBe(stage);
      f.session.close();
    },
  );

  it("observes signaling and peer error events without changing their identity or source", () => {
    const f = fixture();
    const signalingError = new Error(SECRET);
    const peerError = new Error(SECRET);
    f.sig.emit("error", signalingError);
    expect(f.errors[0]).toBe(signalingError);
    expect(f.session.getConnectionDiagnostics().lastFailure?.stage).toBe("signaling");
    f.peer.emit("error", peerError);
    expect(f.errors[1]).toBe(peerError);
    expect(f.session.getConnectionDiagnostics().lastFailure?.stage).toBe("peer");
    f.session.close();
    f.sig.emit("error", new Error(SECRET));
    f.peer.emit("error", new Error(SECRET));
    expect(f.errors).toHaveLength(2);
  });

  it("ignores recorder failures while preserving retry and teardown trace", async () => {
    const f = fixture();
    vi.spyOn(ConnectionStageRecorder.prototype, "record").mockImplementation(() => {
      throw Error(SECRET);
    });
    await f.session.connect();
    f.hub("scall", { status: 486 });
    await flush();
    expect(f.trace).toEqual([
      ["sign"],
      ["connect"],
      ["call", 0],
      ["hangup", 0],
      ["peer-close"],
      ["sleep", 10_000],
      ["call", 0],
    ]);
    f.session.close();
    expect(f.trace.slice(-4)).toEqual([["hangup", 0], ["sig-close"], ["peer-close"], ["close"]]);
  });

  it("retains a late init failure on a terminal row after reset, without a new operational error", async () => {
    let rejectInit!: (error: Error) => void;
    const f = routerFixture((session) => {
      session.sig.sendCall.mockImplementationOnce(() => {
        session.peer.emit("commandChannelOpen");
        session.hub("scall", { status: 100, turn: {} });
      });
      session.peer.init.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectInit = reject;
          }),
      );
    });
    const lease = await f.router.sessionFor(SN);
    lease.release();
    await flush();
    f.router.close();
    rejectInit(new Error(SECRET));
    await flush();
    const snapshot = f.router.getConnectionDiagnostics();
    expect(snapshot).toMatchObject({ epoch: 1, active: [], activeCount: 0 });
    expect(snapshot.terminal[0]).toMatchObject({
      epoch: 0,
      generation: 1,
      outcome: "connected",
      retirement: "router_reset",
      closeOrigin: "local",
      stages: { lastFailure: { stage: "peer_init" } },
    });
    expect(f.sessions[0]!.errors).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  it.each(["ordinary", "hangup throws", "signaling throws", "peer throws", "observer throws"])(
    "preserves peer-init cause through synchronous current-owner error/drop: %s",
    async (mode) => {
      vi.useFakeTimers();
      const cause = new Error(SECRET);
      const error = new Error(`rtc: ${SN} did not come up within 10ms`, { cause });
      const onError = vi.fn(() => {
        if (mode === "observer throws") throw new Error(SECRET);
      });
      const f = routerFixture(
        (session) => {
          session.sig.sendCall.mockImplementationOnce(() => session.hub("scall", { status: 100, turn: {} }));
          session.peer.init.mockRejectedValueOnce(error);
          const fail = () => {
            throw new Error(SECRET);
          };
          if (mode === "hangup throws") session.sig.sendHangup.mockImplementationOnce(fail);
          if (mode === "signaling throws") session.sig.close.mockImplementationOnce(fail);
          if (mode === "peer throws") session.peer.close.mockImplementationOnce(fail);
        },
        { onError },
      );
      try {
        const opening = f.router.sessionFor(SN).catch((failure: unknown) => failure);
        await vi.advanceTimersByTimeAsync(0);
        const rejected = await opening;
        expect(rejected).toBe(error);
        expect((rejected as Error).cause).toBe(cause);
        expect(consumeConnectionDeadline(rejected)).toBe(false);
        expect(onError).toHaveBeenCalledExactlyOnceWith(error);
        expect(f.sessions[0]!.errors[0]).toBe(error);
        expect(f.sessions[0]!.sig.close).toHaveBeenCalledTimes(1);
        expect(f.sessions[0]!.peer.close).toHaveBeenCalledTimes(1);
        expect(f.sessions[0]!.session.listenerCount("connected")).toBe(1);
        expect(f.sessions[0]!.session.listenerCount("close")).toBe(1);
        expect(f.sessions[0]!.session.listenerCount("commandData")).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(f.router.getConnectionDiagnostics().terminal).toHaveLength(1);
        expect(f.router.getConnectionDiagnostics().terminal[0]).toMatchObject({
          outcome: "closed_before_open",
          closeOrigin: "peer_failed",
          stages: { lastFailure: { stage: "peer_init", status: "failed" } },
        });
        expect(JSON.stringify(f.router.getConnectionDiagnostics())).not.toContain(SECRET);
      } finally {
        f.router.close();
        expect(f.router.getConnectionDiagnostics().terminal).toHaveLength(1);
        vi.useRealTimers();
      }
    },
  );

  it("rejects an unsent command promptly with the original peer-build error", async () => {
    vi.useFakeTimers();
    const error = new Error(SECRET, { cause: new Error(SECRET) });
    const sends: ReturnType<typeof answerInformation>[] = [];
    const onError = vi.fn();
    const f = routerFixture(
      (session) => {
        sends.push(answerInformation(session));
        session.sig.sendCall.mockImplementationOnce(() => session.hub("scall", { status: 100, turn: {} }));
        session.peer.init.mockRejectedValueOnce(error);
      },
      { onError, connectTimeoutMs: 12_000 },
    );
    try {
      const command = f.router
        .dispatchCommand(SN, { kind: "set-json", param: 1400, channel: 255, data: { value: 0 } })
        .catch((failure: unknown) => failure);
      await vi.advanceTimersByTimeAsync(0);
      expect(await command).toBe(error);
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(sends[0]).not.toHaveBeenCalled();
      expect(f.router.getCommandDiagnostics().recent[0]!.sendAttemptedAtMs).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.router.close();
      vi.useRealTimers();
    }
  });

  it.each(["ordinary", "signaling throws", "peer throws", "observer throws"])(
    "ends only a rejected replacement peer and keeps the original usable: %s",
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const error = new Error(SECRET, { cause: new Error(SECRET) });
      const onError = vi.fn();
      const sends: ReturnType<typeof answerInformation>[] = [];
      const f = routerFixture(
        (session, index) => {
          sends.push(answerInformation(session));
          session.sig.sendCall.mockImplementationOnce(() => {
            if (index === 0) session.peer.emit("commandChannelOpen");
            else session.hub("scall", { status: 100, turn: {} });
          });
          if (!index) return;
          session.peer.init.mockRejectedValueOnce(error);
          const fail = () => {
            throw new Error(SECRET);
          };
          if (mode === "signaling throws") session.sig.close.mockImplementationOnce(fail);
          if (mode === "peer throws") session.peer.close.mockImplementationOnce(fail);
          if (mode === "observer throws") session.session.on("error", fail);
        },
        { sessionRefreshMs: 270_000, connectTimeoutMs: 12_000, onError },
      );
      try {
        const lease = await f.router.sessionFor(SN);
        lease.release();
        await vi.advanceTimersByTimeAsync(270_000);
        expect(f.router.getSessionRefreshDiagnostics()).toMatchObject({
          attempts: 1,
          failures: 1,
          successes: 0,
          lastAttempt: {
            elapsedMs: 0,
            phase: "connect",
            failure: "other",
            sessionError: mode === "observer throws" ? null : "other",
            candidateCloseOrigin: "peer_failed",
          },
        });
        expect(onError).not.toHaveBeenCalled();
        expect(f.sessions[1]!.errors).toEqual([error]);
        expect(f.sessions[1]!.peer.close).toHaveBeenCalledTimes(1);
        expect(f.sessions[1]!.sig.close).toHaveBeenCalledTimes(1);
        expect(sends[1]).not.toHaveBeenCalled();
        expect(f.sessions[0]!.session.isConnected).toBe(true);
        expect(f.sessions[0]!.sig.close).not.toHaveBeenCalled();
        expect(f.router.informationRefreshReady(SN)).toBe(true);
        await f.router.refreshInformation(SN);
        expect(sends[0]).toHaveBeenCalledTimes(1);
        f.sessions[1]!.peer.emit("commandChannelOpen");
        f.sessions[1]!.hub("info", { sdp: SECRET });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.sessions).toHaveLength(2);
        const current = await f.router.sessionFor(SN);
        expect(current.session).toBe(f.sessions[0]!.session);
        current.release();
        const evidence = f.router.getConnectionDiagnostics();
        expect(evidence.active).toHaveLength(1);
        expect(evidence.terminal).toHaveLength(1);
        expect(evidence.terminal[0]).toMatchObject({
          generation: 2,
          role: "candidate",
          outcome: "closed_before_open",
          closeOrigin: "peer_failed",
          stages: { lastFailure: { stage: "peer_init", status: "failed" } },
        });
        expect(
          evidence.terminal[0]!.stages!.events.filter(
            (event) => event.stage === "peer_init" && event.status === "failed",
          ),
        ).toHaveLength(1);
        expect(JSON.stringify(evidence)).not.toContain(SECRET);
      } finally {
        f.router.close();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    },
  );

  it("distinguishes router timeout from phase failure and retains epochs across repeated close", async () => {
    vi.useFakeTimers();
    try {
      const f = routerFixture();
      const acquisition = f.router.sessionFor(SN).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      const error = await acquisition;
      expect(error).toBeInstanceOf(Error);
      expect(consumeConnectionDeadline(error)).toBe(true);
      expect(consumeConnectionDeadline(error)).toBe(false);
      f.router.close();
      f.router.close();
      const row = f.router.getConnectionDiagnostics().terminal[0]!;
      expect(row).toMatchObject({ epoch: 0, outcome: "connect_timeout", closeOrigin: "local" });
      expect(row.stages!.lastFailure).toBeNull();
      expect(f.router.getConnectionDiagnostics().epoch).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
