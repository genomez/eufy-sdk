import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Device } from "../../model/device.js";
import { buildPortalHeader, parsePortalHeader } from "../../transport/rtc/portal-packet.js";
import { EufyMega } from "../eufy-mega.js";

const HUB = "T9000P0000000000";
const CAMERA = "T8425P0000000000";

class Session extends EventEmitter {
  isConnected = false;
  sent: Buffer[] = [];
  async connect() {
    this.isConnected = true;
    this.emit("connected");
  }
  sendCommand(packet: Buffer) {
    this.sent.push(packet);
    return true;
  }
  report(
    value: unknown,
    over: Partial<{ command: number; channel: number; segment: number; response: number; link: number }> = {},
  ) {
    const cfg = { command: 1400, channel: 11, segment: 0, response: 0, link: 3, ...over };
    const body = Buffer.from(JSON.stringify(value));
    this.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(cfg.command, body.length, cfg.channel, cfg.segment, cfg.response), body]),
      cfg.link,
    );
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
  binary(value: number) {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(value);
    this.emit("commandData", Buffer.concat([buildPortalHeader(1400, 4, 11, 0), body]), 3);
  }
  late(packet: Buffer, value: number) {
    const h = parsePortalHeader(packet)!;
    const code = Buffer.alloc(4);
    const body = Buffer.concat([code, Buffer.from(JSON.stringify({ commandType: 1400, data: { value } }))]);
    this.emit("commandData", Buffer.concat([buildPortalHeader(1700, body.length, h.channel, h.segment, 1), body]), 1);
  }
  information(value: number, ack = true) {
    const packet = this.sent.findLast((packet) => parsePortalHeader(packet)?.commandId === 1103)!;
    if (ack) this.ack(packet);
    this.report({ params: [{ channel: 11, param_type: 1400, param_value: value }] }, { command: 1103, channel: 255 });
  }
  close() {
    this.isConnected = false;
    this.emit("close");
  }
}

function fixture(initial = "1") {
  const eufy = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
    rtc: { commandTimeoutMs: 13000, sessionRefreshMs: 0 },
  });
  const client = eufy as any;
  const session = new Session();
  const params = { 1400: initial };
  client.registry.devices = [
    { sn: HUB, model: "T9000", params: {}, raw: {} },
    {
      sn: CAMERA,
      model: "T8425",
      stationSn: HUB,
      params,
      api: "mega",
      category: "eufy_security",
      raw: { parent_sn: HUB, device_channel: 11, device_type: 47 },
    },
  ];
  const device = Device.fromRecord(CAMERA, { model: "T8425", deviceType: 47, category: "eufy_security", params });
  client.liveDevices.set(CAMERA, new WeakRef(device));
  client.boundParamIds.set(CAMERA, new Set([1400]));
  device.bindActions(
    { channel: 11, codec: "camera", deviceType: 47, paramIds: new Set([1400]) },
    client.commandSinkFor(CAMERA),
  );
  client.rtc.deps.identity = () => ({ authToken: "synthetic-token", userId: "synthetic-user" });
  client.rtc.deps.shard = () => "ie-pr";
  client.rtc.deps.createSession = () => session;
  const receipts: unknown[] = [];
  const changes: unknown[] = [];
  eufy.on("propertiesObserved", (event) => receipts.push(event));
  eufy.on("propertyChanged", (event) => changes.push(event));
  return { eufy, client, session, device, receipts, changes };
}

afterEach(() => vi.useRealTimers());

function command(f: ReturnType<typeof fixture>, on = false) {
  const settled: string[] = [];
  const run = f.device.light!()!
    .set(on)
    .then(
      () => settled.push("success"),
      () => settled.push("failure"),
    );
  return { settled, run };
}

function informationPackets(session: Session) {
  return session.sent.filter((packet) => parsePortalHeader(packet)?.commandId === 1103);
}

function automatic(f: ReturnType<typeof fixture>) {
  f.client.opts.autoRealtime = true;
  const generation = {
    epoch: f.client.realtimeEpoch,
    abort: new AbortController(),
    stateRefreshFailures: 0,
    readiness: { push: {}, mqtt: {}, wiredP2p: {}, states: {} },
    settled: true,
  };
  f.client.realtimeGeneration = generation;
  return generation;
}

describe("RTC information readback confirmation", () => {
  it.each([false, true])("confirms %s only from the read and ignores a late -108", async (on) => {
    vi.useFakeTimers();
    const f = fixture(on ? "0" : "1");
    const c = command(f, on);
    try {
      await vi.advanceTimersByTimeAsync(5500);
      f.session.report({ cmd: 1400, payload: { data: { value: on ? 0 : 1 } } });
      f.session.binary(on ? 1 : 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.settled).toEqual([]);
      expect(f.device.light!()!.isOn).toBe(!on);
      expect(informationPackets(f.session)).toHaveLength(1);
      f.session.information(on ? 1 : 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.settled).toEqual(["success"]);
      expect(f.device.light!()!.isOn).toBe(on);
      expect(f.changes).toEqual([{ deviceSn: CAMERA, property: "light", value: on }]);
      await vi.advanceTimersByTimeAsync(11100);
      f.session.ack(f.session.sent[0]!, -108);
      expect(f.client.rtc.getCommandDiagnostics()).toMatchObject({
        failures: 0,
        recent: [{ outcome: "success", readbackAttempts: 1, confirmedByReadback: 1, matchedAcks: 0 }],
      });
      expect(f.session.listenerCount("commandData")).toBe(1);
    } finally {
      await f.eufy.disconnect();
      await c.run;
    }
  });

  it.each(["binary off", "binary on", "json notify", "late reply", "scalar"])(
    "recognizes %s as a trigger",
    async (shape) => {
      vi.useFakeTimers();
      const f = fixture();
      const c = command(f);
      try {
        await vi.advanceTimersByTimeAsync(100);
        if (shape === "binary off") f.session.binary(0);
        if (shape === "binary on") f.session.binary(1);
        if (shape === "json notify") f.session.report({ cmd: 1400, payload: { data: { value: 0 } } });
        if (shape === "late reply") f.session.late(f.session.sent[0]!, 0);
        if (shape === "scalar") f.session.report({ value: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(informationPackets(f.session)).toHaveLength(1);
        expect(c.settled).toEqual(shape === "late reply" ? ["success"] : []);
        expect(f.device.light!()!.isOn).toBe(true);
        f.session.information(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(c.settled).toEqual(["success"]);
      } finally {
        await f.eufy.disconnect();
        await c.run;
      }
    },
  );

  it("uses ACK timeout as a catch-all for an unknown report shape", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const c = command(f);
    try {
      await vi.advanceTimersByTimeAsync(5500);
      f.session.report({ unknown: 0 });
      expect(informationPackets(f.session)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2500);
      expect(c.settled).toEqual([]);
      expect(informationPackets(f.session)).toHaveLength(1);
      f.session.information(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.settled).toEqual(["success"]);
    } finally {
      await f.eufy.disconnect();
      await c.run;
    }
  });

  it.each(["wrong value", "read rejected", "missing target"])("keeps ACK timeout failure when %s", async (kind) => {
    vi.useFakeTimers();
    const f = fixture();
    const c = command(f);
    try {
      await vi.advanceTimersByTimeAsync(8000);
      const read = informationPackets(f.session)[0]!;
      if (kind === "read rejected") f.session.ack(read, -1);
      else if (kind === "missing target") {
        f.session.ack(read);
        f.session.report({ params: [] }, { command: 1103, channel: 255 });
      } else f.session.information(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.settled).toEqual(["failure"]);
      expect(f.client.rtc.getCommandDiagnostics().lastFailure).toMatchObject({
        outcome: "ack_timeout",
        readbackAttempts: 1,
        confirmedByReadback: 0,
      });
    } finally {
      await f.eufy.disconnect();
      await c.run;
    }
  });

  it.each([
    ["confirms", 0, "success"],
    ["still wrong", 1, "failure"],
  ] as const)("retries an early wrong read once when the ACK window expires and %s", async (_, value, outcome) => {
    vi.useFakeTimers();
    const f = fixture();
    const c = command(f);
    try {
      await vi.advanceTimersByTimeAsync(5500);
      f.session.binary(0);
      f.session.information(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.settled).toEqual([]);
      f.session.binary(0);
      expect(informationPackets(f.session)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2500);
      expect(c.settled).toEqual([]);
      expect(informationPackets(f.session)).toHaveLength(2);
      f.session.information(value);
      await vi.advanceTimersByTimeAsync(0);
      f.session.binary(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.settled).toEqual([outcome]);
      expect(informationPackets(f.session)).toHaveLength(2);
      expect(f.client.rtc.getCommandDiagnostics().recent.at(-1)).toMatchObject({ readbackAttempts: 2 });
    } finally {
      await f.eufy.disconnect();
      await c.run;
    }
  });

  it("bounds an unanswered read by the original 13 s deadline and removes its listeners", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const c = command(f);
    try {
      await vi.advanceTimersByTimeAsync(12999);
      expect(c.settled).toEqual([]);
      expect(informationPackets(f.session)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(c.settled).toEqual(["failure"]);
      expect(f.client.rtc.getCommandDiagnostics().lastFailure).toMatchObject({
        outcome: "ack_timeout",
        elapsedMs: 13000,
      });
      expect(f.session.listenerCount("commandData")).toBe(0);
      f.session.report({ value: 0 });
      expect(f.device.light!()!.isOn).toBe(true);
    } finally {
      await f.eufy.disconnect();
      await c.run;
    }
  });

  it("does not let a late rejection or old report settle the next request", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = command(f);
    let second: ReturnType<typeof command> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(5500);
      f.session.binary(0);
      f.session.information(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(first.settled).toEqual(["success"]);
      await vi.advanceTimersByTimeAsync(10500);
      second = command(f, true);
      await vi.advanceTimersByTimeAsync(600);
      const packet = f.session.sent.findLast((packet) => parsePortalHeader(packet)?.commandId === 1700)!;
      f.session.ack(f.session.sent[0]!, -108);
      f.session.binary(0);
      f.session.information(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(second.settled).toEqual([]);
      f.session.ack(packet);
      await vi.advanceTimersByTimeAsync(0);
      expect(second.settled).toEqual(["success"]);
    } finally {
      await f.eufy.disconnect();
      await first.run;
      await second?.run;
    }
  });

  it("fails immediately on session close during readback", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const c = command(f);
    try {
      await vi.advanceTimersByTimeAsync(5500);
      f.session.binary(0);
      f.session.close();
      f.session.information(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.settled).toEqual(["failure"]);
      expect(f.client.rtc.getCommandDiagnostics().lastFailure.outcome).toBe("closed");
      expect(f.device.light!()!.isOn).toBe(true);
      expect(f.session.listenerCount("commandData")).toBe(0);
    } finally {
      await f.eufy.disconnect();
      await c.run;
    }
  });

  it.each([0, -108])("preserves timely ACK code %i if an overlapping read reaches the deadline", async (code) => {
    vi.useFakeTimers();
    const f = fixture();
    const c = command(f);
    try {
      await vi.advanceTimersByTimeAsync(5500);
      f.session.binary(0);
      await vi.advanceTimersByTimeAsync(500);
      f.session.ack(f.session.sent[0]!, code);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.settled).toEqual(code === 0 ? ["success"] : []);
      await vi.advanceTimersByTimeAsync(6999);
      expect(c.settled).toEqual(code === 0 ? ["success"] : []);
      await vi.advanceTimersByTimeAsync(1);
      expect(c.settled).toEqual([code === 0 ? "success" : "failure"]);
      expect(f.client.rtc.getCommandDiagnostics().recent[0]).toMatchObject({
        outcome: code === 0 ? "success" : "rejected",
        confirmedByReadback: 0,
      });
    } finally {
      await f.eufy.disconnect();
      await c.run;
    }
  });

  it.each([0, 1])("returns a successful ACK before readback value %i and still updates the cache", async (value) => {
    vi.useFakeTimers();
    const f = fixture();
    const c = command(f);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      f.session.binary(0);
      await vi.advanceTimersByTimeAsync(100);
      f.session.ack(f.session.sent[0]!);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.settled).toEqual(["success"]);
      expect(f.device.light!()!.isOn).toBe(true);
      const completed = f.client.rtc.getCommandDiagnostics();
      expect(completed).toMatchObject({
        completed: 1,
        failures: 0,
        recent: [{ outcome: "success", elapsedMs: 1100, matchedAcks: 1, confirmedByReadback: 0 }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      f.session.information(value);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.device.light!()!.isOn).toBe(value === 1);
      expect(f.client.rtc.getReadDiagnostics()).toMatchObject({ successes: 1, failures: 0 });
      expect(f.client.rtc.getCommandDiagnostics()).toEqual(completed);
      expect(f.session.isConnected).toBe(true);
      expect(f.session.listenerCount("commandData")).toBe(1);
      await vi.advanceTimersByTimeAsync(13000);
      expect(f.client.rtc.getCommandDiagnostics()).toEqual(completed);
    } finally {
      await f.eufy.disconnect();
      await c.run;
    }
  });

  it.each(["command", "information read"])(
    "keeps the next %s queued until the acknowledged command's read drains",
    async (next) => {
      vi.useFakeTimers();
      const f = fixture();
      const first = command(f);
      let second: ReturnType<typeof command> | undefined;
      let refresh: Promise<unknown> | undefined;
      try {
        await vi.advanceTimersByTimeAsync(1000);
        f.session.binary(0);
        await vi.advanceTimersByTimeAsync(100);
        f.session.ack(f.session.sent[0]!);
        await vi.advanceTimersByTimeAsync(0);
        expect(first.settled).toEqual(["success"]);
        if (next === "command") second = command(f, true);
        else refresh = f.client.rtc.refreshInformation(HUB);
        await vi.advanceTimersByTimeAsync(500);
        expect(f.session.sent).toHaveLength(2);
        expect(second?.settled ?? []).toEqual([]);
        f.session.information(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.session.sent).toHaveLength(3);
        if (next === "command") f.session.ack(f.session.sent[2]!);
        else f.session.information(0);
        await vi.advanceTimersByTimeAsync(0);
        await refresh;
        if (second) expect(second.settled).toEqual(["success"]);
        expect(f.client.rtc.getReadDiagnostics()).toMatchObject({ successes: next === "command" ? 1 : 2, failures: 0 });
      } finally {
        await f.eufy.disconnect();
        await first.run;
        await second?.run;
        await refresh;
      }
    },
  );

  it.each(["read timeout", "command deadline", "close", "disconnect"])(
    "preserves acknowledged success and cleans up the pending read on %s",
    async (ending) => {
      vi.useFakeTimers();
      const f = fixture();
      const c = command(f);
      try {
        await vi.advanceTimersByTimeAsync(ending === "command deadline" ? 5500 : 1000);
        f.session.binary(0);
        await vi.advanceTimersByTimeAsync(100);
        f.session.ack(f.session.sent[0]!);
        await vi.advanceTimersByTimeAsync(0);
        expect(c.settled).toEqual(["success"]);
        const completed = f.client.rtc.getCommandDiagnostics();
        if (ending === "close") f.session.close();
        else if (ending === "disconnect") await f.eufy.disconnect();
        else if (ending === "command deadline") {
          await vi.advanceTimersByTimeAsync(7399);
          expect(f.session.isConnected).toBe(true);
          expect(f.client.rtc.getReadDiagnostics()).toMatchObject({ failures: 0 });
          await vi.advanceTimersByTimeAsync(1);
          expect(f.client.rtc.getReadDiagnostics()).toMatchObject({
            lastFailure: { outcome: "aborted", elapsedMs: 7500 },
          });
        } else await vi.advanceTimersByTimeAsync(8000);
        await vi.advanceTimersByTimeAsync(0);
        expect(c.settled).toEqual(["success"]);
        expect(f.session.listenerCount("commandData")).toBe(0);
        expect(f.session.isConnected).toBe(false);
        if (ending !== "disconnect") {
          expect(f.client.rtc.getCommandDiagnostics()).toEqual(completed);
          expect(f.client.rtc.getReadDiagnostics()).toMatchObject({ failures: 1 });
        }
        expect(f.device.light!()!.isOn).toBe(true);
      } finally {
        await f.eufy.disconnect();
        await c.run;
      }
    },
  );

  it.each([0, -108])("retains the first ACK %i when a conflicting duplicate arrives during readback", async (code) => {
    vi.useFakeTimers();
    const f = fixture();
    const c = command(f);
    try {
      await vi.advanceTimersByTimeAsync(5500);
      f.session.binary(0);
      await vi.advanceTimersByTimeAsync(500);
      f.session.ack(f.session.sent[0]!, code);
      await vi.advanceTimersByTimeAsync(3000);
      f.session.ack(f.session.sent[0]!, code === 0 ? -108 : 0);
      await vi.advanceTimersByTimeAsync(4000);
      expect(c.settled).toEqual([code === 0 ? "success" : "failure"]);
      expect(f.client.rtc.getCommandDiagnostics().recent[0]).toMatchObject({
        outcome: code === 0 ? "success" : "rejected",
        matchedAcks: 1,
      });
    } finally {
      await f.eufy.disconnect();
      await c.run;
    }
  });

  it.each([0, -108])("preserves a timely ACK with code %i", async (code) => {
    vi.useFakeTimers();
    const f = fixture();
    const c = command(f);
    try {
      await vi.advanceTimersByTimeAsync(100);
      f.session.ack(f.session.sent[0]!, code);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.settled).toEqual([code === 0 ? "success" : "failure"]);
      expect(informationPackets(f.session)).toHaveLength(0);
      expect(f.device.light!()!.isOn).toBe(true);
    } finally {
      await f.eufy.disconnect();
      await c.run;
    }
  });

  it.each([1400, 1401, 1224])("keeps raw command %i without observation on its existing ACK path", async (param) => {
    vi.useFakeTimers();
    const f = fixture();
    const settled: string[] = [];
    const run = f.client.rtc
      .dispatchCommand(
        param === 1224 ? HUB : CAMERA,
        param === 1224
          ? { kind: "set-payload", cmd: param, channel: 255, payload: { mode: 3 } }
          : { kind: "set-json", param, channel: 11, data: { value: 0 } },
      )
      .then(
        () => settled.push("success"),
        () => settled.push("failure"),
      );
    try {
      await vi.advanceTimersByTimeAsync(100);
      f.session.binary(0);
      await vi.advanceTimersByTimeAsync(7900);
      expect(settled).toEqual(["failure"]);
      expect(informationPackets(f.session)).toHaveLength(0);
      expect(f.client.rtc.getCommandDiagnostics().lastFailure).toMatchObject({
        outcome: "ack_timeout",
        readbackAttempts: 0,
      });
    } finally {
      await f.eufy.disconnect();
      await run;
    }
  });
});

describe("unsolicited RTC report refresh", () => {
  it("debounces a burst and joins a running station read without stacking", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const generation = automatic(f);
    const lease = await f.client.rtc.sessionFor(HUB);
    lease.release();
    try {
      f.session.binary(0);
      await vi.advanceTimersByTimeAsync(1000);
      f.session.report({ cmd: 1400, payload: { data: { value: 0 } } });
      await vi.advanceTimersByTimeAsync(1499);
      expect(f.session.sent).toHaveLength(0);
      expect(f.device.light!()!.isOn).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(informationPackets(f.session)).toHaveLength(1);
      f.session.binary(0);
      const sweep = f.client.refreshRealtimeStates(generation, "cloud_poll");
      await vi.advanceTimersByTimeAsync(2000);
      expect(informationPackets(f.session)).toHaveLength(1);
      f.session.information(0);
      await sweep;
      await vi.advanceTimersByTimeAsync(2000);
      expect(informationPackets(f.session)).toHaveLength(1);
      expect(f.device.light!()!.isOn).toBe(false);
      expect(f.client.reportRefreshes.size).toBe(0);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("refreshes while a media lease keeps the ready session open", async () => {
    vi.useFakeTimers();
    const f = fixture();
    automatic(f);
    const lease = await f.client.rtc.sessionFor(HUB);
    try {
      f.session.binary(0);
      await vi.advanceTimersByTimeAsync(1500);
      expect(informationPackets(f.session)).toHaveLength(1);
      f.session.information(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.device.light!()!.isOn).toBe(false);
    } finally {
      lease.release();
      await f.eufy.disconnect();
    }
  });

  it("does not stack a report refresh on an existing sweep", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const generation = automatic(f);
    try {
      const sweep = f.client.refreshRealtimeStates(generation, "cloud_poll");
      await vi.advanceTimersByTimeAsync(0);
      f.session.binary(0);
      f.session.information(0);
      await sweep;
      await vi.advanceTimersByTimeAsync(2000);
      expect(informationPackets(f.session)).toHaveLength(1);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it.each(["closed", "backoff", "paused", "disabled"])("skips reports when %s", async (condition) => {
    vi.useFakeTimers();
    const f = fixture();
    const generation = automatic(f);
    const lease = await f.client.rtc.sessionFor(HUB);
    lease.release();
    try {
      if (condition === "closed") f.session.close();
      if (condition === "backoff") generation.stateRefreshFailures = 1;
      if (condition === "paused") generation.stateRefreshFailures = 3;
      if (condition === "disabled") f.client.opts.autoRealtime = false;
      f.client.onRtcFrame(HUB, {
        commandId: 1400,
        channel: 11,
        segment: 0,
        isResponse: 0,
        linkType: 3,
        data: { value: 0 },
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.session.sent).toHaveLength(0);
      expect(f.device.light!()!.isOn).toBe(true);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("charges a failed read once when a scheduled sweep joins it", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const generation = automatic(f);
    const lease = await f.client.rtc.sessionFor(HUB);
    lease.release();
    f.eufy.on("error", () => {});
    try {
      f.session.binary(0);
      await vi.advanceTimersByTimeAsync(1500);
      const sweep = f.client.runScheduledStateRefresh(generation);
      await vi.advanceTimersByTimeAsync(0);
      f.session.ack(informationPackets(f.session)[0]!, -1);
      await sweep;
      expect(generation.stateRefreshFailures).toBe(1);
      expect(informationPackets(f.session)).toHaveLength(1);
      expect(f.client.reportRefreshes.size).toBe(0);
    } finally {
      await f.eufy.disconnect();
    }
  });

  it("cancels a pending debounce on disconnect", async () => {
    vi.useFakeTimers();
    const f = fixture();
    automatic(f);
    const lease = await f.client.rtc.sessionFor(HUB);
    lease.release();
    f.session.binary(0);
    await f.eufy.disconnect();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.session.sent).toHaveLength(0);
  });
});
