import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter } from "../command-router.js";
import type { RtcSession, RtcSessionOptions } from "../session.js";
import { PtcsFramer, packetize } from "../ptcs-framer.js";
import {
  buildPortalHeader,
  buildPortalPacket,
  parsePortalHeader,
  parsePortalPacket,
  PortalLinkType,
} from "../portal-packet.js";
import {
  collectEventTableCandidate,
  EVENT_TABLE_BYTE_CAP,
  type EventTableObservation,
} from "../event-table-candidate.js";

const ST = "T9000P0000000000",
  CAM = "T8425P0000000000";
const TABLE = "history_record_info";
const control = { kind: "set-payload" as const, cmd: 1224, payload: { mode_type: 1 }, channel: 0 };

class Session extends EventEmitter {
  connected = false;
  sent: Buffer[] = [];
  framer = new PtcsFramer();
  frameId = 0;
  ack = true;
  onSend?: (packet: Buffer) => void;
  async connect() {
    await this.framer.init(
      () => {},
      (frame, link) => this.emit("commandData", frame, link),
    );
    this.connected = true;
    this.emit("connected");
  }
  get isConnected() {
    return this.connected;
  }
  sendCommand(packet: Buffer) {
    this.sent.push(packet);
    if (this.ack)
      queueMicrotask(() => {
        const h = parsePortalHeader(packet)!;
        this.emit(
          "commandData",
          Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), Buffer.alloc(4)]),
          1,
        );
      });
    this.onSend?.(packet);
    return true;
  }
  fragments(
    body: unknown,
    {
      compressed = true,
      flag = true,
      bytes,
      payloadBytes = 1000,
      commandId = 1306,
      channel = 255,
      isResponse = 0,
      link = 2,
    }: {
      compressed?: boolean;
      flag?: boolean;
      bytes?: Buffer;
      payloadBytes?: number;
      commandId?: number;
      channel?: number;
      isResponse?: number;
      link?: number;
    } = {},
  ) {
    const json = Buffer.from(JSON.stringify(body));
    const packet = Buffer.concat([buildPortalHeader(commandId, json.length, channel, 0, isResponse), json]);
    const encoded = bytes ?? (compressed ? zstdCompressSync(packet) : packet);
    const packets = packetize(encoded, { channel: link, frameId: ++this.frameId, payloadBytes });
    if (compressed && flag) for (const p of packets) p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
    return { encoded, packets, packet };
  }
  notify(body: unknown, options: Parameters<Session["fragments"]>[1] = {}) {
    const { encoded, packets } = this.fragments(body, options);
    for (const p of packets) this.framer.recvPacket(p);
    return encoded;
  }
  close() {
    this.connected = false;
    this.framer.destroy();
    this.emit("close");
  }
}

const routers: RtcCommandRouter[] = [];
afterEach(() => {
  for (const r of routers.splice(0)) r.close();
});
async function setup(extra: Record<string, unknown> = {}) {
  const sessions: Session[] = [];
  const onFrame = vi.fn();
  const devices = new Map<string, EufyDevice>([
    [ST, { sn: ST, stationSn: ST, model: "T9000", raw: {} } as EufyDevice],
    [CAM, { sn: CAM, stationSn: ST, model: "T8425", raw: { device_channel: 2 } } as EufyDevice],
  ]);
  let identity = { authToken: "synthetic", userId: "synthetic", accountUserId: "synthetic", gtoken: "synthetic" };
  const router = new RtcCommandRouter({
    identity: () => identity,
    accountName: () => "synthetic",
    shard: () => "us",
    findDevice: (sn) => devices.get(sn),
    onFrame,
    createSession: (_opts: RtcSessionOptions) => {
      const s = new Session();
      sessions.push(s);
      return s as unknown as RtcSession;
    },
    ...extra,
  });
  routers.push(router);
  await router.dispatchCommand(ST, control);
  const initialMetadata = onFrame.mock.calls.at(-1)![2];
  onFrame.mockClear();
  const s = sessions[0]!;
  s.sent.length = 0;
  return {
    router,
    s,
    sessions,
    onFrame,
    initialMetadata,
    changeOwner: () => {
      identity = { ...identity, userId: "changed" };
    },
  };
}
const request = (s: Session) => JSON.parse(s.sent[0]!.subarray(16).toString()).payload;
const response = (s: Session, extra: Record<string, unknown> = {}) => ({
  cmd: 10000,
  table: TABLE,
  transaction: request(s).transaction,
  count: 1,
  data: [
    { record_id: "synthetic-private", thumb_path: "synthetic-private", device_sn: "synthetic-private", duration: 5 },
  ],
  mIntRet: 0,
  start_id: 0,
  end_id: 1,
  msg: "synthetic-private",
  version: 1,
  ...extra,
});
async function started(s: Session) {
  await vi.waitFor(() => expect(s.sent.length).toBe(1), { interval: 1 });
}

describe("existing-owner event table candidate", () => {
  it("matches the base router callback byte-for-byte when no probe has run", async () => {
    const { s, onFrame, initialMetadata } = await setup();
    const source = execFileSync("git", ["show", "b57f5b8:src/transport/rtc/command-router.ts"], { encoding: "utf8" });
    const anchor = source.indexOf("      this.receivedMessages.delete(bytes);");
    const start = source.lastIndexOf("    const onData = ", anchor) + "    const onData = ".length;
    const end = source.indexOf(";\n    const onConnected", anchor);
    expect(anchor).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const baseCallback = vi.fn();
    const created = { generation: initialMetadata.sessionGeneration };
    let sequence = initialMetadata.sequence;
    const baseReceiver = {
      sessions: new Map([[ST, created]]),
      receivedMessages: new WeakMap(),
      deps: { onFrame: baseCallback },
      receivedIdentity: () => ({ sequence: ++sequence, receivedAtMonotonicMs: performance.now() }),
    };
    const baseOnData = new Function(
      "parsePortalPacket",
      "session",
      "created",
      "sn",
      "return " + source.slice(start, end).replace("(bytes: Buffer, linkType: number)", "(bytes, linkType)"),
    ).call(baseReceiver, parsePortalPacket, s, created, ST);
    s.on("commandData", baseOnData);
    const clock = vi.spyOn(performance, "now").mockReturnValue(1234);
    try {
      for (const [body, commandId, link] of [
        [{ cmd: 10000, table: TABLE, transaction: "never-issued" }, 1306, 2],
        [{ cmd: 10000, table: "other", transaction: "other" }, 1306, 2],
        [{ cmd: 1306 }, 1103, 2],
        [{ cmd: 10000 }, 1350, 2],
        [{ cmd: 1103, state: "ordinary" }, 1306, 2],
        [{ cmd: 1306 }, 1306, 0],
      ] as const)
        s.notify(body, { commandId, link });
      expect(onFrame).toHaveBeenCalledTimes(6);
      expect(JSON.stringify(onFrame.mock.calls)).toBe(JSON.stringify(baseCallback.mock.calls));
    } finally {
      clock.mockRestore();
      s.off("commandData", baseOnData);
    }
  });
  it("tees unrelated fragmented and interleaved notifies across successful completion", async () => {
    const { router, s, onFrame } = await setup();
    const first = s.fragments(
      { cmd: 1103, state: "first", padding: "a".repeat(1000) },
      { compressed: false, commandId: 1103, payloadBytes: 40 },
    ).packets;
    s.framer.recvPacket(first.shift()!);
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    const second = s.fragments(
      { cmd: 10000, table: "unrelated", state: "second", padding: "b".repeat(1000) },
      { compressed: false, payloadBytes: 40 },
    ).packets;
    const third = s.fragments(
      { cmd: 1306, state: "third", padding: "c".repeat(1000) },
      { compressed: false, commandId: 1103, payloadBytes: 40 },
    ).packets;
    const reply = s.fragments(response(s), { payloadBytes: 20 }).packets;
    s.framer.recvPacket(third.shift()!);
    for (let i = 0; i < Math.max(first.length, second.length, reply.length); i++) {
      for (const packets of [first, second, reply]) if (packets[i]) s.framer.recvPacket(packets[i]!);
    }
    expect((await pending).outcome).toBe("success");
    for (const packet of third) s.framer.recvPacket(packet);
    expect(
      onFrame.mock.calls
        .filter(([, frame]) => frame.linkType === PortalLinkType.NOTIFY)
        .map(([, frame]) => frame.data.state)
        .sort(),
    ).toEqual(["first", "second", "third"]);
  });
  it("cancellation between fragments preserves ordinary partials and suppresses only the late probe reply while control awaits ACK", async () => {
    const { router, s, onFrame } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    const state = s.fragments(
      { cmd: 1103, state: "survived", padding: "a".repeat(1000) },
      { compressed: false, commandId: 1103, payloadBytes: 40 },
    ).packets;
    const reply = s.fragments(response(s), { payloadBytes: 20 }).packets;
    s.framer.recvPacket(state.shift()!);
    s.framer.recvPacket(reply.shift()!);
    s.ack = false;
    const next = router.dispatchCommand(ST, control);
    expect((await pending).outcome).toBe("abandoned");
    await vi.waitFor(() => expect(s.sent).toHaveLength(2), { interval: 1 });
    for (const packet of [...state, ...reply]) s.framer.recvPacket(packet);
    s.notify(response(s, { msg: "a".repeat(1_000_000) }));
    expect(
      onFrame.mock.calls
        .filter(([, frame]) => frame.linkType === PortalLinkType.NOTIFY)
        .map(([, frame]) => frame.data.state),
    ).toEqual(["survived"]);
    const h = parsePortalHeader(s.sent[1]!)!;
    s.emit("commandData", Buffer.concat([buildPortalHeader(1350, 4, h.channel, h.segment, 1), Buffer.alloc(4)]), 1);
    await next;
    expect(s.isConnected).toBe(true);
  });
  it.each(["success", "timeout", "rejected"])(
    "suppresses late issued replies after %s and delivers unrelated table replies",
    async (outcome) => {
      const { router, s, onFrame } = await setup();
      const pending = router.readEventTableCandidate(ST, { timeoutMs: outcome === "timeout" ? 100 : 8000 });
      await started(s);
      const body = response(s);
      if (outcome !== "timeout")
        s.notify({ ...body, msg: outcome === "rejected" ? "a".repeat(EVENT_TABLE_BYTE_CAP) : "ok" });
      expect((await pending).outcome).toBe(
        outcome === "timeout" ? "ack_only/timeout" : outcome === "rejected" ? "receive_rejected" : "success",
      );
      s.notify(body);
      s.notify({ ...body, transaction: "unrelated" });
      s.notify({ ...body, table: "unrelated" });
      s.notify({ ...body, cmd: 1306 });
      expect(onFrame.mock.calls.filter(([, frame]) => frame.linkType === PortalLinkType.NOTIFY)).toHaveLength(3);
    },
  );
  it.each([
    { commandId: 1103 },
    { commandId: 1350 },
    { isResponse: 1 },
    { isResponse: 2 },
    { channel: 2 },
    { link: 0 },
  ])("does not accept or suppress an unexpected outer envelope %j", async (options) => {
    const { router, s, onFrame } = await setup();
    const pending = router.readEventTableCandidate(ST, { timeoutMs: 100 });
    await started(s);
    s.notify(response(s), options);
    expect((await pending).outcome).toBe("ack_only/timeout");
    expect(
      onFrame.mock.calls.filter(([, frame]) => frame.commandId !== 1350 || frame.linkType !== PortalLinkType.COMMAND),
    ).toHaveLength(1);
    expect(onFrame).toHaveBeenCalledTimes(2);
  });
  it("delivers an unrelated notify above the probe cap and below the ordinary cap", async () => {
    const { router, s, onFrame } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    s.notify({ cmd: 1103, state: "large", padding: "a".repeat(1_000_000) }, { commandId: 1103 });
    s.notify(response(s));
    expect((await pending).outcome).toBe("success");
    expect(
      onFrame.mock.calls
        .filter(([, frame]) => frame.linkType === PortalLinkType.NOTIFY)
        .map(([, frame]) => frame.data.state),
    ).toEqual(["large"]);
  });
  it("bounds transaction retention and expires completed tombstones after sixty seconds", async () => {
    const { router, s, onFrame } = await setup();
    let body: Record<string, unknown> = {};
    for (let i = 0; i < 16; i++) {
      s.sent.length = 0;
      const pending = router.readEventTableCandidate(ST);
      await started(s);
      body = response(s);
      s.notify(body);
      expect((await pending).outcome).toBe("success");
    }
    s.sent.length = 0;
    expect((await router.readEventTableCandidate(ST)).outcome).toBe("busy/not_admitted");
    expect(s.sent).toHaveLength(0);
    const later = performance.now() + 60_001;
    const clock = vi.spyOn(performance, "now").mockReturnValue(later);
    try {
      s.notify(body);
      expect(onFrame.mock.calls.filter(([, frame]) => frame.linkType === PortalLinkType.NOTIFY)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    s.notify(response(s));
    expect((await pending).outcome).toBe("success");
  });
  it("rejects decoded oversize before touching the parsed body", async () => {
    const { s } = await setup();
    let observe!: Parameters<EventTableObservation["subscribe"]>[0];
    const pending = collectEventTableCandidate(
      s as unknown as RtcSession,
      "synthetic",
      1,
      "synthetic",
      new AbortController().signal,
      performance.now() + 8000,
      () => ({ ownerContinuous: true, generationContinuous: true }),
      {
        subscribe: (callback) => {
          observe = callback;
          return () => {};
        },
        issued: () => {},
      },
    );
    observe(EVENT_TABLE_BYTE_CAP + 1, {
      commandId: 1306,
      channel: 255,
      segment: 0,
      isResponse: 0,
      linkType: PortalLinkType.NOTIFY,
      get data() {
        throw new Error("oversize body must not be inspected");
      },
    });
    expect(await pending).toMatchObject({
      outcome: "receive_rejected",
      decompressedBytes: EVENT_TABLE_BYTE_CAP + 1,
      rowCount: null,
      compressedBytes: null,
    });
  });
  it("does not suppress an old transaction on a new session generation", async () => {
    const { router, s, sessions, onFrame } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    const old = response(s);
    s.notify(old);
    expect((await pending).outcome).toBe("success");
    s.close();
    await router.dispatchCommand(ST, control);
    expect(sessions).toHaveLength(2);
    onFrame.mockClear();
    sessions[1]!.notify(old);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![1].data.transaction).toBe(old.transaction);
  });
  it("sends the exact single count-20 query, decodes a compressed portal packet, and returns only count/types", async () => {
    const { router, s, sessions, onFrame } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    const h = parsePortalHeader(s.sent[0]!)!;
    expect(h).toMatchObject({ commandId: 1350, channel: 255 });
    expect(JSON.parse(s.sent[0]!.subarray(16).toString())).toMatchObject({ cmd: 1306, mChannel: 255 });
    expect(request(s)).toEqual({
      cmd: 10000,
      table: TABLE,
      transaction: expect.any(String),
      payload: {
        count: 20,
        start_date: "",
        end_date: "",
        start_id: 0,
        end_id: 1,
        flag: 0,
        need_ai: 1,
        res_unzip: 1,
        update_time: "0",
        start_time: "0",
        alarm_id: "",
      },
    });
    const encoded = s.notify(response(s), { payloadBytes: 40 });
    const receipt = await pending;
    expect(receipt).toMatchObject({
      outcome: "success",
      rowCount: 1,
      resultCode: 0,
      ownerContinuous: true,
      generationContinuous: true,
      compressedBytes: null,
    });
    expect(receipt.decompressedBytes).toBeGreaterThan(encoded.length);
    expect(receipt.fieldTypes["row.thumb_path"]).toEqual(["string"]);
    expect(JSON.stringify(receipt)).not.toContain("synthetic-private");
    expect(onFrame.mock.calls.filter(([, f]) => f.cmd === 10000)).toHaveLength(0);
    expect(s.sent).toHaveLength(1);
    expect(sessions).toHaveLength(1);
  });
  it.each([true, false])("accepts empty replies, compressed %s", async (compressed) => {
    const { router, s } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    s.notify(response(s, { data: [], count: 0 }), { compressed });
    expect(await pending).toMatchObject({ outcome: "empty", rowCount: 0 });
  });
  it("does not treat ACK as data and ignores wrong transaction/table", async () => {
    const { router, s } = await setup();
    const pending = router.readEventTableCandidate(ST, { timeoutMs: 40 });
    await started(s);
    s.notify(response(s, { transaction: "wrong" }));
    s.notify(response(s, { table: "wrong" }));
    expect(await pending).toMatchObject({ outcome: "ack_only/timeout", rowCount: null });
    expect(s.sent).toHaveLength(1);
  });
  it("abandons immediately for control and ignores the late table body in state handlers", async () => {
    const { router, s, onFrame } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    const body = response(s);
    const next = router.dispatchCommand(ST, control);
    expect(await pending).toMatchObject({ outcome: "abandoned", rowCount: null });
    await next;
    s.notify(body);
    expect(onFrame.mock.calls.filter(([, f]) => f.cmd === 10000)).toHaveLength(0);
    expect(s.sent).toHaveLength(2);
    expect(s.listenerCount("commandData")).toBe(1);
  });
  it("cancels an unsent queued probe before yielding to a control", async () => {
    const { router, s } = await setup();
    const pending = router.readEventTableCandidate(ST);
    const next = router.dispatchCommand(ST, control);
    expect(await pending).toMatchObject({ outcome: "abandoned" });
    await next;
    expect(s.sent).toHaveLength(1);
    expect(JSON.parse(s.sent[0]!.subarray(16).toString()).cmd).toBe(1224);
  });
  it("does not publish a reply when control preemption wins the completion handoff", async () => {
    const { router, s } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    s.notify(response(s));
    const next = router.dispatchCommand(ST, control);
    expect(await pending).toMatchObject({ outcome: "abandoned", rowCount: null });
    await next;
  });
  it("refuses existing live leases and in-flight controls without sending", async () => {
    const { router, s } = await setup();
    const lease = await router.sessionFor(ST);
    expect(await router.readEventTableCandidate(ST)).toMatchObject({ outcome: "busy/not_admitted" });
    lease.release();
    s.ack = false;
    const next = router.dispatchCommand(ST, control);
    await started(s);
    expect(await router.readEventTableCandidate(ST)).toMatchObject({ outcome: "busy/not_admitted" });
    const h = parsePortalHeader(s.sent[0]!)!;
    s.emit("commandData", Buffer.concat([buildPortalHeader(1350, 4, h.channel, h.segment, 1), Buffer.alloc(4)]), 1);
    await next;
    expect(s.sent).toHaveLength(1);
  });
  it("refuses a pending and active live view, and yields an admitted probe to a viewer", async () => {
    const { router, s } = await setup();
    const live = router.mediaProviderFor(CAM).live();
    expect(await router.readEventTableCandidate(ST)).toMatchObject({ outcome: "busy/not_admitted" });
    const viewer = await live;
    expect(await router.readEventTableCandidate(ST)).toMatchObject({ outcome: "busy/not_admitted" });
    viewer.stop();
    await new Promise((r) => setImmediate(r));
    s.sent.length = 0;
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    const second = router.mediaProviderFor(CAM).live();
    expect(await pending).toMatchObject({ outcome: "abandoned" });
    (await second).stop();
  });
  it("refuses a running storage candidate without sending a table query", async () => {
    const { router, s } = await setup();
    const abort = new AbortController();
    const storage = router.readStorageCandidate(ST, { signal: abort.signal }).catch(() => {});
    expect(await router.readEventTableCandidate(ST)).toMatchObject({ outcome: "busy/not_admitted" });
    abort.abort();
    await storage;
    expect(s.sent).toHaveLength(0);
  });
  it("refuses a queued command and an imminent scheduled renewal", async () => {
    const { router, s } = await setup();
    const next = router.dispatchCommand(ST, control);
    expect(await router.readEventTableCandidate(ST)).toMatchObject({ outcome: "busy/not_admitted" });
    await next;
    const second = await setup({ sessionRefreshMs: 120_000 });
    const now = Date.now;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 119_000);
    try {
      expect(await second.router.readEventTableCandidate(ST)).toMatchObject({ outcome: "busy/not_admitted" });
    } finally {
      clock.mockRestore();
    }
    expect(second.s.sent).toHaveLength(0);
    expect(s.sent).toHaveLength(1);
  });
  it("refuses absent owner and invalid time budgets", async () => {
    const { router, s } = await setup();
    await expect(router.readEventTableCandidate(ST, { timeoutMs: 8001 })).rejects.toThrow();
    s.close();
    expect(await router.readEventTableCandidate(ST)).toMatchObject({ outcome: "busy/not_admitted" });
    expect(s.sent).toHaveLength(0);
  });
  it("rejects owner drift and never attributes an old generation", async () => {
    const { router, s, changeOwner } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    changeOwner();
    s.notify(response(s));
    expect(await pending).toMatchObject({ outcome: "owner_changed", ownerContinuous: false });
  });
  it("session retirement ends the waiter without acquiring another owner", async () => {
    const { router, s, sessions } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    s.close();
    expect(await pending).toMatchObject({ outcome: "owner_changed", generationContinuous: false });
    expect(sessions).toHaveLength(1);
  });
  it("a late abandoned transaction cannot satisfy another invocation", async () => {
    const { router, s } = await setup();
    const abort = new AbortController();
    const first = router.readEventTableCandidate(ST, { signal: abort.signal });
    await started(s);
    const old = response(s);
    abort.abort();
    expect((await first).outcome).toBe("abandoned");
    await new Promise((r) => setImmediate(r));
    s.sent.length = 0;
    const second = router.readEventTableCandidate(ST);
    await started(s);
    expect(request(s).transaction).not.toBe(old.transaction);
    s.notify(old);
    s.notify(response(s, { data: [] }));
    expect(await second).toMatchObject({ outcome: "empty", rowCount: 0 });
  });
  it.each([false, true])(
    "rejects a decoded oversize reply, compressed %s, without losing other traffic",
    async (compressed) => {
      const { router, s, onFrame } = await setup();
      const pending = router.readEventTableCandidate(ST);
      await started(s);
      s.notify(response(s, { msg: "a".repeat(EVENT_TABLE_BYTE_CAP) }), { compressed });
      expect((await pending).outcome).toBe("receive_rejected");
      s.notify({ cmd: 1103, state: "after-oversize" });
      expect(
        onFrame.mock.calls.filter(([, f]) => f.linkType === PortalLinkType.NOTIFY).map(([, f]) => f.data.state),
      ).toEqual(["after-oversize"]);
      expect(s.isConnected).toBe(true);
    },
  );
  it.each(["oversize", "bomb", "window", "malformed", "false_compression", "unflagged"])(
    "preserves ordinary rejection of %s without an exclusive receiver",
    async (kind) => {
      const { router, s, onFrame } = await setup();
      const pending = router.readEventTableCandidate(ST, { timeoutMs: 100 });
      await started(s);
      if (kind === "oversize") s.notify({}, { bytes: Buffer.alloc(EVENT_TABLE_BYTE_CAP + 1) });
      if (kind === "bomb") s.notify({}, { bytes: zstdCompressSync(Buffer.alloc(EVENT_TABLE_BYTE_CAP + 1, 65)) });
      if (kind === "window")
        s.notify({}, { bytes: Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x68, 0x09, 0x00, 0x00, 65]) });
      if (kind === "malformed") s.notify({}, { bytes: Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff, 0xff]) });
      if (kind === "false_compression")
        s.notify(response(s), {
          bytes: buildPortalPacket({ commandId: 1306, channel: 255, segment: 0, payload: response(s) }),
        });
      if (kind === "unflagged") s.notify(response(s), { flag: false });
      expect((await pending).outcome).toBe("ack_only/timeout");
      s.notify({ cmd: 1103, state: "ordinary" });
      expect(onFrame.mock.calls.filter(([, frame]) => frame.linkType === PortalLinkType.NOTIFY)).toHaveLength(1);
      expect(s.isConnected).toBe(true);
    },
  );
  it("rejects nonzero result without copying its message", async () => {
    const { router, s } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    s.notify(response(s, { mIntRet: -6001 }));
    expect(await pending).toMatchObject({ outcome: "result_nonzero", resultCode: -6001, rowCount: null });
  });
  it.each([{ mIntRet: "0" }, { data: "invalid" }, { data: [null] }])(
    "rejects malformed result shape %j",
    async (extra) => {
      const { router, s } = await setup();
      const pending = router.readEventTableCandidate(ST);
      await started(s);
      s.notify(response(s, extra));
      expect((await pending).outcome).toBe("invalid_reply");
    },
  );
  it("does not charge unrelated transactions against the probe observation budget", async () => {
    const { router, s, onFrame } = await setup();
    const pending = router.readEventTableCandidate(ST);
    await started(s);
    s.notify(response(s, { transaction: "wrong", msg: "a".repeat(140_000) }));
    s.notify(response(s, { msg: "a".repeat(140_000) }));
    expect((await pending).outcome).toBe("success");
    expect(onFrame.mock.calls.filter(([, f]) => f.cmd === 10000)).toHaveLength(1);
  });
  it("requires ACK even when a matching table arrives first", async () => {
    const { router, s } = await setup();
    s.ack = false;
    const pending = router.readEventTableCandidate(ST, { timeoutMs: 40 });
    await started(s);
    s.notify(response(s));
    expect(await pending).toMatchObject({ outcome: "timeout", rowCount: null });
  });
});
