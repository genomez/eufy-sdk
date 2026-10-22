import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { buildPortalHeader, parsePortalHeader } from "../../transport/rtc/portal-packet.js";
import type { CommandReceipt } from "../../core/contracts.js";

const STATION = "T9000P0000000000";
const TARGET = "T8425P0000000000";
const profile = { profile: "bounded-state-v1" } as const;
type ReceiptStatus = "acknowledged" | "pending_accepted" | "ack_timeout";

function fixture(rtc: { idleCloseMs?: number; sessionRefreshMs?: number } = { idleCloseMs: 900_000 }) {
  const wall = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - wall);
  const eufy = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
    rtc: { commandTimeoutMs: 14_000, sessionRefreshMs: 0, ...rtc },
  });
  const client = eufy as any;
  const packets: { at: number; packet: Buffer }[] = [];
  class Session extends EventEmitter {
    isConnected = false;
    async connect() {
      this.isConnected = true;
      this.emit("connected");
    }
    sendCommand(packet: Buffer) {
      packets.push({ at: performance.now(), packet });
      return true;
    }
    ack(packet: Buffer, code = 0) {
      const header = parsePortalHeader(packet)!;
      const body = Buffer.alloc(4);
      body.writeInt32LE(code);
      this.emit(
        "commandData",
        Buffer.concat([buildPortalHeader(header.commandId, body.length, header.channel, header.segment, 1), body]),
        1,
      );
    }
    report(value: boolean, channel = 1) {
      const body = Buffer.from(JSON.stringify({ params: [{ channel, param_type: 1400, param_value: Number(value) }] }));
      const packet = Buffer.concat([buildPortalHeader(1103, body.length, 255, 0, 0), body]);
      this.emit("commandData", packet, 3);
      return packet;
    }
    answer(value: boolean, channel = 1) {
      const latest = packets.findLast(({ packet }) => parsePortalHeader(packet)!.commandId === 1103)!;
      this.ack(latest.packet);
      this.report(value, channel);
    }
    close() {
      this.isConnected = false;
      this.emit("close");
    }
  }
  const session = new Session();
  const sessions = [session];
  let created = false;
  client.registry.devices = [
    { sn: STATION, model: "T9000", params: {}, raw: {} },
    {
      sn: TARGET,
      stationSn: STATION,
      model: "T8425",
      category: "eufy_security",
      params: { 1400: "0" },
      raw: { device_channel: 1, device_type: 47, parent_sn: STATION },
    },
  ];
  vi.spyOn(client.registry, "record").mockImplementation(async () => ({
    model: "T8425",
    deviceType: 47,
    category: "eufy_security",
    parentSn: STATION,
    params: { 1400: "0" },
    paramUpdatedAt: {},
  }));
  client.rtc.deps.identity = () => ({ authToken: "synthetic-token", userId: "synthetic-user" });
  client.rtc.deps.shard = () => "ie-pr";
  client.rtc.deps.createSession = () => {
    if (!created) {
      created = true;
      return session;
    }
    const next = new Session();
    sessions.push(next);
    return next;
  };
  client.opts.autoRealtime = true;
  client.realtimeGeneration = {
    epoch: client.realtimeEpoch,
    abort: new AbortController(),
    stateRefreshFailures: 0,
    readiness: { push: {}, mqtt: {}, wiredP2p: {}, states: {} },
    settled: true,
  };
  const events: { state: string; intent: number; desiredValue: boolean; observedValue?: boolean; ageMs: number }[] = [];
  eufy.on("lateContraryEffect", (event) => events.push(event));
  const commands = () => packets.map(({ packet }) => parsePortalHeader(packet)!.commandId);
  async function write(desired: boolean, status: ReceiptStatus): Promise<CommandReceipt> {
    const work = eufy.setPropertyWithReceipt(TARGET, "light", desired, profile);
    await vi.advanceTimersByTimeAsync(0);
    if (status === "ack_timeout") await vi.advanceTimersByTimeAsync(12_000);
    else {
      await vi.advanceTimersByTimeAsync(1_000);
      session.ack(packets[0]!.packet, status === "pending_accepted" ? -108 : 0);
      await vi.advanceTimersByTimeAsync(0);
    }
    const receipt = await work;
    expect(receipt.status).toBe(status);
    expect(receipt.intent).toBeTypeOf("number");
    return receipt;
  }
  async function advanceTo(at: number) {
    await vi.advanceTimersByTimeAsync(Math.max(0, at - performance.now()));
  }
  return { eufy, client, session, sessions, packets, events, commands, write, advanceTo };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("late contrary effects through the public RTC facade", () => {
  it.each(
    (["acknowledged", "pending_accepted", "ack_timeout"] as const).flatMap((status) =>
      [false, true].map((desired) => ({ status, desired })),
    ),
  )(
    "preserves a $status $desired watch after initial match and requires two fresh reads",
    async ({ status, desired }) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        const receipt = await f.write(desired, status);
        f.session.report(desired);
        await f.advanceTo(30_000);
        expect(f.commands()).toEqual([1700]);
        f.session.report(!desired);
        expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.commands()).toEqual([1700, 1103]);
        expect(f.packets[1]!.at).toBeGreaterThan(30_000);
        expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
        f.session.answer(!desired);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.events.filter((event) => event.state === "contrary")).toEqual([
          expect.objectContaining({ intent: receipt.intent, desiredValue: desired, observedValue: !desired }),
        ]);
        const confirmed = f.eufy.confirmLateContraryEffect(TARGET, receipt.intent!);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(f.commands()).toEqual([1700, 1103]);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.commands()).toEqual([1700, 1103, 1103]);
        expect(f.packets[2]!.at - f.packets[1]!.at).toBeGreaterThanOrEqual(5_000);
        f.session.answer(!desired);
        await vi.advanceTimersByTimeAsync(0);
        expect(await confirmed).toMatchObject({
          intent: receipt.intent,
          desiredValue: desired,
          observedValue: !desired,
          confirmed: true,
          recoveryBusy: false,
        });
        await f.advanceTo(59_000);
        expect(f.commands()).toEqual([1700, 1103, 1103]);
        expect(f.eufy.getRtcCommandDiagnostics().schedulerTotals).toMatchObject({ active: 0, queued: 0 });
      } finally {
        await f.eufy.disconnect();
      }
    },
  );

  it.each([false, true])("cancels a candidate when %s is restored while its read is queued", async (desired) => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.write(desired, "acknowledged");
      f.session.report(desired);
      await f.advanceTo(30_000);
      f.session.report(!desired);
      f.session.report(desired);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.commands()).toEqual([1700, 1103]);
      f.session.answer(desired);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      f.session.report(!desired);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.commands()).toEqual([1700, 1103, 1103]);
      f.session.answer(!desired);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("lets a matching candidate-read response settle without tainting the station session", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.write(true, "acknowledged");
      f.session.report(true);
      await f.advanceTo(30_000);
      f.session.report(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.commands()).toEqual([1700, 1103]);
      f.session.answer(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      f.session.report(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.commands()).toEqual([1700, 1103, 1103]);
      f.session.answer(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("gives a separate receive its own identity when the session reuses the same buffer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.write(true, "acknowledged");
      f.session.report(true);
      await f.advanceTo(30_000);
      const reused = f.session.report(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.commands()).toEqual([1700, 1103]);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
      f.session.ack(f.packets[1]!.packet);
      f.session.emit("commandData", reused, 3);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("verifies a newer contrary candidate after an older candidate read settles", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.write(true, "acknowledged");
      f.session.report(true);
      await f.advanceTo(30_000);
      f.session.report(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.commands()).toEqual([1700, 1103]);
      await vi.advanceTimersByTimeAsync(1);
      f.session.report(true);
      await vi.advanceTimersByTimeAsync(1);
      f.session.report(false);
      await vi.advanceTimersByTimeAsync(1);
      f.session.ack(f.packets[1]!.packet);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(f.commands()).toEqual([1700, 1103]);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.commands()).toEqual([1700, 1103, 1103]);
      expect(f.packets[2]!.at - f.packets[1]!.at).toBeGreaterThanOrEqual(5_000);
      f.session.answer(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("does not confirm a stale candidate without a subsequent information response", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.write(true, "acknowledged");
      f.session.report(true);
      await f.advanceTo(30_000);
      f.session.report(false);
      await vi.advanceTimersByTimeAsync(8_001);
      expect(f.commands()).toEqual([1700, 1103]);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("rejects a completed read that reports another channel instead of the watched target", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.write(true, "acknowledged");
      f.session.report(true);
      await f.advanceTo(30_000);
      f.session.report(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.commands()).toEqual([1700, 1103]);
      f.session.answer(false, 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
      expect(f.eufy.getRtcCommandDiagnostics().schedulerTotals).toMatchObject({ active: 0, queued: 0 });
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each(["bounded", "legacy"])("supersedes a watch when a newer %s write owns the property", async (mode) => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const original = await f.write(true, "acknowledged");
      f.session.report(true);
      const work =
        mode === "bounded"
          ? f.eufy.setPropertyWithReceipt(TARGET, "light", false, profile)
          : f.eufy.setProperty(TARGET, "light", false).then(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      f.session.ack(f.packets[1]!.packet);
      await vi.advanceTimersByTimeAsync(0);
      const latest = await work;
      expect(f.events).toContainEqual(expect.objectContaining({ state: "superseded", intent: original.intent }));
      await expect(f.eufy.confirmLateContraryEffect(TARGET, original.intent!)).rejects.toThrow();
      f.session.report(false);
      await f.advanceTo(30_000);
      f.session.report(true);
      await vi.advanceTimersByTimeAsync(1);
      if (mode === "bounded") {
        expect(f.commands()).toEqual([1700, 1700, 1103]);
        f.session.answer(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.events.filter((event) => event.state === "contrary")).toEqual([
          expect.objectContaining({ intent: latest!.intent, desiredValue: false, observedValue: true }),
        ]);
      } else {
        expect(f.commands()).toEqual([1700, 1700]);
        expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
      }
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("keeps the original pending recovery as the only additional state send", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const receipt = await f.write(true, "pending_accepted");
      await f.advanceTo(15_000);
      expect(f.commands()).toEqual([1700, 1103]);
      await vi.advanceTimersByTimeAsync(1);
      f.session.answer(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.commands()).toEqual([1700, 1103, 1700]);
      expect(await f.eufy.confirmLateContraryEffect(TARGET, receipt.intent!)).toMatchObject({
        intent: receipt.intent,
        confirmed: false,
        recoveryBusy: true,
      });
      expect(f.commands()).toEqual([1700, 1103, 1700]);
      f.session.ack(f.packets[2]!.packet);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.events.some((event) => event.state === "recovery_settled")).toBe(true);
      expect(f.commands()).toEqual([1700, 1103, 1700, 1103]);
      f.session.answer(false);
      await vi.advanceTimersByTimeAsync(0);
      f.session.report(true);
      await f.advanceTo(60_000);
      expect(f.commands().filter((command) => command === 1700)).toHaveLength(2);
      expect(f.eufy.getRtcCommandDiagnostics().lateEffect).toMatchObject({ retrySent: 1 });
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each([false, true])(
    "migrates a %s correction to its new intent while preserving the original window",
    async (desired) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        const original = await f.write(desired, "acknowledged");
        f.session.report(desired);
        await f.advanceTo(40_000);
        const work = f.eufy.setPropertyWithReceipt(TARGET, "light", desired, { ...profile, correction: true });
        await vi.advanceTimersByTimeAsync(0);
        f.session.ack(f.packets[1]!.packet);
        await vi.advanceTimersByTimeAsync(0);
        const correction = await work;
        expect(correction).toMatchObject({ status: "acknowledged", sendAttempted: true });
        expect(correction.intent).not.toBe(original.intent);
        expect(f.events.filter((event) => event.state === "superseded")).toHaveLength(0);
        await expect(f.eufy.confirmLateContraryEffect(TARGET, original.intent!)).rejects.toThrow();
        await f.advanceTo(50_000);
        f.session.report(!desired);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.commands()).toEqual([1700, 1700, 1103]);
        f.session.answer(!desired);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.events.filter((event) => event.state === "contrary")).toEqual([
          expect.objectContaining({ intent: correction.intent, desiredValue: desired, ageMs: 50_001 }),
        ]);
        await f.advanceTo(600_001);
        expect(f.events).toContainEqual(
          expect.objectContaining({ state: "expired", intent: correction.intent, ageMs: 600_000 }),
        );
        await expect(f.eufy.confirmLateContraryEffect(TARGET, correction.intent!)).rejects.toThrow();
        f.session.report(!desired);
        await vi.advanceTimersByTimeAsync(8_001);
        expect(f.commands()).toEqual([1700, 1700, 1103]);
      } finally {
        await f.eufy.disconnect();
      }
    },
  );

  it.each(["queued", "sent"])("preserves passive observation after a %s correction is cancelled", async (stage) => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.write(true, "acknowledged");
      f.session.report(true);
      await f.advanceTo(40_000);
      const blockingRead = stage === "queued" ? f.client.rtc.refreshInformation(STATION) : undefined;
      await vi.advanceTimersByTimeAsync(0);
      const controller = new AbortController();
      const work = f.eufy.setPropertyWithReceipt(TARGET, "light", true, {
        ...profile,
        correction: true,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      const correction = await work;
      expect(correction).toMatchObject({
        status: stage === "queued" ? "cancelled_before_send" : "cancelled_after_send",
        sendAttempted: stage === "sent",
      });
      if (blockingRead) {
        f.session.answer(true);
        await vi.advanceTimersByTimeAsync(0);
        await blockingRead;
      }
      expect(f.eufy.getRtcCommandDiagnostics().lateContrary.active).toBe(1);
      await f.advanceTo(50_000);
      f.session.report(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.commands()).toEqual(stage === "queued" ? [1700, 1103, 1103] : [1700, 1700, 1103]);
      f.session.answer(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.filter((event) => event.state === "contrary")).toEqual([
        expect.objectContaining({ intent: correction.intent, ageMs: 50_001 }),
      ]);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("preserves the sixteen reserved confirmation reads across a correction intent", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const original = await f.write(true, "acknowledged");
      f.session.report(true);
      await f.advanceTo(30_000);
      for (let count = 0; count < 16; count++) {
        const confirmation = f.eufy.confirmLateContraryEffect(TARGET, original.intent!);
        await vi.advanceTimersByTimeAsync(1);
        f.session.answer(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(await confirmation).toMatchObject({ confirmed: true, observedValue: true });
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(f.commands().filter((command) => command === 1103)).toHaveLength(16);
      await f.advanceTo(100_000);
      const work = f.eufy.setPropertyWithReceipt(TARGET, "light", true, { ...profile, correction: true });
      await vi.advanceTimersByTimeAsync(0);
      f.session.ack(f.packets.at(-1)!.packet);
      await vi.advanceTimersByTimeAsync(0);
      const correction = await work;
      expect(await f.eufy.confirmLateContraryEffect(TARGET, correction.intent!)).toMatchObject({ confirmed: false });
      expect(f.commands().filter((command) => command === 1103)).toHaveLength(16);
      expect(f.eufy.getRtcCommandDiagnostics().lateContrary.active).toBe(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each(["close", "expiry"])("ends a watch on %s without periodic traffic", async (ending) => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.write(true, "acknowledged");
      f.session.report(true);
      if (ending === "close") f.session.close();
      else await f.advanceTo(600_001);
      f.session.report(false);
      await vi.advanceTimersByTimeAsync(8_001);
      expect(f.commands()).toEqual([1700]);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
      expect(f.events.some((event) => event.state === (ending === "close" ? "suspended" : "expired"))).toBe(true);
    } finally {
      await f.eufy.disconnect();
    }
  });
  it.each([1_000, 600_000])(
    "never sends an admitted correction held in the real scheduler beyond original expiry without cancellation (%s)",
    async (remaining) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        await f.write(false, "acknowledged");
        f.session.report(false);
        await f.advanceTo(599_000);
        const blocking = f.client.rtc.refreshInformation(STATION);
        await vi.advanceTimersByTimeAsync(0);
        const work = f.eufy.setPropertyWithReceipt(TARGET, "light", false, {
          ...profile,
          correction: true,
          correctionExpiresAtMs: Date.now() + remaining,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.eufy.getRtcCommandDiagnostics().schedulerTotals.queued).toBe(1);
        await vi.advanceTimersByTimeAsync(1_001);
        f.session.answer(false);
        await vi.advanceTimersByTimeAsync(0);
        await blocking;
        expect(f.commands().filter((command) => command === 1700)).toHaveLength(1);
        expect(await work).toMatchObject({ status: "expired_before_send", sendAttempted: false });
        expect(f.commands().filter((command) => command === 1700)).toHaveLength(1);
      } finally {
        await f.eufy.disconnect();
      }
    },
  );

  it("three freshly confirmed spaced correction origins with slow correlated rejection send exactly three corrections", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      let owner = (await f.write(false, "acknowledged")).intent!;
      f.session.report(false);
      await f.advanceTo(30_000);
      f.session.report(true);
      await vi.advanceTimersByTimeAsync(1);
      f.session.answer(true);
      await vi.advanceTimersByTimeAsync(0);
      let corrections = 0;
      for (const at of [45_000, 105_000, 345_000]) {
        await f.advanceTo(at);
        const confirmation = f.eufy.confirmLateContraryEffect(TARGET, owner);
        await vi.advanceTimersByTimeAsync(1);
        f.session.answer(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(await confirmation).toMatchObject({ confirmed: true, observedValue: true });
        const work = f.eufy.setPropertyWithReceipt(TARGET, "light", false, {
          ...profile,
          correction: true,
          correctionExpiresAtMs: Date.now() + 600_000 - performance.now(),
        });
        await vi.advanceTimersByTimeAsync(0);
        const correctionPacket = f.packets.at(-1)!;
        expect(parsePortalHeader(correctionPacket.packet)!.commandId).toBe(1700);
        await vi.advanceTimersByTimeAsync(10_000);
        f.session.ack(correctionPacket.packet, -108);
        await vi.advanceTimersByTimeAsync(0);
        const receipt = await work;
        expect(receipt.status).toBe("pending_accepted");
        expect(receipt.responseLatencyMs).toBe(10_000);
        owner = receipt.intent!;
        corrections++;
        for (const offset of [15_000, 25_000, 40_000]) {
          await f.advanceTo(correctionPacket.at + offset + 1);
          f.session.answer(true);
          await vi.advanceTimersByTimeAsync(0);
          expect(f.commands().filter((command) => command === 1700)).toHaveLength(corrections + 1);
        }
      }
      const statePackets = f.packets.filter(({ packet }) => parsePortalHeader(packet)!.commandId === 1700);
      expect(statePackets).toHaveLength(4);
      expect(statePackets.slice(1).map(({ at }) => at)).toEqual([45_001, 105_001, 345_001]);
      expect(f.eufy.getRtcCommandDiagnostics().lateEffect.retrySent).toBe(0);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("default idle retirement preserves the window and requires explicit fresh session confirmation", async () => {
    vi.useFakeTimers();
    const f = fixture({});
    try {
      const receipt = await f.write(false, "acknowledged");
      f.session.report(false);
      await f.advanceTo(61_001);
      expect(f.session.isConnected).toBe(false);
      expect(f.events.at(-1)).toMatchObject({ state: "suspended", intent: receipt.intent });
      expect(await f.eufy.confirmLateContraryEffect(TARGET, receipt.intent!)).toMatchObject({ confirmed: false });
      expect(f.sessions).toHaveLength(1);
      const confirmation = f.eufy.confirmLateContraryEffect(TARGET, receipt.intent!, { resumeSession: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.sessions).toHaveLength(2);
      f.session.report(true);
      expect(f.events.filter((event) => event.state === "contrary")).toHaveLength(0);
      f.sessions[1]!.answer(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(await confirmation).toMatchObject({ confirmed: true, observedValue: true });
      expect(f.commands().filter((command) => command === 1700)).toHaveLength(1);
      await f.advanceTo(600_001);
      expect(f.events.at(-1)).toMatchObject({ state: "expired", ageMs: 600_000 });
      await expect(
        f.eufy.confirmLateContraryEffect(TARGET, receipt.intent!, { resumeSession: true }),
      ).rejects.toThrow();
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("proactive replacement retains ownership but invalidates candidate-session evidence until a fresh read", async () => {
    vi.useFakeTimers();
    const f = fixture({ idleCloseMs: 900_000, sessionRefreshMs: 30_000 });
    try {
      const receipt = await f.write(false, "acknowledged");
      f.session.report(false);
      await f.advanceTo(31_001);
      expect(f.sessions).toHaveLength(2);
      f.sessions[1]!.answer(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.events.at(-1)).toMatchObject({ state: "suspended", intent: receipt.intent });
      expect(f.session.isConnected).toBe(false);
      const confirmation = f.eufy.confirmLateContraryEffect(TARGET, receipt.intent!, { resumeSession: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.commands().filter((command) => command === 1103)).toHaveLength(2);
      f.sessions[1]!.answer(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(await confirmation).toMatchObject({ confirmed: true, observedValue: true, intent: receipt.intent });
      expect(f.commands().filter((command) => command === 1700)).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each([
    { correction: false, offset: 100 },
    { correction: true, offset: NaN },
    { correction: true, offset: Infinity },
    { correction: true, offset: 600_001 },
  ])("rejects invalid correction deadline authority %j before transport admission", async ({ correction, offset }) => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.write(false, "acknowledged");
      const receipt = await f.eufy.setPropertyWithReceipt(TARGET, "light", false, {
        ...profile,
        correction,
        correctionExpiresAtMs: Date.now() + offset,
      });
      expect(receipt).toMatchObject({ status: "validation_failed", sendAttempted: false });
      expect(f.commands().filter((command) => command === 1700)).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("cannot create or renew correction observation after the original window has expired", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.write(false, "acknowledged");
      await f.advanceTo(600_001);
      const receipt = await f.eufy.setPropertyWithReceipt(TARGET, "light", false, {
        ...profile,
        correction: true,
        correctionExpiresAtMs: Date.now() + 60_000,
      });
      expect(receipt).toMatchObject({ status: "expired_before_send", sendAttempted: false });
      expect(f.commands().filter((command) => command === 1700)).toHaveLength(1);
      expect(f.eufy.getRtcCommandDiagnostics().lateContrary.active).toBe(0);
    } finally {
      await f.eufy.disconnect();
    }
  });
});
