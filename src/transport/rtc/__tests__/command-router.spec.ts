/** Modified for genomez S1 experimental source preview, 2026-10-17. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { observeCommand } from "../../../core/contracts.js";
import { RtcCommandRouter, type RtcCommandRouterDeps } from "../command-router.js";
import type { RtcSession, RtcSessionOptions } from "../session.js";
import { buildPortalHeader, parsePortalHeader, PORTAL_HEADER_LENGTH } from "../portal-packet.js";
import { PORTAL_CMD_SET_PAYLOAD, PORTAL_STATION_CHANNEL } from "../commands.js";

/** A stand-in for RtcSession: comes up on connect(), answers every send with a 1350 ACK unless told not to. */
class FakeSession extends EventEmitter {
  connected = false;
  closed = false;
  sent: Buffer[] = [];
  /** What to do with a sent packet: "ack" (default), "nack" (errCode 1), "silent", or "close". */
  behaviour: "ack" | "nack" | "silent" | "close" = "ack";
  /** How connect() behaves: come up (default), throw, or never answer. */
  static connectMode: "up" | "throw" | "never" | "hang" = "up";
  constructor(readonly opts: RtcSessionOptions) {
    super();
  }
  get isConnected(): boolean {
    return this.connected && !this.closed;
  }
  async connect(): Promise<void> {
    if (FakeSession.connectMode === "throw") throw new Error("sign refused");
    // "never": connect() resolves but the session never emits `connected`.
    // "hang": connect() itself never settles — the deadline must still fire.
    if (FakeSession.connectMode === "never") return;
    if (FakeSession.connectMode === "hang") return new Promise<void>(() => {});
    queueMicrotask(() => {
      this.connected = true;
      this.emit("connected");
    });
  }
  /** Inject an ACK for an arbitrary segment, as a hub answering late would. */
  ackSegment(segment: number, commandId = PORTAL_CMD_SET_PAYLOAD, channel = PORTAL_STATION_CHANNEL, link = 1): void {
    const body = Buffer.alloc(4);
    this.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(commandId, body.length, channel, segment, 1), body]),
      link,
    );
  }
  sendCommand(pkt: Buffer): boolean {
    if (!this.isConnected) return false;
    this.sent.push(pkt);
    if (this.behaviour === "ack" || this.behaviour === "nack") {
      // The hub's ACK on the wire: response header repeating the request's segment + body whose first
      // int32 LE is the error code.
      const header = parsePortalHeader(pkt)!;
      const body = Buffer.alloc(4);
      body.writeInt32LE(this.behaviour === "nack" ? 1 : 0, 0);
      const ack = Buffer.concat([
        buildPortalHeader(header.commandId, body.length, header.channel, header.segment, 1),
        body,
      ]);
      queueMicrotask(() => this.emit("commandData", ack, 1));
    } else if (this.behaviour === "close") {
      queueMicrotask(() => this.close());
    }
    return true;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.emit("close");
  }
}

const SN = "T9000P0000000001";
const station = {
  sn: SN,
  model: "T9000",
  stationSn: SN,
  raw: { member: { admin_user_id: "adminid" } },
} as unknown as EufyDevice;
const CAMERA = "T8425P0000000001";
const camera = {
  sn: CAMERA,
  model: "T8425",
  stationSn: SN,
  raw: { device_channel: 2, member: { admin_user_id: "synthetic-child-member" } },
} as unknown as EufyDevice;

function makeRouter(over: Partial<RtcCommandRouterDeps> = {}) {
  const sessions: FakeSession[] = [];
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "tok", userId: "uid", accountUserId: "acct", gtoken: "g" }),
    shard: () => "ie-pr",
    country: "CH",
    accountName: () => "synthetic00000",
    findDevice: (sn) => (sn === SN ? station : sn === CAMERA ? camera : undefined),
    createSession: (opts) => {
      const s = new FakeSession(opts);
      sessions.push(s);
      return s as unknown as RtcSession;
    },
    ackTimeoutMs: 50,
    connectTimeoutMs: 200,
    ...over,
  });
  return { router, sessions };
}

/** Decode a request the router sent: header fields + the JSON body (a request body is plain JSON). */
const sent = (buf: Buffer) => ({
  ...parsePortalHeader(buf)!,
  body: JSON.parse(buf.subarray(PORTAL_HEADER_LENGTH).toString("utf8")) as Record<string, unknown>,
});

const arming = (mode: number) => ({
  kind: "set-payload" as const,
  cmd: 1224,
  payload: { mode_type: mode, user_name: "synthetic00000" },
  channel: 0,
  mValue3: 0,
});

const passiveLight = () =>
  observeCommand(
    { kind: "set-json", param: 1400, data: { value: 1 }, channel: 2 },
    {
      event: "property changed",
      expected: 1,
      param: 1400,
      property: "enabled",
      passiveReadback: true,
      timeoutMs: 14_000,
    },
  );

function answerInformation(session: FakeSession): void {
  const request = parsePortalHeader(session.sent.at(-1)!)!;
  session.ackSegment(request.segment, 1103, 255);
  const body = Buffer.from(JSON.stringify({ params: [] }));
  session.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 255, 0, 0), body]), 3);
}

describe("RtcCommandRouter", () => {
  it("claims a T9000 station itself, not other hubs nor cameras attached to it", () => {
    expect(RtcCommandRouter.claimsDevice(station)).toBe(true);
    expect(
      RtcCommandRouter.claimsDevice({ sn: "T8030X", model: "T8030", stationSn: "T8030X" } as unknown as EufyDevice),
    ).toBe(false);
    expect(
      RtcCommandRouter.claimsDevice({ sn: "T8410C", model: "T8410", stationSn: SN } as unknown as EufyDevice),
    ).toBe(false);
  });

  it("refuses command kinds it cannot carry instead of misrouting them", async () => {
    const { router, sessions } = makeRouter();
    await expect(
      router.dispatchCommand(SN, { kind: "set-param", param: 1, value: 1, form: "auto", channel: 0 } as never),
    ).rejects.toThrow(/only set-payload/);
    expect(sessions).toHaveLength(0);
  });

  it("sends the app's 1350 envelope on the station channel with relay ICE and resolves on the ACK", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.opts.stationSn).toBe(SN);
    expect(s.opts.adminUserId).toBe("adminid");
    expect(s.opts.gtoken).toBe("g");
    expect(s.opts.shard).toBe("ie-pr");
    expect(s.opts.peer?.icePolicy).toBe("relay");
    expect(s.sent).toHaveLength(1);
    const p = sent(s.sent[0]!);
    expect(p.commandId).toBe(PORTAL_CMD_SET_PAYLOAD);
    expect(p.channel).toBe(PORTAL_STATION_CHANNEL);
    expect(p.isResponse).toBe(0);
    expect(p.body).toEqual({
      account_id: "adminid",
      cmd: 1224,
      mValue3: 0,
      payload: { mode_type: 1, user_name: "synthetic00000" },
    });
  });

  it("reuses the station session across commands and serialises them", async () => {
    const { router, sessions } = makeRouter();
    await Promise.all([router.dispatchCommand(SN, arming(1)), router.dispatchCommand(SN, arming(2))]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sent).toHaveLength(2);
    expect(sent(sessions[0]!.sent[0]!).body).toMatchObject({ payload: { mode_type: 1 } });
    expect(sent(sessions[0]!.sent[1]!).body).toMatchObject({ payload: { mode_type: 2 } });
    // distinct segments, never 0 (the portal reserves it)
    expect(sent(sessions[0]!.sent[0]!).segment).not.toBe(sent(sessions[0]!.sent[1]!).segment);
  });

  it("routes an attached-device JSON intent through its parent's session and member identity", async () => {
    const { router, sessions } = makeRouter();
    try {
      await router.dispatchCommand(CAMERA, {
        kind: "set-json",
        param: 1400,
        data: { time: 0, type: 2, value: 0 },
        channel: 2,
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.opts.stationSn).toBe(SN);
      expect(sessions[0]!.opts.adminUserId).toBe("adminid");
      expect(sent(sessions[0]!.sent[0]!)).toMatchObject({
        commandId: 1700,
        channel: 2,
        isResponse: 0,
        body: { account_id: "adminid", cmd: 1400, commandType: 1400, data: { time: 0, type: 2, value: 0 } },
      });
    } finally {
      router.close();
    }
  });

  it("shares one station owner between a held media lease, attached commands and station commands", async () => {
    const { router, sessions } = makeRouter();
    const lease = await router.sessionFor(SN);
    try {
      await Promise.all([
        router.dispatchCommand(CAMERA, { kind: "set-json", param: 1400, data: { value: 1 }, channel: 2 }),
        router.dispatchCommand(SN, arming(1)),
        router.dispatchCommand(CAMERA, { kind: "set-payload", cmd: 1234, payload: {}, channel: 2 }),
      ]);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.closed).toBe(false);
      expect(sessions[0]!.sent.map((packet) => sent(packet).channel)).toEqual([2, 255, 2]);
      expect(sessions[0]!.sent.map((packet) => sent(packet).commandId)).toEqual([1700, 1350, 1350]);
    } finally {
      lease.release();
      router.close();
    }
  });

  it.each([-1, 1.5, 255, 256, NaN])("rejects attached channel %s before opening a session", async (channel) => {
    const { router, sessions } = makeRouter();
    await expect(router.dispatchCommand(CAMERA, { kind: "set-json", param: 1400, data: {}, channel })).rejects.toThrow(
      RangeError,
    );
    expect(sessions).toHaveLength(0);
  });

  it("rejects an unresolved or non-T9000 parent instead of opening a camera-owned session", async () => {
    for (const parent of [undefined, { ...station, model: "T8030" }]) {
      const { router, sessions } = makeRouter({ findDevice: (sn) => (sn === CAMERA ? camera : parent) });
      await expect(
        router.dispatchCommand(CAMERA, { kind: "set-json", param: 1400, data: {}, channel: 2 }),
      ).rejects.toThrow(/known T9000 station/);
      expect(sessions).toHaveLength(0);
    }
  });

  it("matches a JSON command ACK by command link, response envelope and segment without replay", async () => {
    const { router, sessions } = makeRouter();
    try {
      await router.dispatchCommand(SN, arming(1));
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAMERA, {
        kind: "set-json",
        param: 1400,
        data: { value: 0 },
        channel: 2,
      });
      let completed = false;
      void operation.then(() => {
        completed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const header = sent(session.sent[1]!);
      session.ackSegment(header.segment, 1350, 2);
      session.ackSegment(header.segment + 1, 1700, 2);
      session.ackSegment(header.segment, 1700, 2, 3);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(completed).toBe(false);
      session.ackSegment(header.segment, 1700, 2);
      await operation;
      expect(session.sent).toHaveLength(2);
    } finally {
      router.close();
    }
  });

  it("accepts a control result notification correlated by channel, parameter and segment", async () => {
    const { router, sessions } = makeRouter();
    try {
      await router.dispatchCommand(SN, arming(1));
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAMERA, {
        kind: "set-json",
        param: 6030,
        data: { cmd_type: 1, rotate_type: 1, zoom: 1 },
        channel: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const header = sent(session.sent[1]!);
      const body = Buffer.from(JSON.stringify({ cmd: 6030, payload: { limit: 0 } }));
      session.emit("commandData", Buffer.concat([buildPortalHeader(1351, body.length, 2, header.segment, 0), body]), 3);
      await operation;
      expect(session.sent).toHaveLength(2);
      expect(session.closed).toBe(false);
    } finally {
      router.close();
    }
  });

  it.each([
    { label: "wrong segment", segment: 99 },
    { label: "wrong channel", channel: 3 },
    { label: "wrong parameter", param: 6034 },
    { label: "wrong envelope", envelope: 1700 },
    { label: "command link", link: 1 },
    { label: "response flag", response: 1 },
    { label: "missing payload", payload: undefined },
    { label: "null payload", payload: null },
    { label: "array payload", payload: [] },
    { label: "scalar payload", payload: 1 },
  ])("does not complete a control command on $label", async (over) => {
    const { router, sessions } = makeRouter({ ackTimeoutMs: 20 });
    try {
      await router.dispatchCommand(SN, arming(1));
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAMERA, {
        kind: "set-json",
        param: 6030,
        data: { cmd_type: 1, rotate_type: 1, zoom: 1 },
        channel: 2,
      });
      const assertion = expect(operation).rejects.toThrow("ACK timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const header = sent(session.sent[1]!);
      const cfg = {
        segment: header.segment,
        channel: 2,
        param: 6030,
        envelope: 1351,
        link: 3,
        response: 0,
        payload: { limit: 0 },
        ...over,
      };
      const body = Buffer.from(JSON.stringify({ cmd: cfg.param, payload: cfg.payload }));
      session.emit(
        "commandData",
        Buffer.concat([buildPortalHeader(cfg.envelope, body.length, cfg.channel, cfg.segment, cfg.response), body]),
        cfg.link,
      );
      await assertion;
      expect(session.sent).toHaveLength(2);
      expect(session.listenerCount("commandData")).toBe(2);
      expect(session.closed).toBe(false);
    } finally {
      router.close();
    }
  });
  it("refuses an already expired facade deadline before acquiring a session", async () => {
    const { router, sessions } = makeRouter();
    await expect(router.dispatchCommand(SN, arming(1), { deadlineAtMs: Date.now() - 1 })).rejects.toThrow(
      "timed out before send",
    );
    expect(sessions).toHaveLength(0);
    router.close();
  });

  it("bounds a silent exchange by the remaining facade deadline without replay", async () => {
    const { router, sessions } = makeRouter({ commandTimeoutMs: 1_000, ackTimeoutMs: 1_000 });
    const lease = await router.sessionFor(SN);
    try {
      const session = sessions[0]!;
      session.behaviour = "silent";
      await expect(router.dispatchCommand(SN, arming(1), { deadlineAtMs: Date.now() + 20 })).rejects.toThrow(
        "after send; outcome unknown",
      );
      expect(session.sent).toHaveLength(1);
      expect(session.closed).toBe(false);
      expect(session.listenerCount("commandData")).toBe(1);
    } finally {
      lease.release();
      router.close();
    }
  });

  it("expires a queued command without transmitting it after the preceding information read completes", async () => {
    const { router, sessions } = makeRouter({ commandTimeoutMs: 15, ackTimeoutMs: 100 });
    try {
      const read = router.refreshInformation(SN, { timeoutMs: 200 });
      void read.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const session = sessions[0]!;
      expect(parsePortalHeader(session.sent[0]!)?.commandId).toBe(1103);
      await expect(
        router.dispatchCommand(CAMERA, {
          kind: "set-json",
          param: 1400,
          data: { value: 0 },
          channel: 2,
        }),
      ).rejects.toThrow(/timed out before send/);
      expect(session.sent).toHaveLength(1);
      expect(router.getCommandDiagnostics().lastFailure).toMatchObject({
        phase: "queue",
        outcome: "expired_before_send",
        sessionGeneration: 1,
        expectedChannel: 2,
        sendAttemptedAtMs: null,
        headerSamples: [],
      });
      const data = Buffer.from(JSON.stringify({ params: [] }));
      session.emit("commandData", Buffer.concat([buildPortalHeader(1103, data.length, 2, 0, 0), data]), 3);
      await read;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(session.sent).toHaveLength(1);
      await router.dispatchCommand(SN, arming(1));
      expect(session.sent).toHaveLength(2);
    } finally {
      router.close();
    }
  });

  it("bounds an in-flight ACK wait without replay, leaking listeners or closing another lease", async () => {
    const { router, sessions } = makeRouter({ commandTimeoutMs: 15, ackTimeoutMs: 100 });
    const lease = await router.sessionFor(SN);
    try {
      const session = sessions[0]!;
      session.behaviour = "silent";
      await expect(
        router.dispatchCommand(CAMERA, {
          kind: "set-json",
          param: 1400,
          data: { value: 0 },
          channel: 2,
        }),
      ).rejects.toThrow(/after send; outcome unknown/);
      expect(session.sent).toHaveLength(1);
      expect(session.closed).toBe(false);
      expect(session.listenerCount("commandData")).toBe(1);
      expect(session.listenerCount("close")).toBe(1);
      session.ackSegment(sent(session.sent[0]!).segment, 1700, 2);
      session.behaviour = "ack";
      await router.dispatchCommand(SN, arming(1));
      expect(session.sent).toHaveLength(2);
    } finally {
      lease.release();
      router.close();
    }
  });

  it("bounds stalled acquisition and releases only its own lease", async () => {
    FakeSession.connectMode = "hang";
    try {
      const { router, sessions } = makeRouter({ commandTimeoutMs: 10, connectTimeoutMs: 200 });
      await expect(router.dispatchCommand(SN, arming(1))).rejects.toThrow(/timed out before send/);
      expect(sessions[0]!.sent).toHaveLength(0);
      expect(sessions[0]!.closed).toBe(true);
      expect(sessions[0]!.eventNames()).toHaveLength(0);
      router.close();
    } finally {
      FakeSession.connectMode = "up";
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, 60001])(
    "refuses command deadline %s before acquiring a session",
    async (commandTimeoutMs) => {
      const { router, sessions } = makeRouter({ commandTimeoutMs });
      await expect(router.dispatchCommand(SN, arming(1))).rejects.toThrow(RangeError);
      expect(sessions).toHaveLength(0);
    },
  );

  it("rejects an ACK that carries a non-zero error code", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    sessions[0]!.behaviour = "nack";
    await expect(router.dispatchCommand(SN, arming(2))).rejects.toThrow(/rejected cmd 1224 \(err 1\)/);
  });

  it("rejects when the hub never ACKs, and when the session drops mid-flight", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    sessions[0]!.behaviour = "silent";
    await expect(router.dispatchCommand(SN, arming(2))).rejects.toThrow(/ACK timed out/);
    const { router: r2, sessions: s2 } = makeRouter();
    await r2.dispatchCommand(SN, arming(1));
    s2[0]!.behaviour = "close";
    await expect(r2.dispatchCommand(SN, arming(2))).rejects.toThrow(/session closed/);
  });

  it("does not let a late ACK for a timed-out command complete the next one", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    const s = sessions[0]!;
    s.behaviour = "silent";
    await expect(router.dispatchCommand(SN, arming(2))).rejects.toThrow(/ACK timed out/);
    const timedOut = sent(s.sent[1]!).segment;
    // B is in flight on the same session when A's ACK finally arrives: B must NOT resolve on it.
    const b = router.dispatchCommand(SN, arming(3));
    await new Promise((r) => setTimeout(r, 5));
    s.ackSegment(timedOut);
    await expect(b).rejects.toThrow(/ACK timed out/);
    expect(s.sent).toHaveLength(3); // nothing was replayed
  });

  it("fails the bring-up once, with the session closed, when connect() throws or never comes up", async () => {
    FakeSession.connectMode = "throw";
    try {
      const { router, sessions } = makeRouter();
      await expect(router.dispatchCommand(SN, arming(1))).rejects.toThrow(/sign refused/);
      expect(sessions[0]!.closed).toBe(true);
      FakeSession.connectMode = "never";
      const { router: r2, sessions: s2 } = makeRouter({ connectTimeoutMs: 30 });
      await expect(r2.dispatchCommand(SN, arming(1))).rejects.toThrow(/did not come up within 30ms/);
      expect(s2[0]!.closed).toBe(true);
      // connect() that never settles at all: the bounded bring-up's deadline still fires and closes it
      FakeSession.connectMode = "hang";
      const { router: r3, sessions: s3 } = makeRouter({ connectTimeoutMs: 30 });
      await expect(r3.dispatchCommand(SN, arming(1))).rejects.toThrow(/did not come up within 30ms/);
      expect(s3[0]!.closed).toBe(true);
      // the deadline has passed and the session is gone: a retry opens a fresh one instead of reusing it
      FakeSession.connectMode = "up";
      await r2.dispatchCommand(SN, arming(1));
      expect(s2).toHaveLength(2);
    } finally {
      FakeSession.connectMode = "up";
    }
  });

  it("opens a fresh session after the previous one closed", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    sessions[0]!.close();
    await router.dispatchCommand(SN, arming(2));
    expect(sessions).toHaveLength(2);
  });

  it("refuses to drive anything while logged out, and tears every session down on close()", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    router.close();
    expect(sessions[0]!.closed).toBe(true);
    const { router: out } = makeRouter({ identity: () => undefined });
    await expect(out.dispatchCommand(SN, arming(1))).rejects.toThrow(/not logged in/);
    vi.restoreAllMocks();
  });
});

it("does not advertise an unsupported optional control query or open a session", async () => {
  const { router, sessions } = makeRouter();
  try {
    expect(router.mediaProviderFor(CAMERA).p2pControlQuery).toBeUndefined();
    expect(sessions).toHaveLength(0);
  } finally {
    await router.close();
  }
});

describe("five target deadline contention", () => {
  it.each([false, true])("bounds five delayed acknowledgements, sequential=%s", async (sequential) => {
    vi.useFakeTimers();
    const { router, sessions } = makeRouter({ ackTimeoutMs: 8000, commandTimeoutMs: 14000 });
    const leasePromise = router.sessionFor(SN);
    await vi.advanceTimersByTimeAsync(0);
    const lease = await leasePromise;
    const packets: Buffer[] = [];
    vi.spyOn(sessions[0]!, "sendCommand").mockImplementation((packet) => {
      packets.push(packet);
      const header = parsePortalHeader(packet)!;
      setTimeout(() => sessions[0]!.ackSegment(header.segment, header.commandId, header.channel), 4000);
      return true;
    });
    const outcomes: string[] = [];
    const send = async (channel: number) => {
      try {
        await router.dispatchCommand(CAMERA, { ...arming(0), channel });
        outcomes.push("completed");
      } catch (error) {
        outcomes.push((error as Error).message);
      }
    };
    const pending = sequential
      ? (async () => {
          for (let n = 0; n < 5; n++) await send(n);
        })()
      : Promise.all([0, 1, 2, 3, 4].map(send));
    await vi.advanceTimersByTimeAsync(21000);
    await pending;
    expect(outcomes.filter((x) => x === "completed")).toHaveLength(sequential ? 5 : 3);
    if (!sequential) {
      expect(outcomes).toContain("RTC command timed out after send; outcome unknown");
      expect(outcomes).toContain("RTC command timed out before send");
    }
    expect(packets).toHaveLength(sequential ? 5 : 4);
    await vi.advanceTimersByTimeAsync(10000);
    expect(packets).toHaveLength(sequential ? 5 : 4);
    lease.release();
    router.close();
    vi.useRealTimers();
  });
});

describe("passive control operation evidence", () => {
  it.each([
    { code: -108, at: 10_200, outcome: "rejected" },
    { code: 0, at: 10_000, outcome: "success" },
  ])("accepts a correlated $code reply at $at ms after fallback readback misses", async ({ code, at, outcome }) => {
    vi.useFakeTimers();
    const { router, sessions } = makeRouter({ ackTimeoutMs: 8_000, commandTimeoutMs: 14_000 });
    try {
      const lease = await router.sessionFor(SN);
      lease.release();
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAMERA, passiveLight());
      const result = operation.then(
        () => "success",
        (error: Error) => {
          if (code !== 0) expect(error).toHaveProperty("code", code);
          return error.message;
        },
      );
      await vi.advanceTimersByTimeAsync(8_000);
      expect(session.sent.map((packet) => parsePortalHeader(packet)!.commandId)).toEqual([1700, 1103]);
      answerInformation(session);
      await vi.advanceTimersByTimeAsync(at - 8_000);
      const request = sent(session.sent[0]!);
      const body = Buffer.alloc(4);
      body.writeInt32LE(code);
      session.emit("commandData", Buffer.concat([buildPortalHeader(1700, 4, 2, request.segment, 1), body]), 1);
      expect(await result).toBe(code === 0 ? "success" : `rtc: ${SN} rejected cmd 1400 (err -108)`);
      expect(router.getCommandDiagnostics().recent.at(-1)).toMatchObject({
        outcome,
        matchedAcks: 1,
        rejectionCode: code || null,
        readbackAttempts: 1,
      });
      expect(session.sent.filter((packet) => parsePortalHeader(packet)!.commandId === 1700)).toHaveLength(1);
    } finally {
      router.close();
      vi.useRealTimers();
    }
  });

  it("keeps the ACK window open until 12 seconds when no reply follows mismatching readback", async () => {
    vi.useFakeTimers();
    const { router, sessions } = makeRouter({ ackTimeoutMs: 8_000, commandTimeoutMs: 14_000 });
    try {
      const lease = await router.sessionFor(SN);
      lease.release();
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAMERA, passiveLight());
      const rejected = expect(operation).rejects.toThrow("ACK timed out; outcome unknown");
      await vi.advanceTimersByTimeAsync(8_000);
      answerInformation(session);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(router.getCommandDiagnostics().completed).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(router.getCommandDiagnostics().lastFailure).toMatchObject({ outcome: "ack_timeout", elapsedMs: 12_000 });
      expect(session.sent.map((packet) => parsePortalHeader(packet)!.commandId)).toEqual([1700, 1103]);
    } finally {
      router.close();
      vi.useRealTimers();
    }
  });

  it("returns a late negative reply while its information read drains without aborting that read", async () => {
    vi.useFakeTimers();
    const { router, sessions } = makeRouter({ ackTimeoutMs: 8_000, commandTimeoutMs: 14_000 });
    try {
      const lease = await router.sessionFor(SN);
      lease.release();
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAMERA, passiveLight());
      const rejected = expect(operation).rejects.toThrow("(err -108)");
      await vi.advanceTimersByTimeAsync(10_200);
      const request = sent(session.sent[0]!);
      const body = Buffer.alloc(4);
      body.writeInt32LE(-108);
      session.emit("commandData", Buffer.concat([buildPortalHeader(1700, 4, 2, request.segment, 1), body]), 1);
      await rejected;
      expect(router.getCommandDiagnostics().lastFailure).toMatchObject({
        outcome: "rejected",
        rejectionCode: -108,
        elapsedMs: 10_200,
      });
      expect(session.closed).toBe(false);
      answerInformation(session);
      await vi.advanceTimersByTimeAsync(0);
      expect(router.informationRefreshReady(SN)).toBe(true);
      expect(session.sent.map((packet) => parsePortalHeader(packet)!.commandId)).toEqual([1700, 1103]);
    } finally {
      router.close();
      vi.useRealTimers();
    }
  });

  it("bounds both a silent ACK and a stalled fallback read by the original command deadline", async () => {
    vi.useFakeTimers();
    const { router, sessions } = makeRouter({ ackTimeoutMs: 8_000, commandTimeoutMs: 14_000 });
    try {
      const lease = await router.sessionFor(SN);
      lease.release();
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAMERA, passiveLight());
      const rejected = expect(operation).rejects.toThrow("ACK timed out; outcome unknown");
      await vi.advanceTimersByTimeAsync(14_000);
      await rejected;
      expect(router.getCommandDiagnostics().lastFailure).toMatchObject({ outcome: "ack_timeout", elapsedMs: 14_000 });
      expect(session.sent.map((packet) => parsePortalHeader(packet)!.commandId)).toEqual([1700, 1103]);
    } finally {
      router.close();
      vi.useRealTimers();
    }
  });

  it("lets authoritative readback confirmation finish before a late rejection", async () => {
    vi.useFakeTimers();
    const { router, sessions } = makeRouter({
      ackTimeoutMs: 8_000,
      commandTimeoutMs: 14_000,
      confirmsCommand: () => true,
    });
    try {
      const lease = await router.sessionFor(SN);
      lease.release();
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAMERA, passiveLight());
      await vi.advanceTimersByTimeAsync(8_000);
      answerInformation(session);
      await operation;
      await vi.advanceTimersByTimeAsync(2_200);
      const request = sent(session.sent[0]!);
      const body = Buffer.alloc(4);
      body.writeInt32LE(-108);
      session.emit("commandData", Buffer.concat([buildPortalHeader(1700, 4, 2, request.segment, 1), body]), 1);
      expect(router.getCommandDiagnostics().recent.at(-1)).toMatchObject({
        outcome: "success",
        matchedAcks: 0,
        confirmedByReadback: 1,
      });
      expect(session.sent.map((packet) => parsePortalHeader(packet)!.commandId)).toEqual([1700, 1103]);
    } finally {
      router.close();
      vi.useRealTimers();
    }
  });

  it("records first mismatches and signed rejection codes without changing ACK admission", async () => {
    const { router, sessions } = makeRouter({ ackTimeoutMs: 200 });
    try {
      await router.dispatchCommand(SN, arming(1));
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAMERA, {
        kind: "set-json",
        param: 1400,
        data: { value: 1 },
        channel: 2,
      });
      const rejected = expect(operation).rejects.toThrow("(err -17)");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const header = sent(session.sent[1]!);
      session.emit("commandData", Buffer.alloc(0), 1);
      session.ackSegment(header.segment + 1, 1700, 2);
      session.ackSegment(header.segment, 1700, 3);
      session.ackSegment(header.segment, 1700, 2, 2);
      session.ackSegment(header.segment, 1350, 2);
      session.emit(
        "commandData",
        Buffer.concat([buildPortalHeader(1700, 4, 2, header.segment, 0), Buffer.alloc(4)]),
        1,
      );
      for (const data of [
        { cmd: 1401, payload: {} },
        { cmd: 1400, payload: null },
      ]) {
        const body = Buffer.from(JSON.stringify(data));
        session.emit(
          "commandData",
          Buffer.concat([buildPortalHeader(1351, body.length, 2, header.segment, 0), body]),
          3,
        );
      }
      const code = Buffer.alloc(4);
      code.writeInt32LE(-17);
      session.emit("commandData", Buffer.concat([buildPortalHeader(1700, 4, 2, header.segment, 1), code]), 1);
      await rejected;
      const diagnostics = router.getCommandDiagnostics();
      expect(diagnostics).toMatchObject({ attempts: 2, completed: 2, failures: 1 });
      expect(diagnostics.lastFailure).toMatchObject({
        scope: "attached",
        command: 1400,
        envelope: 1700,
        phase: "exchange",
        outcome: "rejected",
        rejectionCode: -17,
        receivedFrames: 9,
        invalidFrames: 1,
        otherSegments: 1,
        otherChannels: 1,
        otherLinks: 1,
        otherEnvelopes: 1,
        otherResponseFlags: 1,
        otherParameters: 1,
        invalidResultPayloads: 1,
        matchedAcks: 1,
        matchedResults: 0,
      });
      expect(JSON.stringify(diagnostics)).not.toMatch(/T9000P|T8425P|adminid|synthetic-child-member/);
      expect(session.sent).toHaveLength(2);
      expect(session.listenerCount("commandData")).toBe(1);
    } finally {
      router.close();
    }
    expect(router.getCommandDiagnostics()).toMatchObject({ attempts: 0, recent: [] });
  });

  it("retains a timed out attempt and does not complete it on a late ACK", async () => {
    const { router, sessions } = makeRouter({ ackTimeoutMs: 20 });
    try {
      await router.dispatchCommand(SN, arming(1));
      const session = sessions[0]!;
      session.behaviour = "silent";
      await expect(
        router.dispatchCommand(CAMERA, { kind: "set-json", param: 1400, data: {}, channel: 2 }),
      ).rejects.toThrow("ACK timed out");
      const before = router.getCommandDiagnostics();
      expect(before.lastFailure).toMatchObject({ outcome: "ack_timeout", matchedAcks: 0, rejectionCode: null });
      expect(before.lastFailure).toMatchObject({ sessionGeneration: 1, expectedChannel: 2, headerSamples: [] });
      const header = sent(session.sent[1]!);
      session.ackSegment(header.segment, 1700, 2);
      const after = router.getCommandDiagnostics();
      expect(after.lastFailure).toMatchObject({ outcome: "ack_timeout", matchedAcks: 0, matchedResults: 0 });
      expect(after.lastFailure!.postTimeout!.headerSamples).toHaveLength(1);
      expect(before.lastFailure!.postTimeout!.headerSamples).toEqual([]);
      expect(session.sent).toHaveLength(2);
    } finally {
      router.close();
    }
  });

  it("retains wrong-segment ACK-shaped headers without accepting them or extending the ACK deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { router, sessions } = makeRouter({ ackTimeoutMs: 8_000, commandTimeoutMs: 20_000 });
    try {
      expect(router.getCommandTarget(CAMERA)).toBeUndefined();
      await router.dispatchCommand(SN, arming(1));
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAMERA, {
        kind: "set-json",
        param: 1400,
        data: { value: 0, unrelated: "synthetic-secret-command" },
        channel: 2,
      });
      const rejected = expect(operation).rejects.toThrow("ACK timed out; outcome unknown");
      await vi.advanceTimersByTimeAsync(0);
      const request = sent(session.sent[1]!);
      expect(router.getCommandTarget(CAMERA)).toEqual({ target: 2, latestCommandAttempt: 2 });
      for (let i = 0; i < 19; i++) session.ackSegment(request.segment + 1, 1700, 3, 2);
      session.ackSegment(request.segment + 1, 1700, 2);
      const body = Buffer.from(JSON.stringify({ cmd: 1400, payload: { secret: "synthetic-secret-response" } }));
      session.emit(
        "commandData",
        Buffer.concat([buildPortalHeader(1351, body.length, 2, request.segment + 1, 0), body]),
        3,
      );
      await vi.advanceTimersByTimeAsync(7_999);
      expect(router.getCommandDiagnostics().completed).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      const row = router.getCommandDiagnostics().lastFailure!;
      expect(row).toMatchObject({
        outcome: "ack_timeout",
        elapsedMs: 8_000,
        sessionGeneration: 1,
        expectedSegment: request.segment,
        expectedChannel: 2,
        receivedFrames: 21,
        otherSegments: 21,
        otherChannels: 0,
        otherLinks: 0,
        matchedAcks: 0,
        matchedResults: 0,
        headerSamplesEvicted: 5,
      });
      expect(row.headerSamples).toHaveLength(16);
      expect(row.headerSamples[0]).toMatchObject({
        receivedAtMs: 1_000,
        linkType: 2,
        envelope: 1700,
        channel: 3,
        response: 1,
        matchesSegment: false,
        matchesChannel: false,
        matchesLink: false,
        matchesEnvelope: true,
        matchesResponse: false,
      });
      expect(row.headerSamples.at(-1)).toMatchObject({
        envelope: 1351,
        innerCommand: 1400,
        errorCode: null,
        matchesSegment: false,
        matchesChannel: true,
        matchesLink: true,
        matchesEnvelope: true,
        matchesResponse: true,
        matchesInnerCommand: true,
      });
      expect(row.headerSamples.at(-2)).toMatchObject({
        linkType: 1,
        envelope: 1700,
        response: 1,
        errorCode: 0,
        matchesSegment: false,
        matchesChannel: true,
        matchesLink: true,
        matchesEnvelope: true,
        matchesResponse: true,
      });
      expect(JSON.stringify(row)).not.toMatch(/synthetic-secret|unrelated|payload|T9000P|T8425P/);
      const retained = router.getCommandDiagnostics();
      session.ackSegment(request.segment, 1700, 2);
      const late = router.getCommandDiagnostics().lastFailure!;
      expect(late).toMatchObject({ outcome: "ack_timeout", matchedAcks: 0, matchedResults: 0 });
      expect(late.headerSamples).toEqual(retained.lastFailure!.headerSamples);
      expect(late.postTimeout!.headerSamples).toHaveLength(1);
      expect(retained.lastFailure!.postTimeout!.headerSamples).toEqual([]);
      expect(session.sent).toHaveLength(2);
      expect(session.listenerCount("commandData")).toBe(2);
    } finally {
      router.close();
      vi.useRealTimers();
    }
  });

  it("clears command target associations and restarts anonymous generation numbering on lifecycle close", async () => {
    const { router, sessions } = makeRouter();
    try {
      await router.dispatchCommand(SN, arming(1));
      expect(router.getCommandDiagnostics().recent[0]!.sessionGeneration).toBe(1);
      expect(router.getCommandTarget(SN)).toEqual({ target: 1, latestCommandAttempt: 1 });
      router.close();
      expect(router.getCommandTarget(SN)).toBeUndefined();
      await router.dispatchCommand(SN, arming(1));
      expect(sessions).toHaveLength(2);
      expect(router.getCommandDiagnostics().recent[0]).toMatchObject({ attempt: 1, target: 1, sessionGeneration: 1 });
    } finally {
      router.close();
    }
  });

  it("keeps acquisition failures distinct and drops completions after lifecycle close", async () => {
    FakeSession.connectMode = "hang";
    const { router } = makeRouter({ connectTimeoutMs: 10 });
    try {
      await expect(router.dispatchCommand(SN, arming(1))).rejects.toThrow("did not come up");
      expect(router.getCommandDiagnostics().lastFailure).toMatchObject({
        phase: "acquisition",
        outcome: "connect_timeout",
        sendAttemptedAtMs: null,
        receivedFrames: 0,
      });
      const pending = router.dispatchCommand(SN, arming(1));
      const closed = expect(pending).rejects.toThrow();
      router.close();
      await closed;
      expect(router.getCommandDiagnostics()).toMatchObject({ attempts: 0, completed: 0, recent: [] });
    } finally {
      FakeSession.connectMode = "up";
      router.close();
    }
  });
});

describe("bounded state profile", () => {
  it.each([0, 1, 2, 3, 4])("serves five distinct targets when target %i never acknowledges", async (slow) => {
    vi.useFakeTimers();
    const { performance } = await import("node:perf_hooks");
    const wall = Date.now();
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => Date.now() - wall);
    try {
      const devices = Array.from(
        { length: 5 },
        (_, index) => ({ ...camera, sn: `T8425P000000000${index + 1}`, raw: { device_channel: index } }) as EufyDevice,
      );
      const { router, sessions } = makeRouter({
        findDevice: (sn) => (sn === SN ? station : devices.find((device) => device.sn === sn)),
      });
      const lease = await router.sessionFor(SN);
      lease.release();
      const session = sessions[0]!;
      const sendTimes: number[] = [];
      session.sendCommand = (packet: Buffer) => {
        session.sent.push(packet);
        const header = parsePortalHeader(packet)!;
        sendTimes.push(performance.now());
        if (header.channel !== slow)
          setTimeout(() => session.ackSegment(header.segment, header.commandId, header.channel), 4000);
        return true;
      };
      const calls = devices.map((device, index) =>
        router.dispatchCommandWithReceipt(
          device.sn,
          observeCommand(
            { kind: "set-json", param: 1400, data: { value: 1 }, channel: index },
            {
              event: "property changed",
              expected: 1,
              param: 1400,
              property: "enabled",
              passiveReadback: true,
              replaceableState: true,
              timeoutMs: 14000,
            },
          ),
          {
            execution: {
              profile: "bounded-state-v1",
              bornAtMs: 0,
              sendByMs: 60000,
              totalByMs: 72000,
              intent: index + 1,
            },
          },
        ),
      );
      const result = Promise.all(calls);
      await vi.advanceTimersByTimeAsync(28001);
      const receipts = await result;
      expect(receipts.filter((receipt) => receipt.status === "acknowledged")).toHaveLength(4);
      expect(receipts[slow]).toMatchObject({ status: "ack_timeout", sendAttempted: true, effect: "unknown" });
      expect(session.sent).toHaveLength(5);
      expect(session.sent.map((packet) => parsePortalHeader(packet)!.channel)).toEqual([0, 1, 2, 3, 4]);
      expect(new Set(session.sent.map((packet) => parsePortalHeader(packet)!.segment)).size).toBe(5);
      expect(sendTimes.at(-1)).toBeLessThanOrEqual(24000);
      expect(router.getCommandDiagnostics().queueWait.observations).toBe(5);
      expect(router.getCommandDiagnostics().scheduler[0]).toMatchObject({ active: 0, queued: 0 });
      router.close();
    } finally {
      monotonic.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retains a 10.8-second ACK and sends no inline information request", async () => {
    vi.useFakeTimers();
    const { performance } = await import("node:perf_hooks");
    const wall = Date.now();
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => Date.now() - wall);
    try {
      const { router, sessions } = makeRouter({ requestsCommandReadback: () => true });
      const lease = await router.sessionFor(SN);
      lease.release();
      const session = sessions[0]!;
      session.behaviour = "silent";
      const command = passiveLight();
      const observation = {
        event: "property changed",
        expected: 1,
        param: 1400,
        property: "enabled",
        passiveReadback: true,
        replaceableState: true,
        timeoutMs: 14000,
      };
      const result = router.dispatchCommandWithReceipt(CAMERA, observeCommand(command, observation), {
        execution: { profile: "bounded-state-v1", bornAtMs: 0, sendByMs: 60000, totalByMs: 72000 },
      });
      await vi.advanceTimersByTimeAsync(10800);
      expect(session.sent).toHaveLength(1);
      const header = parsePortalHeader(session.sent[0]!)!;
      session.ackSegment(header.segment, header.commandId, header.channel);
      expect(await result).toMatchObject({ status: "acknowledged", effect: "unconfirmed", sendAttempted: true });
      expect(session.sent).toHaveLength(1);
      router.close();
    } finally {
      monotonic.mockRestore();
      vi.useRealTimers();
    }
  });

  it("removes cancelled queued work and freezes unsent receipt evidence", async () => {
    const { performance } = await import("node:perf_hooks");
    const { router, sessions } = makeRouter();
    const lease = await router.sessionFor(SN);
    lease.release();
    const session = sessions[0]!;
    session.behaviour = "silent";
    const born = performance.now();
    const command = () =>
      observeCommand(passiveLight(), {
        event: "property changed",
        expected: 1,
        param: 1400,
        property: "enabled",
        passiveReadback: true,
        replaceableState: true,
        timeoutMs: 14000,
      });
    const controller = new AbortController();
    const firstController = new AbortController();
    const context = {
      profile: "bounded-state-v1" as const,
      bornAtMs: born,
      sendByMs: born + 60000,
      totalByMs: born + 72000,
    };
    const first = router.dispatchCommandWithReceipt(CAMERA, command(), {
      execution: { ...context, signal: firstController.signal },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const queued = router.dispatchCommandWithReceipt(CAMERA, command(), {
      execution: { ...context, signal: controller.signal },
    });
    controller.abort();
    const receipt = await queued;
    expect(receipt).toMatchObject({ status: "cancelled_before_send", sendAttempted: false });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(session.sent).toHaveLength(1);
    firstController.abort();
    expect(await first).toMatchObject({ status: "cancelled_after_send", effect: "unknown" });
    await new Promise((resolve) => setImmediate(resolve));
    session.close();
    expect(router.getCommandDiagnostics().scheduler).toHaveLength(0);
    expect(router.getCommandDiagnostics().schedulerTotals).toMatchObject({
      cancelledBeforeSend: 1,
      cancelledAfterSend: 1,
      active: 0,
      queued: 0,
    });
    router.close();
    expect(router.getCommandDiagnostics().schedulerTotals.cancelledBeforeSend).toBe(0);
  });
});

describe("bounded acquisition ownership", () => {
  it("keeps shared acquisition alive when one subscriber cancels", async () => {
    const { performance } = await import("node:perf_hooks");
    FakeSession.connectMode = "never";
    const { router, sessions } = makeRouter();
    try {
      const born = performance.now();
      const context = {
        profile: "bounded-state-v1" as const,
        bornAtMs: born,
        sendByMs: born + 60000,
        totalByMs: born + 72000,
      };
      const command = () =>
        observeCommand(passiveLight(), {
          event: "property changed",
          expected: 1,
          param: 1400,
          property: "enabled",
          passiveReadback: true,
          replaceableState: true,
          timeoutMs: 14000,
        });
      const controller = new AbortController();
      const first = router.dispatchCommandWithReceipt(CAMERA, command(), {
        execution: { ...context, signal: controller.signal },
      });
      const survivor = router.dispatchCommandWithReceipt(CAMERA, command(), { execution: context });
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      expect(await first).toMatchObject({ status: "cancelled_before_send", sendAttempted: false });
      const session = sessions[0]!;
      expect(session.closed).toBe(false);
      session.connected = true;
      session.emit("connected");
      expect(await survivor).toMatchObject({ status: "acknowledged", sendAttempted: true });
      expect(sessions).toHaveLength(1);
      expect(session.sent).toHaveLength(1);
    } finally {
      FakeSession.connectMode = "up";
      router.close();
    }
  });
});

describe("bounded terminal race", () => {
  it("keeps a correlated ACK that wins before cancellation", async () => {
    const { performance } = await import("node:perf_hooks");
    const { router, sessions } = makeRouter();
    const lease = await router.sessionFor(SN);
    lease.release();
    const session = sessions[0]!;
    session.behaviour = "silent";
    const born = performance.now();
    const controller = new AbortController();
    const command = observeCommand(passiveLight(), {
      event: "property changed",
      expected: 1,
      param: 1400,
      property: "enabled",
      passiveReadback: true,
      replaceableState: true,
      timeoutMs: 14000,
    });
    const result = router.dispatchCommandWithReceipt(CAMERA, command, {
      execution: {
        profile: "bounded-state-v1",
        bornAtMs: born,
        sendByMs: born + 60000,
        totalByMs: born + 72000,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const header = parsePortalHeader(session.sent[0]!)!;
    session.ackSegment(header.segment, header.commandId, header.channel);
    controller.abort();
    expect(await result).toMatchObject({ status: "acknowledged", sendAttempted: true, effect: "unconfirmed" });
    expect(session.listenerCount("commandData")).toBe(1);
    router.close();
  });
});

describe("bounded ACK deadline ordering", () => {
  it.each([11999, 12000])("settles the ACK/deadline race once at %i milliseconds", async (ackAt) => {
    vi.useFakeTimers();
    const { performance } = await import("node:perf_hooks");
    const wall = Date.now();
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => Date.now() - wall);
    try {
      const { router, sessions } = makeRouter();
      const lease = await router.sessionFor(SN);
      lease.release();
      const session = sessions[0]!;
      session.sendCommand = (packet) => {
        session.sent.push(packet);
        const header = parsePortalHeader(packet)!;
        setTimeout(() => session.ackSegment(header.segment, header.commandId, header.channel), ackAt);
        return true;
      };
      const command = observeCommand(passiveLight(), {
        event: "property changed",
        expected: 1,
        param: 1400,
        property: "enabled",
        passiveReadback: true,
        replaceableState: true,
        timeoutMs: 14000,
      });
      const result = router.dispatchCommandWithReceipt(CAMERA, command, {
        execution: { profile: "bounded-state-v1", bornAtMs: 0, sendByMs: 60000, totalByMs: 72000 },
      });
      await vi.advanceTimersByTimeAsync(12001);
      const receipt = await result;
      expect(receipt.status).toBe(ackAt < 12000 ? "acknowledged" : "ack_timeout");
      const header = parsePortalHeader(session.sent[0]!)!;
      session.ackSegment(header.segment, header.commandId, header.channel);
      expect(router.getCommandDiagnostics().completed).toBe(1);
      expect(router.getCommandDiagnostics().recent[0]!.terminalReason).toBe(receipt.status);
      expect(session.sent).toHaveLength(1);
      router.close();
      expect(session.listenerCount("commandData")).toBe(0);
      expect(session.listenerCount("close")).toBe(0);
    } finally {
      monotonic.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("mixed profile intent replacement", () => {
  it("replaces an older queued legacy state write with a newer bounded state write", async () => {
    const { performance } = await import("node:perf_hooks");
    const { router, sessions } = makeRouter();
    const lease = await router.sessionFor(SN);
    lease.release();
    const session = sessions[0]!;
    session.behaviour = "silent";
    const active = router.dispatchCommand(SN, arming(0));
    await new Promise((resolve) => setImmediate(resolve));
    let current = true;
    const old = router
      .dispatchCommand(CAMERA, passiveLight(), {
        intent: { replacementKey: "synthetic-state", isCurrent: () => current },
      })
      .catch((error) => error.reason);
    await new Promise((resolve) => setImmediate(resolve));
    current = false;
    const born = performance.now();
    const command = observeCommand(
      { kind: "set-json", param: 1400, data: { value: 0 }, channel: 2 },
      {
        event: "property changed",
        expected: 0,
        param: 1400,
        property: "enabled",
        passiveReadback: true,
        replaceableState: true,
        timeoutMs: 14000,
      },
    );
    const latest = router.dispatchCommandWithReceipt(CAMERA, command, {
      execution: {
        profile: "bounded-state-v1",
        bornAtMs: born,
        sendByMs: born + 60000,
        totalByMs: born + 72000,
        replacementKey: "synthetic-state",
        isCurrent: () => true,
      },
    });
    expect(await old).toBe("superseded_before_send");
    session.behaviour = "ack";
    const first = parsePortalHeader(session.sent[0]!)!;
    session.ackSegment(first.segment, first.commandId, first.channel);
    await active;
    expect(await latest).toMatchObject({ status: "acknowledged", sendAttempted: true });
    expect(session.sent).toHaveLength(2);
    expect(sent(session.sent[1]!).body.data).toEqual({ value: 0 });
    expect(router.getCommandDiagnostics().recent.find((row) => row.outcome === "superseded_before_send")).toMatchObject(
      { sendAttempted: false, sendAttemptedAtMs: null },
    );
    router.close();
  });
});
