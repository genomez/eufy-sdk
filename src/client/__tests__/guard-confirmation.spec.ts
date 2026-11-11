import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuardConfirmationOwner } from "../guard-confirmation.js";
import { EufyMega } from "../eufy-mega.js";
import { EventEmitter } from "node:events";
import { performance as rtcPerformance } from "node:perf_hooks";
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
    owner.observe(sn, sn, { 1224: "1" }, report);
    expect(op.receipt).toMatchObject({ outcome: "contradicted", reason: "different_mode_reported", attempts: 1 });
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
  it("ignores pre-existing matches, currentMode, and reports before dispatch completion", async () => {
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
  it("wrong requested mode is terminal and later matching reports cannot rewrite it", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    owner.dispatched(op, 1);
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "63" }, 1);
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
  ] as const)("cancels on %s with session %s and has no retry", async (kind, session) => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    owner.dispatched(op, session);
    if (kind === "session") owner.closeStation(sn);
    else owner.close();
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "1" });
    expect(op.receipt.reason).toBe(kind === "session" ? "session_changed" : "runtime_closed");
    expect(op.receipt.attempts).toBe(1);
  });
  it("replacement session reports cannot settle the previous session", async () => {
    const { owner, begin } = fixture();
    const op = begin();
    owner.sent(op);
    owner.dispatched(op, 1);
    await vi.advanceTimersByTimeAsync(1);
    owner.observe(sn, sn, { 1224: "1" }, 2);
    expect(op.receipt.reason).toBe("session_changed");
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
  information() {
    const body = Buffer.from(JSON.stringify({ params: [{ channel: 255, param_type: 1224, param_value: 1 }] }));
    this.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 255, 0), body]), 3);
  }
  close() {
    this.isConnected = false;
    this.emit("close");
  }
}

describe("real facade transaction wiring", () => {
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
  it("confirms the real RTC generation 70 readback after a legacy dispatch with unknown session", async () => {
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
      expect(dispatched.sessionGeneration).toBeUndefined();
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
