/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { describe, expect, it, vi } from "vitest";
import { PassthroughFramer, type FramingDiagnostics, type PortalFramer } from "../framer.js";
import { PortalLinkType } from "../portal-packet.js";
import { packetize, PtcsChannel, PtcsFramer } from "../ptcs-framer.js";
import {
  COMMAND_CHANNEL,
  DATA_CHANNEL_LABELS,
  RtcPeer,
  type NativeDataChannel,
  type NativePeerConfig,
  type NativePeerConnection,
  type RtcPeerOptions,
} from "../peer.js";
import { ANKER_MAX_MESSAGE_SIZE, scallJsonToSdp } from "../scall-sdp.js";
import { copyRtcTransportDiagnostics, TransportEvidenceRecorder } from "../transport-diagnostics.js";

class FakeDc implements NativeDataChannel {
  open = false;
  sent: Buffer[] = [];
  private cbs: Record<string, ((...a: never[]) => void) | undefined> = {};
  constructor(
    readonly label: string,
    readonly config?: { id?: number },
  ) {}
  getLabel(): string {
    return this.label;
  }
  isOpen(): boolean {
    return this.open;
  }
  sendResult = true;
  sendError: unknown;
  sendMessageBinary(buffer: Buffer | Uint8Array): boolean {
    this.sent.push(Buffer.from(buffer));
    if (this.sendError !== undefined) throw this.sendError;
    return this.sendResult;
  }
  close(): void {
    this.open = false;
  }
  onOpen(cb: () => void): void {
    this.cbs.open = cb;
  }
  onClosed(cb: () => void): void {
    this.cbs.closed = cb;
  }
  onError(cb: (err: string) => void): void {
    this.cbs.error = cb as never;
  }
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void {
    this.cbs.message = cb as never;
  }
  fireOpen(): void {
    this.open = true;
    (this.cbs.open as (() => void) | undefined)?.();
  }
  fireMessage(msg: Buffer): void {
    (this.cbs.message as ((m: Buffer) => void) | undefined)?.(msg);
  }
  fireClosed(): void {
    this.open = false;
    (this.cbs.closed as (() => void) | undefined)?.();
  }
}

class FakePc implements NativePeerConnection {
  readonly channels: FakeDc[] = [];
  remote?: { sdp: string; type: string };
  candidates: Array<[string, string]> = [];
  closed = false;
  local: { type: string; sdp: string } | null = null;
  private cbs: Record<string, ((...a: never[]) => void) | undefined> = {};
  close(): void {
    this.closed = true;
  }
  setRemoteDescription(sdp: string, type: "offer" | "answer"): void {
    this.remote = { sdp, type };
  }
  localDescription(): { type: string; sdp: string } | null {
    return this.local;
  }
  addRemoteCandidate(candidate: string, mid: string): void {
    this.candidates.push([candidate, mid]);
  }
  createDataChannel(label: string, config?: { id?: number }): NativeDataChannel {
    const dc = new FakeDc(label, config);
    this.channels.push(dc);
    return dc;
  }
  onLocalDescription(cb: (sdp: string, type: string) => void): void {
    this.cbs.local = cb as never;
  }
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
    this.cbs.cand = cb as never;
  }
  onStateChange(cb: (state: string) => void): void {
    this.cbs.state = cb as never;
  }
  onGatheringStateChange(cb: (state: string) => void): void {
    this.cbs.gather = cb as never;
  }
  onDataChannel(cb: (dc: NativeDataChannel) => void): void {
    this.cbs.dc = cb as never;
  }
  fireLocalAnswer(sdp: string): void {
    (this.cbs.local as ((s: string, t: string) => void) | undefined)?.(sdp, "answer");
  }
  fireLocalCandidate(c: string): void {
    (this.cbs.cand as ((c: string, m: string) => void) | undefined)?.(c, "2");
  }
  fireGathering(state: string): void {
    (this.cbs.gather as ((s: string) => void) | undefined)?.(state);
  }
  fireState(state: string): void {
    (this.cbs.state as ((s: string) => void) | undefined)?.(state);
  }
  fireDataChannel(dc: NativeDataChannel): void {
    (this.cbs.dc as ((dc: NativeDataChannel) => void) | undefined)?.(dc);
  }
}

const HOST = "1 1 udp 2130706431 192.168.1.10 47470 typ host";
const SRFLX = "2 1 udp 1694498815 203.0.113.10 47470 typ srflx raddr 192.168.1.10 rport 47470";
const OFFER = scallJsonToSdp({
  setup: "actpass",
  ice: { ufrag: "u", pwd: "p", fingerprint: "ab" },
  candidate: [HOST, SRFLX],
});
const ANSWER =
  "v=0\r\na=setup:passive\r\na=ice-ufrag:x\r\na=ice-pwd:y\r\na=fingerprint:sha-256 aa:bb\r\na=max-message-size:65536\r\n";

function setup(
  icePolicy: "host-only" | "all" = "host-only",
  createFramer = (): PortalFramer => new PassthroughFramer(),
  opts: Pick<RtcPeerOptions, "receiveTimingNow" | "logger"> = {},
) {
  let pc!: FakePc;
  let config!: NativePeerConfig;
  const peer = new RtcPeer({
    icePolicy,
    createPeer: (_name, cfg) => {
      config = cfg;
      pc = new FakePc();
      return pc;
    },
    createFramer,
    answerTimeoutMs: 200,
    ...opts,
  });
  return { peer, pc: () => pc, config: () => config };
}

describe("RtcPeer", () => {
  it("builds a host-only peer with no ICE servers and the hub's max message size", async () => {
    const { peer, config } = setup();
    await peer.init({ turn_addr: "t", turn_port: 3478, turn_user: "u", turn_password: "p" });
    expect(config()).toEqual({
      iceServers: [],
      iceTransportPolicy: "all",
      maxMessageSize: ANKER_MAX_MESSAGE_SIZE,
      enableIceTcp: true,
    });
    const all = setup("all");
    await all.peer.init({
      turn_addr: "t",
      turn_port: 3478,
      turn_user: "u",
      turn_password: "p",
      alt_turn_addr: "t2",
      alt_turn_port: 3479,
    });
    expect(all.config().iceServers.map((s) => `${s.relayType}@${s.hostname}:${s.port}`)).toEqual([
      "TurnUdp@t:3478",
      "TurnTcp@t:3478",
      "TurnUdp@t2:3479",
      "TurnTcp@t2:3479",
    ]);
  });

  it("answers the hub's offer: declares the portal's channels, strips non-host candidates, pins the size", async () => {
    const { peer, pc } = setup();
    await peer.init();
    const answering = peer.handleRemoteOffer(OFFER);
    expect(pc().channels.map((c) => c.label)).toEqual([...DATA_CHANNEL_LABELS]);
    expect(pc().remote?.type).toBe("offer");
    expect(pc().remote?.sdp).toContain(HOST);
    expect(pc().remote?.sdp).not.toContain("typ srflx");
    pc().fireLocalAnswer(ANSWER);
    const answer = await answering;
    expect(answer).toContain(`a=max-message-size:${ANKER_MAX_MESSAGE_SIZE}`);
    expect(pc().channels.map((c) => c.config?.id)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(pc().remote?.sdp).toContain("a=setup:passive"); // we pin the hub passive, so we answer active
    expect(JSON.parse(peer.answerAsScallJson(answer))).toEqual({
      setup: "passive",
      ice: { ufrag: "x", pwd: "y", fingerprint_type: "sha-256", fingerprint: "aabb" },
    });
  });

  it("pins our DTLS role by pinning the complement into the hub's offer, not by editing the answer", async () => {
    // The role has to be pinned where it is DECIDED. Rewriting our own answer changes only what we
    // announce, never the role libdatachannel plays, and announcing a role we are not playing deadlocks
    // the handshake. Pinning the offer leaves exactly one legal answer, so the two always agree.
    // The default is `active` — the role the portal plays, and the one whose even stream ids the hub
    // pairs with.
    const dflt = setup();
    await dflt.peer.init();
    const a = dflt.peer.handleRemoteOffer(OFFER);
    expect(dflt.pc().remote?.sdp).toContain("a=setup:passive");
    expect(dflt.pc().channels.map((c) => c.config?.id)).toEqual([0, 2, 4, 6, 8, 10]);
    dflt.pc().fireLocalAnswer(ANSWER);
    await a;

    let loose!: FakePc;
    const peer = new RtcPeer({
      createPeer: () => (loose = new FakePc()),
      createFramer: () => new PassthroughFramer(),
      answerTimeoutMs: 200,
      dataChannelIds: "auto",
      dtlsRole: undefined, // leave the hub's actpass alone
    });
    await peer.init();
    const answering = peer.handleRemoteOffer(OFFER);
    expect(loose.remote?.sdp).toContain("a=setup:actpass");
    expect(loose.channels.map((c) => c.config?.id)).toEqual(new Array(DATA_CHANNEL_LABELS.length).fill(undefined));
    loose.fireLocalAnswer(ANSWER);
    await answering;
  });

  it("uses an answer libdatachannel already produced, and times out when it never does", async () => {
    const { peer, pc } = setup();
    await peer.init();
    const early = setup();
    await early.peer.init();
    early.pc().local = { type: "answer", sdp: ANSWER };
    await expect(early.peer.handleRemoteOffer(OFFER)).resolves.toContain("a=setup:passive");
    await expect(peer.handleRemoteOffer(OFFER)).rejects.toThrow(/local SDP answer/);
    expect(pc().closed).toBe(false);
  });

  it("queues remote candidates until the offer is applied, and filters both directions by policy", async () => {
    const { peer, pc } = setup();
    await peer.init();
    peer.addRemoteCandidate(HOST);
    peer.addRemoteCandidate(SRFLX);
    expect(pc().candidates).toEqual([]);
    const answering = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answering;
    expect(pc().candidates).toEqual([[HOST, "2"]]);
    peer.addRemoteCandidate("3 1 udp 1 10.0.0.9 5 typ host");
    expect(pc().candidates).toHaveLength(2);
    const local: string[] = [];
    peer.on("iceCandidate", (c) => local.push(c));
    pc().fireLocalCandidate(SRFLX);
    pc().fireLocalCandidate(HOST);
    pc().fireLocalCandidate("");
    expect(local).toEqual([HOST]);
    const done = vi.fn();
    peer.on("iceGatheringComplete", done);
    pc().fireGathering("in-progress");
    pc().fireGathering("complete");
    pc().fireGathering("complete");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("opens the command path once the channel opens, sends through the framer, and surfaces inbound frames", async () => {
    const { peer, pc } = setup();
    await peer.init();
    const answering = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answering;
    const cmd = pc().channels.find((c) => c.label === COMMAND_CHANNEL)!;
    expect(peer.isCommandChannelReady).toBe(false);
    expect(peer.sendCommand(Buffer.from("XZYH-not-open-yet!"))).toBe(false);
    const opened = vi.fn();
    peer.on("commandChannelOpen", opened);
    cmd.fireOpen();
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(peer.isCommandChannelReady).toBe(true);
    const packet = Buffer.from("XZYHcommand");
    expect(peer.sendCommand(packet)).toBe(true);
    expect(cmd.sent).toEqual([packet]);
    const frames: Array<[string, string, number]> = [];
    peer.on("data", (label, frame, lt) => frames.push([label, frame.toString(), lt]));
    cmd.fireMessage(Buffer.from("XZYHreply-16-bytes"));
    const notify = pc().channels.find((c) => c.label === "notify")!;
    notify.fireMessage(Buffer.from("XZYHpush--16-bytes"));
    const video = pc().channels.find((c) => c.label === "video")!;
    video.fireMessage(Buffer.from("XZYHvideo-16-byte!"));
    video.fireMessage(Buffer.from("raw"));
    // Every channel feeds the framer; the passthrough framer tags all of them as command frames, and
    // a three-byte message is not a portal packet at all.
    expect(frames).toEqual([
      [COMMAND_CHANNEL, "XZYHreply-16-bytes", 1],
      [COMMAND_CHANNEL, "XZYHpush--16-bytes", 1],
      [COMMAND_CHANNEL, "XZYHvideo-16-byte!", 1],
    ]);
    const states: string[] = [];
    peer.on("connectionState", (s) => states.push(s));
    pc().fireState("connected");
    expect(states).toEqual(["connected"]);
    peer.close();
    expect(pc().closed).toBe(true);
    expect(peer.isCommandChannelReady).toBe(false);
  });

  it("rejects a pending local answer when the peer is closed instead of dropping it", async () => {
    const { peer } = setup();
    await peer.init();
    const answering = peer.handleRemoteOffer(OFFER);
    peer.close();
    await expect(answering).rejects.toThrow(/closed while waiting for the local SDP answer/);
  });

  it("announces the command channel closing so a caller stops believing it is ready", async () => {
    const { peer, pc } = setup();
    await peer.init();
    const answering = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answering;
    const cmd = pc().channels.find((c) => c.label === COMMAND_CHANNEL)!;
    cmd.fireOpen();
    await vi.waitFor(() => expect(peer.isCommandChannelReady).toBe(true));
    const closed = vi.fn();
    peer.on("commandChannelClosed", closed);
    // a non-command channel closing says nothing about the session
    pc()
      .channels.find((c) => c.label === "notify")!
      .fireClosed();
    expect(closed).not.toHaveBeenCalled();
    cmd.fireClosed();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(peer.isCommandChannelReady).toBe(false);
    cmd.fireClosed();
    expect(closed).toHaveBeenCalledTimes(1); // once, not per event
  });

  it("reports a refused native send as a failed command instead of a silent success", async () => {
    const { peer, pc } = setup();
    await peer.init();
    const answering = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answering;
    const cmd = pc().channels.find((c) => c.label === COMMAND_CHANNEL)!;
    cmd.fireOpen();
    await vi.waitFor(() => expect(peer.isCommandChannelReady).toBe(true));
    expect(peer.sendCommand(Buffer.from("XZYHok----------"))).toBe(true);
    cmd.sendResult = false; // the native channel refuses the wire packet
    expect(peer.sendCommand(Buffer.from("XZYHrefused-----"))).toBe(false);
  });

  it("refuses to work before init and to handle two offers at once", async () => {
    const { peer, pc } = setup();
    await expect(peer.handleRemoteOffer(OFFER)).rejects.toThrow(/not initialised/);
    await peer.init();
    const first = peer.handleRemoteOffer(OFFER);
    await expect(peer.handleRemoteOffer(OFFER)).rejects.toThrow(/already handling/);
    pc().fireLocalAnswer(ANSWER);
    await first;
  });
});

describe("RTC passive receive timing", () => {
  it("invalidates old logical timing when replacement-framer timing initialization throws", async () => {
    const first = new EvidenceFramer();
    const replacement = new EvidenceFramer();
    let created = 0;
    const s = setup("host-only", () => (created++ === 0 ? first : replacement), { receiveTimingNow: () => 2 });
    const frame = Buffer.from("XZYH012345678901");
    const originalInit = first.init.bind(first);
    const sentinel = new Error("synthetic-framer-init-error");
    vi.spyOn(first, "init").mockImplementationOnce(async (onWire, onFrame) => {
      await originalInit(onWire, onFrame);
      onFrame(frame, PortalLinkType.COMMAND);
      throw sentinel;
    });
    const errors = vi.fn();
    const delivered = vi.fn();
    s.peer.on("error", errors);
    s.peer.on("data", delivered);
    await s.peer.init();
    const answering = s.peer.handleRemoteOffer(OFFER);
    s.pc().fireLocalAnswer(ANSWER);
    await answering;
    const dc = s.pc().channels.find((channel) => channel.label === COMMAND_CHANNEL)!;
    dc.fireOpen();
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(sentinel));
    expect(s.peer.getTransportDiagnostics().receiveTiming!.logicalFrames.command).not.toBeNull();
    const fault = vi.spyOn(TransportEvidenceRecorder.prototype, "initFramingTiming").mockImplementationOnce(() => {
      throw new Error("synthetic-timing-init-error");
    });
    try {
      dc.fireOpen();
      await vi.waitFor(() => expect(s.peer.isCommandChannelReady).toBe(true));
      dc.fireMessage(frame);
      expect(delivered).toHaveBeenCalledTimes(2);
      expect(delivered).toHaveBeenLastCalledWith(COMMAND_CHANNEL, frame, PortalLinkType.COMMAND);
      expect(s.peer.getTransportDiagnostics().receiveTiming).toBeNull();
    } finally {
      fault.mockRestore();
      s.peer.close();
    }
  });
  it("preserves current timing when a framer has no optional diagnostics getter", async () => {
    const s = setup("host-only", () => new PassthroughFramer(), { receiveTimingNow: () => 2 });
    const dc = await openCommand(s);
    dc.fireMessage(Buffer.from("XZYH012345678901"));
    const snapshot = s.peer.getTransportDiagnostics();
    expect(snapshot.framingEpoch).toBeNull();
    expect(snapshot.framing).toBeUndefined();
    expect(copyRtcTransportDiagnostics(snapshot).receiveTiming).toMatchObject({
      transportEpoch: 1,
      framingEpoch: 1,
      logicalFrames: { command: { source: { role: "command", sequence: 1 } } },
    });
    s.peer.close();
  });

  it("preserves a framer's exact thrown value while measuring its failed callback", async () => {
    let now = 10;
    const framer = new EvidenceFramer();
    const s = setup("host-only", () => framer, { receiveTimingNow: () => now });
    const dc = await openCommand(s);
    const sentinel = { original: "synthetic-framer-error" };
    vi.spyOn(framer, "recvPacket").mockImplementation(() => {
      now += 4;
      throw sentinel;
    });
    let caught: unknown;
    try {
      dc.fireMessage(Buffer.from("synthetic-frame"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(s.peer.getTransportDiagnostics().receiveTiming!.nativeCallbacks.command.processing).toEqual({
      lastMicros: 4000,
      maxMicros: 4000,
      samples: 1,
    });
    s.peer.close();
  });

  it.each([
    "receiveTimestamp",
    "beginNativeCallback",
    "logicalCompletion",
    "finishNativeCallback",
    "restoreNativeCallback",
  ] as const)("keeps delivery and original consumer errors when %s instrumentation fails", async (method) => {
    const framer = new EvidenceFramer();
    const s = setup("host-only", () => framer, { receiveTimingNow: () => 2 });
    const dc = await openCommand(s);
    const fault = vi.spyOn(TransportEvidenceRecorder.prototype, method).mockImplementation(() => {
      throw new Error("synthetic-instrumentation-error");
    });
    const frame = Buffer.from("XZYH012345678901");
    const delivered = vi.fn();
    const sentinel = { original: "synthetic-consumer-error" };
    try {
      s.peer.on("data", delivered);
      expect(() => dc.fireMessage(frame)).not.toThrow();
      expect(delivered).toHaveBeenCalledWith(COMMAND_CHANNEL, frame, PortalLinkType.COMMAND);
      const throwingListener = () => {
        throw sentinel;
      };
      s.peer.on("data", throwingListener);
      let caught: unknown;
      try {
        dc.fireMessage(frame);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
      s.peer.off("data", throwingListener);
      fault.mockRestore();
      framer.deliver!(frame, PortalLinkType.NOTIFY);
      expect(s.peer.getTransportDiagnostics().receiveTiming).toBeNull();
    } finally {
      fault.mockRestore();
      s.peer.close();
    }
  });
  it("separates a late native entry from prompt logical completion and captures logging and consumers", async () => {
    let now = 10;
    const framer = new EvidenceFramer();
    const s = setup("host-only", () => framer, {
      receiveTimingNow: () => now,
      logger: {
        debug: (message) => {
          if (message.startsWith("[rtc] wire")) now += 1;
        },
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    const dc = await openCommand(s);
    const original = framer.recvPacket.bind(framer);
    vi.spyOn(framer, "recvPacket").mockImplementation((packet) => {
      now += 1;
      original(packet);
    });
    s.peer.on("data", () => {
      const duringEmit = s.peer.getTransportDiagnostics().receiveTiming!;
      expect(duringEmit.logicalFrames.command!.completionMicros).toBe(now * 1000);
      now += 5;
    });
    now = 100;
    dc.fireMessage(Buffer.from("XZYH012345678901"));
    const first = s.peer.getTransportDiagnostics().receiveTiming!;
    expect(first.nativeCallbacks.command).toEqual({
      latest: { sequence: 1, entryMicros: 100000 },
      processing: { lastMicros: 7000, maxMicros: 7000, samples: 1 },
    });
    expect(first.logicalFrames.command).toEqual({
      completionMicros: 102000,
      source: { role: "command", sequence: 1, entryMicros: 100000 },
      callbackToFrameMicros: 2000,
    });
    now = 5000;
    dc.fireMessage(Buffer.from("XZYH012345678901"));
    const late = s.peer.getTransportDiagnostics().receiveTiming!;
    expect(late.nativeCallbacks.command.latest!.entryMicros - first.nativeCallbacks.command.latest!.entryMicros).toBe(
      4900000,
    );
    expect(late.logicalFrames.command!.callbackToFrameMicros).toBe(2000);
    expect(late.sampledAtMicros).toBe(5007000);
    expect(late.nativeCallbacks.command.processing.samples).toBe(2);
    s.peer.close();
  });

  it("timestamps only the completing fragment's callback, independently of assembly age", async () => {
    let now = 10;
    const framer = new PtcsFramer();
    const s = setup("host-only", () => framer, { receiveTimingNow: () => now });
    const dc = await openCommand(s);
    const frame = Buffer.from("XZYH012345678901");
    const packets = packetize(frame, { frameId: 4, channel: PtcsChannel.COMMAND, payloadBytes: 8 });
    const receive = framer.recvPacket.bind(framer);
    vi.spyOn(framer, "recvPacket").mockImplementation((packet) => {
      now += 2;
      receive(packet);
    });
    const data = vi.fn(() => {
      now += 3;
    });
    s.peer.on("data", data);
    now = 100;
    dc.fireMessage(packets[0]!);
    expect(s.peer.getTransportDiagnostics().receiveTiming!.logicalFrames.command).toBeNull();
    now = 9100;
    dc.fireMessage(packets[1]!);
    const timing = s.peer.getTransportDiagnostics().receiveTiming!;
    expect(timing.logicalFrames.command).toEqual({
      completionMicros: 9102000,
      source: { role: "command", sequence: 2, entryMicros: 9100000 },
      callbackToFrameMicros: 2000,
    });
    expect(timing.nativeCallbacks.command.processing).toEqual({ lastMicros: 5000, maxMicros: 5000, samples: 2 });
    expect(data).toHaveBeenCalledWith(COMMAND_CHANNEL, frame, PortalLinkType.COMMAND);
    s.peer.close();
  });

  it("restores nested callback sources and leaves later asynchronous completions unattributed", async () => {
    let now = 10;
    const framer = new EvidenceFramer();
    const s = setup("host-only", () => framer, { receiveTimingNow: () => now });
    const dc = await openCommand(s);
    const audio = s.pc().channels.find((channel) => channel.label === "audio")!;
    const frame = Buffer.from("synthetic-frame");
    vi.spyOn(framer, "recvPacket").mockImplementation((packet) => {
      now += 1;
      framer.deliver!(frame, packet[0] === 1 ? PortalLinkType.COMMAND : PortalLinkType.NOTIFY);
      if (packet[0] === 1) {
        now += 1;
        framer.deliver!(frame, PortalLinkType.COMMAND);
      }
    });
    let nested = false;
    s.peer.on("data", (_label, _frame, link) => {
      if (link === PortalLinkType.COMMAND && !nested) {
        nested = true;
        audio.fireMessage(Buffer.from([2]));
      }
    });
    now = 100;
    dc.fireMessage(Buffer.from([1]));
    const timing = s.peer.getTransportDiagnostics().receiveTiming!;
    expect(timing.logicalFrames.command!.source).toEqual({ role: "command", sequence: 1, entryMicros: 100000 });
    expect(timing.logicalFrames.notify!.source).toEqual({ role: "audio", sequence: 2, entryMicros: 101000 });
    expect(timing.nativeCallbacks.command.processing.lastMicros).toBe(3000);
    expect(timing.nativeCallbacks.audio.processing.lastMicros).toBe(1000);
    await Promise.resolve();
    now += 10;
    framer.deliver!(frame, PortalLinkType.FILE);
    expect(s.peer.getTransportDiagnostics().receiveTiming!.logicalFrames.file).toEqual({
      completionMicros: 113000,
      source: null,
      callbackToFrameMicros: null,
    });
    s.peer.close();
  });

  it("preserves the exact consumer exception and delivery with throwing or invalid clocks", async () => {
    let now = 10;
    let broken = false;
    const s = setup("host-only", () => new PassthroughFramer(), {
      receiveTimingNow: () => {
        if (broken) throw new Error("synthetic-clock-error");
        return now;
      },
    });
    const dc = await openCommand(s);
    const sentinel = { original: "synthetic-consumer-error" };
    const listener = () => {
      now += 6;
      throw sentinel;
    };
    s.peer.on("data", listener);
    let caught: unknown;
    try {
      dc.fireMessage(Buffer.from("XZYH012345678901"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(s.peer.getTransportDiagnostics().receiveTiming!.nativeCallbacks.command.processing).toEqual({
      lastMicros: 6000,
      maxMicros: 6000,
      samples: 1,
    });
    s.peer.off("data", listener);
    const delivered = vi.fn();
    s.peer.on("data", delivered);
    broken = true;
    expect(() => dc.fireMessage(Buffer.from("XZYH012345678901"))).not.toThrow();
    let timing = s.peer.getTransportDiagnostics().receiveTiming!;
    expect(timing.sampledAtMicros).toBeNull();
    expect(timing.nativeCallbacks.command.latest).toBeNull();
    expect(timing.nativeCallbacks.command.processing.samples).toBe(1);
    expect(timing.logicalFrames.command).toBeNull();
    broken = false;
    now = Number.NaN;
    dc.fireMessage(Buffer.from("XZYH012345678901"));
    timing = s.peer.getTransportDiagnostics().receiveTiming!;
    expect(timing.logicalFrames.command).toBeNull();
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(s.peer.getTransportDiagnostics().inbound.command.packets).toBe(3);
    s.peer.close();
  });

  it("resets sequence and max duration per native epoch and suppresses contaminated framing", async () => {
    let now = 10;
    const s = setup("host-only", () => new PtcsFramer(), { receiveTimingNow: () => now });
    const old = await openCommand(s);
    const listener = () => {
      now += 3;
    };
    s.peer.on("data", listener);
    const frame = Buffer.from("XZYH012345678901");
    old.fireMessage(frame);
    expect(s.peer.getTransportDiagnostics().receiveTiming!.nativeCallbacks.command.processing.maxMicros).toBe(3000);
    s.peer.off("data", listener);
    s.peer.close();
    await s.peer.init();
    const reset = s.peer.getTransportDiagnostics().receiveTiming!;
    expect(reset.transportEpoch).toBe(2);
    expect(reset.framingEpoch).toBeNull();
    expect(reset.nativeCallbacks.command).toEqual({
      latest: null,
      processing: { lastMicros: null, maxMicros: null, samples: 0 },
    });
    const current = await openCommand(s);
    current.fireMessage(frame);
    expect(s.peer.getTransportDiagnostics().receiveTiming!.nativeCallbacks.command.latest!.sequence).toBe(1);
    old.fireMessage(frame);
    expect(s.peer.getTransportDiagnostics().receiveTiming).toBeNull();
    current.fireMessage(frame);
    expect(s.peer.getTransportDiagnostics().receiveTiming).toBeNull();
    s.peer.close();
    const fresh = await openCommand(s);
    fresh.fireMessage(frame);
    expect(s.peer.getTransportDiagnostics().receiveTiming).toMatchObject({
      transportEpoch: 3,
      framingEpoch: 3,
      nativeCallbacks: { command: { latest: { sequence: 1 }, processing: { maxMicros: 0, samples: 1 } } },
    });
    s.peer.close();
  });
});

function framingSample(): FramingDiagnostics {
  return {
    receivedPackets: 2,
    barePackets: 0,
    nonPtcsPackets: 0,
    admittedFragments: 2,
    duplicateFragments: 0,
    completedFrames: 1,
    invalidMetadata: 0,
    conflicts: 0,
    frameLimit: 0,
    fragmentLimit: 0,
    bufferLimit: 0,
    capacity: 0,
    decompression: 0,
    expiry: 0,
    pendingFrames: 1,
    bufferedBytes: 6,
  };
}

class EvidenceFramer extends PassthroughFramer {
  deliver?: (frame: Buffer, linkType: number) => void;
  readonly sample = Object.assign(framingSample(), { remoteLabel: "synthetic-private-channel" });
  getDiagnostics = vi.fn(() => this.sample);

  override async init(
    onWire: (packet: Buffer) => void,
    onFrame: (frame: Buffer, linkType: number) => void,
  ): Promise<void> {
    this.deliver = onFrame;
    await super.init(onWire, onFrame);
  }

  override sendFrame(packet: Buffer): void {
    super.sendFrame(packet.subarray(0, 3));
    super.sendFrame(packet.subarray(3));
  }

  override destroy(): void {
    this.sample.pendingFrames = 0;
    this.sample.bufferedBytes = 0;
    super.destroy();
  }
}

async function openCommand(s: ReturnType<typeof setup>): Promise<FakeDc> {
  await s.peer.init();
  const answering = s.peer.handleRemoteOffer(OFFER);
  s.pc().fireLocalAnswer(ANSWER);
  await answering;
  const channel = s.pc().channels.find((dc) => dc.label === COMMAND_CHANNEL)!;
  channel.fireOpen();
  await vi.waitFor(() => expect(s.peer.isCommandChannelReady).toBe(true));
  return channel;
}

describe("RTC native transport evidence", () => {
  it("counts actual framed and raw native calls while preserving refusal and throw behavior", async () => {
    const framer = new EvidenceFramer();
    const s = setup("host-only", () => framer);
    const packet = Buffer.from("abcdefg");
    expect(s.peer.sendCommand(packet)).toBe(false);
    expect(s.peer.sendRaw(packet)).toBe(false);
    expect(s.peer.getTransportDiagnostics().outbound.framed.packets).toBe(0);
    const dc = await openCommand(s);
    const send = vi.spyOn(dc, "sendMessageBinary");
    expect(s.peer.sendCommand(packet)).toBe(true);
    expect(dc.sent).toEqual([packet.subarray(0, 3), packet.subarray(3)]);
    dc.sendResult = false;
    expect(s.peer.sendCommand(packet)).toBe(false);
    expect(s.peer.sendRaw(packet)).toBe(false);
    const sentinel = { privateErrorText: "synthetic-private-error" };
    dc.sendError = sentinel;
    expect(s.peer.sendCommand(packet)).toBe(false);
    let caught: unknown;
    try {
      s.peer.sendRaw(packet);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    dc.sendError = undefined;
    dc.sendResult = true;
    expect(s.peer.sendRaw(packet)).toBe(true);
    expect(send.mock.calls.at(-1)?.[0]).toBe(packet);
    const snapshot = s.peer.getTransportDiagnostics();
    expect(snapshot.outbound).toEqual({
      framed: { packets: 5, bytes: 17, accepted: 2, refused: 2, thrown: 1 },
      raw: { packets: 3, bytes: 21, accepted: 1, refused: 1, thrown: 1 },
    });
    expect(snapshot).toMatchObject({ transportEpoch: 1, framingEpoch: 1, channelReady: true, closed: false });
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-private|privateErrorText|remoteLabel/);
    s.peer.close();
  });

  it("keeps fixed native roles distinct from logical links and never copies frame bytes", async () => {
    const framer = new EvidenceFramer();
    const s = setup("host-only", () => framer);
    const dc = await openCommand(s);
    const extra = new FakeDc("synthetic-private-channel");
    s.pc().fireDataChannel(extra);
    const data = vi.fn();
    s.peer.on("data", data);
    for (const channel of [...s.pc().channels, extra]) channel.fireMessage(Buffer.alloc(7));
    const packet = Buffer.from("synthetic-frame");
    for (const link of [
      PortalLinkType.COMMAND,
      PortalLinkType.NOTIFY,
      PortalLinkType.LIVE,
      PortalLinkType.PLAYBACK,
      PortalLinkType.FILE,
      PortalLinkType.INNER,
    ])
      framer.deliver?.(packet, link);
    const snapshot = s.peer.getTransportDiagnostics();
    expect(Object.keys(snapshot.inbound)).toEqual(["command", "audio", "idr", "video", "notify", "download", "other"]);
    for (const row of Object.values(snapshot.inbound)) expect(row).toEqual({ packets: 1, bytes: 7 });
    expect(snapshot.logicalFrames).toEqual({
      command: { frames: 1, bytes: packet.length },
      notify: { frames: 1, bytes: packet.length },
      media: { frames: 2, bytes: packet.length * 2 },
      file: { frames: 1, bytes: packet.length },
      other: { frames: 1, bytes: packet.length },
    });
    expect(data.mock.calls).toHaveLength(6);
    expect(data.mock.calls.every((call) => call[1] === packet)).toBe(true);
    snapshot.inbound.command.packets = 999;
    snapshot.logicalFrames.media.frames = 999;
    snapshot.outbound.raw.bytes = 999;
    snapshot.framing!.bufferedBytes = 999;
    expect(s.peer.getTransportDiagnostics().inbound.command.packets).toBe(1);
    expect(s.peer.getTransportDiagnostics().logicalFrames.media.frames).toBe(2);
    expect(s.peer.getTransportDiagnostics().outbound.raw.bytes).toBe(0);
    expect(s.peer.getTransportDiagnostics().framing!.bufferedBytes).toBe(6);
    dc.fireClosed();
    expect(s.peer.getTransportDiagnostics().channelReady).toBe(false);
    s.peer.close();
  });

  it("retains disposal framing evidence, isolates late messages and identifies a fresh epoch", async () => {
    const framers: EvidenceFramer[] = [];
    const s = setup("host-only", () => {
      const framer = new EvidenceFramer();
      framers.push(framer);
      return framer;
    });
    const old = await openCommand(s);
    old.fireMessage(Buffer.alloc(4));
    const oldFramer = framers[0]!;
    s.peer.close();
    oldFramer.sample.bufferedBytes = 800;
    const closed = s.peer.getTransportDiagnostics();
    expect(closed).toMatchObject({ transportEpoch: 1, framingEpoch: 1, closed: true, channelReady: false });
    expect(closed.framing!.bufferedBytes).toBe(0);
    expect(closed.framing!.pendingFrames).toBe(0);
    old.fireMessage(Buffer.alloc(9));
    oldFramer.deliver?.(Buffer.alloc(9), PortalLinkType.NOTIFY);
    expect(s.peer.getTransportDiagnostics().inbound.command.packets).toBe(1);
    expect(s.peer.getTransportDiagnostics().logicalFrames.notify.frames).toBe(0);
    await s.peer.init();
    expect(s.peer.getTransportDiagnostics()).toMatchObject({
      transportEpoch: 2,
      framingEpoch: 1,
      closed: false,
      channelReady: false,
    });
    const current = await openCommand(s);
    current.fireMessage(Buffer.alloc(5));
    const delivered = vi.fn();
    s.peer.on("data", delivered);
    old.fireMessage(Buffer.from("XZYH012345678901"));
    oldFramer.deliver?.(Buffer.alloc(9), PortalLinkType.NOTIFY);
    expect(s.peer.getTransportDiagnostics()).toMatchObject({
      transportEpoch: 2,
      framingEpoch: null,
      inbound: { command: { packets: 2, bytes: 9 } },
      logicalFrames: { notify: { frames: 0 }, command: { frames: 0 } },
    });
    expect(delivered).toHaveBeenCalledTimes(2);
    s.peer.close();
  });

  it.each(["bare", "ptcs"] as const)(
    "omits contaminated %s framing evidence until a fresh framer exists",
    async (wireKind) => {
      const s = setup("host-only", () => new PtcsFramer());
      const old = await openCommand(s);
      s.peer.close();
      const current = await openCommand(s);
      const frame = Buffer.from("XZYH012345678901");
      current.fireMessage(frame);
      expect(s.peer.getTransportDiagnostics()).toMatchObject({
        transportEpoch: 2,
        framingEpoch: 2,
        framing: { barePackets: 1 },
      });
      const delivered = vi.fn();
      s.peer.on("data", delivered);
      const packet = wireKind === "bare" ? frame : packetize(frame, { frameId: 1, channel: PtcsChannel.COMMAND })[0]!;
      old.fireMessage(packet);
      const contaminated = s.peer.getTransportDiagnostics();
      expect(contaminated.framing).toBeUndefined();
      expect(contaminated.framingEpoch).toBeNull();
      expect(contaminated.inbound.command).toEqual({ packets: 1, bytes: frame.length });
      expect(contaminated.logicalFrames.command.frames).toBe(1);
      expect(delivered).toHaveBeenCalledWith(COMMAND_CHANNEL, frame, PortalLinkType.COMMAND);
      current.fireMessage(frame);
      expect(s.peer.getTransportDiagnostics().framing).toBeUndefined();
      s.peer.close();
      expect(s.peer.getTransportDiagnostics().framing).toBeUndefined();
      const fresh = await openCommand(s);
      fresh.fireMessage(frame);
      expect(s.peer.getTransportDiagnostics()).toMatchObject({
        transportEpoch: 3,
        framingEpoch: 3,
        framing: { barePackets: 1 },
      });
      s.peer.close();
    },
  );

  it("does not let an optional framing getter or accessor interrupt sends, reads or close", async () => {
    const framer = new EvidenceFramer();
    const s = setup("host-only", () => framer);
    const dc = await openCommand(s);
    framer.getDiagnostics.mockImplementation(() => {
      throw new Error("synthetic-private-error");
    });
    expect(() => s.peer.getTransportDiagnostics()).not.toThrow();
    expect(s.peer.getTransportDiagnostics().framing).toBeUndefined();
    expect(s.peer.sendCommand(Buffer.from("abcdef"))).toBe(true);
    framer.getDiagnostics.mockImplementation(
      () =>
        Object.defineProperty(framingSample(), "receivedPackets", {
          get() {
            throw new Error("synthetic-private-accessor");
          },
        }) as typeof framer.sample,
    );
    expect(() => s.peer.getTransportDiagnostics()).not.toThrow();
    expect(() => s.peer.close()).not.toThrow();
    expect(dc.sent).toHaveLength(2);
    expect(s.peer.getTransportDiagnostics()).toMatchObject({ closed: true, outbound: { framed: { accepted: 2 } } });
  });

  it("omits an unavailable post-disposal sample and preserves original disposal exceptions", async () => {
    const framer = new EvidenceFramer();
    const s = setup("host-only", () => framer);
    await openCommand(s);
    expect(s.peer.getTransportDiagnostics().framing!.bufferedBytes).toBe(6);
    const destroy = framer.destroy.bind(framer);
    vi.spyOn(framer, "destroy").mockImplementation(() => {
      destroy();
      framer.getDiagnostics.mockImplementation(() => {
        throw new Error("synthetic-disposed-sample");
      });
    });
    s.peer.close();
    expect(s.peer.getTransportDiagnostics().framing).toBeUndefined();
    s.peer.close();
    expect(s.peer.getTransportDiagnostics().framing).toBeUndefined();
    const failing = new EvidenceFramer();
    const other = setup("host-only", () => failing);
    await openCommand(other);
    const sentinel = new Error("synthetic-disposal-failure");
    vi.spyOn(failing, "destroy").mockImplementationOnce(() => {
      throw sentinel;
    });
    let caught: unknown;
    try {
      other.peer.close();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    other.peer.close();
  });
});
