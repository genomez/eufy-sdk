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
  let code: number | null = -108;
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

describe("shared per-property fast-refusal gate at the RTC packet boundary", () => {
  it.each([
    { options: { automatic: true }, sent: false },
    { options: { correction: true }, sent: false },
    { options: { automatic: true, correction: true }, sent: false },
    { options: { automatic: false, correction: true }, sent: false },
    { options: {}, sent: true },
    { options: { automatic: false, correction: false }, sent: true },
  ])("applies admission for $options during cooldown", async ({ options, sent }) => {
    const f = fixture();
    try {
      await f.degrade();
      const work = f.eufy.setPropertyWithReceipt(TARGET, "light", false, { ...profile, ...options });
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await work).sendAttempted).toBe(sent);
      expect(f.writes()).toHaveLength(sent ? 3 : 2);
      expect(f.health().status).toBe("command_degraded");
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("rejects automatic admission without a bounded profile before preparation", async () => {
    const f = fixture();
    try {
      const preparation = vi.spyOn(f.client, "commandContext");
      expect(await f.eufy.setPropertyWithReceipt(TARGET, "light", false, { automatic: true })).toMatchObject({
        status: "validation_failed",
        sendAttempted: false,
      });
      expect(preparation).not.toHaveBeenCalled();
      expect(f.writes()).toHaveLength(0);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("suppresses an automatic bootstrap during cooldown without correction watch semantics", async () => {
    const f = fixture();
    try {
      await f.degrade();
      const bootstrap = f.eufy.setPropertyWithReceipt(TARGET, "light", false, { ...profile, automatic: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await bootstrap).toMatchObject({ status: "cancelled_before_send", sendAttempted: false });
      expect(f.writes()).toHaveLength(2);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("keeps the refusal lineage when an automatic bootstrap queues behind the second response", async () => {
    const f = fixture();
    try {
      const first = f.write();
      await vi.advanceTimersByTimeAsync(100);
      await first;
      f.configure(-108, 500);
      const second = f.write(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.writes()).toHaveLength(2);
      f.configure(0);
      const bootstrap = f.eufy.setPropertyWithReceipt(TARGET, "light", false, { ...profile, automatic: true });
      await vi.advanceTimersByTimeAsync(1_000);
      await second;
      expect(await bootstrap).toMatchObject({ status: "cancelled_before_send", sendAttempted: false });
      expect(f.health().status).toBe("command_degraded");
      expect(f.writes()).toHaveLength(2);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each([{ automatic: true }, { correction: true }])(
    "checks automatic $options admission after activation during asynchronous preparation",
    async (options) => {
      const f = fixture();
      try {
        const first = f.write();
        await vi.advanceTimersByTimeAsync(100);
        await first;
        f.configure(-108, 500);
        const second = f.write(true);
        await vi.advanceTimersByTimeAsync(0);
        const context = await f.client.commandContext(TARGET);
        const prepared = Promise.withResolvers<typeof context>();
        vi.spyOn(f.client, "commandContext").mockImplementationOnce(() => prepared.promise);
        const bootstrap = f.eufy.setPropertyWithReceipt(TARGET, "light", false, { ...profile, ...options });
        await vi.advanceTimersByTimeAsync(1_000);
        await second;
        expect(f.health().status).toBe("command_degraded");
        prepared.resolve(context);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await bootstrap).toMatchObject({ status: "cancelled_before_send", sendAttempted: false });
        expect(f.writes()).toHaveLength(2);
      } finally {
        await f.eufy.disconnect();
      }
    },
  );

  it("lets a healthy automatic bootstrap establish the normal bounded passive watch", async () => {
    const f = fixture();
    const events: any[] = [];
    f.eufy.on("lateContraryEffect", (event) => events.push(event));
    f.configure(0);
    try {
      const bootstrap = f.eufy.setPropertyWithReceipt(TARGET, "light", false, { ...profile, automatic: true });
      await vi.advanceTimersByTimeAsync(100);
      const receipt = await bootstrap;
      expect(receipt).toMatchObject({ status: "acknowledged", sendAttempted: true });
      await vi.advanceTimersByTimeAsync(16_000);
      f.observe(false);
      await vi.advanceTimersByTimeAsync(1);
      f.observe(true);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(events.some((event) => event.intent === receipt.intent && event.state === "contrary")).toBe(true);
      expect(f.writes()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600_000);
      await expect(f.eufy.confirmLateContraryEffect(TARGET, receipt.intent!)).rejects.toThrow("unavailable");
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("keeps correction automatic even when automatic is false", async () => {
    const f = fixture();
    try {
      await f.degrade();
      const correction = f.eufy.setPropertyWithReceipt(TARGET, "light", false, {
        ...profile,
        correction: true,
        automatic: false,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await correction).toMatchObject({ status: "cancelled_before_send", sendAttempted: false });
      expect(f.writes()).toHaveLength(2);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each(["true", 1, null])("rejects malformed automatic admission %s before preparation", async (automatic) => {
    const f = fixture();
    try {
      const preparation = vi.spyOn(f.client, "commandContext");
      const work = f.eufy.setPropertyWithReceipt(TARGET, "light", false, { ...profile, automatic } as any);
      await vi.advanceTimersByTimeAsync(100);
      expect(await work).toMatchObject({ status: "validation_failed", sendAttempted: false });
      expect(preparation).not.toHaveBeenCalled();
      expect(f.writes()).toHaveLength(0);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each(["receipt", "void"])("counts legacy %s refusal before bounded corrections", async (api) => {
    const f = fixture();
    try {
      const original =
        api === "receipt"
          ? f.eufy.setPropertyWithReceipt(TARGET, "light", false)
          : f.eufy.setProperty(TARGET, "light", false);
      await vi.advanceTimersByTimeAsync(100);
      const result = await original;
      if (api === "receipt") expect(result).toMatchObject({ status: "pending_accepted", sendAttempted: true });
      const second = f.write(true);
      await vi.advanceTimersByTimeAsync(100);
      await second;
      const third = f.write(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(f.writes()).toHaveLength(2);
      expect(await third).toMatchObject({ status: "cancelled_before_send", sendAttempted: false });
      expect(f.health().status).toBe("command_degraded");
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each(["receipt", "void"])("preserves legacy %s slow refusal, ACK and error behavior", async (api) => {
    const f = fixture();
    const legacy = () =>
      (api === "receipt"
        ? f.eufy.setPropertyWithReceipt(TARGET, "light", false)
        : f.eufy.setProperty(TARGET, "light", false)
      ).then(
        (result) => ({ result }),
        (error: Error) => ({ error }),
      );
    try {
      f.configure(-108, 10_000);
      const slow = legacy();
      await vi.advanceTimersByTimeAsync(10_000);
      const slowResult = await slow;
      expect(slowResult).not.toHaveProperty("error");
      if (api === "receipt") expect(slowResult).toMatchObject({ result: { status: "pending_accepted" } });
      f.configure(0);
      const ack = legacy();
      await vi.advanceTimersByTimeAsync(100);
      expect(await ack).not.toHaveProperty("error");
      f.configure(-103);
      const rejected = legacy();
      await vi.advanceTimersByTimeAsync(100);
      expect(await rejected).toMatchObject({ error: { code: -103 } });
      f.configure(null);
      const timeout = legacy();
      await vi.advanceTimersByTimeAsync(14_000);
      expect(await timeout).toHaveProperty("error");
      expect(f.health().status).toBe("healthy");
      expect(f.writes()).toHaveLength(4);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("counts caller plus recovery child and suppresses corrections while a sibling succeeds", async () => {
    const f = fixture();
    try {
      await f.degrade();
      const correction = f.write(true);
      const sibling = f.write(false, SIBLING);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await correction).toMatchObject({
        status: "cancelled_before_send",
        sendAttempted: false,
        commandHealth: { status: "command_degraded", revision: 1 },
      });
      expect((await sibling).status).toBe("acknowledged");
      expect(f.writes()).toHaveLength(2);
      expect(f.writes(2)).toHaveLength(1);
      expect(f.eufy.getRtcCommandDiagnostics()).toMatchObject({
        commandHealth: { activations: 1, suppressedSends: 1 },
      });
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("gives a new explicit command exactly one packet during cooldown and restores retry eligibility after expiry", async () => {
    const f = fixture();
    try {
      await f.degrade();
      const explicit = f.write();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(await explicit).toMatchObject({ sendAttempted: true, commandHealth: { status: "command_degraded" } });
      expect(f.writes()).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.health()).toEqual({ status: "healthy", cooldownRemainingMs: 0, revision: 2 });
      const next = f.write();
      await vi.advanceTimersByTimeAsync(16_000);
      expect((await next).status).toBe("pending_accepted");
      expect(f.writes()).toHaveLength(5);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("cancels an already queued correction before the second fast response releases its station exchange", async () => {
    const f = fixture();
    try {
      const first = f.write();
      await vi.advanceTimersByTimeAsync(100);
      await first;
      f.configure(-108, 500);
      const second = f.write(true);
      await vi.advanceTimersByTimeAsync(0);
      const queued = f.write(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await second).sendAttempted).toBe(true);
      expect(await queued).toMatchObject({
        status: "cancelled_before_send",
        sendAttempted: false,
        commandHealth: { status: "command_degraded" },
      });
      expect(f.writes()).toHaveLength(2);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each([
    { code: -108, latency: 10_000, status: "pending_accepted" },
    { code: -103, latency: 100, status: "rejected" },
    { code: null, latency: 12_000, status: "ack_timeout" },
    { code: -108, latency: 1001, status: "pending_accepted" },
  ])("does not count $code at $latency ms as fast refusal", async ({ code, latency, status }) => {
    const f = fixture();
    f.configure(code, latency);
    try {
      const first = f.write();
      await vi.advanceTimersByTimeAsync(Math.max(12_000, latency));
      expect((await first).status).toBe(status);
      const correction = f.write(true);
      await vi.advanceTimersByTimeAsync(12_000);
      expect((await correction).sendAttempted).toBe(true);
      expect(f.health()).toEqual({ status: "healthy", cooldownRemainingMs: 0, revision: 0 });
      expect(f.eufy.getRtcCommandDiagnostics()).toMatchObject({ commandHealth: { activations: 0 } });
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("does not combine separate explicit lineages", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 2; i++) {
        const explicit = f.write();
        await vi.advanceTimersByTimeAsync(100);
        expect(await explicit).toMatchObject({ responseLatencyMs: 100, rejectionCode: -108 });
      }
      expect(f.health().status).toBe("healthy");
      const correction = f.write(true);
      await vi.advanceTimersByTimeAsync(100);
      expect((await correction).sendAttempted).toBe(true);
      expect(f.health().status).toBe("command_degraded");
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("counts fast correlated responses after long station queue waits using only send-to-response latency", async () => {
    const f = fixture();
    f.delaySibling(5_000);
    try {
      const firstBlocker = f.write(false, SIBLING);
      const first = f.write();
      await vi.advanceTimersByTimeAsync(5_100);
      expect((await firstBlocker).status).toBe("acknowledged");
      expect(await first).toMatchObject({ sentAtMonotonicMs: 5_000, responseLatencyMs: 100 });
      const secondBlocker = f.write(false, SIBLING);
      const second = f.write(true);
      await vi.advanceTimersByTimeAsync(5_100);
      expect((await secondBlocker).status).toBe("acknowledged");
      expect(await second).toMatchObject({ responseLatencyMs: 100, commandHealth: { status: "command_degraded" } });
      expect(f.writes()).toHaveLength(2);
      expect(f.writes(2)).toHaveLength(2);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("expires fast evidence at 60 seconds while preserving the original passive watch", async () => {
    const f = fixture();
    try {
      const first = f.write();
      await vi.advanceTimersByTimeAsync(100);
      await first;
      f.client.opts.autoRealtime = false;
      await vi.advanceTimersByTimeAsync(60_001);
      const correction = f.write(true);
      await vi.advanceTimersByTimeAsync(100);
      await correction;
      expect(f.health().status).toBe("healthy");
      expect(f.eufy.getRtcCommandDiagnostics().lateContrary.watched).toBe(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("keeps passive contrary detection alive after gate activation", async () => {
    const f = fixture();
    const events: any[] = [];
    f.eufy.on("lateContraryEffect", (event) => events.push(event));
    try {
      await f.degrade();
      f.observe(false);
      await vi.advanceTimersByTimeAsync(1);
      f.observe(true);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(events.some((event) => event.state === "contrary")).toBe(true);
      expect(f.writes()).toHaveLength(2);
      expect(f.health().status).toBe("command_degraded");
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("retains original passive bounds under a suppressed correction receipt's current intent", async () => {
    const f = fixture();
    const events: any[] = [];
    f.eufy.on("lateContraryEffect", (event) => events.push(event));
    try {
      await f.degrade();
      const suppressed = f.write(true);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await suppressed;
      expect(receipt).toMatchObject({ status: "cancelled_before_send", sendAttempted: false });
      f.observe(false);
      await vi.advanceTimersByTimeAsync(1);
      f.observe(true);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(events.some((event) => event.state === "contrary" && event.intent === receipt.intent)).toBe(true);
      const confirmation = f.eufy.confirmLateContraryEffect(TARGET, receipt.intent!);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await confirmation).toMatchObject({ intent: receipt.intent, confirmed: true, observedValue: true });
      expect(f.eufy.getRtcCommandDiagnostics().lateContrary.watched).toBe(1);
      expect(f.writes()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(600_000);
      await expect(f.eufy.confirmLateContraryEffect(TARGET, receipt.intent!)).rejects.toThrow("unavailable");
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("rejects an unprofiled correction without transmitting around the shared gate", async () => {
    const f = fixture();
    try {
      await f.degrade();
      const work = f.eufy
        .setPropertyWithReceipt(TARGET, "light", false, { correction: true })
        .catch((error: Error) => ({ status: error.message, sendAttempted: true }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.writes()).toHaveLength(2);
      expect(await work).toMatchObject({ status: "validation_failed", sendAttempted: false });
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("suppresses later ON correction packets after an ON retry, late match, contrary report and skipped OFF", async () => {
    const f = fixture();
    try {
      f.observe(false);
      const original = f.eufy.setPropertyWithReceipt(TARGET, "light", true, profile);
      await vi.advanceTimersByTimeAsync(16_000);
      expect((await original).status).toBe("pending_accepted");
      expect(f.writes()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(124_000);
      f.observe(true);
      await vi.advanceTimersByTimeAsync(23_000);
      f.observe(false);
      await vi.advanceTimersByTimeAsync(54_000);
      expect(f.writes()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(100_000);
      const correction = f.eufy.setPropertyWithReceipt(TARGET, "light", true, { ...profile, correction: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await correction).toMatchObject({
        status: "cancelled_before_send",
        sendAttempted: false,
        commandHealth: { status: "command_degraded" },
      });
      expect(f.writes()).toHaveLength(2);
    } finally {
      await f.eufy.disconnect();
    }
  });
});
