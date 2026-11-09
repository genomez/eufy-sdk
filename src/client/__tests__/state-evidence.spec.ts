import { afterEach, describe, expect, it, vi } from "vitest";
import { StateEvidenceOwner, type EvidenceIngress } from "../state-evidence.js";
import { EufyMega } from "../eufy-mega.js";
import { Device } from "../../model/device.js";

const station = "T9000P0000000000";
const camera = "T8425P0000000000";
const ingress = (overrides: Partial<EvidenceIngress> = {}): EvidenceIngress => ({
  source: "rtc_push",
  receivedAtMs: 100_000,
  receivedAtMonotonicMs: 100,
  sessionGeneration: 1,
  receiveSequence: 1,
  station: "synthetic-station",
  ...overrides,
});
function sample(owner: StateEvidenceOwner, value: boolean, input = ingress()) {
  owner.record("synthetic-camera", 1400, value ? "1" : "0", input);
  return owner.project("synthetic-camera", 1400, "light", value)!;
}
const ordered = (sequence: number, overrides: Partial<EvidenceIngress> = {}) =>
  ingress({
    producerSequence: String(sequence),
    producerDomain: "device_sequence",
    producerOrderQualified: true,
    ...overrides,
  });

afterEach(() => vi.restoreAllMocks());

describe("shadow evidence policy", () => {
  it.each([true, false])("keeps unorderable %s then contrary report uncertain", (initial) => {
    const owner = new StateEvidenceOwner();
    expect(sample(owner, initial).status).toBe("uncertain");
    const late = sample(owner, !initial, ingress({ receiveSequence: 2, receivedAtMs: 101_000 }));
    expect(late).toMatchObject({ status: "uncertain", reason: "incomparable_conflict", confirmationEligible: false });
  });
  it("rejects same-session producer reorder while receipt sequence increases", () => {
    const owner = new StateEvidenceOwner();
    expect(sample(owner, true, ordered(20)).status).toBe("current");
    expect(sample(owner, false, ordered(19, { receiveSequence: 2 }))).toMatchObject({
      status: "stale",
      reason: "older_sample",
      decision: "retained",
    });
  });
  it("cannot order an older cloud poll against RTC by arrival or source", () => {
    const owner = new StateEvidenceOwner();
    sample(owner, true, ordered(20));
    expect(
      sample(
        owner,
        false,
        ingress({
          source: "cloud_poll",
          sessionGeneration: undefined,
          receiveSequence: undefined,
          producerTimeMs: 99_000,
          producerDomain: "cloud_update_time",
          receivedAtMs: 102_000,
        }),
      ),
    ).toMatchObject({ status: "uncertain", reason: "incomparable_conflict", producerTimeMs: 99_000 });
  });
  it("echo and ACK/cache equality are not OFF proof", () => {
    const owner = new StateEvidenceOwner();
    sample(owner, true);
    owner.dispatched("synthetic-camera", 1400, false, 200, "light", {
      station: "synthetic-station",
      sessionGeneration: 1,
    });
    const before = owner.diagnostics().total;
    expect(owner.diagnostics().total).toBe(before);
    expect(sample(owner, false, ingress({ source: "command_echo", receiveSequence: 2 }))).toMatchObject({
      confirmationEligible: false,
      offProof: { eligible: false, reason: "echo_not_proof" },
    });
  });
  it("post-dispatch temporal read is associated but never proof", () => {
    const owner = new StateEvidenceOwner();
    owner.dispatched("synthetic-camera", 1400, false, 50, "light", {
      station: "synthetic-station",
      sessionGeneration: 1,
    });
    expect(
      sample(owner, false, ingress({ source: "rtc_readback", readGeneration: 7, readIssuedAtMonotonicMs: 60 })),
    ).toMatchObject({
      correlation: "temporal_only",
      readIssuedAfterDispatch: true,
      offProof: { eligible: false, reason: "unverified_read" },
    });
  });
  it("qualifying fresh read can confirm only the dispatch it follows", () => {
    const owner = new StateEvidenceOwner();
    owner.dispatched("synthetic-camera", 1400, false, 50, "light", {
      station: "synthetic-station",
      sessionGeneration: 1,
    });
    expect(
      sample(
        owner,
        false,
        ingress({ source: "rtc_readback", readGeneration: 7, readIssuedAtMonotonicMs: 60, freshSampleContract: true }),
      ),
    ).toMatchObject({
      status: "current",
      decision: "confirmation-of-command",
      confirmationEligible: true,
      offProof: { eligible: true },
    });
    owner.dispatched("synthetic-camera", 1400, false, 200, "light", {
      station: "synthetic-station",
      sessionGeneration: 1,
    });
    expect(
      sample(
        owner,
        false,
        ingress({
          source: "rtc_readback",
          readGeneration: 7,
          readIssuedAtMonotonicMs: 60,
          receivedAtMonotonicMs: 300,
          receiveSequence: 2,
          freshSampleContract: true,
        }),
      ).confirmationEligible,
    ).toBe(false);
  });
  it.each(["cloud_poll", "snapshot", "legacy_unknown", "command_echo"] as const)(
    "never promotes %s to post-command proof",
    (source) => {
      const owner = new StateEvidenceOwner();
      owner.dispatched("synthetic-camera", 1400, false, 50, "light", {
        station: "synthetic-station",
        sessionGeneration: 1,
      });
      expect(sample(owner, false, ordered(1, { source, producerAfterDispatch: true })).confirmationEligible).toBe(
        false,
      );
    },
  );
  it("rejects a read superseded by an intervening observation", () => {
    const owner = new StateEvidenceOwner();
    sample(owner, true, ingress({ receivedAtMonotonicMs: 150 }));
    expect(
      sample(
        owner,
        false,
        ingress({
          source: "rtc_readback",
          readGeneration: 2,
          readIssuedAtMonotonicMs: 100,
          receivedAtMonotonicMs: 200,
          receiveSequence: 2,
          freshSampleContract: true,
        }),
      ).status,
    ).toBe("uncertain");
  });
  it("keeps an overlapping OFF read uncertain after an intervening unqualified ON", () => {
    const owner = new StateEvidenceOwner();
    sample(owner, false, ingress({ receivedAtMonotonicMs: 10 }));
    owner.dispatched("synthetic-camera", 1400, false, 15, "light");
    sample(owner, true, ingress({ receiveSequence: 2, receivedAtMonotonicMs: 30 }));
    expect(
      sample(
        owner,
        false,
        ingress({
          source: "rtc_readback",
          readGeneration: 1,
          readIssuedAtMonotonicMs: 20,
          receivedAtMonotonicMs: 40,
          receiveSequence: 3,
          freshSampleContract: true,
        }),
      ),
    ).toMatchObject({ status: "uncertain", confirmationEligible: false, offProof: { eligible: false } });
    expect(owner.diagnostics().offCommandsWithProof).toBe(0);
  });
  it.each([20, undefined])(
    "keeps a contrary observation with timestamp %s from being bypassed by a read",
    (contraryAt) => {
      const owner = new StateEvidenceOwner();
      vi.spyOn(performance, "now").mockReturnValue(30);
      sample(owner, false, ingress({ receivedAtMonotonicMs: 10 }));
      owner.dispatched("synthetic-camera", 1400, false, 15, "light");
      sample(owner, true, ingress({ receiveSequence: 2, receivedAtMonotonicMs: contraryAt }));
      expect(
        sample(
          owner,
          false,
          ingress({
            source: "rtc_readback",
            readGeneration: 1,
            readIssuedAtMonotonicMs: 20,
            receivedAtMonotonicMs: 40,
            receiveSequence: 3,
            freshSampleContract: true,
          }),
        ),
      ).toMatchObject({ status: "uncertain", confirmationEligible: false });
      expect(
        sample(
          owner,
          false,
          ingress({
            source: "rtc_readback",
            readGeneration: 2,
            readIssuedAtMonotonicMs: 50,
            receivedAtMonotonicMs: 60,
            receiveSequence: 4,
            freshSampleContract: true,
          }),
        ),
      ).toMatchObject({ status: "current", confirmationEligible: true });
    },
  );
  it("cannot confirm a dispatched intent from a replacement station session", () => {
    const owner = new StateEvidenceOwner();
    sample(owner, false, ingress({ receivedAtMonotonicMs: 10 }));
    owner.dispatched("synthetic-camera", 1400, false, 15, "light");
    const result = sample(
      owner,
      false,
      ingress({
        source: "rtc_readback",
        sessionGeneration: 2,
        readGeneration: 1,
        readIssuedAtMonotonicMs: 20,
        receivedAtMonotonicMs: 40,
        receiveSequence: 2,
        freshSampleContract: true,
      }),
    );
    expect(result).toMatchObject({ confirmationEligible: false, intentGeneration: null, dispatchRevision: null });
    expect(owner.diagnostics()).toMatchObject({ offCommandsWithoutProof: 1, offCommandsWithProof: 0 });
  });
  it("ordered external OFF does not confirm an outstanding command without an application anchor", () => {
    const owner = new StateEvidenceOwner();
    owner.dispatched("synthetic-camera", 1400, false, 50, "light", {
      station: "synthetic-station",
      sessionGeneration: 1,
    });
    expect(sample(owner, false, ordered(4))).toMatchObject({
      status: "current",
      confirmationEligible: false,
      offProof: { eligible: false, reason: "no_post_dispatch_anchor" },
    });
    expect(sample(owner, false, ordered(5, { receiveSequence: 2, producerAfterDispatch: true }))).toMatchObject({
      confirmationEligible: true,
    });
  });
  it("rejects retired sessions and old runtimes without treating reconnect as new sampling", () => {
    const owner = new StateEvidenceOwner();
    sample(owner, true, ingress({ sessionGeneration: 2 }));
    expect(sample(owner, false).reason).toBe("retired_session");
    expect(sample(owner, false, ingress({ runtimeGeneration: "retired-runtime" })).reason).toBe("old_runtime");
    expect(sample(owner, false, ingress({ sessionGeneration: 3 })).status).toBe("uncertain");
  });
  it("invalidates all station intents permanently when another property observes replacement", () => {
    const owner = new StateEvidenceOwner();
    sample(owner, false, ingress({ receivedAtMonotonicMs: 10 }));
    owner.dispatched("synthetic-camera", 1400, false, 15, "light");
    owner.record("synthetic-other", 1, "0", ingress({ sessionGeneration: 2 }));
    for (let i = 0; i < 256; i++)
      owner.record("synthetic-other", 1, "0", ingress({ station: `synthetic-station-${i}` }));
    expect(
      sample(
        owner,
        false,
        ordered(1, {
          receiveSequence: 2,
          receivedAtMonotonicMs: 200,
          producerAfterDispatch: true,
        }),
      ),
    ).toMatchObject({ confirmationEligible: false, intentGeneration: null });
    expect(owner.diagnostics().offCommandsWithoutProof).toBe(1);
  });
  it("never associates a qualified replacement-runtime read with an old intent", () => {
    const owner = new StateEvidenceOwner();
    sample(owner, false, ingress({ receivedAtMonotonicMs: 10 }));
    owner.dispatched("synthetic-camera", 1400, false, 15, "light");
    expect(
      sample(
        owner,
        false,
        ingress({
          source: "rtc_readback",
          runtimeGeneration: "retired-runtime",
          receiveSequence: 2,
          readGeneration: 1,
          readIssuedAtMonotonicMs: 20,
          receivedAtMonotonicMs: 40,
          freshSampleContract: true,
        }),
      ),
    ).toMatchObject({ reason: "old_runtime", confirmationEligible: false, intentGeneration: null });
  });
  it("detects duplicates, equal-order conflict and counter reset without confirming", () => {
    const owner = new StateEvidenceOwner();
    sample(owner, true, ordered(10));
    expect(sample(owner, true, ordered(10, { receiveSequence: 2 })).reason).toBe("duplicate");
    expect(sample(owner, false, ordered(10, { receiveSequence: 3 })).reason).toBe("producer_conflict");
    expect(sample(owner, false, ordered(1, { receiveSequence: 4 })).reason).toBe("older_sample");
  });
  it("rejects skewed/aged producer samples and malformed typed values", () => {
    const owner = new StateEvidenceOwner();
    expect(
      sample(
        owner,
        false,
        ingress({ producerTimeMs: 200_000, producerDomain: "device_sample_time", producerOrderQualified: true }),
      ).reason,
    ).toBe("sample_expired");
    expect(owner.project("synthetic-camera", 1400, "light", undefined)).toMatchObject({
      reason: "invalid_value",
      confirmationEligible: false,
    });
  });
  it("advances equal-value fresh evidence and detaches cached projections without restamping", () => {
    const owner = new StateEvidenceOwner();
    const first = sample(owner, false, ordered(1));
    const second = sample(owner, false, ordered(2, { receiveSequence: 2, receivedAtMs: 101_000 }));
    expect(second.revision).toBeGreaterThan(first.revision);
    second.receivedAtMs = 0;
    expect(owner.project("synthetic-camera", 1400, "light", false)?.receivedAtMs).toBe(101_000);
    expect(owner.diagnostics().recent).toHaveLength(2);
  });
  it("preserves captured cloud ingress through lazy adoption and never restamps snapshots", () => {
    const owner = new StateEvidenceOwner();
    owner.captureCloud("synthetic-camera", { 1400: "0" }, { 1400: 90 }, 100_000);
    const original = owner.cachedIngress("synthetic-camera", 1400, "0")!;
    owner.record("synthetic-camera", 1400, "0", original);
    expect(owner.project("synthetic-camera", 1400, "light", false)).toMatchObject({
      source: "cloud_poll",
      receivedAtMs: 100_000,
      producerTimeMs: 90_000,
      confirmationEligible: false,
    });
    expect(owner.matches("synthetic-camera", 1400, "0")).toBe(true);
    expect(owner.cachedIngress("synthetic-camera", 1400, "1")).toBeUndefined();
    const missing = new StateEvidenceOwner();
    expect(sample(missing, false, { source: "snapshot", receivedAtMs: null })).toMatchObject({
      source: "snapshot",
      receivedAtMs: null,
      status: "uncertain",
    });
  });
  it("keeps camera indexes stable across bounded eviction without exposing identity", () => {
    const owner = new StateEvidenceOwner();
    sample(owner, false);
    const target = owner.diagnostics().recent[0]!.target;
    for (let i = 0; i < 2050; i++) owner.record(`synthetic-${i}`, 1400, "1", ingress());
    sample(owner, false);
    expect(owner.diagnostics().recent.at(-1)!.target).toBe(target);
  });
  it("bounds retention, counters and anonymized diagnostics", () => {
    const owner = new StateEvidenceOwner();
    for (let i = 0; i < 2100; i++) {
      owner.record(`private-target-${i}`, 1400, "0", ingress({ receiveSequence: i }));
      owner.project(`private-target-${i}`, 1400, "light", false);
    }
    const summary = owner.diagnostics();
    expect(summary).toMatchObject({ retainedParameters: 2048, evicted: 52, total: 2100 });
    expect(summary.recent).toHaveLength(32);
    expect(JSON.stringify(summary)).not.toContain("private-target");
  });
});

function fixture() {
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", autoRealtime: false, pollMs: 0 });
  const client = eufy as any;
  const params = { 1400: "0" };
  client.registry.devices = [
    { sn: station, model: "T9000", params: {}, raw: {} },
    { sn: camera, model: "T8425", stationSn: station, params, raw: { device_channel: 0, device_type: 47 } },
  ];
  const device = Device.fromRecord(camera, { model: "T8425", deviceType: 47, category: "eufy_security", params });
  client.liveDevices.set(camera, new WeakRef(device));
  client.boundParamIds.set(camera, new Set([1400]));
  device.bindActions(
    { channel: 0, codec: "camera", deviceType: 47, paramIds: new Set([1400]) },
    client.commandSinkFor(camera),
  );
  const report = (value: boolean, sequence: number, read = false) =>
    client.rtc.deps.onFrame(
      station,
      {
        commandId: 1103,
        channel: 255,
        segment: 1,
        isResponse: 0,
        linkType: 3,
        data: { params: [{ channel: 0, param_type: 1400, param_value: Number(value) }] },
      },
      {
        sessionGeneration: 1,
        sequence,
        receivedAtMonotonicMs: 100 + sequence,
        ...(read ? { readGeneration: 1, readIssuedAtMonotonicMs: 100 } : {}),
      },
    );
  return { eufy, client, device, report };
}

describe("production shadow wiring preserves legacy outputs", () => {
  it("keeps state, valued events, safety observations and cloud replacement in legacy arrival order", async () => {
    const { eufy, client, device, report } = fixture();
    const changes: unknown[] = [],
      observations: unknown[] = [],
      quality: unknown[] = [];
    eufy.on("propertyChanged", ({ evidence: _e, ...event }) => changes.push(event));
    eufy.on("propertiesObserved", ({ evidence: _e, ...event }) => observations.push(event));
    eufy.on("propertyEvidenceChanged", (event) => quality.push(event));
    report(true, 1);
    report(false, 2);
    report(false, 3);
    expect(device.light!()!.isOn).toBe(false);
    expect(changes).toEqual([
      { deviceSn: camera, property: "light", value: true },
      { deviceSn: camera, property: "light", value: false },
    ]);
    expect(observations).toEqual(
      [true, false, false].map((light) => ({
        deviceSn: camera,
        source: "rtc",
        observedAtMs: expect.any(Number),
        properties: { light },
      })),
    );
    expect(quality).toHaveLength(3);
    expect(eufy.getStateEvidence(camera).light).toMatchObject({
      source: "rtc_push",
      status: "uncertain",
      confirmationEligible: false,
    });
    client.applyPolledParams([{ deviceSn: camera, paramType: 1400, to: "1", from: "0", params: { 1400: "1" } }]);
    expect(device.light!()!.isOn).toBe(true);
    expect(eufy.getStateEvidence(camera).light.source).toBe("cloud_poll");
    await eufy.disconnect();
  });
  it.each(["record", "project", "consumer"])(
    "finishes every legacy frame handler before failing shadow %s",
    async (failure) => {
      const { eufy, client, report } = fixture();
      const trace: string[] = [];
      const late = vi.spyOn(client.lateEffects, "observe").mockImplementation(() => {
        trace.push("lateEffect");
      });
      const contrary = vi.spyOn(client.lateContrary, "observe").mockImplementation(() => {
        trace.push("lateContrary");
      });
      eufy.on("deviceState", () => trace.push("deviceState"));
      eufy.on("propertiesObserved", () => trace.push("propertiesObserved"));
      const fail = () => {
        expect(trace).toEqual(["deviceState", "lateEffect", "lateContrary", "propertiesObserved"]);
        throw new Error("synthetic shadow fault");
      };
      if (failure === "consumer") eufy.on("propertyEvidenceChanged", fail);
      else vi.spyOn(client.evidenceOwner(), failure).mockImplementation(fail);
      try {
        expect(() => report(false, 1)).not.toThrow();
        expect(trace).toEqual(["deviceState", "lateEffect", "lateContrary", "propertiesObserved"]);
        expect(late).toHaveBeenCalledOnce();
        expect(contrary).toHaveBeenCalledOnce();
        expect(eufy.getStateEvidenceDiagnostics().failures).toBeGreaterThan(0);
      } finally {
        await eufy.disconnect();
      }
    },
  );
  it.each(["record", "project", "consumer"])("finishes legacy frame handling before slow shadow %s", async (slow) => {
    const { eufy, client, report } = fixture();
    const trace: string[] = [];
    eufy.on("deviceState", () => trace.push("deviceState"));
    eufy.on("propertiesObserved", () => trace.push("propertiesObserved"));
    const delay = () => {
      expect(trace).toEqual(["deviceState", "propertiesObserved"]);
      const until = performance.now() + 5;
      while (performance.now() < until) {}
    };
    if (slow === "consumer") eufy.on("propertyEvidenceChanged", delay);
    else {
      const owner = client.evidenceOwner();
      const original = owner[slow].bind(owner);
      vi.spyOn(owner, slow).mockImplementation((...args: unknown[]) => {
        delay();
        return original(...args);
      });
    }
    try {
      report(false, 1);
    } finally {
      await eufy.disconnect();
    }
  });
  it("preserves exceptions from legacy consumers without classifying them as shadow failures", async () => {
    const { eufy, report } = fixture();
    const fault = new Error("synthetic legacy fault");
    eufy.on("deviceState", () => {
      throw fault;
    });
    try {
      expect(() => report(false, 1)).toThrow(fault);
      expect(eufy.getStateEvidenceDiagnostics().failures).toBe(0);
    } finally {
      await eufy.disconnect();
    }
  });
  it("contains dispatch and cloud capture failures without changing legacy command callbacks", async () => {
    const { eufy, client, device } = fixture();
    const owner = client.evidenceOwner();
    const fault = () => {
      throw new Error("synthetic shadow fault");
    };
    vi.spyOn(owner, "dispatched").mockImplementation(fault);
    vi.spyOn(owner, "captureCloud").mockImplementation(fault);
    const late = vi.spyOn(client.lateEffects, "sent");
    vi.spyOn(client.rtc, "dispatchCommand").mockImplementation(async (_sn, _cmd, opts: any) => {
      opts.onSent(1_800_000_000_000);
    });
    try {
      await expect(device.light!()!.off()).resolves.toBeUndefined();
      expect(late).toHaveBeenCalledWith(expect.anything(), 1_800_000_000_000);
      expect(() => client.registry.onCloudEvidence(camera, { 1400: "0" }, {}, 100_000)).not.toThrow();
      expect(eufy.getStateEvidenceDiagnostics().failures).toBe(2);
    } finally {
      await eufy.disconnect();
    }
  });
  it("uses a monotonic dispatch fence while preserving the wall-clock transport callback", async () => {
    const { eufy, client, device, report } = fixture();
    vi.spyOn(performance, "now").mockReturnValue(50);
    const wall = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    vi.spyOn(client.rtc, "dispatchCommand").mockImplementation(async (_sn, _cmd, opts: any) => {
      opts.onSent(Date.now());
    });
    try {
      await device.light!()!.off();
      wall.mockReturnValue(1_700_000_000_000);
      report(false, 1, true);
      expect(eufy.getStateEvidence(camera).light).toMatchObject({
        readIssuedAfterDispatch: true,
        confirmationEligible: false,
      });
    } finally {
      await eufy.disconnect();
    }
  });
  it("records actual dispatch and temporal-only OFF but adds no reads, retries or proof", async () => {
    const { eufy, client, device, report } = fixture();
    vi.spyOn(performance, "now").mockReturnValue(50);
    const refresh = vi.spyOn(client.rtc, "refreshInformation");
    const send = vi.spyOn(client.rtc, "dispatchCommand").mockImplementation(async (_sn, _cmd, opts: any) => {
      opts.onSent(50);
    });
    await device.light!()!.off();
    expect(eufy.getStateEvidenceDiagnostics()).toMatchObject({ total: 0, offCommands: 1, offCommandsWithoutProof: 1 });
    report(false, 1, true);
    expect(eufy.getStateEvidence(camera).light).toMatchObject({
      source: "rtc_readback",
      readIssuedAfterDispatch: true,
      offProof: { eligible: false, reason: "unverified_read" },
    });
    expect(eufy.getStateEvidenceDiagnostics()).toMatchObject({
      offAfterCommand: 1,
      offProofEligible: 0,
      offUnresolved: 1,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    await eufy.disconnect();
  });
  it("preserves cached evidence and runtime replacement without equality becoming proof", async () => {
    const { eufy, client, device, report } = fixture();
    report(false, 1);
    const before = eufy.getStateEvidence(camera).light;
    client.applyAndAnnounce(device, { 1400: "0" }, "cached");
    expect(eufy.getStateEvidence(camera).light).toEqual(before);
    client.realtimeEpoch++;
    expect(eufy.getStateEvidence(camera)).toEqual({});
    expect(eufy.getStateEvidenceScope().runtimeGeneration).not.toBe(before.runtimeGeneration);
    await eufy.disconnect();
  });
});
