import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { CommandEvidenceRecorder } from "../command-diagnostics.js";
import { RtcCommandRouter, type RtcCommandRouterDeps } from "../command-router.js";
import { observeTimedOutCommand, selectedTransportSnapshot } from "../command-transport-evidence.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";
import type { RtcSession } from "../session.js";
import { TransportEvidenceRecorder } from "../transport-diagnostics.js";

const station = { sn: "synthetic-station", stationSn: "synthetic-station", model: "T9000", raw: {} } as EufyDevice;
const camera = { sn: "synthetic-camera", stationSn: station.sn, model: "T8425", raw: {} } as EufyDevice;
const command = { kind: "set-json" as const, param: 1400, channel: 2, data: { value: 1 } };

class DiagnosticSession extends EventEmitter {
  isConnected = false;
  closed = false;
  sent: Buffer[] = [];
  evidence = new TransportEvidenceRecorder();
  mode: "silent" | "ack" | "refused" | "throw" = "silent";
  diagnosticsThrow = false;

  async connect(): Promise<void> {
    this.evidence.init();
    this.isConnected = true;
    this.emit("connected");
  }

  getTransportDiagnostics() {
    if (this.diagnosticsThrow) throw new Error("synthetic-private-diagnostic-error");
    return Object.assign(this.evidence.snapshot(this.isConnected, this.closed), {
      privatePayload: "synthetic-private-diagnostic-data",
    });
  }

  sendCommand(packet: Buffer): boolean {
    this.sent.push(packet);
    this.evidence.nativeSend(
      "framed",
      packet.length,
      this.mode === "refused" ? "refused" : this.mode === "throw" ? "thrown" : "accepted",
    );
    if (this.mode === "throw") throw new Error("synthetic-send-error");
    if (this.mode === "refused") return false;
    if (this.mode === "ack") queueMicrotask(() => this.header());
    return true;
  }

  header(
    over: Partial<{ segment: number; channel: number; envelope: number; response: number; link: number }> = {},
  ): void {
    const request = parsePortalHeader(this.sent.at(-1)!)!;
    const body = Buffer.alloc(4);
    const cfg = {
      segment: request.segment,
      channel: request.channel,
      envelope: request.commandId,
      response: 1,
      link: 1,
      ...over,
    };
    this.frame(
      Buffer.concat([buildPortalHeader(cfg.envelope, body.length, cfg.channel, cfg.segment, cfg.response), body]),
      cfg.link,
    );
  }

  frame(frame: Buffer, link: number): void {
    this.evidence.nativeReceive("WebrtcDataChannel", frame.length);
    this.evidence.logicalFrame(link, frame.length);
    this.emit("commandData", frame, link);
  }

  close(): void {
    if (this.closed) return;
    this.isConnected = false;
    this.closed = true;
    this.emit("close");
  }
}

function fixture(over: Partial<RtcCommandRouterDeps> = {}) {
  const sessions: DiagnosticSession[] = [];
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "synthetic-token", userId: "synthetic-user" }),
    accountName: () => "synthetic-name",
    shard: () => "us-pr",
    findDevice: (sn) => (sn === station.sn ? station : sn === camera.sn ? camera : undefined),
    ackTimeoutMs: 50,
    commandTimeoutMs: 1_000,
    idleCloseMs: 60_000,
    createSession: () => {
      const session = new DiagnosticSession();
      sessions.push(session);
      return session as unknown as RtcSession;
    },
    ...over,
  });
  return { router, sessions };
}

async function timeout(router: RtcCommandRouter): Promise<void> {
  const rejected = expect(router.dispatchCommand(camera.sn, command)).rejects.toThrow("ACK timed out; outcome unknown");
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
}

describe("selected-session command transport evidence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => vi.useRealTimers());

  it("captures before send and completion, then records a late matching header without success or replay", async () => {
    const { router, sessions } = fixture();
    try {
      await timeout(router);
      const session = sessions[0]!;
      const before = router.getCommandDiagnostics();
      expect(before.lastFailure).toMatchObject({
        outcome: "ack_timeout",
        elapsedMs: 50,
        matchedAcks: 0,
        matchedResults: 0,
        sessionGeneration: 1,
      });
      expect(before.lastFailure!.transportBeforeSend!.outbound.framed.packets).toBe(0);
      expect(before.lastFailure!.transportAtFinish!.outbound.framed).toMatchObject({ packets: 1, accepted: 1 });
      expect(before.lastFailure!.transportAtFinish!.inbound.command.packets).toBe(0);
      expect(before.lastFailure!.postTimeout).toMatchObject({
        startedAtMs: 1_050,
        deadlineAtMs: 31_050,
        status: "observing",
      });
      session.header();
      const after = router.getCommandDiagnostics();
      expect(after.lastFailure).toMatchObject({
        outcome: "ack_timeout",
        elapsedMs: 50,
        matchedAcks: 0,
        matchedResults: 0,
      });
      expect(after.lastFailure!.postTimeout!.headerSamples[0]).toMatchObject({
        matchesSegment: true,
        matchesChannel: true,
        matchesEnvelope: true,
        matchesResponse: true,
      });
      expect(after.lastFailure!.postTimeout!.transportAtFinish!.inbound.command.packets).toBe(1);
      expect(before.lastFailure!.postTimeout!.headerSamples).toEqual([]);
      expect(before.lastFailure!.transportAtFinish!.inbound.command.packets).toBe(0);
      after.lastFailure!.postTimeout!.headerSamples[0]!.channel = 999;
      after.recent[0]!.transportAtFinish!.outbound.framed.accepted = 999;
      expect(router.getCommandDiagnostics().lastFailure!.postTimeout!.headerSamples[0]!.channel).toBe(2);
      expect(router.getCommandDiagnostics().recent[0]!.transportAtFinish!.outbound.framed.accepted).toBe(1);
      expect(JSON.stringify(after)).not.toMatch(/synthetic-|privatePayload/);
      expect(session.sent).toHaveLength(1);
      expect(session.listenerCount("commandData")).toBe(2);
    } finally {
      router.close();
    }
    expect(sessions[0]!.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(router.getCommandDiagnostics().recent).toEqual([]);
  });

  it("retains independent wrong-header comparisons, at most sixteen headers, omissions and invalid frames", async () => {
    const { router, sessions } = fixture();
    try {
      await timeout(router);
      const session = sessions[0]!;
      const request = parsePortalHeader(session.sent[0]!)!;
      session.header({ segment: request.segment + 1, channel: 3, envelope: 1350, response: 0, link: 2 });
      const body = Buffer.from(JSON.stringify({ cmd: 1401, payload: { secret: "synthetic-private-response" } }));
      session.frame(Buffer.concat([buildPortalHeader(1351, body.length, 2, request.segment, 0), body]), 3);
      session.header();
      for (let i = 0; i < 30; i++) session.header({ segment: request.segment + 1 });
      session.frame(Buffer.alloc(2), 1);
      const row = router.getCommandDiagnostics().lastFailure!;
      expect(row.postTimeout).toMatchObject({ receivedFrames: 34, invalidFrames: 1, headerSamplesOmitted: 17 });
      expect(row.postTimeout!.headerSamples).toHaveLength(16);
      expect(row.postTimeout!.headerSamples[0]).toMatchObject({
        matchesSegment: false,
        matchesChannel: false,
        matchesLink: false,
        matchesEnvelope: false,
        matchesResponse: false,
      });
      expect(row.postTimeout!.headerSamples[1]).toMatchObject({ matchesInnerCommand: false, innerCommand: 1401 });
      expect(row.postTimeout!.headerSamples[2]).toMatchObject({ matchesSegment: true });
      expect(row).toMatchObject({ outcome: "ack_timeout", receivedFrames: 0, matchedAcks: 0, matchedResults: 0 });
      expect(JSON.stringify(row)).not.toMatch(/secret|payload|synthetic-/);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(router.getCommandDiagnostics().lastFailure!.postTimeout).toMatchObject({
        status: "expired",
        finishedAtMs: 31_050,
      });
      const final = router.getCommandDiagnostics();
      session.header();
      expect(router.getCommandDiagnostics()).toEqual(final);
      expect(session.listenerCount("commandData")).toBe(1);
      expect(session.listenerCount("close")).toBe(1);
      expect(session.sent).toHaveLength(1);
    } finally {
      router.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["retired", "session_closed"] as const)(
    "ends the window on %s without holding an extra lease",
    async (reason) => {
      const { router, sessions } = fixture({ idleCloseMs: reason === "retired" ? 5 : 60_000 });
      try {
        await timeout(router);
        const session = sessions[0]!;
        if (reason === "retired") await vi.advanceTimersByTimeAsync(5);
        else session.close();
        expect(router.getCommandDiagnostics().lastFailure!.postTimeout).toMatchObject({
          status: reason,
          finishedAtMs: reason === "retired" ? 1_055 : 1_050,
        });
        expect(session.eventNames()).toEqual([]);
        expect(session.closed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        router.close();
      }
    },
  );

  it("ends on transport reinitialization before attributing headers to the new transport", async () => {
    const { router, sessions } = fixture();
    try {
      await timeout(router);
      const session = sessions[0]!;
      session.evidence.init();
      session.header();
      expect(router.getCommandDiagnostics().lastFailure!.postTimeout).toMatchObject({
        status: "transport_replaced",
        receivedFrames: 0,
        headerSamples: [],
      });
      expect(session.listenerCount("commandData")).toBe(1);
      expect(session.listenerCount("close")).toBe(1);
      expect(session.sent).toHaveLength(1);
    } finally {
      router.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds completed windows to thirty-two with one passive listener pair and the default warning limit", async () => {
    const { router, sessions } = fixture();
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
    };
    process.on("warning", onWarning);
    try {
      for (let i = 0; i < 33; i++) await timeout(router);
      const session = sessions[0]!;
      expect(session.getMaxListeners()).toBe(10);
      expect(router.getCommandDiagnostics()).toMatchObject({ attempts: 33, completed: 33, failures: 33, evicted: 1 });
      expect(router.getCommandDiagnostics().recent).toHaveLength(32);
      expect(session.listenerCount("commandData")).toBe(2);
      expect(session.listenerCount("close")).toBe(2);
      expect(vi.getTimerCount()).toBe(33);
      expect(session.sent).toHaveLength(33);
      session.header();
      const rows = router.getCommandDiagnostics().recent;
      expect(rows.every((row) => row.postTimeout!.receivedFrames === 1 && row.outcome === "ack_timeout")).toBe(true);
      expect(rows[0]!.postTimeout!.headerSamples[0]!.matchesSegment).toBe(false);
      expect(rows.at(-1)!.postTimeout!.headerSamples[0]!.matchesSegment).toBe(true);
      expect(session.sent).toHaveLength(33);
      expect(warnings).toEqual([]);
    } finally {
      router.close();
      process.off("warning", onWarning);
    }
    expect(sessions[0]!.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["expired", "session_closed", "retired", "shutdown", "transport_replaced"] as const)(
    "detaches the shared listener pair after overlapping windows end through %s",
    async (reason) => {
      const { router, sessions } = fixture({ idleCloseMs: reason === "retired" ? 250 : 60_000 });
      try {
        for (let i = 0; i < 3; i++) await timeout(router);
        const session = sessions[0]!;
        expect(session.listenerCount("commandData")).toBe(2);
        expect(session.listenerCount("close")).toBe(2);
        if (reason === "expired") await vi.advanceTimersByTimeAsync(30_000);
        else if (reason === "retired") await vi.advanceTimersByTimeAsync(250);
        else if (reason === "session_closed") session.close();
        else if (reason === "shutdown") router.close();
        else {
          session.evidence.init();
          session.header();
        }
        if (reason === "shutdown") expect(router.getCommandDiagnostics().recent).toEqual([]);
        else
          expect(router.getCommandDiagnostics().recent.every((row) => row.postTimeout!.status === reason)).toBe(true);
        const stillConnected = reason === "expired" || reason === "transport_replaced";
        expect(session.listenerCount("commandData")).toBe(stillConnected ? 1 : 0);
        expect(session.listenerCount("close")).toBe(stillConnected ? 1 : 0);
        expect(vi.getTimerCount()).toBe(stillConnected ? 1 : 0);
        expect(session.sent).toHaveLength(3);
        if (stillConnected) {
          await timeout(router);
          expect(session.listenerCount("commandData")).toBe(2);
          expect(session.listenerCount("close")).toBe(2);
          expect(vi.getTimerCount()).toBe(2);
          session.header();
          expect(router.getCommandDiagnostics().recent.at(-1)!.postTimeout!.receivedFrames).toBe(1);
        }
      } finally {
        router.close();
      }
      expect(sessions[0]!.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps an evicted window's finite status without mutating snapshots", () => {
    const session = new DiagnosticSession();
    session.isConnected = true;
    const recorder = new CommandEvidenceRecorder();
    const retirement = new Set<Parameters<typeof observeTimedOutCommand>[3] extends Set<infer T> ? T : never>();
    const first = recorder.begin(camera.sn, "attached", 1400, 1700);
    first.sendAttemptedAtMs = Date.now();
    observeTimedOutCommand(session as unknown as RtcSession, first, recorder, retirement, 1700, 1400, 2, 1);
    recorder.finish(first, "ack_timeout");
    const detached = recorder.snapshot();
    for (let i = 0; i < 32; i++) recorder.finish(recorder.begin(camera.sn, "attached", 1400, 1700), "success");
    expect(first.postTimeout!.status).toBe("evicted");
    expect(recorder.snapshot().lastFailure!.postTimeout!.status).toBe("evicted");
    expect(detached.lastFailure!.postTimeout!.status).toBe("observing");
    expect(retirement.size).toBe(0);
    expect(session.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "timeout", "deadline", "refused", "throw"] as const)(
    "diagnostic exceptions cannot alter %s behavior",
    async (scenario) => {
      const { router, sessions } = fixture({ commandTimeoutMs: scenario === "deadline" ? 10 : 1_000 });
      const lease = await router.sessionFor(station.sn);
      const session = sessions[0]!;
      session.diagnosticsThrow = true;
      session.mode =
        scenario === "success" ? "ack" : scenario === "refused" ? "refused" : scenario === "throw" ? "throw" : "silent";
      try {
        const operation = router.dispatchCommand(camera.sn, command);
        if (scenario === "success") await operation;
        else {
          const rejected = expect(operation).rejects.toThrow(
            scenario === "timeout"
              ? "ACK timed out"
              : scenario === "deadline"
                ? "after send"
                : scenario === "refused"
                  ? "not sent"
                  : "synthetic-send-error",
          );
          await vi.advanceTimersByTimeAsync(50);
          await rejected;
        }
        const row = router.getCommandDiagnostics().recent[0]!;
        expect(row.transportBeforeSend).toBeNull();
        expect(row.transportAtFinish).toBeNull();
        if (scenario === "timeout") {
          session.header();
          expect(router.getCommandDiagnostics().lastFailure!.postTimeout!.headerSamples).toHaveLength(1);
          expect(router.getCommandDiagnostics().lastFailure!.outcome).toBe("ack_timeout");
        } else expect(row.postTimeout).toBeNull();
        expect(session.sent).toHaveLength(1);
      } finally {
        lease.release();
        router.close();
      }
      expect(session.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("contains absent diagnostic methods and throwing optional getters", () => {
    expect(selectedTransportSnapshot({} as RtcSession)).toBeNull();
    expect(
      selectedTransportSnapshot(
        Object.defineProperty({}, "getTransportDiagnostics", {
          get: () => {
            throw new Error("synthetic-private-getter");
          },
        }) as RtcSession,
      ),
    ).toBeNull();
  });

  it("refuses non-S1 targets without invoking any diagnostics or creating a session", async () => {
    const { router, sessions } = fixture({ findDevice: () => ({ ...station, model: "T8030" }) });
    await expect(router.dispatchCommand(station.sn, command)).rejects.toThrow("known T9000 station");
    expect(router.getCommandDiagnostics().attempts).toBe(0);
    expect(sessions).toEqual([]);
    router.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
