/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { RtcPeer, TurnConfig } from "../peer.js";
import { scallJsonToSdp } from "../scall-sdp.js";
import { RtcSession } from "../session.js";
import type { RtcInnerMessage, RtcSignalingClient } from "../signaling.js";
import { TransportEvidenceRecorder, type RtcTransportDiagnostics } from "../transport-diagnostics.js";

class FakeSignaling extends EventEmitter {
  isOpen = false;
  fetchSign = vi.fn(async () => "SIGN");
  connect = vi.fn(async () => {
    this.isOpen = true;
  });
  sendCall = vi.fn();
  sendAck = vi.fn();
  sendInfoSdp = vi.fn();
  sendInfoCandidate = vi.fn();
  sendHangup = vi.fn();
  close = vi.fn(() => {
    this.isOpen = false;
  });
  /** What the hub would send: an inner message with `data` as JSON text. */
  hub(inner: Omit<RtcInnerMessage, "data"> & { data?: Record<string, unknown> }): void {
    this.emit("message", { ...inner, data: inner.data ? JSON.stringify(inner.data) : undefined } as RtcInnerMessage);
  }
}

class FakePeer extends EventEmitter {
  init = vi.fn(async (_turn?: TurnConfig) => {});
  handleRemoteOffer = vi.fn(async (sdp: string) => `ANSWER<${sdp.length}>`);
  answerAsScallJson = vi.fn((sdp: string) => JSON.stringify({ answer: sdp }));
  addRemoteCandidate = vi.fn();
  sendCommand = vi.fn(() => true);
  sendRaw = vi.fn(() => true);
  readonly transportEvidence = new TransportEvidenceRecorder();
  getTransportDiagnostics = vi.fn(() => this.transportEvidence.snapshot(false, false));
  close = vi.fn();
  isCommandChannelReady = false;
}

const TURN: TurnConfig = { turn_addr: "203.0.113.13", turn_port: 3478, turn_user: "u", turn_password: "p" };
const HUB_SDP = {
  setup: "actpass",
  ice: { ufrag: "a", pwd: "b", fingerprint: "cd" },
  candidate: ["1 1 udp 1 192.168.1.10 1 typ host"],
};

function setup(overrides: { maxCallRetries?: number } = {}) {
  const sig = new FakeSignaling();
  const peer = new FakePeer();
  const sleeps: number[] = [];
  const session = new RtcSession({
    authToken: "T",
    userId: "u",
    stationSn: "T9000P0000000001",
    adminUserId: "a",
    shard: "eu-pr",
    country: "IT",
    createSignaling: () => sig as unknown as RtcSignalingClient,
    createPeer: () => peer as unknown as RtcPeer,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    authTimeoutMs: 100,
    ...overrides,
  });
  const errors: Error[] = [];
  session.on("error", (e) => errors.push(e));
  return { sig, peer, session, sleeps, errors };
}

async function authenticated(s: ReturnType<typeof setup>) {
  const connecting = s.session.connect();
  await vi.waitFor(() => expect(s.sig.connect).toHaveBeenCalled());
  s.sig.hub({ action: 1, code: 200 });
  await connecting;
  return s;
}

const flush = () => new Promise((r) => setImmediate(r));

describe("RtcSession", () => {
  it("forwards keepalive echoes separately from frames until the session closes", () => {
    const s = setup();
    const echo = vi.fn();
    const commandData = vi.fn();
    const mediaData = vi.fn();
    s.session.on("keepaliveEcho", echo);
    s.session.on("commandData", commandData);
    s.session.on("mediaData", mediaData);
    s.peer.emit("commandChannelOpen");
    s.peer.emit("keepaliveEcho");
    expect(echo).toHaveBeenCalledTimes(1);
    expect(commandData).not.toHaveBeenCalled();
    expect(mediaData).not.toHaveBeenCalled();
    s.session.close();
    s.peer.emit("keepaliveEcho");
    expect(echo).toHaveBeenCalledTimes(1);
  });

  it("signs, connects, waits for auth, then calls", async () => {
    const s = setup();
    const connecting = s.session.connect();
    await vi.waitFor(() => expect(s.sig.connect).toHaveBeenCalled());
    expect(s.sig.fetchSign).toHaveBeenCalledTimes(1);
    expect(s.sig.sendCall).not.toHaveBeenCalled();
    s.sig.hub({ action: 3, code: 200, dataType: "scall", data: { status: 100, turn: TURN } }); // not auth
    s.sig.hub({ action: 1, code: 200 });
    await connecting;
    expect(s.sig.sendCall).toHaveBeenCalledWith(0);
  });

  it("times out when the hub never authenticates", async () => {
    const s = setup();
    await expect(s.session.connect()).rejects.toThrow(/auth timeout/);
  });

  it("runs the whole exchange: grant → offer → answer → trickle → ack → open", async () => {
    const s = await authenticated(setup());
    const turn = vi.fn();
    s.session.on("turn", turn);
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 100, turn: TURN } });
    await flush();
    expect(turn).toHaveBeenCalledWith(TURN);
    expect(s.peer.init).toHaveBeenCalledWith(TURN);

    s.sig.hub({ action: 3, dataType: "info", data: { sdp: JSON.stringify(HUB_SDP) } });
    await flush();
    const offered = s.peer.handleRemoteOffer.mock.calls[0]![0];
    expect(offered).toContain("a=ice-ufrag:a");
    expect(offered).toBe(scallJsonToSdp(HUB_SDP, () => Number(offered.match(/o=- (\d+)/)![1])));
    expect(s.sig.sendInfoSdp).toHaveBeenCalledWith(JSON.stringify({ answer: `ANSWER<${offered.length}>` }), 0);
    // A second offer is ignored.
    s.sig.hub({ action: 3, dataType: "info", data: { sdp: JSON.stringify(HUB_SDP) } });
    await flush();
    expect(s.peer.handleRemoteOffer).toHaveBeenCalledTimes(1);

    s.sig.hub({ action: 3, dataType: "info", data: { candidate: "1 1 udp 1 192.168.1.10 2 typ host" } });
    s.sig.hub({
      action: 3,
      dataType: "info",
      data: { format: "CANDIDATE", value: "1 1 udp 1 192.168.1.10 3 typ host" },
    });
    s.sig.hub({ action: 3, dataType: "info", data: { candidate: "" } });
    await flush();
    expect(s.peer.addRemoteCandidate.mock.calls.map((c) => c[0])).toEqual([
      "1 1 udp 1 192.168.1.10 2 typ host",
      "1 1 udp 1 192.168.1.10 3 typ host",
    ]);

    s.peer.emit("iceCandidate", "our-host");
    s.peer.emit("iceGatheringComplete");
    // Candidates ride the session's own channel (0 here) — the same channel the SDP answer and ack use,
    // matching the portal, not a fixed channel 1.
    expect(s.sig.sendInfoCandidate.mock.calls).toEqual([
      ["our-host", 0],
      ["", 0],
    ]);

    s.sig.hub({ action: 3, dataType: "scall", data: { status: 200 } });
    await flush();
    expect(s.sig.sendAck).toHaveBeenCalledWith(0);

    const connected = vi.fn();
    s.session.on("connected", connected);
    s.peer.emit("commandChannelOpen");
    s.peer.emit("commandChannelOpen");
    expect(connected).toHaveBeenCalledTimes(1);
    expect(s.session.isConnected).toBe(true);

    const frames: Array<[string, number]> = [];
    const media: Array<[string, number]> = [];
    s.session.on("commandData", (f, lt) => frames.push([f.toString(), lt]));
    s.session.on("mediaData", (f, lt) => media.push([f.toString(), lt]));
    s.peer.emit("data", "notify", Buffer.from("XZYH"), 3);
    s.peer.emit("data", "video", Buffer.from("v"), 5);
    s.peer.emit("data", "playback", Buffer.from("p"), 4);
    expect(frames).toEqual([["XZYH", 3]]);
    expect(media).toEqual([
      ["v", 5],
      ["p", 4],
    ]);
    expect(s.session.sendCommand(Buffer.from("XZYH"))).toBe(true);
    expect(s.errors).toEqual([]);
  });

  it("initialises the peer without TURN when the hub offers before it grants", async () => {
    const s = await authenticated(setup());
    s.sig.hub({ action: 3, dataType: "info", data: { format: "SDP", value: JSON.stringify(HUB_SDP) } });
    await flush();
    expect(s.peer.init).toHaveBeenCalledWith();
    expect(s.peer.handleRemoteOffer).toHaveBeenCalledTimes(1);
  });

  it("backs off and calls again on 486/408, then gives up", async () => {
    const s = await authenticated(setup({ maxCallRetries: 2 }));
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 486 } });
    await flush();
    expect(s.sig.sendHangup).toHaveBeenCalledTimes(1);
    expect(s.peer.close).toHaveBeenCalledTimes(1);
    expect(s.sleeps).toEqual([10_000]);
    expect(s.sig.sendCall).toHaveBeenCalledTimes(2);
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 408 } });
    await flush();
    expect(s.sleeps).toEqual([10_000, 15_000]);
    expect(s.sig.sendCall).toHaveBeenCalledTimes(3);
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 486 } });
    await flush();
    expect(s.sig.sendCall).toHaveBeenCalledTimes(3);
    expect(s.errors.map((e) => e.message)).toEqual(["RTC scall 486 after 2 retries"]);
  });

  it("reports a lost peer or socket as close, and close() hangs up both sides once", async () => {
    const s = await authenticated(setup());
    const closed = vi.fn();
    s.session.on("close", closed);
    s.peer.emit("commandChannelOpen");
    s.peer.emit("connectionState", "failed");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(s.session.isConnected).toBe(false);
    s.session.close();
    s.session.close();
    expect(s.sig.sendHangup).toHaveBeenCalledTimes(1);
    expect(s.sig.close).toHaveBeenCalledTimes(1);
    expect(s.peer.close).toHaveBeenCalledTimes(1);
    s.sig.emit("close", 1000, "");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("stops reporting connected when the command channel closes under a live peer", async () => {
    const s = await authenticated(setup());
    const closed = vi.fn();
    s.session.on("close", closed);
    s.peer.emit("commandChannelOpen");
    expect(s.session.isConnected).toBe(true);
    s.peer.emit("commandChannelClosed");
    expect(s.session.isConnected).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
    s.peer.emit("commandChannelClosed");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it.each(["ordinary", "synchronous close", "observer throws", "hangup throws", "signaling throws", "peer throws"])(
    "terminates a granted peer-init failure with its original cause: %s",
    async (mode) => {
      const s = await authenticated(setup());
      const cause = new Error("synthetic native cause");
      const failure = new Error("synthetic peer initialization failure", { cause });
      const disposalFailure = new Error("synthetic disposal failure");
      const closed = vi.fn();
      s.session.on("close", closed);
      s.session.on("error", () => {
        expect(s.session.getConnectionDiagnostics().lastFailure?.stage).toBe("peer_init");
        if (mode === "synchronous close") s.session.close();
        if (mode === "observer throws") throw disposalFailure;
      });
      if (mode === "hangup throws")
        s.sig.sendHangup.mockImplementation(() => {
          throw disposalFailure;
        });
      if (mode === "signaling throws")
        s.sig.close.mockImplementation(() => {
          throw disposalFailure;
        });
      if (mode === "peer throws")
        s.peer.close.mockImplementation(() => {
          throw disposalFailure;
        });
      s.peer.init.mockRejectedValueOnce(failure);
      s.sig.hub({ action: 3, dataType: "scall", data: { status: 100, turn: TURN } });
      s.sig.hub({ action: 3, dataType: "info", data: { sdp: "synthetic queued offer" } });
      await flush();
      expect(s.errors).toEqual([failure]);
      expect(s.errors[0]).toBe(failure);
      expect(closed).toHaveBeenCalledExactlyOnceWith(failure);
      expect((closed.mock.calls[0]![0] as Error).cause).toBe(cause);
      expect(s.session.closeOrigin).toBe("peer_failed");
      expect(s.sig.sendHangup).toHaveBeenCalledTimes(1);
      expect(s.sig.close).toHaveBeenCalledTimes(1);
      expect(s.peer.close).toHaveBeenCalledTimes(1);
      s.sig.hub({ action: 3, dataType: "info", data: { sdp: "synthetic late offer" } });
      s.peer.emit("commandChannelOpen");
      s.peer.emit("iceCandidate", "synthetic candidate");
      s.session.close();
      await flush();
      expect(s.session.isConnected).toBe(false);
      expect(s.peer.handleRemoteOffer).not.toHaveBeenCalled();
      expect(s.sig.sendInfoSdp).not.toHaveBeenCalled();
      expect(s.sig.sendInfoCandidate).not.toHaveBeenCalled();
      expect(s.session.sendCommand(Buffer.from("synthetic"))).toBe(false);
      expect(closed).toHaveBeenCalledTimes(1);
    },
  );

  it("normalizes a non-Error peer-init rejection once for error and close", async () => {
    const s = await authenticated(setup());
    const closed = vi.fn();
    s.session.on("close", closed);
    s.peer.init.mockRejectedValueOnce("synthetic failure");
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 100, turn: TURN } });
    await flush();
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toBeInstanceOf(Error);
    expect(s.errors[0]!.message).toBe("synthetic failure");
    expect(closed).toHaveBeenCalledExactlyOnceWith(s.errors[0]);
    expect(s.session.closeOrigin).toBe("peer_failed");
  });

  it("disposes a granted peer completing after local closure without replacing the first origin", async () => {
    const s = await authenticated(setup());
    const init = Promise.withResolvers<void>();
    const closed = vi.fn();
    s.session.on("close", closed);
    s.peer.init.mockImplementationOnce(() => init.promise);
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 100, turn: TURN } });
    await flush();
    s.session.close();
    init.resolve();
    await flush();
    expect(s.peer.close).toHaveBeenCalledTimes(2);
    expect(s.session.closeOrigin).toBe("local");
    expect(s.errors).toEqual([]);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(s.session.isConnected).toBe(false);
  });
});

describe("session close origin", () => {
  it.each([
    "local",
    "signaling_closed",
    "remote_hangup",
    "command_channel_closed",
    "peer_failed",
    "peer_closed",
  ] as const)("retains the first %s origin through repeated disposal", async (origin) => {
    const s = await authenticated(setup());
    s.peer.emit("commandChannelOpen");
    expect(s.session.closeOrigin).toBeNull();
    const closed = vi.fn();
    s.session.on("close", closed);
    if (origin === "local") s.session.close();
    if (origin === "signaling_closed") s.sig.emit("close");
    if (origin === "remote_hangup") s.sig.hub({ action: 3, dataType: "hangup" });
    if (origin === "command_channel_closed") s.peer.emit("commandChannelClosed");
    if (origin === "peer_failed") s.peer.emit("connectionState", "failed");
    if (origin === "peer_closed") s.peer.emit("connectionState", "closed");
    await flush();
    s.session.close();
    s.sig.emit("close");
    s.peer.emit("connectionState", "failed");
    expect(s.session.closeOrigin).toBe(origin);
    expect(s.session.isConnected).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(s.peer.close).toHaveBeenCalledTimes(1);
    expect(s.sig.close).toHaveBeenCalledTimes(1);
  });
});

describe("session transport evidence", () => {
  it("detaches peer evidence and retains session routing, send arguments and close flags", () => {
    const s = setup();
    const packet = Buffer.from("synthetic-packet");
    const command = vi.fn();
    const media = vi.fn();
    s.session.on("commandData", command);
    s.session.on("mediaData", media);
    s.peer.emit("commandChannelOpen");
    s.peer.transportEvidence.init();
    s.peer.transportEvidence.nativeReceive("audio", packet.length);
    s.peer.transportEvidence.logicalFrame(3, packet.length);
    s.peer.emit("data", "audio", packet, 3);
    s.peer.emit("data", "notify", packet, 5);
    expect(command).toHaveBeenCalledWith(packet, 3);
    expect(media).toHaveBeenCalledWith(packet, 5);
    expect(s.session.sendCommand(packet)).toBe(true);
    expect(s.session.sendRaw(packet)).toBe(true);
    expect(s.peer.sendCommand).toHaveBeenCalledWith(packet);
    expect(s.peer.sendRaw).toHaveBeenCalledWith(packet);
    const snapshot = s.session.getTransportDiagnostics();
    expect(snapshot).toMatchObject({ channelReady: true, closed: false, transportEpoch: 1 });
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error("Missing synthetic peer evidence");
    snapshot.inbound.audio.packets = 999;
    expect(s.session.getTransportDiagnostics()?.inbound.audio.packets).toBe(1);
    s.session.close();
    s.peer.emit("data", "notify", packet, 3);
    s.peer.emit("data", "video", packet, 5);
    s.peer.emit("commandChannelOpen");
    expect(command).toHaveBeenCalledTimes(1);
    expect(media).toHaveBeenCalledTimes(1);
    expect(s.session.getTransportDiagnostics()).toMatchObject({ channelReady: false, closed: true });
    expect(s.session.sendCommand(packet)).toBe(false);
    expect(s.session.sendRaw(packet)).toBe(false);
    expect(s.peer.sendCommand).toHaveBeenCalledTimes(1);
    expect(s.peer.sendRaw).toHaveBeenCalledTimes(1);
  });

  it("whitelists optional peer evidence and tolerates a throwing diagnostic getter", () => {
    const s = setup();
    const peerSnapshot = Object.assign(s.peer.transportEvidence.snapshot(false, false), {
      remoteLabel: "synthetic-private-channel",
      payload: Buffer.from("synthetic-private-payload"),
    });
    Object.assign(peerSnapshot.inbound.other, { address: "synthetic-private-address" });
    s.peer.getTransportDiagnostics.mockReturnValue(peerSnapshot);
    expect(JSON.stringify(s.session.getTransportDiagnostics())).not.toMatch(
      /synthetic-private|remoteLabel|payload|address/,
    );
    s.peer.getTransportDiagnostics.mockImplementation(() => {
      throw new Error("synthetic-private-error");
    });
    s.peer.emit("commandChannelOpen");
    expect(() => s.session.getTransportDiagnostics()).not.toThrow();
    expect(s.session.getTransportDiagnostics()).toBeNull();
    expect(s.session.sendCommand(Buffer.from("synthetic"))).toBe(true);
    s.session.close();
    expect(s.session.getTransportDiagnostics()).toBeNull();
    s.peer.getTransportDiagnostics.mockReturnValue(peerSnapshot);
    expect(s.session.getTransportDiagnostics()).toMatchObject({ channelReady: false, closed: true });
  });

  it.each(["missing", "throwing", "malformed", "copy_error"] as const)(
    "returns null for %s peer evidence without inventing lifecycle flags or changing session work",
    (mode) => {
      const s = setup();
      const frame = Buffer.from("synthetic-packet");
      const command = vi.fn();
      const media = vi.fn();
      s.session.on("commandData", command);
      s.session.on("mediaData", media);
      if (mode === "missing") Reflect.deleteProperty(s.peer, "getTransportDiagnostics");
      if (mode === "throwing")
        s.peer.getTransportDiagnostics.mockImplementation(() => {
          throw new Error("synthetic-private-error");
        });
      if (mode === "malformed") s.peer.getTransportDiagnostics.mockReturnValue({} as RtcTransportDiagnostics);
      if (mode === "copy_error")
        s.peer.getTransportDiagnostics.mockReturnValue(
          Object.defineProperty(s.peer.transportEvidence.snapshot(false, false), "inbound", {
            get() {
              throw new Error("synthetic-private-accessor");
            },
          }),
        );
      expect(s.session.getTransportDiagnostics()).toBeNull();
      s.peer.emit("commandChannelOpen");
      expect(s.session.isConnected).toBe(true);
      expect(s.session.getTransportDiagnostics()).toBeNull();
      s.peer.emit("data", "audio", frame, 3);
      s.peer.emit("data", "notify", frame, 5);
      expect(command).toHaveBeenCalledWith(frame, 3);
      expect(media).toHaveBeenCalledWith(frame, 5);
      s.peer.sendCommand.mockReturnValueOnce(false);
      expect(s.session.sendCommand(frame)).toBe(false);
      expect(s.session.sendCommand(frame)).toBe(true);
      expect(s.peer.sendCommand).toHaveBeenCalledWith(frame);
      expect(s.session.sendRaw(frame)).toBe(true);
      expect(s.peer.sendRaw).toHaveBeenCalledWith(frame);
      const sentinel = new Error("synthetic-send-failure");
      s.peer.sendRaw.mockImplementationOnce(() => {
        throw sentinel;
      });
      let caught: unknown;
      try {
        s.session.sendRaw(frame);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
      s.session.close();
      expect(s.session.getTransportDiagnostics()).toBeNull();
      expect(s.session.isConnected).toBe(false);
      expect(s.session.sendCommand(frame)).toBe(false);
      expect(s.session.sendRaw(frame)).toBe(false);
      s.peer.emit("data", "notify", frame, 3);
      expect(command).toHaveBeenCalledTimes(1);
      expect(s.errors).toEqual([]);
    },
  );
});
