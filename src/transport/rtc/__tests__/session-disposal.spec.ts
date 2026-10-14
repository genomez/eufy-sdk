import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RtcSession } from "../session.js";
import type { RtcPeer } from "../peer.js";
import type { RtcSignalingClient } from "../signaling.js";

function setup() {
  const signaling = Object.assign(new EventEmitter(), {
    isOpen: false,
    fetchSign: vi.fn(async () => ""),
    connect: vi.fn(async () => {}),
    close: vi.fn(),
    sendHangup: vi.fn(),
    sendCall: vi.fn(),
    sendInfoCandidate: vi.fn(),
  });
  const peer = Object.assign(new EventEmitter(), { close: vi.fn() });
  const session = new RtcSession({
    stationSn: "station",
    userId: "account",
    adminUserId: "member",
    authToken: "",
    shard: "us-pr",
    country: "US",
    authTimeoutMs: 20,
    createSignaling: () => signaling as unknown as RtcSignalingClient,
    createPeer: () => peer as unknown as RtcPeer,
  });
  return { session, signaling, peer };
}

describe("RTC session disposal", () => {
  it.each([false, true])(
    "does not answer after close during asynchronous negotiation (offer=%s)",
    async (duringOffer) => {
      const { session, signaling, peer } = setup();
      const pending = Promise.withResolvers<string>();
      const init = vi.fn(() => (duringOffer ? Promise.resolve() : pending.promise));
      const handleRemoteOffer = vi.fn(() => pending.promise);
      Object.assign(peer, { init, handleRemoteOffer, answerAsScallJson: vi.fn() });
      const sendInfoSdp = vi.fn();
      Object.assign(signaling, { sendInfoSdp });
      signaling.emit("message", { action: 3, dataType: "info", data: JSON.stringify({ sdp: "synthetic-offer" }) });
      await vi.waitFor(() => expect(duringOffer ? handleRemoteOffer : init).toHaveBeenCalled());
      session.close();
      pending.resolve("synthetic-answer");
      await Promise.resolve();
      await Promise.resolve();
      expect(sendInfoSdp).not.toHaveBeenCalled();
      if (!duringOffer) expect(handleRemoteOffer).not.toHaveBeenCalled();
    },
  );

  it("accepts authentication received before the socket connect promise settles", async () => {
    const { session, signaling } = setup();
    signaling.connect.mockImplementation(async () => {
      queueMicrotask(() => signaling.emit("message", { action: 1, code: 200 }));
    });
    try {
      await expect(session.connect()).resolves.toBeUndefined();
      expect(signaling.sendCall).toHaveBeenCalledOnce();
    } finally {
      session.close();
    }
  });

  it("closes on remote hangup even without a data body", async () => {
    const { session, signaling, peer } = setup();
    const closed = vi.fn();
    session.on("close", closed);
    peer.emit("commandChannelOpen");
    signaling.emit("message", { action: 3, dataType: "hangup" });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(session.isConnected).toBe(false);
  });

  it("notifies subscribers once on explicit close and ignores late channel events", () => {
    const { session, signaling, peer } = setup();
    const closed = vi.fn();
    const connected = vi.fn();
    session.on("close", closed);
    session.on("connected", connected);
    session.close();
    session.close();
    peer.emit("commandChannelOpen");
    peer.emit("iceCandidate", "candidate");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(connected).not.toHaveBeenCalled();
    expect(signaling.sendInfoCandidate).not.toHaveBeenCalled();
    expect(session.isConnected).toBe(false);
  });

  it("does not open signaling after a pending sign finishes on a closed session", async () => {
    const { session, signaling } = setup();
    const sign = Promise.withResolvers<string>();
    signaling.fetchSign.mockImplementation(() => sign.promise);
    const connecting = session.connect();
    const rejected = expect(connecting).rejects.toThrow(/closed/);
    session.close();
    sign.resolve("");
    await rejected;
    expect(signaling.connect).not.toHaveBeenCalled();
    expect(signaling.sendCall).not.toHaveBeenCalled();
  });

  it("closes signaling that finishes opening after disposal", async () => {
    const { session, signaling } = setup();
    const socket = Promise.withResolvers<void>();
    signaling.connect.mockImplementation(() => socket.promise);
    const connecting = session.connect();
    const rejected = expect(connecting).rejects.toThrow(/closed/);
    await vi.waitFor(() => expect(signaling.connect).toHaveBeenCalled());
    session.close();
    signaling.close.mockClear();
    socket.resolve();
    await rejected;
    expect(signaling.close).toHaveBeenCalledOnce();
    expect(signaling.sendCall).not.toHaveBeenCalled();
  });

  it("cancels the authentication wait on close instead of leaving its timer running", async () => {
    const { session, signaling } = setup();
    const baseline = signaling.listenerCount("message");
    const connecting = session.connect();
    const rejected = expect(connecting).rejects.toThrow(/closed/);
    await vi.waitFor(() => expect(signaling.listenerCount("message")).toBe(baseline + 1), { interval: 1 });
    session.close();
    await rejected;
    expect(signaling.listenerCount("message")).toBe(baseline);
    expect(signaling.sendCall).not.toHaveBeenCalled();
  });
});
