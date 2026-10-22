import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { buildPortalHeader, parsePortalHeader } from "../../transport/rtc/portal-packet.js";
import type { CommandReceipt } from "../../core/contracts.js";
import type { PropertyExecutionOptions } from "../types.js";

const HUB = "T9000P0000000000";
const targets = Array.from({ length: 5 }, (_, i) => `T8425P000000000${i}`);
const profile = { profile: "bounded-state-v1" } as const;

function fixture(delays: (number | null)[] = [4_000, 4_000, 4_000, 4_000, 4_000]) {
  const wall = Date.now();
  let clockJump = 0;
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - wall - clockJump);
  const eufy = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
    rtc: { commandTimeoutMs: 14_000, sessionRefreshMs: 0 },
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
      const header = parsePortalHeader(packet)!;
      packets.push({ at: performance.now(), packet });
      const delay = delays[header.channel - 1];
      if (header.commandId !== 1103 && delay !== null) setTimeout(() => this.ack(packet), delay ?? 0);
      return true;
    }
    ack(packet: Buffer, code = 0) {
      const h = parsePortalHeader(packet)!;
      const body = Buffer.alloc(4);
      body.writeInt32LE(code);
      this.emit(
        "commandData",
        Buffer.concat([buildPortalHeader(h.commandId, body.length, h.channel, h.segment, 1), body]),
        1,
      );
    }
    information(value: number) {
      const packet = packets.findLast(({ packet }) => parsePortalHeader(packet)?.commandId === 1103)!.packet;
      this.ack(packet);
      const body = Buffer.from(JSON.stringify({ params: [{ channel: 1, param_type: 1400, param_value: value }] }));
      this.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 255, 0, 0), body]), 3);
    }
    close() {
      this.isConnected = false;
      this.emit("close");
    }
  }
  const session = new Session();
  client.registry.devices = [
    { sn: HUB, model: "T9000", params: {}, raw: {} },
    ...targets.map((sn, i) => ({
      sn,
      stationSn: HUB,
      model: "T8425",
      category: "eufy_security",
      params: { 1400: "0" },
      raw: { device_channel: i + 1, device_type: 47, parent_sn: HUB },
    })),
  ];
  const record = vi.spyOn(client.registry, "record").mockImplementation(async () => ({
    model: "T8425",
    deviceType: 47,
    category: "eufy_security",
    parentSn: HUB,
    params: { 1400: "0" },
    paramUpdatedAt: {},
  }));
  client.rtc.deps.identity = () => ({ authToken: "synthetic-token", userId: "synthetic-user" });
  client.rtc.deps.shard = () => "ie-pr";
  client.rtc.deps.createSession = () => session;
  return {
    eufy,
    client,
    packets,
    session,
    record,
    jumpWall: (ms: number) => {
      clockJump += ms;
      vi.setSystemTime(Date.now() + ms);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("public bounded absolute-state writes", () => {
  it.each(["normal", ...targets.map((_, i) => `slow-${i}`), ...targets.map((_, i) => `silent-${i}`)])(
    "serves five distinct roster targets within the quantitative bounds: %s",
    async (scenario) => {
      vi.useFakeTimers();
      const delays: (number | null)[] = [4_000, 4_000, 4_000, 4_000, 4_000];
      if (scenario !== "normal") delays[Number(scenario.split("-")[1])] = scenario.startsWith("slow") ? 10_800 : null;
      const f = fixture(delays);
      try {
        const work = targets.map((sn) => f.eufy.setPropertyWithReceipt(sn, "light", true, profile));
        await vi.advanceTimersByTimeAsync(29_000);
        const receipts = await Promise.all(work);
        expect(receipts.map((r) => r.status)).toEqual(
          delays.map((delay) => (delay === null ? "ack_timeout" : "acknowledged")),
        );
        expect(f.packets).toHaveLength(5);
        expect(f.packets.map(({ packet }) => parsePortalHeader(packet)!.channel)).toEqual([1, 2, 3, 4, 5]);
        expect(new Set(f.packets.map(({ packet }) => parsePortalHeader(packet)!.segment)).size).toBe(5);
        let elapsed = 0;
        for (let i = 0; i < 5; i++) {
          expect(f.packets[i]!.at).toBe(elapsed);
          expect(f.packets[i]!.at).toBeLessThan(60_000);
          elapsed += delays[i] ?? 12_000;
        }
        expect(elapsed).toBeLessThanOrEqual(28_000);
        expect(f.client.rtc.getCommandDiagnostics().scheduler[0]).toMatchObject({
          active: 0,
          queued: 0,
          invariantViolations: 0,
        });
        expect(f.eufy.getRtcCommandDiagnostics().queueWait.observations).toBe(5);
      } finally {
        await f.eufy.disconnect();
      }
    },
  );

  it.each([false, true])("supersedes queued equal/opposite state without transmitting old state (%s)", async (same) => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const block = f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, profile);
      await vi.advanceTimersByTimeAsync(0);
      const old = f.eufy.setPropertyWithReceipt(targets[1]!, "light", true, profile);
      const latest = f.eufy.setPropertyWithReceipt(targets[1]!, "light", same, profile);
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await old).status).toBe("superseded_before_send");
      expect((await latest).status).toBe("acknowledged");
      expect(f.packets).toHaveLength(2);
      expect((await block).status).toBe("acknowledged");
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("does not resurrect a prepared older invocation after a newer command", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: (value: unknown) => void;
    f.record.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    try {
      const old = f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, profile);
      const latest = f.eufy.setPropertyWithReceipt(targets[0]!, "light", false, profile);
      await vi.advanceTimersByTimeAsync(0);
      release({ model: "T8425", deviceType: 47, category: "eufy_security", params: { 1400: "0" }, paramUpdatedAt: {} });
      await vi.advanceTimersByTimeAsync(4_000);
      expect((await old).status).toBe("superseded_before_send");
      expect((await latest).status).toBe("acknowledged");
      expect(f.packets).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("supersedes an unsent legacy invocation through the same property registry", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const block = f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, profile);
      await vi.advanceTimersByTimeAsync(0);
      const old = f.eufy.setProperty(targets[1]!, "light", true).then(
        () => "accepted",
        (error: Error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(0);
      const latest = f.eufy.setPropertyWithReceipt(targets[1]!, "light", false, profile);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await old).toBe("superseded_before_send");
      expect((await latest).status).toBe("acknowledged");
      expect((await block).status).toBe("acknowledged");
      expect(f.packets).toHaveLength(2);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("charges a slow cold connect to acquisition, not to queue waiting", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.session.connect = () => new Promise<void>(() => {});
    try {
      const result = f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, profile);
      await vi.advanceTimersByTimeAsync(80_000);
      const receipt = await result;
      expect(receipt.sendAttempted).toBe(false);
      expect(f.packets).toHaveLength(0);
      const diagnostics = f.eufy.getRtcCommandDiagnostics();
      expect(diagnostics.queueWait.observations).toBe(1);
      expect(diagnostics.queueWait.lastMs).toBeLessThanOrEqual(100);
      expect(diagnostics.recent.at(-1)!.acquisitionWaitMs).toBeGreaterThan(5_000);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each(["cancel", "disconnect", "expiry"])(
    "settles %s during preparation once without an orphan send",
    async (ending) => {
      vi.useFakeTimers();
      const f = fixture();
      const controller = new AbortController();
      let release!: (value: unknown) => void;
      f.record.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const result = f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, {
        ...profile,
        signal: controller.signal,
      });
      if (ending === "cancel") controller.abort();
      else if (ending === "disconnect") await f.eufy.disconnect();
      else await vi.advanceTimersByTimeAsync(60_000);
      expect((await result).status).toBe(
        ending === "cancel"
          ? "cancelled_before_send"
          : ending === "disconnect"
            ? "closed_before_send"
            : "expired_before_send",
      );
      release({ model: "T8425", deviceType: 47, params: { 1400: "0" }, paramUpdatedAt: {} });
      await vi.advanceTimersByTimeAsync(80_000);
      expect(f.packets).toHaveLength(0);
      expect(f.client.propertyPreparations.size).toBe(0);
      expect(f.eufy.getRtcCommandDiagnostics().queueWait.observations).toBe(0);
      await f.eufy.disconnect();
    },
  );

  it.each([0, -1, NaN, Infinity, Number.MAX_VALUE, "72000"])(
    "rejects malformed remaining budget %s",
    async (remaining) => {
      vi.useFakeTimers();
      const f = fixture();
      const receipt = await f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, {
        ...profile,
        remainingBudgetMs: remaining,
      } as PropertyExecutionOptions);
      expect(receipt).toMatchObject({ status: "validation_failed", sendAttempted: false });
      expect(f.packets).toHaveLength(0);
      await f.eufy.disconnect();
    },
  );

  it("retains a shorter propagated deadline and rejects a wall jump before send", async () => {
    vi.useFakeTimers();
    const f = fixture([10_800, 4_000, 4_000, 4_000, 4_000]);
    try {
      const block = f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, profile);
      await vi.advanceTimersByTimeAsync(0);
      const short = f.eufy.setPropertyWithReceipt(targets[1]!, "light", true, {
        ...profile,
        remainingBudgetMs: 15_000,
      });
      const jump = f.eufy.setPropertyWithReceipt(targets[2]!, "light", true, profile);
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await short).status).toBe("expired_before_send");
      f.jumpWall(10_000);
      await vi.advanceTimersByTimeAsync(10_800);
      expect((await jump).status).toBe("expired_before_send");
      expect((await block).status).toBe("acknowledged");
      expect(f.packets).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("keeps an active superseded exchange correlated and returns only its own receipt", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const old = f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, profile);
      await vi.advanceTimersByTimeAsync(0);
      const latest = f.eufy.setPropertyWithReceipt(targets[0]!, "light", false, profile);
      await vi.advanceTimersByTimeAsync(8_000);
      const a: CommandReceipt = await old;
      const b = await latest;
      expect(a).toMatchObject({ status: "acknowledged", superseded: true, sendAttempted: true });
      expect(b).toMatchObject({ status: "acknowledged", sendAttempted: true });
      expect(a.attempt).not.toBe(b.attempt);
      expect(a.intent).not.toBe(b.intent);
      expect(Object.isFrozen(a)).toBe(true);
      expect(f.packets).toHaveLength(2);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("authorizes one same-value retry from the actual designated authoritative read", async () => {
    vi.useFakeTimers();
    const f = fixture([null, null, null, null, null]);
    f.client.opts.autoRealtime = true;
    f.client.realtimeGeneration = {
      epoch: f.client.realtimeEpoch,
      abort: new AbortController(),
      stateRefreshFailures: 0,
      readiness: { push: {}, mqtt: {}, wiredP2p: {}, states: {} },
      settled: true,
    };
    try {
      const work = f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, profile);
      await vi.advanceTimersByTimeAsync(1_000);
      f.session.ack(f.packets[0]!.packet, -108);
      expect((await work).status).toBe("pending_accepted");
      await vi.advanceTimersByTimeAsync(14_000);
      expect(f.packets.map(({ packet }) => parsePortalHeader(packet)!.commandId)).toEqual([1700, 1103]);
      f.session.information(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.packets.map(({ packet }) => parsePortalHeader(packet)!.commandId)).toEqual([1700, 1103, 1700]);
      expect(f.packets[2]!.at).toBe(15_000);
      f.session.ack(f.packets[2]!.packet, -108);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.eufy.getRtcCommandDiagnostics().lateEffect).toMatchObject({
        retryEligible: 1,
        retryQueued: 1,
        retrySent: 1,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.packets.filter(({ packet }) => parsePortalHeader(packet)!.commandId === 1700)).toHaveLength(2);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("cancels a transmitted exchange with an unknown effect and no replay", async () => {
    vi.useFakeTimers();
    const f = fixture([null, null, null, null, null]);
    const controller = new AbortController();
    try {
      const work = f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, { ...profile, signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.packets).toHaveLength(1);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await work).toMatchObject({ status: "cancelled_after_send", sendAttempted: true, effect: "unknown" });
      expect(f.eufy.getRtcCommandDiagnostics().schedulerTotals).toMatchObject({ active: 0, queued: 0 });
      expect(f.eufy.getRtcCommandDiagnostics().lateEffect.scheduled).toBe(0);
      await vi.advanceTimersByTimeAsync(80_000);
      expect(f.packets).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("does not turn a matching passive information report into ACK acceptance", async () => {
    vi.useFakeTimers();
    const f = fixture([null, null, null, null, null]);
    try {
      let completed = false;
      const work = f.eufy.setPropertyWithReceipt(targets[0]!, "light", true, profile).then((receipt) => {
        completed = true;
        return receipt;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const body = Buffer.from(JSON.stringify({ params: [{ channel: 1, param_type: 1400, param_value: 1 }] }));
      f.session.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 255, 0, 0), body]), 3);
      await vi.advanceTimersByTimeAsync(10_999);
      expect(completed).toBe(false);
      expect(f.packets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await work).toMatchObject({ status: "ack_timeout", sendAttempted: true, effect: "unknown" });
      expect(f.packets).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });
});
