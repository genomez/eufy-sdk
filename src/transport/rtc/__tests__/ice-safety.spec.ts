import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { observeCommand } from "../../../core/contracts.js";
import { RtcCommandRouter } from "../command-router.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";
import { RtcSession, type RtcSessionOptions } from "../session.js";
import type { RtcPeer } from "../peer.js";
import type { RtcSignalingClient } from "../signaling.js";

type Mode = "up" | "error" | "close" | "throw" | "hang" | "silent";
const station = "T9000P0000000000";

class Session extends EventEmitter {
  isConnected = false;
  closed = false;
  information = true;
  sent: Buffer[] = [];
  attachIngressGuard() {}
  constructor(
    readonly options: RtcSessionOptions,
    readonly mode: Mode,
  ) {
    super();
  }
  async connect() {
    if (this.mode === "error") this.emit("error", Error("synthetic establishment failure"));
    else if (this.mode === "close") this.close();
    else if (this.mode === "throw") throw Error("synthetic establishment failure");
    else if (this.mode === "hang") await new Promise(() => {});
    else if (this.mode === "up") {
      this.isConnected = true;
      this.emit("connected");
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.isConnected = false;
    this.emit("close");
  }
  sendCommand(packet: Buffer) {
    if (!this.isConnected) return false;
    this.sent.push(packet);
    if (this.information)
      queueMicrotask(() => {
        const h = parsePortalHeader(packet)!;
        this.emit(
          "commandData",
          Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), Buffer.alloc(4)]),
          1,
        );
        const body = Buffer.from('{"params":[]}');
        this.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 0, 0, 0), body]), 3);
      });
    return true;
  }
}

const routers: RtcCommandRouter[] = [];
function setup(modes: Mode[], initialPolicy: "all" | "relay" = "all") {
  const sessions: Session[] = [];
  const config = { policy: initialPolicy };
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "synthetic-token", userId: "synthetic-user" }),
    shard: () => "us-pr",
    accountName: () => "synthetic-account",
    findDevice: () => ({ sn: station, stationSn: station, model: "T9000" }) as EufyDevice,
    icePolicyAtSessionCreation: () => config.policy,
    idleCloseMs: 1_000_000,
    createSession: (o) => {
      const s = new Session(o, modes[sessions.length] ?? "silent");
      sessions.push(s);
      return s as unknown as RtcSession;
    },
  });
  routers.push(router);
  return { router, sessions, config };
}
function owner(router: RtcCommandRouter) {
  return Reflect.get(router, "sessions").get(station);
}
function reconnect(router: RtcCommandRouter) {
  return Reflect.get(router, "reconnectPlayback").call(router, station, owner(router)) as Promise<{
    reconnectOutcome: string;
  }>;
}

function lightCommand() {
  return observeCommand(
    { kind: "set-json", param: 1400, data: { value: 1 }, channel: 0 },
    {
      event: "property changed",
      property: "enabled",
      param: 1400,
      expected: 1,
      passiveReadback: true,
      replaceableState: true,
      timeoutMs: 14_000,
    },
  );
}

function sendLight(router: RtcCommandRouter, scheduled: boolean, signal?: AbortSignal, isCurrent?: () => boolean) {
  const bornAtMs = Math.floor(performance.now());
  return router.dispatchCommandWithReceipt(
    station,
    lightCommand(),
    scheduled
      ? {
          execution: {
            profile: "bounded-state-v1",
            bornAtMs,
            sendByMs: bornAtMs + 60_000,
            totalByMs: bornAtMs + 72_000,
            signal,
            isCurrent,
          },
        }
      : { intent: { isCurrent } },
  );
}

describe("ICE safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    routers.splice(0).forEach((router) => router.close());
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([true, false])("sends pending and new commands after relay fallback (scheduled=%s)", async (scheduled) => {
    const f = setup(["silent", "silent"]);
    const first = sendLight(f.router, scheduled).catch((e: Error) => e);
    const queued = sendLight(f.router, scheduled).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(12_000);
    const arriving = sendLight(f.router, scheduled).catch((e: Error) => e);
    let current = true;
    const cancelled = sendLight(f.router, scheduled, undefined, () => current).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sessions.map((s) => s.options.peer?.icePolicy)).toEqual(["all", "relay"]);
    expect(f.sessions.every((s) => s.sent.length === 0)).toBe(true);
    current = false;
    f.sessions[1]!.isConnected = true;
    f.sessions[1]!.emit("connected");
    await vi.advanceTimersByTimeAsync(1);
    for (const result of await Promise.all([first, queued, arriving]))
      expect(result).toMatchObject({ status: "acknowledged", sendAttempted: true });
    expect(await cancelled).toMatchObject(
      scheduled ? { status: "superseded_before_send", sendAttempted: false } : { reason: "superseded_before_send" },
    );
    await expect(sendLight(f.router, scheduled)).resolves.toMatchObject({
      status: "acknowledged",
      sendAttempted: true,
    });
    expect(f.sessions[0]!.sent).toHaveLength(0);
    expect(f.sessions[1]!.sent).toHaveLength(4);
    expect(owner(f.router).scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("honors active and queued cancellations through fallback without closing the surviving command queue", async () => {
    const f = setup(["silent", "silent"]);
    const active = new AbortController();
    const queued = new AbortController();
    const first = sendLight(f.router, true, active.signal);
    const second = sendLight(f.router, true, queued.signal);
    const survivor = sendLight(f.router, true);
    await vi.advanceTimersByTimeAsync(12_000);
    active.abort();
    queued.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sessions).toHaveLength(2);
    f.sessions[1]!.isConnected = true;
    f.sessions[1]!.emit("connected");
    await vi.advanceTimersByTimeAsync(1);
    for (const result of await Promise.all([first, second]))
      expect(result).toMatchObject({ status: "cancelled_before_send", sendAttempted: false });
    expect(await survivor).toMatchObject({ status: "acknowledged", sendAttempted: true });
    expect(f.sessions[1]!.sent).toHaveLength(1);
  });

  it.each(["error", "close", "throw", "hang", "silent"] as const)(
    "shares one relay fallback after initial %s",
    async (mode) => {
      const f = setup([mode, "up"]);
      const a = f.router.sessionFor(station);
      const b = f.router.sessionFor(station);
      await vi.advanceTimersByTimeAsync(12_000);
      const [first, second] = await Promise.all([a, b]);
      expect(f.sessions.map((s) => s.options.peer?.icePolicy)).toEqual(["all", "relay"]);
      expect(first.session).toBe(f.sessions[1]);
      expect(second.session).toBe(first.session);
      expect(f.sessions[0]!.closed).toBe(true);
      first.release();
      second.release();
    },
  );

  it("stops after two bounded failed attempts without retrying the dynamic all policy", async () => {
    const f = setup(["silent", "hang"]);
    const pending = f.router.sessionFor(station).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(23_999);
    expect(f.sessions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeInstanceOf(Error);
    expect(f.sessions.every((s) => s.closed)).toBe(true);
    expect(owner(f.router)).toBeUndefined();
  });

  it.each(["abort", "reset"])("does not start fallback after %s", async (mode) => {
    const f = setup(["silent", "up"]);
    const controller = new AbortController();
    const pending = f.router.sessionFor(station, { signal: controller.signal }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1);
    if (mode === "abort") controller.abort();
    else f.router.close();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(await pending).toBeInstanceOf(Error);
    expect(f.sessions).toHaveLength(1);
  });

  it("keeps the original until a relay fallback connects and passes its information read", async () => {
    const f = setup(["up", "silent", "up"], "relay");
    (await f.router.sessionFor(station)).release();
    const original = owner(f.router);
    f.config.policy = "all";
    const pending = reconnect(f.router);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(owner(f.router)).toBe(original);
    expect(original.session.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ reconnectOutcome: "connected" });
    expect(f.sessions.map((s) => s.options.peer?.icePolicy)).toEqual(["relay", "all", "relay"]);
    expect(owner(f.router).session).toBe(f.sessions[2]);
    expect(f.sessions[0]!.closed).toBe(true);
  });

  it("preserves the original after both replacement attempts fail and refuses unsafe media", async () => {
    const f = setup(["up", "silent", "hang"], "relay");
    (await f.router.sessionFor(station)).release();
    const original = owner(f.router);
    f.config.policy = "all";
    const pending = reconnect(f.router);
    await vi.advanceTimersByTimeAsync(24_000);
    expect(await pending).toMatchObject({ reconnectOutcome: "failed" });
    expect(owner(f.router)).toBe(original);
    expect(original.session.isConnected).toBe(true);
    expect(f.sessions.slice(1).every((s) => s.closed)).toBe(true);
    expect(f.router.getPlaybackSafetyDiagnostics().unresolved).toBe(true);
    const lease = await f.router.sessionFor(station);
    expect(lease.session).toBe(original.session);
    lease.release();
    expect(f.sessions).toHaveLength(3);
  });

  it("never adopts an unverified relay fallback and bounds the whole replacement", async () => {
    const f = setup(["up", "silent", "up"], "relay");
    (await f.router.sessionFor(station)).release();
    const original = owner(f.router);
    f.config.policy = "all";
    const pending = reconnect(f.router);
    await vi.advanceTimersByTimeAsync(11_999);
    const create = Reflect.get(f.router, "deps").createSession;
    Reflect.get(f.router, "deps").createSession = (o: RtcSessionOptions) => {
      const s = create(o) as unknown as Session;
      s.information = false;
      return s;
    };
    await vi.advanceTimersByTimeAsync(18_001);
    expect(await pending).toMatchObject({ reconnectOutcome: "failed" });
    expect(owner(f.router)).toBe(original);
    expect(f.sessions[2]!.closed).toBe(true);
    expect(original.session.isConnected).toBe(true);
  });

  it("exposes the actual connection deadline and policy in sanitized terminal diagnostics", async () => {
    const f = setup([]);
    const deps = Reflect.get(f.router, "deps");
    deps.createSession = (o: RtcSessionOptions) => {
      const peer = Object.assign(new EventEmitter(), { close: vi.fn() });
      const sig = Object.assign(new EventEmitter(), {
        isOpen: true,
        fetchSign: async () => "synthetic-sign",
        connect: async () => {
          sig.emit("message", { action: 1, code: 200 });
        },
        sendCall: () => {
          if (o.peer?.icePolicy === "relay") peer.emit("commandChannelOpen");
        },
        sendHangup: vi.fn(),
        close: vi.fn(),
      });
      return new RtcSession({
        ...o,
        createPeer: () => peer as unknown as RtcPeer,
        createSignaling: () => sig as unknown as RtcSignalingClient,
      });
    };
    const pending = f.router.sessionFor(station);
    await vi.advanceTimersByTimeAsync(12_000);
    (await pending).release();
    const d = f.router.getConnectionDiagnostics();
    expect(d.terminal[0]).toMatchObject({
      outcome: "connect_timeout",
      stages: { establishment: { policy: "all", deadlines: [{ kind: "connection", atMs: 12_000 }] } },
    });
    expect(d.active[0]!.stages?.establishment?.policy).toBe("relay");
    for (const secret of [station, "synthetic-user", "synthetic-token", "synthetic-sign"])
      expect(JSON.stringify(d)).not.toContain(secret);
  });
});
