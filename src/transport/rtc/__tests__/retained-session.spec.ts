import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter } from "../command-router.js";
import type { RtcPeer } from "../peer.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";
import { RtcSession } from "../session.js";
import type { RtcInnerMessage, RtcSignalingClient } from "../signaling.js";

const SN = "T9000P0000000001";
const information = () => {
  const body = Buffer.from('{"params":[]}');
  return Buffer.concat([buildPortalHeader(1103, body.length, 0, 0, 0), body]);
};

/** Synthetic peer boundary; no native connection or frame capture is used. */
class Peer extends EventEmitter {
  response: "complete" | "ack-only" | "silent" = "complete";
  close = vi.fn();
  sendCommand = vi.fn((packet: Buffer) => {
    if (this.response === "silent") return true;
    const header = parsePortalHeader(packet)!;
    const ack = Buffer.concat([
      buildPortalHeader(header.commandId, 4, header.channel, header.segment, 1),
      Buffer.alloc(4),
    ]);
    setTimeout(() => this.emit("data", "command", ack, 1), 186);
    if (this.response === "complete") setTimeout(() => this.emit("data", "notify", information(), 3), 200);
    else {
      for (let i = 0; i < 9; i++) {
        const unrelated = buildPortalHeader(1200, 0, 0, i, 0);
        setTimeout(() => this.emit("data", "notify", unrelated, 3), 187 + i);
      }
    }
    return true;
  });
}

/** Distinct synthetic signaling endpoint for each real session instance. */
class Signaling extends EventEmitter {
  isOpen = false;
  fetchSign = vi.fn(async () => "synthetic-sign");
  connect = vi.fn(async () => {
    this.isOpen = true;
    this.hub({ action: 1, code: 200 });
  });
  sendCall = vi.fn(() => {
    if (this.autoOpen) this.peer.emit("commandChannelOpen");
  });
  sendHangup = vi.fn();
  close = vi.fn(() => {
    this.isOpen = false;
  });
  constructor(
    readonly peer: Peer,
    readonly autoOpen: boolean,
  ) {
    super();
  }
  hub(message: Omit<RtcInnerMessage, "data"> & { data?: Record<string, unknown> }) {
    this.emit("message", { ...message, data: message.data ? JSON.stringify(message.data) : undefined });
  }
  socketClosed() {
    this.isOpen = false;
    this.emit("close");
  }
}

/** Runs router and session ownership together while replacing only the network/peer boundary. */
function setup() {
  const instances: Array<{ session: RtcSession; signaling: Signaling; peer: Peer }> = [];
  const onFrame = vi.fn();
  const onError = vi.fn();
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "synthetic", userId: "synthetic-user" }),
    shard: () => "us-pr",
    accountName: () => "synthetic",
    findDevice: () => ({ sn: SN, stationSn: SN, model: "T9000" }) as EufyDevice,
    sessionRefreshMs: 270_000,
    idleCloseMs: 1_000_000,
    connectTimeoutMs: 12_000,
    onFrame,
    onError,
    createSession: (options) => {
      const peer = new Peer();
      const signaling = new Signaling(peer, instances.length !== 1);
      const session = new RtcSession({
        ...options,
        createSignaling: () => signaling as unknown as RtcSignalingClient,
        createPeer: () => peer as unknown as RtcPeer,
      });
      instances.push({ session, signaling, peer });
      return session;
    },
  });
  return { router, instances, onFrame, onError };
}

async function rejectCandidate(s: ReturnType<typeof setup>, ending: "socket" | "hangup" | "deadline") {
  const lease = await s.router.sessionFor(SN);
  lease.release();
  await vi.advanceTimersByTimeAsync(270_000);
  const candidate = s.instances[1]!;
  await vi.advanceTimersByTimeAsync(705);
  candidate.signaling.hub({ action: 3, dataType: "scall", data: { status: 486 } });
  await vi.advanceTimersByTimeAsync(0);
  if (ending === "socket") candidate.signaling.socketClosed();
  if (ending === "hangup") candidate.signaling.hub({ action: 3, dataType: "hangup" });
  await vi.advanceTimersByTimeAsync(ending === "deadline" ? 11_295 : 0);
}

describe("retained session after replacement signaling rejection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Network access prohibited in this test");
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(["socket", "hangup", "deadline"] as const)(
    "preserves current-session reads after candidate %s cleanup",
    async (ending) => {
      const s = setup();
      await rejectCandidate(s, ending);
      const original = s.instances[0]!;
      const candidate = s.instances[1]!;
      expect(s.router.getSessionRefreshDiagnostics().lastFailure).toMatchObject({
        phase: "connect",
        sessionError: "signaling_486",
        candidateCloseOrigin:
          ending === "socket" ? "signaling_closed" : ending === "hangup" ? "remote_hangup" : "local",
        failure: ending === "deadline" ? "connect_timeout" : "session_closed",
        elapsedMs: ending === "deadline" ? 12_000 : 705,
      });
      expect(original.peer.close).not.toHaveBeenCalled();
      expect(original.signaling.sendHangup).not.toHaveBeenCalled();
      expect(original.session.isConnected).toBe(true);
      expect(candidate.signaling.sendCall).toHaveBeenCalledTimes(1);
      expect(candidate.signaling.sendHangup).toHaveBeenCalledTimes(ending === "socket" ? 1 : 2);
      expect(s.onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_322);
      const read = s.router.refreshInformation(SN);
      await vi.advanceTimersByTimeAsync(200);
      await expect(read).resolves.toMatchObject({ notificationCorrelation: "temporal-only" });
      expect(original.peer.sendCommand).toHaveBeenCalledTimes(1);
      expect(candidate.peer.sendCommand).not.toHaveBeenCalled();
      expect(s.router.getReadDiagnostics().recent.at(-1)).toMatchObject({
        purpose: "current",
        outcome: "success",
        acknowledged: true,
        informationReceived: true,
      });
      expect(s.instances).toHaveLength(2);
      s.router.close();
      expect(vi.getTimerCount()).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("isolates candidate errors, closure and data while the original read is pending", async () => {
    const s = setup();
    const lease = await s.router.sessionFor(SN);
    lease.release();
    await vi.advanceTimersByTimeAsync(270_000);
    const original = s.instances[0]!;
    const candidate = s.instances[1]!;
    original.peer.response = "silent";
    const read = s.router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(0);
    candidate.signaling.hub({ action: 3, dataType: "scall", data: { status: 486 } });
    await vi.advanceTimersByTimeAsync(0);
    candidate.signaling.socketClosed();
    candidate.peer.emit("data", "notify", information(), 3);
    candidate.peer.emit("commandChannelOpen");
    await vi.advanceTimersByTimeAsync(0);
    expect(original.session.isConnected).toBe(true);
    expect(s.onFrame).not.toHaveBeenCalled();
    const header = parsePortalHeader(original.peer.sendCommand.mock.calls[0]![0])!;
    original.peer.emit(
      "data",
      "command",
      Buffer.concat([buildPortalHeader(1103, 4, 255, header.segment, 1), Buffer.alloc(4)]),
      1,
    );
    original.peer.emit("data", "notify", information(), 3);
    await expect(read).resolves.toMatchObject({ notificationCorrelation: "temporal-only" });
    expect(s.onError).not.toHaveBeenCalled();
    s.router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires information despite ACK and unrelated frames, retires the tainted generation and recovers on the next read", async () => {
    const s = setup();
    await rejectCandidate(s, "socket");
    const original = s.instances[0]!;
    original.peer.response = "ack-only";
    await vi.advanceTimersByTimeAsync(5_322);
    const read = s.router.refreshInformation(SN);
    const rejection = expect(read).rejects.toThrow("RTC information response timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    expect(s.router.getReadDiagnostics().lastFailure).toMatchObject({
      purpose: "current",
      outcome: "timeout",
      elapsedMs: 8_000,
      ackElapsedMs: 186,
      receivedFrames: 10,
      matchedAcknowledgments: 1,
      otherCommandFrames: 9,
      invalidPortalFrames: 0,
      informationFrames: 0,
      acknowledged: true,
      informationReceived: false,
    });
    expect(original.peer.close).toHaveBeenCalledTimes(1);
    expect(original.session.isConnected).toBe(false);
    expect(s.instances).toHaveLength(2);
    const nextRead = s.router.refreshInformation(SN);
    await vi.advanceTimersByTimeAsync(200);
    await expect(nextRead).resolves.toMatchObject({ notificationCorrelation: "temporal-only" });
    expect(s.instances).toHaveLength(3);
    expect(s.instances[2]!.peer.sendCommand).toHaveBeenCalledTimes(1);
    expect(original.peer.sendCommand).toHaveBeenCalledTimes(1);
    s.router.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["socket", "hangup", "deadline"] as const)(
    "recovers through a health-gated retry after candidate %s without reconnecting the original",
    async (ending) => {
      const s = setup();
      await rejectCandidate(s, ending);
      const failure = s.router.getSessionRefreshDiagnostics().lastFailure!;
      await vi.advanceTimersByTimeAsync(1);
      const read = s.router.refreshInformation(SN);
      await vi.advanceTimersByTimeAsync(200);
      await read;
      await vi.advanceTimersByTimeAsync(29_798);
      expect(s.instances).toHaveLength(2);
      expect(s.instances[0]!.session.isConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.instances).toHaveLength(3);
      expect(s.instances[0]!.peer.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(s.router.getSessionRefreshDiagnostics()).toMatchObject({ attempts: 2, successes: 1, failures: 1 });
      expect(s.router.getSessionRefreshDiagnostics().lastAttempt?.startedAtMs).toBe(failure.finishedAtMs + 30_000);
      expect(s.instances[0]!.peer.close).toHaveBeenCalledTimes(1);
      expect(s.instances[2]!.session.isConnected).toBe(true);
      expect(s.instances[2]!.signaling.sendCall).toHaveBeenCalledTimes(1);
      expect(s.instances[0]!.peer.sendCommand).toHaveBeenCalledTimes(1);
      expect(s.instances[2]!.peer.sendCommand).toHaveBeenCalledTimes(1);
      expect(s.onError).not.toHaveBeenCalled();
      expect(s.router.getSessionRefreshDiagnostics().lastFailure).toEqual(failure);
      s.router.close();
      expect(vi.getTimerCount()).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
