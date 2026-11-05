import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { buildPortalHeader, parsePortalHeader } from "../../transport/rtc/portal-packet.js";
import type { RtcSession } from "../../transport/rtc/session.js";

const station = "synthetic-station";

class Session extends EventEmitter {
  isConnected = false;
  closeOrigin: string | null = null;
  answer = true;
  answerLimit = Infinity;
  autoOpen = true;
  sent: Buffer[] = [];
  async connect() {
    if (this.autoOpen) this.open();
  }
  open() {
    this.isConnected = true;
    this.emit("connected");
  }
  close() {
    this.closeOrigin ??= "local";
    this.isConnected = false;
    this.emit("close");
  }
  sendCommand(packet: Buffer) {
    this.sent.push(packet);
    if (this.answer && this.sent.length <= this.answerLimit) this.reply(packet);
    return true;
  }
  reply(packet = this.sent.at(-1)!) {
    const h = parsePortalHeader(packet)!;
    this.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(h.commandId, 4, h.channel, h.segment, 1), Buffer.alloc(4)]),
      1,
    );
    const body = Buffer.from(JSON.stringify({ params: [{ channel: 255, param_type: 1224, param_value: 1 }] }));
    this.emit("commandData", Buffer.concat([buildPortalHeader(1103, body.length, 255, 0), body]), 3);
  }
}

async function fixture(candidateWaits = false) {
  const eufy = new EufyMega({ email: "synthetic@example.invalid", password: "synthetic", pollMs: 0 });
  const client = eufy as any;
  client.mega.auth_ = { userId: "synthetic-account", authToken: "synthetic" };
  client.registry.devices = [{ sn: station, model: "T9000", params: {}, raw: {} }];
  const generation = {
    epoch: client.realtimeEpoch,
    abort: new AbortController(),
    stateRefreshFailures: 0,
    readiness: { push: {}, mqtt: {}, wiredP2p: {} },
    resolve: vi.fn(),
  };
  client.realtimeGeneration = generation;
  const sessions: Session[] = [];
  client.rtc.deps.sessionRefreshMs = 270_000;
  client.rtc.deps.idleCloseMs = 1_000_000;
  client.rtc.deps.createSession = () => {
    const session = new Session();
    if (sessions.length && candidateWaits) session.autoOpen = false;
    sessions.push(session);
    return session as unknown as RtcSession;
  };
  const errors: unknown[] = [];
  eufy.on("error", (error) => errors.push(error));
  const lease = await client.rtc.sessionFor(station);
  lease.release();
  const sweep = () => client.refreshRealtimeStates(generation, "scheduled");
  const renew = () => client.rtc.replaceSession(station, client.rtc.sessions.get(station));
  const report = async () => {
    client.scheduleReportRefresh(station);
    await vi.advanceTimersByTimeAsync(1_500);
    return { read: client.reportRefreshes.get(station)?.promise };
  };
  return { eufy, client, generation, sessions, errors, sweep, renew, report };
}

async function flush() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

describe("automatic state refresh across local renewal adoption", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => vi.useRealTimers());

  it("waits mid-renewal and reads only the adopted session without delaying adoption", async () => {
    const f = await fixture(true);
    const renewal = f.renew();
    const read = f.sweep();
    await flush();
    expect(f.sessions[0]!.sent).toHaveLength(0);
    expect(f.client.rtc.sessions.get(station).leases).toBe(0);
    f.sessions[1]!.open();
    await renewal;
    expect(await read).toMatchObject({ refreshed: true });
    expect(f.sessions.map((s) => s.sent.length)).toEqual([0, 2]);
    expect(f.eufy.getStateRefreshDiagnostics()).toMatchObject({ attempts: 1, successes: 1, failures: 0 });
    await f.eufy.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries an in-flight result superseded at lease release once without reporting failure", async () => {
    const f = await fixture();
    f.sessions[0]!.answer = false;
    const read = f.sweep();
    await flush();
    expect(f.sessions[0]!.sent).toHaveLength(1);
    const renewal = f.renew();
    await flush();
    f.sessions[0]!.reply();
    await renewal;
    expect(await read).toMatchObject({ refreshed: true });
    expect(f.sessions.map((s) => s.sent.length)).toEqual([1, 2]);
    expect(f.eufy.getStateRefreshDiagnostics()).toMatchObject({
      attempts: 1,
      successes: 1,
      failures: 0,
      renewalRetries: 1,
      lastOperationFailure: null,
    });
    expect(f.eufy.getStateRefreshDiagnostics().operations.map((row) => row.outcome)).toEqual([
      "superseded_by_renewal",
      "success",
    ]);
    expect(f.errors).toEqual([]);
    await f.eufy.disconnect();
  });

  it.each(["remote_close", "transport_error", "timeout"])(
    "preserves genuine %s failures without retry",
    async (mode) => {
      const f = await fixture();
      f.sessions[0]!.answer = false;
      const read = f.sweep();
      await flush();
      if (mode === "remote_close") {
        f.sessions[0]!.closeOrigin = "remote";
        f.sessions[0]!.close();
      } else if (mode === "transport_error") f.sessions[0]!.emit("error", new Error("synthetic transport failure"));
      else await vi.advanceTimersByTimeAsync(8_000);
      expect(await read).toMatchObject({ refreshed: false });
      expect(f.eufy.getStateRefreshDiagnostics()).toMatchObject({
        attempts: 1,
        successes: 0,
        failures: 1,
        renewalRetries: 0,
      });
      expect(f.errors).toHaveLength(mode === "transport_error" ? 2 : 1);
      await f.eufy.disconnect();
    },
  );

  it("shares the report's renewal retry with a sweep before either handles failure", async () => {
    const f = await fixture();
    f.client.opts.rtc = { stateRefreshMs: 10_000 };
    f.sessions[0]!.answer = false;
    const { read: report } = await f.report();
    expect(report).toBeDefined();
    const sweep = f.sweep();
    await flush();
    const renewal = f.renew();
    await flush();
    f.sessions[0]!.reply();
    await renewal;
    expect(await report).toMatchObject({ parametersUpdated: 1 });
    expect(await sweep).toMatchObject({ refreshed: true });
    await flush();
    expect(f.sessions.map((s) => s.sent.length)).toEqual([1, 2]);
    expect(f.eufy.getStateRefreshDiagnostics()).toMatchObject({
      attempts: 1,
      successes: 1,
      failures: 0,
      renewalRetries: 1,
      schedules: [],
      lastOperationFailure: null,
    });
    expect(f.generation.stateRefreshFailures ?? 0).toBe(0);
    expect(f.errors).toEqual([]);
    expect(f.eufy.getStateRefreshDiagnostics().operations.map((row) => row.outcome)).toEqual([
      "superseded_by_renewal",
      "success",
    ]);
    await f.eufy.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for renewal before a report refresh acquires the adopted session", async () => {
    const f = await fixture(true);
    const renewal = f.renew();
    const { read } = await f.report();
    expect(read).toBeDefined();
    expect(f.sessions[0]!.sent).toHaveLength(0);
    expect(f.client.rtc.sessions.get(station).leases).toBe(0);
    f.sessions[1]!.open();
    await renewal;
    expect(await read).toMatchObject({ parametersUpdated: 1 });
    await flush();
    expect(f.sessions.map((s) => s.sent.length)).toEqual([0, 2]);
    expect(f.errors).toEqual([]);
    await f.eufy.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["sweep", "report"])("carries the original %s deadline through renewal wait and retry", async (mode) => {
    const f = await fixture(true);
    const renewal = f.renew();
    const read = mode === "sweep" ? f.sweep() : (await f.report()).read;
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(2_000);
    f.sessions[1]!.answerLimit = 1;
    f.sessions[1]!.open();
    await renewal;
    await flush();
    await vi.advanceTimersByTimeAsync(5_900);
    const secondRenewal = f.renew();
    await flush();
    f.sessions[2]!.answerLimit = 1;
    f.sessions[2]!.open();
    f.sessions[1]!.reply();
    await secondRenewal;
    await flush();
    expect(f.sessions.map((s) => s.sent.length)).toEqual([0, 2, 2]);
    let settled = false;
    const outcome = read.then(
      (result: unknown) => {
        settled = true;
        return result;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(7_099);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await outcome;
    expect(Date.now() - startedAt).toBe(15_000);
    if (mode === "sweep") expect(result).toMatchObject({ refreshed: false });
    else expect(result).toBeInstanceOf(Error);
    expect(f.eufy.getStateRefreshDiagnostics()).toMatchObject({ renewalRetries: 1 });
    expect(f.errors).toHaveLength(1);
    await f.eufy.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts supersession as failure without retry when the original deadline is exhausted", async () => {
    const f = await fixture();
    const original = f.client.rtc.refreshInformation.bind(f.client.rtc);
    const reads = vi.spyOn(f.client.rtc, "refreshInformation").mockImplementation(async (...args) => {
      const result = await original(...args);
      await f.renew();
      vi.setSystemTime(Date.now() + 15_000);
      return result;
    });
    expect(await f.sweep()).toMatchObject({ refreshed: false });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(f.eufy.getStateRefreshDiagnostics()).toMatchObject({ failures: 1, renewalRetries: 0 });
    expect(f.eufy.getStateRefreshDiagnostics().operations.map((row) => row.outcome)).toEqual(["superseded_by_renewal"]);
    expect(f.errors).toHaveLength(1);
    await f.eufy.disconnect();
  });

  it.each(["remote_close", "transport_error", "timeout"])("counts a genuine shared %s failure", async (mode) => {
    const f = await fixture();
    f.client.opts.rtc = { stateRefreshMs: 10_000 };
    f.sessions[0]!.answer = false;
    const { read } = await f.report();
    const rejected = expect(read).rejects.toThrow();
    const sweep = f.sweep();
    await flush();
    if (mode === "remote_close") {
      f.sessions[0]!.closeOrigin = "remote";
      f.sessions[0]!.close();
    } else if (mode === "transport_error") f.sessions[0]!.emit("error", new Error("synthetic transport failure"));
    else await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(await sweep).toMatchObject({ refreshed: false });
    await flush();
    expect(f.eufy.getStateRefreshDiagnostics()).toMatchObject({ failures: 1, renewalRetries: 0 });
    expect(f.eufy.getStateRefreshDiagnostics().schedules).toMatchObject([{ consecutiveFailures: 1 }]);
    expect(f.errors.length).toBeGreaterThan(0);
    expect(f.generation.stateRefreshFailures).toBe(1);
    await f.eufy.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a pending renewal wait by the refresh deadline", async () => {
    const f = await fixture(true);
    const renewal = f.renew();
    const read = f.eufy.refreshDeviceState(station, { waitForRenewal: true, timeoutMs: 100 });
    const rejected = expect(read).rejects.toThrow("RTC information read timed out");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(f.sessions[0]!.sent).toHaveLength(0);
    await f.eufy.disconnect();
    await renewal;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not loop when its single retry is also superseded", async () => {
    const f = await fixture();
    const original = f.client.rtc.refreshInformation.bind(f.client.rtc);
    const reads = vi.spyOn(f.client.rtc, "refreshInformation").mockImplementation(async (...args) => {
      const result = await original(...args);
      await f.renew();
      return result;
    });
    expect(await f.sweep()).toMatchObject({ refreshed: false });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(f.eufy.getStateRefreshDiagnostics()).toMatchObject({
      attempts: 1,
      successes: 0,
      failures: 1,
      renewalRetries: 1,
    });
    expect(f.errors).toHaveLength(1);
    await f.eufy.disconnect();
  });
});
