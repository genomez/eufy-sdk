import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuardConfirmationOwner } from "../guard-confirmation.js";
import { EufyMega } from "../eufy-mega.js";
import { EventEmitter } from "node:events";
import { performance as rtcPerformance } from "node:perf_hooks";
import { observeCommand } from "../../core/contracts.js";
import { buildPortalHeader, parsePortalHeader, type PortalResponse } from "../../transport/rtc/portal-packet.js";
const sn = "T9000P0000000000";
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  const events: any[] = [];
  const owner = new GuardConfirmationOwner((r) => events.push(r));
  const begin = (mode = 1, caller?: string) => owner.begin(sn, sn, 1224, mode, caller);
  return { owner, events, begin };
}
describe("guard temporal report owner", () => {
  it.each([
    [70, undefined],
    [undefined, 70],
    [undefined, undefined],
    [70, 70],
  ])("reports the information readback with dispatch session %s and report session %s", async (dispatch, report) => {
    vi.setSystemTime(1794350132601);
    const { owner, begin } = fixture();
    const op = begin();
    await vi.advanceTimersByTimeAsync(1373);
    owner.sent(op);
    await vi.advanceTimersByTimeAsync(353);
    owner.dispatched(op, dispatch);
    await vi.advanceTimersByTimeAsync(2);
    const readStartedAt = performance.now();
    await vi.advanceTimersByTimeAsync(511);
    expect(Date.now()).toBe(1794350134840);
    const receivedAt = performance.now();
    await vi.advanceTimersByTimeAsync(32);
    owner.observe(sn, sn, { 1224: "1", 1230: "1" }, report, receivedAt);
    await vi.advanceTimersByTimeAsync(44);
    expect(Date.now()).toBe(1794350134916);
    expect(receivedAt).toBeGreaterThan(readStartedAt);
    expect(op.receipt).toMatchObject({ outcome: "reported", reason: "reported_after_command", attempts: 1 });
    await vi.advanceTimersByTimeAsync(1489);
    expect(Date.now()).toBe(1794350136405);
    expect(op.receipt.outcome).toBe("reported");
    expect(owner.diagnostics()).toMatchObject({ maxAttempts: 1, enabledRetry: false, pending: 0 });
  });
  it.each([
    [70, undefined],
    [undefined, 70],
    [undefined, undefined],
  ])("keeps report protections with dispatch session %s and report session %s", async (dispatch, report) => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    const beforeDispatch = performance.now();
    await vi.advanceTimersByTimeAsync(1);
    owner.dispatched(op, dispatch);
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "1" }, report, beforeDispatch);
    owner.observe(sn, sn, { 1224: "1" }, report, op.dispatchAt);
    owner.observe("other-station", sn, { 1224: "1" }, report);
    owner.observe(sn, "other-device", { 1224: "1" }, report);
    owner.observe(sn, sn, { 1230: "1" }, report);
    expect(op.receipt.outcome).toBe("pending");
    owner.observe(sn, sn, { 1224: "63" }, report);
    expect(op.receipt.outcome).toBe("pending");
    owner.observe(sn, sn, { 1224: "1" }, report);
    expect(op.receipt).toMatchObject({ outcome: "reported", reason: "reported_after_command", attempts: 1 });
  });
  it.each([70, undefined])("expires an unknown-session report window after dispatch session %s", async (session) => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    owner.dispatched(op, session);
    await vi.advanceTimersByTimeAsync(20_000);
    owner.observe(sn, sn, { 1224: "1" });
    expect(op.receipt).toMatchObject({ outcome: "not_reported", reason: "window_expired", attempts: 1 });
  });
  it("cancellation aborts preparation and the report window without resend", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    const controller = new AbortController();
    await owner.run(
      op,
      async () => {
        owner.sent(op);
        owner.dispatched(op, 1);
      },
      controller.signal,
    );
    controller.abort();
    expect(op.receipt.reason).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(op.receipt.attempts).toBe(1);
  });
  it("ignores pre-existing matches and currentMode", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.observe(sn, sn, { 1224: "1" }, 1);
    owner.sent(op);
    owner.dispatched(op, 1);
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1230: "1" }, 1);
    expect(op.receipt.outcome).toBe("pending");
    owner.observe(sn, sn, { 1224: "1" }, 1);
    expect(op.receipt).toMatchObject({ outcome: "reported", reason: "reported_after_command", attempts: 1 });
  });
  it("a differing mode becomes terminal only at the original window end", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    owner.dispatched(op, 1);
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "63" }, 1);
    expect(op.receipt.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(op.receipt).toMatchObject({ outcome: "contradicted", reason: "different_mode_reported", attempts: 1 });
    owner.observe(sn, sn, { 1224: "1" }, 1);
    expect(op.receipt.outcome).toBe("contradicted");
  });
  it("starts the full 20 second window after dispatch and uses monotonic time across rollback", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    await vi.advanceTimersByTimeAsync(30_000);
    owner.sent(op);
    owner.dispatched(op, 1);
    vi.setSystemTime(1);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(op.receipt.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(op.receipt.reason).toBe("window_expired");
  });
  it("caps preparation/queue lifetime at 55 seconds without a late send", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let sends = 0;
    const promise = owner.run(op, async () => {
      await gate;
      if (owner.current(op)) sends++;
    });
    await vi.advanceTimersByTimeAsync(55_000);
    expect((await promise).reason).toBe("budget_expired");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toBe(0);
  });
  it("same-intent duplicates join one dispatch and completed tokens never resend", async () => {
    const { owner, begin } = fixture();
    const op = begin(1, "request_1");
    const send = vi.fn(async () => {
      owner.sent(op);
      owner.dispatched(op, 1);
    });
    const first = owner.run(op, send);
    const second = owner.run(begin(1, "request_1"), send);
    expect(second).toBe(first);
    await first;
    await vi.advanceTimersByTimeAsync(20_000);
    await owner.run(begin(1, "request_1"), send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("different deliberate mode supersedes without old callbacks settling the replacement", async () => {
    const { owner, begin } = fixture();
    const old = begin();
    owner.sent(old);
    owner.dispatched(old, 1);
    const next = begin(63);
    owner.dispatched(old, 1);
    expect(old.receipt.reason).toBe("superseded");
    expect(next.receipt.outcome).toBe("pending");
  });
  it.each([
    ["session", 1],
    ["runtime", 1],
    ["session", undefined],
    ["runtime", undefined],
  ] as const)("preserves session windows but cancels runtime close: %s, %s", async (kind, session) => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    owner.dispatched(op, session);
    if (kind === "session") owner.closeStation(sn);
    else owner.close();
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "1" });
    expect(op.receipt.reason).toBe(kind === "session" ? "reported_after_command" : "runtime_closed");
    expect(op.receipt.attempts).toBe(1);
  });
  it("a matching current report from a newer session settles the original attempt", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    owner.dispatched(op, 1);
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "1" }, 2);
    expect(op.receipt.reason).toBe("reported_after_command");
  });
  it("expires without an early terminal event after a session close", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    owner.dispatched(op, 1);
    await vi.advanceTimersByTimeAsync(5_000);
    owner.closeStation(sn);
    expect(op.receipt.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(op.receipt).toMatchObject({ outcome: "not_reported", reason: "session_changed", attempts: 1 });
  });
  it("starts at send and never renews the window at ACK", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    await vi.advanceTimersByTimeAsync(12_000);
    owner.dispatched(op, 1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(op.receipt).toMatchObject({ outcome: "not_reported", reason: "window_expired", attempts: 1 });
  });
  it.each([false, true])("uses the last trusted observation after a session change: observed=%s", async (observed) => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    owner.dispatched(op, 1);
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "63" }, 1);
    owner.closeStation(sn);
    if (observed) owner.observe(sn, sn, { 1224: "63" }, 2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(op.receipt).toMatchObject({
      outcome: observed ? "contradicted" : "not_reported",
      reason: observed ? "different_mode_reported" : "session_changed",
      attempts: 1,
    });
  });
  it("supersedes a provisional mode without allowing its confirmation timer to affect the replacement", async () => {
    const confirm = vi.fn();
    const owner = new GuardConfirmationOwner(() => {}, confirm);
    const old = owner.begin(sn, sn, 1224, 1);
    owner.sent(old);
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "63" }, 1);
    const next = owner.begin(sn, sn, 1224, 63);
    owner.sent(next);
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "63" }, 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(old.receipt.reason).toBe("superseded");
    expect(next.receipt.outcome).toBe("reported");
    expect(confirm).not.toHaveBeenCalled();
  });
  it("preserves new-session evidence when the old-session ACK completes later", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    owner.closeStation(sn);
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "63" }, 2);
    owner.dispatched(op, 1);
    owner.observe(sn, sn, { 1230: "1" }, 2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(op.receipt).toMatchObject({ outcome: "contradicted", reason: "different_mode_reported" });
  });
  it("retains only 32 terminal receipts for ten monotonic minutes, with anonymous counters", async () => {
    const { owner, begin } = fixture();
    let first = "";
    for (let i = 0; i < 40; i++) {
      const op = begin(i % 2);
      first ||= op.receipt.handle;
      owner.finish(op, "not_reported", "ack_missing");
    }
    expect(owner.get(first)).toBeNull();
    const op = begin();
    owner.finish(op, "not_reported", "cancelled");
    expect(owner.get(op.receipt.handle)?.reason).toBe("cancelled");
    expect(JSON.stringify(owner.diagnostics())).not.toContain(sn);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(owner.get(op.receipt.handle)).toBeNull();
  });
});
function clientFixture(status = "acknowledged") {
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
  const client = eufy as any;
  client.registry.devices = [{ sn, model: "T9000", params: { 1224: "1" }, raw: {} }];
  vi.spyOn(client, "commandContext").mockResolvedValue({
    codec: "station",
    model: "T9000",
    channel: 255,
    accountName: "synthetic",
    paramIds: new Set([1224]),
    capabilities: new Set(["arming"]),
  });
  vi.spyOn(client, "refreshEventState").mockResolvedValue(false);
  const send = vi
    .spyOn(client.rtc, "dispatchCommandWithReceipt")
    .mockResolvedValue({ status, sendAttempted: true, effect: "unconfirmed", sessionGeneration: 1 });
  return { eufy, client, send };
}
/** In-memory RTC session admitting explicit acknowledgements and information frames. */
class GuardSession extends EventEmitter {
  isConnected = false;
  packets: Buffer[] = [];
  async connect() {
    this.isConnected = true;
    this.emit("connected");
  }
  sendCommand(packet: Buffer) {
    this.packets.push(packet);
    return true;
  }
  ack(packet: Buffer) {
    const header = parsePortalHeader(packet)!;
    this.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(header.commandId, 4, header.channel, header.segment, 1), Buffer.alloc(4)]),
      1,
    );
  }
  information(mode = 1, commandId = 1103) {
    const body = Buffer.from(JSON.stringify({ params: [{ channel: 255, param_type: 1224, param_value: mode }] }));
    this.emit("commandData", Buffer.concat([buildPortalHeader(commandId, body.length, 255, 0), body]), 3);
  }
  close() {
    this.isConnected = false;
    this.emit("close");
  }
}

function wireFixture(readback = true, monotonic = () => performance.now()) {
  const f = clientFixture();
  f.send.mockRestore();
  if (readback) f.client.refreshEventState.mockRestore();
  vi.spyOn(rtcPerformance, "now").mockImplementation(monotonic);
  vi.spyOn(f.client.registry, "refreshedList").mockImplementation(async () => f.client.registry.list());
  const sessions: GuardSession[] = [];
  f.client.rtc.deps.identity = () => ({ authToken: "synthetic", userId: "synthetic-user" });
  f.client.rtc.deps.shard = () => "us-pr";
  f.client.rtc.deps.createSession = () => {
    const session = new GuardSession();
    sessions.push(session);
    return session;
  };
  return { ...f, sessions };
}

describe("real facade transaction wiring", () => {
  it("does not assert contradiction when a last-moment report leaves no integer read budget", async () => {
    let now = 0.25;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(rtcPerformance, "now").mockImplementation(() => now);
    const { eufy, client, send } = clientFixture();
    const reads = vi.spyOn(eufy, "refreshDeviceState");
    try {
      const receipt = await eufy.setGuardModeWithReceipt(sn, 1);
      now = 20_000;
      client.guardOwner().observe(sn, sn, { 1224: "63" }, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).not.toHaveBeenCalled();
      expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe("pending");
      now = 20_000.25;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({
        outcome: "not_reported",
        reason: "window_expired",
        attempts: 1,
      });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await eufy.disconnect();
    }
  });
  it("reads a replacement adopted around eight seconds with a fractional monotonic clock", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const realNow = performance.now.bind(performance);
    const wall = Date.now();
    const monotonic = () => realNow() + (Date.now() - wall);
    vi.spyOn(performance, "now").mockImplementation(monotonic);
    const { eufy, client, sessions } = wireFixture(false, monotonic);
    vi.spyOn(client.rtc, "canRefresh").mockReturnValue(true);
    const reads = vi.spyOn(eufy, "refreshDeviceState");
    try {
      const pending = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(0);
      const original = sessions[0]!;
      await vi.advanceTimersByTimeAsync(1);
      original.ack(original.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await pending;
      await vi.advanceTimersByTimeAsync(7_999);
      expect(Number.isInteger(performance.now())).toBe(false);
      const replacement = client.rtc.replaceSession(sn, client.rtc.sessions.get(sn));
      await vi.advanceTimersByTimeAsync(0);
      const next = sessions[1]!;
      next.ack(next.packets[0]!);
      next.information(63);
      await vi.advanceTimersByTimeAsync(0);
      await replacement;
      const timeout = reads.mock.calls.at(-1)![1]!.timeoutMs!;
      expect(Number.isSafeInteger(timeout)).toBe(true);
      expect(timeout).toBeGreaterThan(11_000);
      expect(timeout).toBeLessThanOrEqual(12_000);
      expect(next.packets.map((p) => parsePortalHeader(p)!.commandId)).toEqual([1103, 1103]);
      next.ack(next.packets[1]!);
      next.information(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({ outcome: "reported", attempts: 1 });
    } finally {
      await eufy.disconnect();
    }
  });
  it.each(["matches", "differs", "silent"])(
    "confirms a provisional mode with one read around twelve seconds: %s",
    async (response) => {
      const { eufy, client, sessions } = wireFixture();
      const reads = vi.spyOn(eufy, "refreshDeviceState");
      try {
        const pending = eufy.setGuardModeWithReceipt(sn, 1);
        await vi.advanceTimersByTimeAsync(0);
        const session = sessions[0]!;
        await vi.advanceTimersByTimeAsync(1);
        session.ack(session.packets[0]!);
        await vi.advanceTimersByTimeAsync(0);
        const receipt = await pending;
        session.ack(session.packets[1]!);
        session.information(63);
        await vi.advanceTimersByTimeAsync(11_998);
        expect(session.packets).toHaveLength(2);
        expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        expect(session.packets.map((p) => parsePortalHeader(p)!.commandId)).toEqual([1350, 1103, 1103]);
        session.ack(session.packets[2]!);
        await vi.advanceTimersByTimeAsync(1);
        if (response !== "silent") session.information(response === "matches" ? 1 : 63);
        await vi.advanceTimersByTimeAsync(7_998);
        expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe(
          response === "matches" ? "reported" : "pending",
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({
          outcome: response === "matches" ? "reported" : "contradicted",
          reason: response === "matches" ? "reported_after_command" : "different_mode_reported",
          attempts: 1,
        });
        expect(reads.mock.calls.filter(([, options]) => options?.timeoutMs === 8_000)).toHaveLength(1);
        expect(sessions.flatMap((s) => s.packets).filter((p) => parsePortalHeader(p)!.commandId === 1350)).toHaveLength(
          1,
        );
        expect(client.guardOwner().pendingStation(sn)).toHaveLength(0);
      } finally {
        await eufy.disconnect();
      }
    },
  );
  it("requests a confirming read for a differing report first observed after twelve seconds", async () => {
    const { eufy, sessions } = wireFixture(false);
    try {
      const pending = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(0);
      const session = sessions[0]!;
      await vi.advanceTimersByTimeAsync(1);
      session.ack(session.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await pending;
      await vi.advanceTimersByTimeAsync(13_000);
      expect(session.packets).toHaveLength(1);
      session.information(63);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.packets).toHaveLength(2);
      session.ack(session.packets[1]!);
      session.information(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe("reported");
    } finally {
      await eufy.disconnect();
    }
  });
  it("does not loop reconnect reads when an unplanned-close recovery fails", async () => {
    const { eufy, client, sessions } = wireFixture(false);
    try {
      const pending = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1);
      sessions[0]!.ack(sessions[0]!.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await pending;
      client.rtc.deps.createSession = () => {
        const session = new GuardSession();
        session.connect = async () => {
          throw new Error("synthetic reconnect failure");
        };
        sessions.push(session);
        return session;
      };
      sessions[0]!.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sessions).toHaveLength(2);
      expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({
        outcome: "not_reported",
        reason: "session_changed",
        attempts: 1,
      });
    } finally {
      await eufy.disconnect();
    }
  });
  it("sends a guard invocation still preparing when the previous session closes", async () => {
    const { eufy, client, sessions } = wireFixture(false);
    try {
      const initial = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1);
      sessions[0]!.ack(sessions[0]!.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      const first = await initial;
      sessions[0]!.information();
      expect(eufy.getGuardConfirmation(first.handle)?.outcome).toBe("reported");
      const context = await client.commandContext(sn);
      const preparation = Promise.withResolvers<unknown>();
      client.commandContext.mockImplementationOnce(() => preparation.promise);
      const pending = eufy.setGuardModeWithReceipt(sn, 63);
      await vi.advanceTimersByTimeAsync(0);
      sessions[0]!.close();
      await vi.advanceTimersByTimeAsync(100);
      preparation.resolve(context);
      await vi.advanceTimersByTimeAsync(0);
      const next = sessions[1]!;
      expect(next.packets).toHaveLength(1);
      next.ack(next.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await pending;
      await vi.advanceTimersByTimeAsync(1);
      next.information(63);
      expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({ outcome: "reported", attempts: 1 });
    } finally {
      await eufy.disconnect();
    }
  });
  it("reads the device after ACK even when the cached mode already matches", async () => {
    const { eufy, sessions } = wireFixture();
    try {
      const pending = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(0);
      const session = sessions[0]!;
      await vi.advanceTimersByTimeAsync(1);
      session.ack(session.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await pending;
      expect(receipt.outcome).toBe("pending");
      expect(session.packets.map((p) => parsePortalHeader(p)!.commandId)).toEqual([1350, 1103]);
      session.ack(session.packets[1]!);
      await vi.advanceTimersByTimeAsync(1);
      session.information();
      await vi.advanceTimersByTimeAsync(0);
      expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({ outcome: "reported", attempts: 1 });
    } finally {
      await eufy.disconnect();
    }
  });
  it("accepts a matching report before ACK without moving the send timestamp", async () => {
    const { eufy, client, sessions } = wireFixture();
    try {
      const pending = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(0);
      const session = sessions[0]!;
      const op = client.guardOwner().pendingStation(sn)[0];
      expect(op.dispatchAt).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      session.information();
      expect((await pending).outcome).toBe("reported");
      await vi.advanceTimersByTimeAsync(100);
      session.ack(session.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      expect(op.dispatchAt).toBe(0);
      expect(parsePortalHeader(session.packets[1]!)?.commandId).toBe(1103);
      session.ack(session.packets[1]!);
      session.information();
    } finally {
      await eufy.disconnect();
    }
  });
  it("keeps a stale first readback provisional until a later matching push", async () => {
    const { eufy, sessions } = wireFixture();
    try {
      const pending = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(0);
      const session = sessions[0]!;
      await vi.advanceTimersByTimeAsync(1);
      session.ack(session.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await pending;
      session.ack(session.packets[1]!);
      session.information(63);
      await vi.advanceTimersByTimeAsync(1);
      expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe("pending");
      session.information(1);
      expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({ outcome: "reported", attempts: 1 });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe("reported");
    } finally {
      await eufy.disconnect();
    }
  });
  it("requests a fresh read after planned refresh adoption within the original window", async () => {
    const { eufy, client, sessions } = wireFixture(false);
    vi.spyOn(client.rtc, "canRefresh").mockReturnValue(true);
    try {
      const pending = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(0);
      const original = sessions[0]!;
      await vi.advanceTimersByTimeAsync(1);
      original.ack(original.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await pending;
      const replacement = client.rtc.replaceSession(sn, client.rtc.sessions.get(sn));
      await vi.advanceTimersByTimeAsync(0);
      const next = sessions[1]!;
      next.ack(next.packets[0]!);
      next.information(63);
      await vi.advanceTimersByTimeAsync(0);
      await replacement;
      expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe("pending");
      expect(next.packets.map((p) => parsePortalHeader(p)!.commandId)).toEqual([1103, 1103]);
      original.information(1);
      expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe("pending");
      next.ack(next.packets[1]!);
      await vi.advanceTimersByTimeAsync(1);
      next.information(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({ outcome: "reported", attempts: 1 });
    } finally {
      await eufy.disconnect();
    }
  });
  it("survives a tainted-session drop and reads again when the next session connects", async () => {
    const { eufy, client, sessions } = wireFixture(false);
    try {
      const pending = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1);
      sessions[0]!.ack(sessions[0]!.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await pending;
      const original = client.rtc.sessions.get(sn);
      original.informationTainted = true;
      client.rtc.touch(sn, original);
      expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(0);
      const next = sessions[1]!;
      expect(next.packets).toHaveLength(1);
      next.ack(next.packets[0]!);
      await vi.advanceTimersByTimeAsync(1);
      next.information();
      await vi.advanceTimersByTimeAsync(0);
      expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({ outcome: "reported", attempts: 1 });
      expect(sessions.flatMap((s) => s.packets).filter((p) => parsePortalHeader(p)!.commandId === 1350)).toHaveLength(
        1,
      );
    } finally {
      await eufy.disconnect();
    }
  });
  it("finishes an implicit guard operation immediately when dispatch throws", async () => {
    const { eufy, client } = clientFixture();
    const route = vi.spyOn(client, "routeCommand").mockRejectedValue(new Error("synthetic dispatch failure"));
    const command = observeCommand(
      { kind: "set-json", param: 1224, data: { value: 1 }, channel: 255 },
      {
        temporalReport: true,
        event: "armingModeChanged",
        property: "armingMode",
        param: 1224,
        expected: 1,
        timeoutMs: 20_000,
      },
    );
    try {
      await expect(client.commandSinkFor(sn).dispatch(command)).rejects.toThrow("synthetic dispatch failure");
      expect(eufy.getGuardConfirmationDiagnostics()).toMatchObject({ pending: 0, not_reported: 1 });
      await expect(client.commandSinkFor(sn).dispatch(command)).rejects.toThrow("synthetic dispatch failure");
      expect(route).toHaveBeenCalledTimes(2);
      expect(eufy.getGuardConfirmationDiagnostics()).toMatchObject({ pending: 0, not_reported: 2 });
    } finally {
      await eufy.disconnect();
    }
  });
  it("does not label unrelated pushes as readbacks during an outstanding information read", async () => {
    const { eufy, client, sessions } = wireFixture();
    const frame = vi.spyOn(client, "onRtcFrame");
    try {
      const pending = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1);
      const session = sessions[0]!;
      session.ack(session.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      session.information(63, 1704);
      const push = frame.mock.calls.find(([, value]) => (value as PortalResponse).commandId === 1704);
      expect(push).toBeDefined();
      expect((push?.[2] as any)?.readGeneration).toBeUndefined();
      session.ack(session.packets[1]!);
      session.information();
    } finally {
      await eufy.disconnect();
    }
  });
  it.each([
    ["RTC without identity", 70, undefined],
    ["RTC after unknown dispatch", undefined, 70],
    ["P2P without identity", 70, undefined],
  ] as const)("accepts a post-dispatch report from %s", async (path, dispatch, report) => {
    const { eufy, client, send } = clientFixture();
    send.mockResolvedValue({ status: "acknowledged", sendAttempted: true, sessionGeneration: dispatch });
    const receipt = await eufy.setGuardModeWithReceipt(sn, 1);
    await vi.advanceTimersByTimeAsync(1);
    try {
      if (path.startsWith("P2P")) client.onP2PFrame(sn, { channel: 0, params: { 1224: "1" } });
      else
        client.onRtcFrame(
          sn,
          { commandId: 1103, isResponse: 0, data: { params: [{ channel: 255, param_type: 1224, param_value: 1 }] } },
          report === undefined ? undefined : { sessionGeneration: report, receivedAtMonotonicMs: performance.now() },
        );
      expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({ outcome: "reported", attempts: 1 });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await eufy.disconnect();
    }
  });
  it("confirms the incident replay readback and captures the legacy sending session", async () => {
    vi.setSystemTime(1794350132601);
    vi.spyOn(rtcPerformance, "now").mockImplementation(() => performance.now());
    const { eufy, client, send } = clientFixture();
    send.mockRestore();
    const session = new GuardSession();
    client.rtc.nextSessionGeneration = 69;
    client.rtc.deps.identity = () => ({ authToken: "synthetic", userId: "synthetic-user" });
    client.rtc.deps.shard = () => "us-pr";
    client.rtc.deps.createSession = () => session;
    const onFrame = vi.spyOn(client, "onRtcFrame");
    const dispatch = vi.spyOn(client.rtc, "dispatchCommandWithReceipt");
    const context = await client.commandContext(sn);
    client.commandContext.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(context), 1373)),
    );
    try {
      const pending = eufy.setGuardModeWithReceipt(sn, 1);
      await vi.advanceTimersByTimeAsync(1373);
      expect(Date.now()).toBe(1794350133974);
      expect(session.packets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(353);
      session.ack(session.packets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await pending;
      expect(receipt.outcome).toBe("pending");
      const dispatched = await dispatch.mock.results[0]!.value;
      expect(dispatched).toMatchObject({ status: "acknowledged", sendAttempted: true });
      expect(dispatched.sessionGeneration).toBe(70);
      expect(dispatched.sentAtMonotonicMs).toBe(1373);
      expect(client.rtc.getCommandDiagnostics().recent.at(-1)).toMatchObject({
        sessionGeneration: 70,
        matchedResults: 0,
      });
      await vi.advanceTimersByTimeAsync(2);
      const read = eufy.refreshDeviceState(sn);
      await vi.advanceTimersByTimeAsync(0);
      expect(parsePortalHeader(session.packets[1]!)?.commandId).toBe(1103);
      session.ack(session.packets[1]!);
      await vi.advanceTimersByTimeAsync(511);
      expect(Date.now()).toBe(1794350134840);
      session.information();
      expect(await read).toMatchObject({ notificationCorrelation: "temporal-only", parametersUpdated: 1 });
      const information = onFrame.mock.calls.find(([, received]) => {
        const frame = received as PortalResponse;
        return frame.commandId === 1103 && frame.isResponse === 0;
      });
      expect(information?.[2]).toMatchObject({ sessionGeneration: 70, readGeneration: expect.any(Number) });
      await vi.advanceTimersByTimeAsync(76);
      expect(eufy.getGuardConfirmation(receipt.handle)).toMatchObject({ outcome: "reported", attempts: 1 });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await eufy.disconnect();
    }
  });
  it("advertises every replacement before receipts, including disconnect and account renewal", async () => {
    const { eufy, client } = clientFixture("ack_timeout");
    const events: any[] = [];
    eufy.on("guardRuntime", (scope) => events.push({ event: "runtime", ...scope }));
    eufy.on("guardConfirmation", (receipt) => events.push({ event: "receipt", ...receipt }));
    const first = eufy.getGuardConfirmationScope();
    await eufy.setGuardModeWithReceipt(sn, 1);
    await eufy.disconnect();
    const disconnected = eufy.getGuardConfirmationScope();
    expect(disconnected.runtimeGeneration).not.toBe(first.runtimeGeneration);
    Object.defineProperty(client.mega, "auth", { get: () => ({ userId: "synthetic-renewed" }) });
    const renewed = eufy.getGuardConfirmationScope();
    expect(renewed.runtimeGeneration).not.toBe(disconnected.runtimeGeneration);
    await eufy.setGuardModeWithReceipt(sn, 1);
    expect(events.filter((e) => e.event === "runtime")).toHaveLength(3);
    for (const [index, event] of events.entries())
      if (event.event === "receipt")
        expect(
          events.slice(0, index).some((e) => e.event === "runtime" && e.runtimeGeneration === event.runtimeGeneration),
        ).toBe(true);
    await eufy.disconnect();
  });
  it("ACK returns pending, report settles, cache-only get recovers a lost event", async () => {
    const { eufy, client, send } = clientFixture();
    const receipt = await eufy.setGuardModeWithReceipt(sn, 1, "first");
    expect(receipt.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    client.guardOwner().observe(sn, sn, { 1224: "1" }, 1);
    expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe("reported");
    expect(send).toHaveBeenCalledTimes(1);
    await eufy.disconnect();
    expect(eufy.getGuardConfirmation(receipt.handle)).toBeNull();
  });
  it("missing ACK yields not_reported rather than report eligibility", async () => {
    const { eufy, client } = clientFixture("ack_timeout");
    const receipt = await eufy.setGuardModeWithReceipt(sn, 1);
    expect(receipt).toMatchObject({ outcome: "not_reported", reason: "ack_missing" });
    client.guardOwner().observe(sn, sn, { 1224: "1" }, 1);
    expect(eufy.getGuardConfirmation(receipt.handle)?.outcome).toBe("not_reported");
    await eufy.disconnect();
  });
  it("dispatch rejection remains an RPC rejection", async () => {
    const { eufy } = clientFixture("rejected");
    await expect(eufy.setGuardModeWithReceipt(sn, 1)).rejects.toThrow("guard dispatch rejected");
    await eufy.disconnect();
  });
});
