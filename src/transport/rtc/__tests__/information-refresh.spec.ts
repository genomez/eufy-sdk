import { consumeConnectionDeadline } from "../connection-deadline.js";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter, type RtcCommandRouterDeps } from "../command-router.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";
import type { RtcSession, RtcSessionOptions } from "../session.js";

const SN = "T9000P0000000001";
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const info = (command = 1103, value: unknown = { params: [] }) => {
  const body = Buffer.from(JSON.stringify(value));
  return Buffer.concat([buildPortalHeader(command, body.length, 2, 0, 0), body]);
};
class FakeSession extends EventEmitter {
  isConnected = false;
  closed = false;
  sent: Buffer[] = [];
  onSend?: (packet: Buffer) => void;
  constructor(
    readonly opts: RtcSessionOptions,
    readonly connecting = false,
  ) {
    super();
  }
  async connect(): Promise<void> {
    if (!this.connecting) this.open();
  }
  open(): void {
    this.isConnected = true;
    this.emit("connected");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.isConnected = false;
    this.emit("close");
  }
  sendCommand(packet: Buffer): boolean {
    if (!this.isConnected) return false;
    this.sent.push(packet);
    this.onSend?.(packet);
    return true;
  }
  ack(packet: Buffer, overrides: { channel?: number; segment?: number; error?: number; link?: number } = {}): void {
    const header = parsePortalHeader(packet)!;
    const body = Buffer.alloc(4);
    body.writeInt32LE(overrides.error ?? 0);
    this.emit(
      "commandData",
      Buffer.concat([
        buildPortalHeader(
          header.commandId,
          4,
          overrides.channel ?? header.channel,
          overrides.segment ?? header.segment,
          1,
        ),
        body,
      ]),
      overrides.link ?? 1,
    );
  }
}
function setup(overrides: Partial<RtcCommandRouterDeps> = {}, connecting = false) {
  const sessions: FakeSession[] = [];
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "synthetic", userId: "synthetic-member" }),
    shard: () => "us-pr",
    accountName: () => "synthetic",
    findDevice: (sn) => (sn === SN ? ({ sn, model: "T9000", stationSn: sn } as EufyDevice) : undefined),
    connectTimeoutMs: 200,
    ackTimeoutMs: 50,
    createSession: (opts) => {
      const session = new FakeSession(opts, connecting);
      sessions.push(session);
      return session as unknown as RtcSession;
    },
    ...overrides,
  });
  return { router, sessions };
}
async function prepared(overrides: Partial<RtcCommandRouterDeps> = {}) {
  const state = setup(overrides);
  const lease = await state.router.sessionFor(SN);
  lease.release();
  return { ...state, session: state.sessions[0]! };
}

describe("RTC information refresh", () => {
  it.each([1, 3])(
    "sends the direct binary request, observes persistent frames, and accepts information on link %i",
    async (link) => {
      const callback = vi.fn();
      const { router, session } = await prepared({ onFrame: callback, maxCallRetries: 0 });
      session.onSend = (packet) => {
        session.emit("commandData", info(), link);
        session.ack(packet);
      };
      const result = await router.refreshInformation(SN);
      expect(result.notificationCorrelation).toBe("temporal-only");
      expect(result.frame.channel).toBe(2);
      expect(callback).toHaveBeenCalledTimes(2);
      expect(session.opts.maxCallRetries).toBe(0);
      const packet = session.sent[0]!;
      expect(parsePortalHeader(packet)).toMatchObject({
        commandId: 1103,
        channel: 255,
        isResponse: 0,
        paramLength: 136,
      });
      expect(packet.readUInt32LE(16)).toBe(255);
      expect(packet.readUInt32LE(20)).toBe(0);
      expect(packet.subarray(24).toString().replace(/\0+$/, "")).toBe("synthetic-member");
      expect(session.listenerCount("commandData")).toBe(1);
      expect(router.getReadDiagnostics().recent[0]).toMatchObject({
        sessionGeneration: 1,
        currentAtArrival: true,
      });
      expect(router.getReadDiagnostics().recent[0]!.informationReceivedAtMs).toBeTypeOf("number");
      session.emit("commandData", info(), 3);
      expect(callback).toHaveBeenCalledTimes(3);
      router.close();
      session.emit("commandData", info(), 3);
      expect(callback).toHaveBeenCalledTimes(3);
      expect(session.listenerCount("commandData")).toBe(0);
    },
  );

  it("requires both a matching accepted ACK and a qualified direct notification", async () => {
    const { router, session } = await prepared();
    session.onSend = (packet) => {
      session.ack(packet, { segment: 200 });
      session.ack(packet, { channel: 0 });
      session.ack(packet, { link: 3 });
      session.emit("commandData", info(1350), 3);
      session.emit("commandData", info(1103, { unrelated: true }), 3);
    };
    const pending = router.refreshInformation(SN);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await pause();
    expect(done).toBe(false);
    session.ack(session.sent[0]!);
    await pause();
    expect(done).toBe(false);
    session.emit("commandData", info(1103, { payload: JSON.stringify({ db_bypass_str: [] }) }), 3);
    await pending;
    router.close();
  });

  it.each(["ack-only", "info-only", "rejected", "send-throw", "send-false", "close"])(
    "cleans failed %s reads and rejects late frames",
    async (kind) => {
      const callback = vi.fn();
      const { router, session } = await prepared({ onFrame: callback, ackTimeoutMs: 10 });
      session.onSend = (packet) => {
        if (kind === "ack-only") session.ack(packet);
        if (kind === "info-only") session.emit("commandData", info(), 3);
        if (kind === "rejected") session.ack(packet, { error: 1 });
        if (kind === "send-throw") throw new Error("synthetic send failure");
        if (kind === "close") session.close();
      };
      if (kind === "send-false") session.sendCommand = () => false;
      await expect(router.refreshInformation(SN, { timeoutMs: 100 })).rejects.toThrow();
      expect(session.closed).toBe(true);
      expect(session.listenerCount("commandData")).toBe(0);
      expect(session.listenerCount("close")).toBe(0);
      const evidence = router.getReadDiagnostics();
      expect(evidence.exchanges).toBe(1);
      expect(evidence.failures).toBe(1);
      expect(evidence.lastFailure).toMatchObject({
        sessionGeneration: 1,
        attempted: true,
        acknowledged: kind === "ack-only",
        informationReceived: kind === "info-only",
      });
      if (kind === "info-only") {
        expect(evidence.lastFailure!.informationReceivedAtMs).toBeTypeOf("number");
        expect(evidence.lastFailure!.currentAtArrival).toBe(true);
      } else {
        expect(evidence.lastFailure!.informationReceivedAtMs).toBeNull();
        expect(evidence.lastFailure!.currentAtArrival).toBeNull();
      }
      expect(JSON.stringify(evidence)).not.toContain(SN);
      expect(JSON.stringify(evidence)).not.toContain("synthetic-member");
      const count = callback.mock.calls.length;
      session.emit("commandData", info(), 3);
      expect(callback).toHaveBeenCalledTimes(count);
      router.close();
      expect(router.getReadDiagnostics().recent).toEqual([]);
    },
  );

  it("records reused-session age, both response timings and detached bounded history", async () => {
    vi.useFakeTimers();
    try {
      const { router, session } = await prepared({ idleCloseMs: 600_000 });
      await vi.advanceTimersByTimeAsync(350_000);
      session.onSend = (packet) => {
        session.ack(packet);
        session.emit("commandData", info(), 3);
      };
      for (let i = 0; i < 22; i++) await router.refreshInformation(SN);
      const result = router.getReadDiagnostics();
      expect(result.exchanges).toBe(22);
      expect(result.successes).toBe(22);
      expect(result.recent).toHaveLength(20);
      expect(result.recent[0]).toMatchObject({
        sessionAgeMs: 350_000,
        otherLeases: 0,
        acknowledged: true,
        informationReceived: true,
        ackElapsedMs: 0,
        informationElapsedMs: 0,
        outcome: "success",
      });
      result.recent[0]!.sessionAgeMs = 9;
      expect(router.getReadDiagnostics().recent[0]!.sessionAgeMs).toBe(350_000);
      expect(session.sent).toHaveLength(22);
      router.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes a read and a write without idle-closing their leases", async () => {
    vi.useFakeTimers();
    let close: (() => void) | undefined;
    try {
      const { router, session } = await prepared({ idleCloseMs: 1, ackTimeoutMs: 100 });
      close = () => router.close();
      const read = router.refreshInformation(SN);
      await vi.advanceTimersByTimeAsync(0);
      expect(parsePortalHeader(session.sent[0]!)?.commandId).toBe(1103);
      const write = router.dispatchCommand(SN, { kind: "set-payload", cmd: 1224, payload: {}, channel: 255 });
      await vi.advanceTimersByTimeAsync(10);
      expect(session.sent).toHaveLength(1);
      expect(session.closed).toBe(false);
      session.onSend = (packet) => session.ack(packet);
      session.ack(session.sent[0]!);
      session.emit("commandData", info(), 3);
      await Promise.all([read, write]);
      expect(session.sent).toHaveLength(2);
    } finally {
      close?.();
      vi.useRealTimers();
    }
  });

  it.each(["timeout", "abort"])(
    "preserves a held media session after information %s and retires it after the final lease",
    async (kind) => {
      const { router, session, sessions } = await prepared({ ackTimeoutMs: 20 });
      const media = await router.sessionFor(SN);
      try {
        const controller = new AbortController();
        const read = router.refreshInformation(SN, { signal: controller.signal, timeoutMs: 100 });
        const failure = expect(read).rejects.toThrow();
        await pause();
        if (kind === "abort") controller.abort();
        await failure;
        expect(session.closed).toBe(false);
        expect(session.listenerCount("commandData")).toBe(1);
        expect(session.sent).toHaveLength(1);
        await expect(router.refreshInformation(SN)).rejects.toThrow(/until the session retires/);
        session.ack(session.sent[0]!);
        session.emit("commandData", info(), 3);
        expect(session.sent).toHaveLength(1);
        session.onSend = (packet) => session.ack(packet);
        await router.dispatchCommand(SN, { kind: "set-payload", cmd: 1224, payload: {}, channel: 255 });
        expect(session.sent).toHaveLength(2);
        expect(session.closed).toBe(false);
        media.release();
        expect(session.closed).toBe(true);
        expect(session.eventNames()).toHaveLength(0);
        const next = await router.sessionFor(SN);
        expect(sessions).toHaveLength(2);
        sessions[1]!.onSend = (packet) => {
          sessions[1]!.ack(packet);
          sessions[1]!.emit("commandData", info(), 3);
        };
        await expect(router.refreshInformation(SN)).resolves.toMatchObject({
          notificationCorrelation: "temporal-only",
        });
        next.release();
      } finally {
        media.release();
        router.close();
      }
    },
  );

  it("rejects a queued information read after the preceding sent read times out", async () => {
    const { router, session } = await prepared({ ackTimeoutMs: 10 });
    const media = await router.sessionFor(SN);
    try {
      const first = expect(router.refreshInformation(SN)).rejects.toThrow();
      const second = expect(router.refreshInformation(SN)).rejects.toThrow(/until the session retires/);
      await Promise.all([first, second]);
      expect(session.sent).toHaveLength(1);
      expect(session.closed).toBe(false);
    } finally {
      media.release();
      router.close();
    }
  });

  it("cancels a queued read without sending or disrupting the preceding read", async () => {
    const { router, session } = await prepared();
    const first = router.refreshInformation(SN);
    const controller = new AbortController();
    const queued = router.refreshInformation(SN, { signal: controller.signal });
    const rejected = expect(queued).rejects.toThrow();
    await pause();
    controller.abort();
    await rejected;
    expect(session.sent).toHaveLength(1);
    expect(session.closed).toBe(false);
    session.ack(session.sent[0]!);
    session.emit("commandData", info(), 3);
    await first;
    await pause();
    expect(session.sent).toHaveLength(1);
    router.close();
  });

  it.each(["abort", "timeout", "router-close"])(
    "bounds connection with %s and leaves no session listeners",
    async (kind) => {
      const { router, sessions } = setup({}, true);
      const controller = new AbortController();
      const read = router.refreshInformation(SN, {
        signal: controller.signal,
        timeoutMs: kind === "timeout" ? 10 : 100,
      });
      const rejected = expect(read).rejects.toThrow();
      if (kind === "abort") controller.abort();
      if (kind === "router-close") router.close();
      await rejected;
      expect(sessions[0]!.closed).toBe(true);
      expect(sessions[0]!.sent).toHaveLength(0);
      expect(sessions[0]!.eventNames()).toHaveLength(0);
      router.close();
    },
  );

  it("keeps a shared pending connection when only one acquisition is aborted", async () => {
    const { router, sessions } = setup({}, true);
    const controller = new AbortController();
    const read = router.refreshInformation(SN, { signal: controller.signal });
    const rejected = expect(read).rejects.toThrow();
    const held = router.sessionFor(SN);
    controller.abort();
    await rejected;
    expect(sessions[0]!.closed).toBe(false);
    sessions[0]!.open();
    const lease = await held;
    lease.release();
    router.close();
  });

  it.each([0, -1, 1.5, Infinity, NaN, 60001])(
    "refuses invalid deadline %s before creating a session",
    async (timeoutMs) => {
      const { router, sessions } = setup();
      await expect(router.refreshInformation(SN, { timeoutMs })).rejects.toThrow(RangeError);
      expect(sessions).toHaveLength(0);
    },
  );

  it("refuses a pre-aborted signal without creating a session", async () => {
    const { router, sessions } = setup();
    await expect(router.refreshInformation(SN, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(sessions).toHaveLength(0);
  });
});

describe("information frame classification", () => {
  it("counts each received frame once without accepting unrelated or malformed information", async () => {
    const { router, session } = await prepared();
    session.onSend = (packet) => {
      session.emit("commandData", Buffer.from("synthetic-invalid"), 3);
      session.emit("commandData", info(1200), 3);
      session.ack(packet, { channel: 1 });
      session.emit("commandData", info(1103, { unrelated: true }), 3);
      session.emit("commandData", buildPortalHeader(1103, 0, 0, 0, 2), 3);
      session.ack(packet);
      session.emit("commandData", info(), 3);
    };
    await expect(router.refreshInformation(SN)).resolves.toMatchObject({ notificationCorrelation: "temporal-only" });
    const evidence = router.getReadDiagnostics().recent.at(-1)!;
    expect(evidence).toMatchObject({
      receivedFrames: 7,
      invalidPortalFrames: 1,
      otherCommandFrames: 1,
      matchedAcknowledgments: 1,
      unmatchedAcknowledgments: 1,
      informationFrames: 1,
      invalidInformation: 1,
      otherInformationFrames: 1,
      outcome: "success",
    });
    expect(evidence.receivedFrames).toBe(
      evidence.invalidPortalFrames +
        evidence.otherCommandFrames +
        evidence.matchedAcknowledgments +
        evidence.unmatchedAcknowledgments +
        evidence.informationFrames +
        evidence.invalidInformation +
        evidence.otherInformationFrames,
    );
    router.close();
  });

  it("counts a matched rejection without changing command rejection behavior", async () => {
    const { router, session } = await prepared();
    session.onSend = (packet) => session.ack(packet, { error: 1 });
    await expect(router.refreshInformation(SN)).rejects.toThrow("RTC information request rejected");
    expect(router.getReadDiagnostics().lastFailure).toMatchObject({
      receivedFrames: 1,
      matchedAcknowledgments: 1,
      acknowledged: false,
      informationFrames: 0,
      outcome: "rejected",
    });
    router.close();
  });
});

describe("complete information operation evidence", () => {
  it("marks only the exact local acquisition deadline once after closing the unready session", async () => {
    vi.useFakeTimers();
    try {
      const { router, sessions } = setup({}, true);
      const pending = router.refreshInformation(SN).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(200);
      const error = await pending;
      expect(sessions[0]!.closed).toBe(true);
      expect(sessions[0]!.sent).toHaveLength(0);
      expect(consumeConnectionDeadline(error)).toBe(true);
      expect(consumeConnectionDeadline(error)).toBe(false);
      expect(router.getReadDiagnostics().lastOperationFailure).toMatchObject({
        phase: "acquisition",
        attempted: false,
      });
      router.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["remote_close", "connect_rejection", "cancel"])(
    "does not mark %s as a local acquisition deadline",
    async (ending) => {
      const { router, sessions } = setup({}, true);
      const controller = new AbortController();
      const pending = router.refreshInformation(SN, { signal: controller.signal }).catch((error: unknown) => error);
      if (ending === "remote_close") sessions[0]!.close();
      else if (ending === "connect_rejection") {
        sessions[0]!.connect = async () => {
          throw new Error("rtc: synthetic did not come up within 12000ms");
        };
      } else controller.abort(new Error("rtc: synthetic did not come up within 12000ms"));
      const error = await pending;
      expect(consumeConnectionDeadline(error)).toBe(false);
      expect(sessions[0]!.sent).toHaveLength(0);
      router.close();
    },
  );

  it("does not mark an acknowledged information-response timeout as an acquisition deadline", async () => {
    const { router, session } = await prepared();
    session.onSend = (packet) => session.ack(packet);
    const error = await router.refreshInformation(SN).catch((failure: unknown) => failure);
    expect(consumeConnectionDeadline(error)).toBe(false);
    expect(router.getReadDiagnostics().lastOperationFailure).toMatchObject({
      phase: "exchange",
      failure: "information_response_timeout",
    });
    router.close();
  });

  it("records pre-ready closure without inventing an exchange or sending a request", async () => {
    const { router, sessions } = setup({}, true);
    const pending = router.refreshInformation(SN);
    const rejected = expect(pending).rejects.toThrow("session closed before");
    sessions[0]!.close();
    await rejected;
    expect(router.getReadDiagnostics()).toMatchObject({
      exchanges: 0,
      lastOperationFailure: { phase: "acquisition", attempted: false, failure: "session_closed" },
    });
    expect(sessions[0]!.sent).toHaveLength(0);
    expect(JSON.stringify(router.getReadDiagnostics())).not.toContain(SN);
    router.close();
  });

  it("records the unchanged connection deadline before any exchange", async () => {
    vi.useFakeTimers();
    try {
      const { router, sessions } = setup({}, true);
      const pending = router.refreshInformation(SN);
      const rejected = expect(pending).rejects.toThrow("did not come up");
      await vi.advanceTimersByTimeAsync(200);
      await rejected;
      expect(router.getReadDiagnostics().lastOperationFailure).toMatchObject({
        phase: "acquisition",
        elapsedMs: 200,
        attempted: false,
        failure: "connect_timeout",
      });
      expect(sessions[0]!.sent).toHaveLength(0);
      router.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes queued cancellation from an ACK-only exchange and bounds detached history", async () => {
    const { router, session } = await prepared();
    session.onSend = (packet) => session.ack(packet);
    const first = router.refreshInformation(SN);
    const firstRejected = expect(first).rejects.toThrow("response timed out");
    await pause();
    const controller = new AbortController();
    const second = router.refreshInformation(SN, { signal: controller.signal });
    const secondRejected = expect(second).rejects.toThrow("synthetic-private-marker");
    await pause();
    controller.abort(new Error("synthetic-private-marker"));
    await secondRejected;
    expect(router.getReadDiagnostics().lastOperationFailure).toMatchObject({
      phase: "queue",
      attempted: false,
      failure: "other",
    });
    await firstRejected;
    expect(session.sent).toHaveLength(1);
    expect(router.getReadDiagnostics().lastOperationFailure).toMatchObject({
      phase: "exchange",
      attempted: true,
      failure: "information_response_timeout",
    });
    const replacement = await router.sessionFor(SN);
    replacement.release();
    const current = replacement.session as unknown as FakeSession;
    current.onSend = (packet) => {
      current.ack(packet);
      current.emit("commandData", info(), 3);
    };
    for (let i = 0; i < 22; i++) await router.refreshInformation(SN);
    const snapshot = router.getReadDiagnostics();
    expect(snapshot.operations).toHaveLength(20);
    expect(snapshot.lastOperationFailure?.failure).toBe("information_response_timeout");
    snapshot.operations[0]!.phase = "acquisition";
    expect(router.getReadDiagnostics().operations[0]!.phase).toBe("exchange");
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-private-marker");
    router.close();
    expect(router.getReadDiagnostics().operations).toEqual([]);
  });
});
