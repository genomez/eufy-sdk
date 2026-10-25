import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { buildPortalHeader, parsePortalHeader } from "../../transport/rtc/portal-packet.js";

const STATION = "T9000P0000000000";
const TARGET = "T8425P0000000000";
const SIBLING = "T8425P0000000001";
const profile = { profile: "bounded-state-v1" } as const;

function fixture() {
  vi.useFakeTimers();
  const wall = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - wall);
  const eufy = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
    rtc: { commandTimeoutMs: 14_000, sessionRefreshMs: 0, idleCloseMs: 900_000 },
  });
  const client = eufy as any;
  const packets: { at: number; packet: Buffer }[] = [];
  let code: number | null = -109;
  let latency = 100;
  let observed = true;
  let siblingLatency = 100;
  class Session extends EventEmitter {
    isConnected = false;
    async connect() {
      this.isConnected = true;
      this.emit("connected");
    }
    ack(packet: Buffer, result = 0) {
      const h = parsePortalHeader(packet)!;
      const body = Buffer.alloc(4);
      body.writeInt32LE(result);
      this.emit("commandData", Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), body]), 1);
    }
    report(value: boolean) {
      const body = Buffer.from(
        JSON.stringify({ params: [{ channel: 1, param_type: 1400, param_value: Number(value) }] }),
      );
      this.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 255, 0, 0), body]), 3);
    }
    sendCommand(packet: Buffer) {
      const h = parsePortalHeader(packet)!;
      packets.push({ at: performance.now(), packet });
      if (h.commandId === 1103) {
        setTimeout(() => {
          this.ack(packet);
          this.report(observed);
        }, 1);
      } else if (h.channel === 2) setTimeout(() => this.ack(packet), siblingLatency);
      else if (code !== null) {
        const result = code;
        setTimeout(() => this.ack(packet, result), latency);
      }
      return true;
    }
    close() {
      this.isConnected = false;
      this.emit("close");
    }
  }
  const session = new Session();
  client.registry.devices = [
    { sn: STATION, model: "T9000", params: {}, raw: {} },
    ...[TARGET, SIBLING].map((sn, index) => ({
      sn,
      stationSn: STATION,
      model: "T8425",
      category: "eufy_security",
      deviceClass: "camera",
      params: { 1400: "1" },
      raw: { device_channel: index + 1, device_type: 47, parent_sn: STATION },
    })),
  ];
  vi.spyOn(client.registry, "record").mockImplementation(async () => ({
    model: "T8425",
    deviceType: 47,
    category: "eufy_security",
    parentSn: STATION,
    params: { 1400: "1" },
    paramUpdatedAt: {},
  }));
  client.rtc.deps.identity = () => ({ authToken: "synthetic-token", userId: "synthetic-user" });
  client.rtc.deps.shard = () => "ie-pr";
  client.rtc.deps.createSession = () => session;
  client.opts.autoRealtime = true;
  client.realtimeGeneration = {
    epoch: client.realtimeEpoch,
    abort: new AbortController(),
    stateRefreshFailures: 0,
    readiness: { push: {}, mqtt: {}, wiredP2p: {}, states: {} },
    settled: true,
  };
  const writes = (channel = 1) =>
    packets.filter(({ packet }) => {
      const h = parsePortalHeader(packet)!;
      return h.commandId === 1700 && h.channel === channel;
    });
  const write = (correction = false, sn = TARGET) =>
    eufy.setPropertyWithReceipt(sn, "light", false, { ...profile, correction });
  const health = () => (eufy as any).propertyCommandHealth(TARGET, "light");
  const configure = (result: number | null, delay = 100) => {
    code = result;
    latency = delay;
  };
  const degrade = async () => {
    const first = write();
    await vi.advanceTimersByTimeAsync(16_000);
    expect((await first).status).toBe("pending_accepted");
    expect(writes()).toHaveLength(2);
  };
  return {
    eufy,
    client,
    session,
    packets,
    writes,
    write,
    health,
    configure,
    degrade,
    observe: (value: boolean) => {
      observed = value;
      session.report(value);
    },
    delaySibling: (delay: number) => {
      siblingLatency = delay;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("observe-only camera health at the RTC packet boundary", () => {
  it("receives HomeBase offline status passively and still sends legacy and bounded OFF commands", async () => {
    const f = fixture();
    f.client.registry.devices[0].deviceClass = "homebase";
    f.configure(0);
    try {
      const warmup = f.write();
      await vi.advanceTimersByTimeAsync(100);
      await warmup;
      const before = f.packets.length;
      const body = Buffer.from(JSON.stringify({ params: [{ channel: 1, param_type: 1131, param_value: 0 }] }));
      f.session.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 255, 0, 0), body]), 3);
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({
        connectivity: "offline",
        basis: "vendor_status",
        evidence: "hub_reported",
      });
      expect(f.packets).toHaveLength(before);
      const legacy = f.eufy.setProperty(TARGET, "light", false);
      await vi.advanceTimersByTimeAsync(100);
      await legacy;
      const bounded = f.write();
      await vi.advanceTimersByTimeAsync(100);
      expect(await bounded).toMatchObject({ status: "acknowledged", sendAttempted: true });
      expect(f.writes()).toHaveLength(3);
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({
        connectivity: "offline",
        enforcement: "observe_only",
        commandsBlocked: false,
        outcomes: { offline: { acknowledged: 2 } },
      });
      f.configure(-109);
      const rejected = f.write();
      await vi.advanceTimersByTimeAsync(100);
      expect(await rejected).toMatchObject({ status: "rejected", sendAttempted: true, rejectionCode: -109 });
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({ connectivity: "offline", hubOfflineCount: 1 });
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each(["rtc", "p2p"] as const)("keeps the parent usable when %s closes first", async (first) => {
    const f = fixture();
    const rtc = (state: "connected" | "disconnected") => f.client.rtc.deps.onTransport(STATION, state);
    const p2p = (state: "connected" | "disconnected") =>
      state === "connected" ? f.client.p2p.deps.onConnect(STATION) : f.client.p2p.deps.onClose(STATION);
    const closeFirst = first === "rtc" ? rtc : p2p;
    const closeLast = first === "rtc" ? p2p : rtc;
    try {
      rtc("connected");
      p2p("connected");
      f.client.cameraHealthIngress.media(TARGET);
      expect(f.eufy.cameraHealth(TARGET)?.connectivity).toBe("online");
      await vi.advanceTimersByTimeAsync(1);
      closeFirst("disconnected");
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({ connectivity: "online", parentTransport: "connected" });
      f.client.cameraHealthIngress.media(TARGET);
      expect(f.eufy.cameraHealth(TARGET)?.connectivity).toBe("online");
      await vi.advanceTimersByTimeAsync(1);
      closeLast("disconnected");
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({
        connectivity: "unknown",
        basis: "parent_unassessable",
        parentTransport: "disconnected",
      });
      await vi.advanceTimersByTimeAsync(1);
      f.client.cameraHealthIngress.media(TARGET);
      expect(f.eufy.cameraHealth(TARGET)?.connectivity).toBe("unknown");
      closeFirst("connected");
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({ connectivity: "unknown", parentTransport: "connected" });
      await vi.advanceTimersByTimeAsync(1);
      f.client.cameraHealthIngress.media(TARGET);
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({ connectivity: "online", basis: "media" });
      expect(f.packets).toHaveLength(0);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each(["begin", "sent", "response", "finish"])(
    "keeps throwing RTC %s observation passive in both command APIs",
    async (stage) => {
      const f = fixture();
      f.configure(0);
      const fail = () => {
        throw new Error("synthetic observer failure");
      };
      f.client.rtc.deps.observeCommand =
        stage === "begin"
          ? fail
          : () => ({
              sent: stage === "sent" ? fail : () => {},
              response: stage === "response" ? fail : () => {},
              finish: stage === "finish" ? fail : () => {},
            });
      try {
        const bounded = f.write(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect((await bounded).status).toBe("acknowledged");
        const legacy = f.eufy.setProperty(TARGET, "light", false);
        await vi.advanceTimersByTimeAsync(1000);
        await legacy;
        expect(f.writes()).toHaveLength(2);
      } finally {
        await f.eufy.disconnect();
      }
    },
  );

  it("records unsent finalized validation receipts as other without initiating work", async () => {
    const f = fixture();
    try {
      const receipt = await f.eufy.setPropertyWithReceipt(TARGET, "light", false, { automatic: true });
      expect(receipt).toMatchObject({ status: "validation_failed", sendAttempted: false });
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({
        outcomes: { unknown: { other: 1 } },
        lastOutcome: { connectivity: "unknown", status: "other", code: null },
      });
      expect(f.packets).toHaveLength(0);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("binds media ownership before awaited session acquisition changes camera topology", async () => {
    const f = fixture();
    f.configure(0);
    let connect!: () => void;
    vi.spyOn(f.session, "connect").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          connect = () => {
            f.session.isConnected = true;
            f.session.emit("connected");
            resolve();
          };
        }),
    );
    try {
      const work = f.client.rtc.mediaProviderFor(TARGET).live();
      await vi.advanceTimersByTimeAsync(0);
      const device = f.client.registry.list().find((row: { sn: string }) => row.sn === TARGET);
      device.raw.device_channel = 3;
      f.client.cameraHealthIngress.roster(f.client.registry.list());
      connect();
      const consumer = await work;
      await vi.advanceTimersByTimeAsync(100);
      const bytes = Buffer.from([0, 0, 0, 1, 0x26, 1, 0xaf, 0]);
      const prefix = Buffer.alloc(22);
      prefix.writeUInt32LE(bytes.length);
      prefix[5] = 1;
      const body = Buffer.concat([prefix, bytes]);
      f.session.emit("mediaData", Buffer.concat([buildPortalHeader(1300, body.length, 101, 0, 0), body]), 5);
      expect(f.eufy.cameraHealth(TARGET)?.lastContactMs).toBeNull();
      consumer.stop();
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("sends a suspect camera command unchanged and counts the captured admission state", async () => {
    const f = fixture();
    const events: unknown[] = [];
    f.eufy.on("cameraHealth", (event) => events.push(event));
    try {
      const first = f.write();
      await vi.advanceTimersByTimeAsync(100);
      expect(await first).toMatchObject({ status: "rejected", rejectionCode: -109, sendAttempted: true });
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({
        connectivity: "suspect",
        basis: "hub_reported_offline",
        hubOfflineCount: 1,
        outcomes: { unknown: { rejected: 1 } },
        lastOutcome: { connectivity: "unknown", status: "rejected", code: -109 },
      });
      f.configure(0);
      const second = f.write();
      await vi.advanceTimersByTimeAsync(100);
      expect(await second).toMatchObject({ status: "acknowledged", sendAttempted: true });
      expect(f.writes()).toHaveLength(2);
      expect(f.writes()[0]!.packet.subarray(16).equals(f.writes()[1]!.packet.subarray(16))).toBe(true);
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({
        connectivity: "suspect",
        commandsBlocked: false,
        enforcement: "observe_only",
        outcomes: { unknown: { rejected: 1 }, suspect: { acknowledged: 1 } },
      });
      expect(f.eufy.cameraHealth(SIBLING)?.hubOfflineCount).toBe(0);
      expect(f.health().status).toBe("healthy");
      expect(events.length).toBeGreaterThan(2);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("captures the state when queued work is actually sent, not when it joins the queue", async () => {
    const f = fixture();
    try {
      const first = f.write();
      await vi.advanceTimersByTimeAsync(0);
      f.configure(0);
      const second = f.write();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await first).rejectionCode).toBe(-109);
      expect((await second).status).toBe("acknowledged");
      expect(f.eufy.cameraHealth(TARGET)?.outcomes).toMatchObject({
        unknown: { rejected: 1 },
        suspect: { acknowledged: 1 },
      });
      expect(f.writes()).toHaveLength(2);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each([-108, -103, -114, 0])("keeps %s command classification separate from camera connectivity", async (code) => {
    const f = fixture();
    f.configure(code);
    try {
      const result = f.write(true);
      await vi.advanceTimersByTimeAsync(100);
      const receipt = await result;
      expect(receipt.status).toBe(code === 0 ? "acknowledged" : code === -108 ? "pending_accepted" : "rejected");
      expect(receipt.rejectionCode).toBe(code === 0 ? undefined : code);
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({ connectivity: "unknown", hubOfflineCount: 0 });
      expect(f.writes()).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("ignores wrong-session, wrong-target and wrong-segment -109 responses", async () => {
    const f = fixture();
    f.configure(null);
    try {
      const work = f.write(true);
      await vi.advanceTimersByTimeAsync(0);
      const header = parsePortalHeader(f.writes()[0]!.packet)!;
      const body = Buffer.alloc(4);
      body.writeInt32LE(-109);
      for (const [command, channel, segment] of [
        [1700, 2, header.segment],
        [1700, 1, header.segment + 1],
        [1350, 1, header.segment],
      ]) {
        f.session.emit("commandData", Buffer.concat([buildPortalHeader(command!, 4, channel!, segment!, 1), body]), 1);
      }
      const other = new EventEmitter();
      other.emit("commandData", Buffer.concat([buildPortalHeader(1700, 4, 1, header.segment, 1), body]), 1);
      expect(f.eufy.cameraHealth(TARGET)?.hubOfflineCount).toBe(0);
      f.session.ack(f.writes()[0]!.packet, -109);
      await vi.advanceTimersByTimeAsync(0);
      expect((await work).rejectionCode).toBe(-109);
      expect(f.eufy.cameraHealth(TARGET)?.hubOfflineCount).toBe(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("records legacy finalization once and never uses ACK as positive child contact", async () => {
    const f = fixture();
    f.configure(0);
    try {
      const work = f.eufy.setProperty(TARGET, "light", false);
      await vi.advanceTimersByTimeAsync(1000);
      await work;
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({
        connectivity: "unknown",
        lastContactMs: null,
        outcomes: { unknown: { acknowledged: 1 } },
      });
      expect(f.writes()).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("records timeout outcomes without altering a receipt or sending a connectivity probe", async () => {
    const f = fixture();
    f.configure(null);
    try {
      const work = f.write(true);
      await vi.advanceTimersByTimeAsync(13000);
      expect(await work).toMatchObject({ status: "ack_timeout", sendAttempted: true });
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({
        connectivity: "unknown",
        outcomes: { unknown: { timeout: 1 } },
      });
      expect(f.writes()).toHaveLength(1);
      expect(f.packets).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("masks child assessment on parent loss and does not recover it on session connect", async () => {
    const f = fixture();
    try {
      const work = f.write(true);
      await vi.advanceTimersByTimeAsync(100);
      await work;
      await vi.advanceTimersByTimeAsync(1);
      f.client.cameraHealthIngress.media(TARGET);
      expect(f.eufy.cameraHealth(TARGET)?.connectivity).toBe("online");
      f.session.close();
      expect(f.eufy.cameraHealth(TARGET)).toMatchObject({
        connectivity: "unknown",
        basis: "parent_unassessable",
        parentTransport: "disconnected",
      });
      f.client.cameraHealthIngress.parent(STATION, "connected");
      expect(f.eufy.cameraHealth(TARGET)?.connectivity).toBe("unknown");
      expect(f.writes()).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });
});
