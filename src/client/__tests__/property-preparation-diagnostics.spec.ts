import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { PropertyPreparationRecorder } from "../property-preparation-diagnostics.js";

const HUB = "T9000P0000000000";
const CAMERA = "T8425P0000000000";
let monotonic = 0;
const clients: EufyMega[] = [];

function fixture() {
  const eufy = new EufyMega({
    email: "synthetic@example.invalid",
    password: "synthetic-password",
    accountName: "synthetic-actor",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
    rtc: { commandTimeoutMs: 14_000, sessionRefreshMs: 0 },
  });
  clients.push(eufy);
  const client = eufy as any;
  client.registry.devices = [
    { sn: HUB, model: "T9000", category: "eufy_security", params: { 1224: "0" }, raw: {} },
    {
      sn: CAMERA,
      stationSn: HUB,
      model: "T8425",
      category: "eufy_security",
      params: { 1400: "0" },
      raw: { device_channel: 1, device_type: 47, parent_sn: HUB },
    },
  ];
  vi.spyOn(eufy.api, "ensureSessionKey").mockResolvedValue({
    shareKey: "00".repeat(32),
    keyIdent: "00".repeat(16),
    clientPublicKeyHex: "00".repeat(65),
    clientPrivateKeyHex: "00".repeat(32),
    createdAt: Date.now(),
  });
  const dispatch = vi.spyOn(client.rtc, "dispatchCommand").mockResolvedValue(undefined);
  vi.spyOn(client.rtc, "dispatchCommandWithReceipt").mockResolvedValue({
    status: "acknowledged",
    sendAttempted: true,
    effect: "unconfirmed",
  });
  vi.spyOn(client, "refreshEventState").mockResolvedValue(false);
  return { eufy, client, dispatch };
}

function response(delay = 0) {
  return {
    status: 200,
    text: async () => {
      monotonic += delay;
      return '{"code":0,"data":{"params":[]}}';
    },
  } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );
});

afterEach(async () => {
  for (const eufy of clients.splice(0)) await eufy.disconnect();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("property preparation path evidence", () => {
  it("covers real registry HTTP preparation and the guard transition wait, ending before RTC work", async () => {
    const { eufy, client, dispatch } = fixture();
    vi.mocked(fetch).mockImplementation(async () => response(6_000));
    let release!: () => void;
    client.stateTransitions.set(`${HUB}:1224`, new Promise<void>((resolve) => (release = resolve)));
    dispatch.mockImplementation(async () => {
      expect(eufy.getPropertyPreparationDiagnostics().recent[0]).toMatchObject({
        elapsedMs: 10_000,
        outcome: "transport_handoff",
      });
      monotonic += 9_000;
      await eufy.api.getDeviceParamList(CAMERA);
    });
    const pending = eufy.setProperty(HUB, "armingMode", "home");
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(eufy.getPropertyPreparationDiagnostics()).toMatchObject({ invocations: 1, prepared: 0, recent: [] });
    monotonic += 4_000;
    release();
    await pending;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(eufy.getPropertyPreparationDiagnostics()).toMatchObject({
      invocations: 1,
      prepared: 1,
      slow: 1,
      failures: 0,
    });
    expect(eufy.getPropertyPreparationDiagnostics().recent).toEqual([
      {
        category: "guard_mode",
        startedAtMs: 1_800_000_000_000,
        elapsedMs: 10_000,
        outcome: "transport_handoff",
        phase: "dispatch_preparation",
        phases: { validation: 0, command_context: 6_000, command_build: 0, dispatch_preparation: 4_000 },
        http: { requests: 1, completed: 1, totalMs: 6_000, maxMs: 6_000 },
      },
    ]);
    expect(eufy.getCloudHttpDiagnostics()).toEqual(eufy.api.getCloudHttpDiagnostics());
    expect(eufy.getCloudHttpDiagnostics()).toMatchObject({ requests: 2, slow: 2 });
    expect(JSON.stringify(eufy.getPropertyPreparationDiagnostics())).not.toMatch(
      /synthetic|T9000|T8425|armingMode|home|https/,
    );
  });

  it("attributes overlapping commands and unrelated HTTP independently without global deltas", async () => {
    const { eufy, dispatch } = fixture();
    let release!: (body: string) => void;
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      text: () => new Promise<string>((resolve) => (release = resolve)),
    } as Response);
    const slow = eufy.setProperty(HUB, "armingMode", "home");
    await vi.advanceTimersByTimeAsync(0);
    monotonic = 50;
    await eufy.api.getDeviceParamList(HUB);
    monotonic = 60;
    vi.mocked(fetch).mockResolvedValueOnce(response(70));
    await eufy.setProperty(CAMERA, "light", true);
    const fast = eufy.getPropertyPreparationDiagnostics().recent[0]!;
    expect(fast).toMatchObject({
      category: "other",
      elapsedMs: 70,
      http: { requests: 1, completed: 1, totalMs: 70, maxMs: 70 },
    });
    monotonic = 6_000;
    release('{"code":0,"data":{"params":[]}}');
    await slow;
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(eufy.getPropertyPreparationDiagnostics().recent[1]).toMatchObject({
      category: "guard_mode",
      elapsedMs: 6_000,
      http: { requests: 1, completed: 1, totalMs: 6_000, maxMs: 6_000 },
    });
    expect(eufy.getCloudHttpDiagnostics().requests).toBe(3);
  });

  it("sums only this invocation's completed HTTP attempts and retains their maximum duration", async () => {
    const { eufy, client } = fixture();
    const record = client.registry.record.bind(client.registry);
    vi.spyOn(client.registry, "record").mockImplementation(async (sn) => {
      await eufy.api.getDeviceParamList(sn as string);
      return record(sn);
    });
    vi.mocked(fetch).mockResolvedValueOnce(response(2_000)).mockResolvedValueOnce(response(4_000));
    await eufy.setProperty(HUB, "armingMode", "home");
    expect(eufy.getPropertyPreparationDiagnostics().recent[0]).toMatchObject({
      elapsedMs: 6_000,
      http: { requests: 2, completed: 2, totalMs: 6_000, maxMs: 4_000 },
    });
  });

  it("does not assign pre-existing shared HTTP work to an invocation that only awaits it", async () => {
    const { eufy, client } = fixture();
    let release!: (body: string) => void;
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      text: () => new Promise<string>((resolve) => (release = resolve)),
    } as Response);
    const shared = eufy.api.getDeviceParamList(HUB);
    await vi.advanceTimersByTimeAsync(0);
    const record = {
      model: "T9000",
      category: "eufy_security",
      params: { 1224: "0" },
      paramUpdatedAt: {},
    };
    vi.spyOn(client.registry, "record").mockImplementation(async () => {
      await shared;
      return record;
    });
    const pending = eufy.setProperty(HUB, "armingMode", "home");
    monotonic = 6_001;
    release('{"code":0,"data":{}}');
    await pending;
    expect(eufy.getPropertyPreparationDiagnostics().recent[0]).toMatchObject({
      elapsedMs: 6_001,
      http: { requests: 0, completed: 0, totalMs: 0, maxMs: 0 },
    });
  });

  it("retains thrown preparation failures with the exact phase and no error or property text", async () => {
    const { eufy, client, dispatch } = fixture();
    const error = new Error("synthetic-private-error");
    vi.spyOn(client.registry, "record").mockImplementationOnce(async () => {
      monotonic = 5_001;
      throw error;
    });
    await expect(eufy.setProperty(HUB, "synthetic-private-property", "synthetic-private-value")).rejects.toBe(error);
    const diagnostics = eufy.getPropertyPreparationDiagnostics();
    expect(diagnostics).toMatchObject({ invocations: 1, prepared: 0, failures: 1, slow: 1 });
    expect(diagnostics.recentFailures[0]).toMatchObject({
      category: "other",
      phase: "command_context",
      elapsedMs: 5_001,
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(/synthetic|T9000|https/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("records command construction failures and early validation receipts without sending", async () => {
    const { eufy, dispatch } = fixture();
    await expect(eufy.setProperty(HUB, "synthetic-unknown-property", true)).rejects.toThrow();
    expect(eufy.getPropertyPreparationDiagnostics().recentFailures[0]!.phase).toBe("command_build");
    const receipt = await eufy.setPropertyWithReceipt(HUB, "armingMode", "home", { automatic: true });
    expect(receipt.status).toBe("validation_failed");
    expect(eufy.getPropertyPreparationDiagnostics().recentFailures[1]).toMatchObject({
      category: "guard_mode",
      phase: "validation",
      http: { requests: 0, completed: 0, totalMs: 0, maxMs: 0 },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps transport rejection out of preparation failures and supports receipt handoff", async () => {
    const { eufy, dispatch } = fixture();
    const error = new Error("synthetic-transport-failure");
    dispatch.mockRejectedValueOnce(error);
    await expect(eufy.setProperty(HUB, "armingMode", "home")).rejects.toBe(error);
    const receipt = await eufy.setPropertyWithReceipt(CAMERA, "light", true);
    expect(receipt.status).toBe("acknowledged");
    expect(eufy.getPropertyPreparationDiagnostics()).toMatchObject({ invocations: 2, prepared: 2, failures: 0 });
  });

  it("freezes a cancelled preparation while its body read continues, without late attribution or dispatch", async () => {
    const { eufy, dispatch } = fixture();
    let release!: (body: string) => void;
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      text: () => new Promise<string>((resolve) => (release = resolve)),
    } as Response);
    const pending = eufy.setPropertyWithReceipt(CAMERA, "light", true, {
      profile: "bounded-state-v1",
      remainingBudgetMs: 13_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    monotonic = 1_001;
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await pending).status).toBe("expired_before_send");
    const snapshot = eufy.getPropertyPreparationDiagnostics();
    expect(snapshot.recentFailures[0]).toMatchObject({
      phase: "command_context",
      elapsedMs: 1_001,
      http: { requests: 1, completed: 0, totalMs: 0, maxMs: 0 },
    });
    monotonic = 6_000;
    release('{"code":0,"data":{"params":[]}}');
    await vi.advanceTimersByTimeAsync(0);
    expect(eufy.getPropertyPreparationDiagnostics()).toEqual(snapshot);
    expect(eufy.getCloudHttpDiagnostics().slow).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("property preparation bounded retention", () => {
  it("retains slow and failed observations independently of recent successes and detaches nested snapshots", () => {
    const recorder = new PropertyPreparationRecorder();
    for (let i = 0; i < 25; i++) {
      const observation = recorder.begin("guard_mode");
      observation.mark("command_context");
      monotonic += 5_001;
      observation.finish("failed");
      observation.finish("failed");
    }
    for (let i = 0; i < 30; i++) recorder.begin("other").finish("transport_handoff");
    const snapshot = recorder.diagnostics();
    expect(snapshot).toMatchObject({
      invocations: 55,
      prepared: 30,
      slow: 25,
      failures: 25,
      recentEvicted: 50,
      slowEvicted: 5,
      failuresEvicted: 5,
    });
    expect(snapshot.recent).toHaveLength(5);
    expect(snapshot.recentSlow).toHaveLength(20);
    expect(snapshot.recentFailures).toHaveLength(20);
    expect(snapshot.recent.every((row) => row.category === "other")).toBe(true);
    snapshot.recentFailures[0]!.phases.command_context = 999;
    snapshot.recentSlow[0]!.http.requests = 999;
    snapshot.recent.length = 0;
    expect(recorder.diagnostics().recentFailures[0]!.phases.command_context).toBe(5_001);
    expect(recorder.diagnostics().recentSlow[0]!.http.requests).toBe(0);
    expect(recorder.diagnostics().recent).toHaveLength(5);
  });

  it("uses an exclusive slow threshold and monotonic integer durations across wall-clock jumps", () => {
    const recorder = new PropertyPreparationRecorder();
    const atThreshold = recorder.begin("other");
    monotonic = 5_000;
    atThreshold.finish("transport_handoff");
    const slow = recorder.begin("other");
    vi.mocked(Date.now).mockReturnValue(1_799_000_000_000);
    monotonic += 5_001.9;
    slow.mark("command_context");
    slow.finish("transport_handoff");
    expect(recorder.diagnostics().slow).toBe(1);
    expect(recorder.diagnostics().recentSlow[0]).toMatchObject({ startedAtMs: 1_800_000_000_000, elapsedMs: 5_002 });
  });

  it("retains a preparation fractionally beyond five seconds", () => {
    const recorder = new PropertyPreparationRecorder();
    const observation = recorder.begin("guard_mode");
    monotonic += 5_000.01;
    observation.finish("transport_handoff");
    expect(recorder.diagnostics().slow).toBe(1);
    expect(recorder.diagnostics().recentSlow[0]!.elapsedMs).toBe(5_001);
  });
});
