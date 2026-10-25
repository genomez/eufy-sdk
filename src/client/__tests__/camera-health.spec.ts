import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandReceipt } from "../../core/contracts.js";
import {
  CAMERA_CONTACT_TTL_MS,
  CAMERA_SUSPECT_TTL_MS,
  CameraHealthStore,
  createCameraHealthState,
  reduceCameraHealth,
  type CameraHealthClock,
  type CameraHealthEvidence,
  type CameraHealthEvent,
  type CameraHealthInput,
  type CameraPower,
} from "../camera-health.js";

const accountId = "synthetic-account";
const device = "T8000P0000000000";
const origin = 1_700_000_000_000;
const stores: CameraHealthStore[] = [];

function harness(power: CameraPower = "mains", maxCameras = 4, hubStatusQualified = false) {
  let wall = origin;
  let monotonic = 0;
  const events: CameraHealthEvent[] = [];
  const store = new CameraHealthStore({
    accountId,
    maxCameras,
    now: () => wall,
    monotonicNow: () => monotonic,
    event: (event) => events.push(event),
  });
  stores.push(store);
  store.register(device, power, hubStatusQualified);
  const evidence = (payload: object): CameraHealthEvidence =>
    ({ accountId, device, receivedAtMs: wall, ...payload }) as CameraHealthEvidence;
  return {
    store,
    events,
    evidence,
    observe: (payload: object) => store.observe(device, evidence(payload))!,
    push: (payload: object = {}) =>
      store.observe(
        device,
        evidence({ kind: "push", qualified: true, childOrigin: true, observedAtMs: wall, ...payload }),
      )!,
    media: (payload: object = {}) =>
      store.observe(
        device,
        evidence({ kind: "media", qualified: true, live: true, cached: false, prebuffered: false, ...payload }),
      )!,
    advance: (ms: number, wallDelta = ms) => {
      wall += wallDelta;
      monotonic += ms;
    },
    clock: (): CameraHealthClock => ({ nowMs: wall, monotonicMs: monotonic }),
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});

describe("qualified HomeBase device status", () => {
  function qualified(power: CameraPower = "mains") {
    const h = harness(power, 4, true);
    h.store.parent(device, "connected");
    return {
      ...h,
      status: (p1131: unknown, extra: object = {}) =>
        h.observe({ kind: "raw_status", source: "hub_report", p1131, ...extra }),
    };
  }

  it.each([1, true, 0, false])("assesses %s with HomeBase evidence and no command enforcement", (value) => {
    const h = qualified();
    expect(h.status(value)).toMatchObject({
      connectivity: value ? "online" : "offline",
      basis: "vendor_status",
      evidence: "hub_reported",
      lastContactMs: null,
      lastHubOfflineMs: null,
      hubOfflineCount: 0,
      enforcement: "observe_only",
      commandsBlocked: false,
      rawStatus: { p1131: value, source: "hub_report" },
    });
  });

  it.each([2, 3, -1, 0.5, null])("retains %s without changing assessment or refreshing its expiry", (value) => {
    const h = qualified();
    h.status(1);
    h.advance(CAMERA_CONTACT_TTL_MS - 1);
    expect(h.status(value)).toMatchObject({ connectivity: "online", rawStatus: { p1131: value } });
    h.advance(1);
    expect(h.store.status(device)).toMatchObject({ connectivity: "unknown", basis: "contact_expired" });
  });

  it.each(["battery", "unknown"] as const)("keeps %s power raw-only even with qualification", (power) => {
    const h = qualified(power);
    expect(h.status(1)?.connectivity).toBe("unknown");
    h.advance(1);
    expect(h.status(0)?.connectivity).toBe("unknown");
  });

  it("keeps unqualified registrations, cloud parameters, missing source and 1182 raw-only", () => {
    const unqualified = harness();
    unqualified.store.parent(device, "connected");
    expect(unqualified.observe({ kind: "raw_status", source: "hub_report", p1131: 0 }).connectivity).toBe("unknown");
    const h = qualified();
    for (const payload of [{ source: "cloud_params", p1131: 0 }, { p1131: 1 }, { source: "hub_report", p1182: 1 }]) {
      expect(h.observe({ kind: "raw_status", ...payload }).connectivity).toBe("unknown");
      h.advance(1);
    }
  });

  it("refreshes online expiry on identical later reports and publishes only actual field changes", () => {
    const h = qualified();
    const first = h.status(1);
    expect(h.status(1)).toEqual(first);
    h.advance(CAMERA_CONTACT_TTL_MS - 1);
    const refreshed = h.status(1);
    expect(refreshed.revision).toBe(first.revision + 1);
    expect(refreshed.sinceMs).toBe(first.sinceMs);
    h.advance(1);
    expect(h.store.status(device)?.connectivity).toBe("online");
    h.advance(CAMERA_CONTACT_TTL_MS - 1);
    expect(h.store.status(device)).toMatchObject({
      connectivity: "unknown",
      basis: "contact_expired",
      evidence: "none",
    });
    expect(h.store.diagnostics().timers).toBe(0);
  });

  it.each(["push", "media"])("latches offline without a timer and recovers only on strictly newer %s", (kind) => {
    const h = qualified();
    h.status(0);
    expect(h.store.diagnostics().timers).toBe(0);
    expect((kind === "push" ? h.push() : h.media()).connectivity).toBe("offline");
    h.advance(CAMERA_SUSPECT_TTL_MS * 2);
    expect(h.store.status(device)?.connectivity).toBe("offline");
    expect(h.observe({ kind: "raw_status", source: "cloud_params", p1131: 1 }).connectivity).toBe("offline");
    expect((kind === "push" ? h.push() : h.media()).connectivity).toBe("online");
  });

  it("orders status against newer child contact, status and -109 without weakening the offline latch", () => {
    const h = qualified();
    h.status(1);
    h.advance(10);
    h.status(0);
    h.advance(10);
    expect(h.status(1, { receivedAtMs: origin + 5 }).connectivity).toBe("offline");
    expect(h.push({ observedAtMs: origin + 9 }).connectivity).toBe("offline");
    expect(h.observe({ kind: "hub_offline", correlated: true, code: -109 }).connectivity).toBe("offline");
    h.advance(1);
    h.media();
    expect(h.status(0, { receivedAtMs: origin + 20 })).toMatchObject({ connectivity: "online", basis: "media" });
    h.advance(1);
    expect(h.observe({ kind: "hub_offline", correlated: true, code: -109 }).connectivity).toBe("suspect");
    h.advance(1);
    expect(h.status(1).connectivity).toBe("online");
    h.advance(1);
    expect(h.status(0).connectivity).toBe("offline");
    h.advance(1);
    expect(h.status(1).connectivity).toBe("online");
  });

  it("requires strictly newer status, retaining the first assessment for equal-millisecond conflicts", () => {
    const h = qualified();
    h.status(1);
    expect(h.status(0)).toMatchObject({ connectivity: "online", rawStatus: { p1131: 0 } });
    h.advance(1);
    h.status(0);
    expect(h.status(1)).toMatchObject({ connectivity: "offline", rawStatus: { p1131: 1 } });
  });

  it.each(["disconnected", "unknown"] as const)(
    "masks status while parent is %s and reassesses on the next report",
    (transport) => {
      const h = qualified();
      h.status(0);
      h.advance(1);
      h.store.parent(device, transport);
      h.advance(1);
      expect(h.status(1)).toMatchObject({ connectivity: "unknown", basis: "parent_unassessable" });
      h.advance(1);
      expect(h.store.parent(device, "connected")?.connectivity).toBe("unknown");
      h.advance(1);
      expect(h.status(1).connectivity).toBe("online");
      h.advance(1);
      h.store.parent(device, transport);
      h.advance(1);
      h.status(0);
      h.advance(1);
      h.store.parent(device, "connected");
      h.advance(1);
      expect(h.status(0).connectivity).toBe("offline");
    },
  );
});

describe("pure camera health evidence", () => {
  it("starts unknown with a complete observation-only projection", () => {
    const { store } = harness();
    expect(store.status(device)).toMatchObject({
      version: 1,
      connectivity: "unknown",
      basis: "startup",
      evidence: "none",
      sinceMs: origin,
      lastContactMs: null,
      lastContactSource: null,
      lastHubOfflineMs: null,
      hubOfflineCount: 0,
      lastHubReportMs: null,
      lastCloudParamMs: null,
      parentTransport: "unknown",
      enforcement: "observe_only",
      commandsBlocked: false,
      rssi: { value: null, valid: false, lastValidMs: null },
      rawStatus: { p1131: null, p1182: null, observedMs: null },
      outcomes: {
        online: { acknowledged: 0, rejected: 0, timeout: 0, other: 0 },
        suspect: { acknowledged: 0, rejected: 0, timeout: 0, other: 0 },
        offline: { acknowledged: 0, rejected: 0, timeout: 0, other: 0 },
        unknown: { acknowledged: 0, rejected: 0, timeout: 0, other: 0 },
      },
      lastOutcome: null,
    });
  });

  it("does not mutate reducer state and is deterministic with explicit clocks", () => {
    const clock = { nowMs: origin, monotonicMs: 0 };
    const state = createCameraHealthState(accountId, device, "mains", "synthetic-incarnation", clock);
    const original = structuredClone(state);
    const input: CameraHealthInput = {
      accountId,
      device,
      receivedAtMs: origin,
      kind: "push",
      qualified: true,
      childOrigin: true,
      observedAtMs: origin,
    };
    const next = reduceCameraHealth(state, input, clock);
    expect(state).toEqual(original);
    expect(next).toEqual(reduceCameraHealth(state, input, clock));
    expect(next.health).toMatchObject({ connectivity: "online", basis: "child_contact", revision: 1 });
    expect(reduceCameraHealth(next, input, clock)).toBe(next);
  });

  it("expires mains contact at exactly five monotonic minutes without declaring offline", () => {
    const h = harness();
    expect(h.push()).toMatchObject({ connectivity: "online", lastContactMs: origin, lastContactSource: "push" });
    h.advance(CAMERA_CONTACT_TTL_MS - 1);
    expect(h.store.status(device)?.connectivity).toBe("online");
    h.advance(1);
    expect(h.store.status(device)).toMatchObject({
      connectivity: "unknown",
      basis: "contact_expired",
      evidence: "none",
      lastContactMs: origin,
    });
    expect(h.events.at(-1)?.basis).toBe("contact_expired");
  });

  it("does not extend contact validity when the local wall clock moves backwards", () => {
    const h = harness();
    h.push();
    h.advance(CAMERA_CONTACT_TTL_MS, -60_000);
    expect(h.store.status(device)).toMatchObject({ connectivity: "unknown", basis: "contact_expired" });
  });

  it("does not shorten validity when the wall clock jumps forward", () => {
    const h = harness();
    h.push();
    h.advance(1, CAMERA_CONTACT_TTL_MS * 2);
    expect(h.store.status(device)?.connectivity).toBe("online");
  });

  it("uses only remaining push freshness rather than granting five more minutes on delivery", () => {
    const h = harness();
    expect(h.push({ observedAtMs: origin - CAMERA_CONTACT_TTL_MS + 1 }).connectivity).toBe("online");
    h.advance(1);
    expect(h.store.status(device)?.basis).toBe("contact_expired");
  });

  it.each<CameraPower>(["battery", "unknown"])(
    "keeps %s power contact historical without a short expiry timer",
    (power) => {
      const h = harness(power);
      expect(h.push()).toMatchObject({ connectivity: "unknown", lastContactSource: "push", lastContactMs: origin });
      h.advance(1);
      expect(h.media()).toMatchObject({
        connectivity: "unknown",
        lastContactSource: "push",
        lastContactMs: origin,
      });
      const initial = createCameraHealthState(accountId, device, power, "test", {
        nowMs: origin,
        monotonicMs: 0,
      });
      const pushed = reduceCameraHealth(
        initial,
        {
          ...h.evidence({ kind: "push", qualified: true, childOrigin: true, observedAtMs: origin }),
          receivedAtMs: origin,
        },
        { nowMs: origin, monotonicMs: 0 },
      );
      const contacted = reduceCameraHealth(
        pushed,
        h.evidence({
          kind: "media",
          qualified: true,
          live: true,
          cached: false,
          prebuffered: false,
        }),
        h.clock(),
      );
      expect(contacted).toMatchObject({
        lastContactAtMs: origin + 1,
        lastContactSource: "media",
        health: { lastContactMs: origin, lastContactSource: "push" },
      });
      h.advance(59_999);
      expect(h.media()).toMatchObject({
        connectivity: "unknown",
        lastContactSource: "media",
        lastContactMs: origin + 60_000,
      });
      expect(h.store.diagnostics().timers).toBe(0);
    },
  );

  it.each([
    { qualified: false },
    { childOrigin: false },
    { observedAtMs: origin + 1 },
    { observedAtMs: origin - CAMERA_CONTACT_TTL_MS },
    { observedAtMs: NaN },
    { observedAtMs: -1 },
    { observedAtMs: 1.5 },
    { observedAtMs: "1700000000000" },
  ])("rejects unqualified, stale and malformed push evidence %j", (payload) => {
    const h = harness();
    const before = h.store.status(device);
    expect(h.push(payload)).toEqual(before);
  });

  it.each([{ qualified: false }, { live: false }, { cached: true }, { prebuffered: true }, { cached: undefined }])(
    "requires newly received live device media %j",
    (payload) => {
      const h = harness();
      expect(h.media(payload)).toEqual(h.store.status(device));
      expect(h.store.status(device)?.lastContactMs).toBeNull();
    },
  );

  it("accepts qualified media with its own receipt time", () => {
    const h = harness();
    expect(h.media()).toMatchObject({
      connectivity: "online",
      basis: "media",
      lastContactSource: "media",
      lastContactMs: origin,
    });
  });

  it.each([
    { device: "T8000P0000000001" },
    { accountId: "other-synthetic-account" },
    { receivedAtMs: origin + 1 },
    { receivedAtMs: -1 },
    { receivedAtMs: NaN },
    { receivedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { receivedAtMs: "1700000000000" },
  ])("rejects misattributed and invalid receipt evidence %j", (payload) => {
    const h = harness();
    expect(h.observe({ kind: "hub_report", ...payload })).toEqual(h.store.status(device));
    expect(h.store.status(device)?.lastHubReportMs).toBeNull();
  });

  it("correlated -109 is suspect for exactly ten minutes and does not change command permission", () => {
    const h = harness();
    const suspect = h.observe({ kind: "hub_offline", code: -109, correlated: true });
    expect(suspect).toMatchObject({
      connectivity: "suspect",
      basis: "hub_reported_offline",
      evidence: "hub_reported",
      lastHubOfflineMs: origin,
      hubOfflineCount: 1,
      enforcement: "observe_only",
      commandsBlocked: false,
    });
    h.advance(CAMERA_SUSPECT_TTL_MS - 1);
    expect(h.store.status(device)?.connectivity).toBe("suspect");
    h.advance(1);
    expect(h.store.status(device)).toMatchObject({
      connectivity: "unknown",
      basis: "suspect_expired",
      hubOfflineCount: 1,
    });
  });

  it.each([-108, -103, -114, 0])("does not classify command code %s as connectivity", (code) => {
    const h = harness();
    expect(h.observe({ kind: "hub_offline", code, correlated: true }).connectivity).toBe("unknown");
    expect(h.store.status(device)?.hubOfflineCount).toBe(0);
  });

  it("rejects uncorrelated -109 and counts separate correlated receipts sharing one millisecond", () => {
    const h = harness();
    expect(h.observe({ kind: "hub_offline", code: -109, correlated: false }).hubOfflineCount).toBe(0);
    h.observe({ kind: "hub_offline", code: -109, correlated: true });
    expect(h.observe({ kind: "hub_offline", code: -109, correlated: true }).hubOfflineCount).toBe(2);
  });

  it("equal-time negative evidence is suspect and cannot be cleared by an equal-time positive", () => {
    const h = harness();
    h.push();
    expect(h.observe({ kind: "hub_offline", code: -109, correlated: true }).connectivity).toBe("suspect");
    expect(h.media().connectivity).toBe("suspect");
  });

  it("preserves same-millisecond partial raw status fields", () => {
    const h = harness();
    h.observe({ kind: "raw_status", p1131: 4 });
    expect(h.observe({ kind: "raw_status", p1182: false }).rawStatus).toEqual({
      p1131: 4,
      p1182: false,
      observedMs: origin,
      source: null,
    });
  });

  it("new -109 extends suspect visibility and retains state onset", () => {
    const h = harness();
    h.observe({ kind: "hub_offline", code: -109, correlated: true });
    h.advance(1_000);
    expect(h.observe({ kind: "hub_offline", code: -109, correlated: true })).toMatchObject({
      sinceMs: origin,
      hubOfflineCount: 2,
    });
    h.advance(CAMERA_SUSPECT_TTL_MS - 1);
    expect(h.store.status(device)?.connectivity).toBe("suspect");
    h.advance(1);
    expect(h.store.status(device)?.basis).toBe("suspect_expired");
  });

  it("does not let a replayed older push undo a newer negative", () => {
    const h = harness();
    h.push();
    h.advance(1_000);
    h.observe({ kind: "hub_offline", code: -109, correlated: true });
    h.advance(1_000);
    expect(h.push({ observedAtMs: origin + 500 })).toMatchObject({ connectivity: "suspect", lastContactMs: origin });
    expect(h.push()).toMatchObject({ connectivity: "online", lastHubOfflineMs: origin + 1_000, hubOfflineCount: 1 });
  });

  it("keeps report, cloud, RSSI and raw status diagnostic-only, with original scalar values", () => {
    const h = harness();
    h.observe({ kind: "hub_report" });
    h.observe({ kind: "cloud_params" });
    h.observe({ kind: "rssi", value: -42 });
    expect(h.observe({ kind: "raw_status", p1131: 4, p1182: false })).toMatchObject({
      connectivity: "unknown",
      basis: "startup",
      lastContactMs: null,
      lastHubReportMs: origin,
      lastCloudParamMs: origin,
      rssi: { value: -42, valid: true, lastValidMs: origin },
      rawStatus: { p1131: 4, p1182: false, observedMs: origin },
    });
    h.advance(1);
    expect(h.observe({ kind: "raw_status", p1131: true }).rawStatus).toEqual({
      p1131: true,
      p1182: false,
      observedMs: origin + 1,
      source: null,
    });
    h.advance(1);
    expect(h.observe({ kind: "raw_status", p1131: "false" }).rawStatus).toEqual({
      p1131: true,
      p1182: false,
      observedMs: origin + 1,
      source: null,
    });
  });

  it.each([-100, null, undefined, NaN, Infinity, "-42", false, 1.5])(
    "invalid RSSI %s retains last-valid time",
    (value) => {
      const h = harness();
      h.observe({ kind: "rssi", value: -42 });
      h.advance(1);
      expect(h.observe({ kind: "rssi", value }).rssi).toEqual({ value: null, valid: false, lastValidMs: origin });
      expect(h.store.status(device)?.connectivity).toBe("unknown");
    },
  );

  it("rejects older diagnostics independently of connectivity and never refreshes contact", () => {
    const h = harness();
    h.observe({ kind: "hub_report" });
    h.advance(1_000);
    h.observe({ kind: "hub_report" });
    h.advance(1);
    expect(h.observe({ kind: "hub_report", receivedAtMs: origin }).lastHubReportMs).toBe(origin + 1_000);
    expect(h.store.status(device)?.lastContactMs).toBeNull();
  });

  it("parent loss masks child assessment and reconnect alone never recovers it", () => {
    const h = harness();
    h.push();
    h.advance(1);
    expect(h.store.parent(device, "disconnected")).toMatchObject({
      connectivity: "unknown",
      basis: "parent_unassessable",
      parentTransport: "disconnected",
      lastContactMs: origin,
    });
    expect(h.store.diagnostics().timers).toBe(0);
    h.advance(1);
    expect(h.media().connectivity).toBe("unknown");
    h.advance(1);
    expect(h.store.parent(device, "connected")).toMatchObject({
      connectivity: "unknown",
      basis: "parent_unassessable",
      parentTransport: "connected",
    });
    h.advance(1);
    expect(h.media().connectivity).toBe("online");
  });

  it("synthetic qualified vendor negative is the only authoritative offline path", () => {
    const h = harness();
    expect(h.observe({ kind: "vendor_offline", qualified: false, observedAtMs: origin }).connectivity).toBe("unknown");
    expect(h.observe({ kind: "vendor_offline", qualified: true, observedAtMs: origin })).toMatchObject({
      connectivity: "offline",
      basis: "vendor_status",
      evidence: "vendor_verified",
      commandsBlocked: false,
    });
    h.advance(CAMERA_SUSPECT_TTL_MS * 2);
    h.observe({ kind: "hub_report" });
    h.observe({ kind: "hub_offline", correlated: true, code: -109 });
    expect(h.store.status(device)?.connectivity).toBe("offline");
    expect(h.store.diagnostics().timers).toBe(0);
    expect(h.push({ observedAtMs: origin }).connectivity).toBe("offline");
    h.advance(1);
    expect(h.media().connectivity).toBe("online");
  });

  it("rejects malformed clocks and unknown input kinds without mutation", () => {
    const clock = { nowMs: origin, monotonicMs: 10 };
    const state = createCameraHealthState(accountId, device, "mains", "test", clock);
    expect(reduceCameraHealth(state, { kind: "tick" }, { nowMs: NaN, monotonicMs: 10 })).toBe(state);
    expect(reduceCameraHealth(state, { kind: "tick" }, { nowMs: origin, monotonicMs: 9 })).toBe(state);
    expect(reduceCameraHealth(state, { kind: "bogus" } as unknown as CameraHealthInput, clock)).toBe(state);
  });
});

describe("bounded camera health store and command outcomes", () => {
  it("masks contact on a same-millisecond parent loss and accepts same-millisecond reconnect metadata", () => {
    const h = harness();
    h.push();
    expect(h.store.parent(device, "disconnected")).toMatchObject({
      connectivity: "unknown",
      basis: "parent_unassessable",
      parentTransport: "disconnected",
    });
    expect(h.store.parent(device, "connected")).toMatchObject({
      connectivity: "unknown",
      basis: "parent_unassessable",
      parentTransport: "connected",
    });
    expect(h.push().connectivity).toBe("unknown");
    h.advance(1);
    expect(h.push().connectivity).toBe("online");
  });

  it("roster retention releases only removed entries and their timers", () => {
    const h = harness();
    h.push();
    const other = "T8000P0000000001";
    h.store.register(other, "mains");
    h.store.retain([other]);
    expect(h.store.status(device)).toBeUndefined();
    expect(h.store.status(other)?.connectivity).toBe("unknown");
    expect(h.store.diagnostics()).toEqual({ entries: 1, timers: 0, capacity: 4 });
  });

  it("counts outcomes by admission state while retaining actual status and rejection code", () => {
    const h = harness();
    const admission = h.store.status(device)!.connectivity;
    h.push();
    expect(
      h.store.outcome(device, admission, {
        status: "rejected",
        sendAttempted: true,
        effect: "unconfirmed",
        rejectionCode: -109,
      }),
    ).toMatchObject({
      connectivity: "online",
      hubOfflineCount: 0,
      outcomes: { unknown: { rejected: 1 }, online: { rejected: 0 } },
      lastOutcome: { atMs: origin, connectivity: "unknown", status: "rejected", code: -109 },
    });
  });

  it.each([
    ["acknowledged", "acknowledged"],
    ["rejected", "rejected"],
    ["ack_timeout", "timeout"],
    ["connect_timeout", "timeout"],
    ["expired_after_send", "timeout"],
    ["pending_accepted", "other"],
    ["not_sent", "other"],
  ] as const)("records receipt %s as %s without inferring contact", (status, expected) => {
    const h = harness();
    const receipt: CommandReceipt = { status, sendAttempted: true, effect: "unconfirmed" };
    const health = h.store.outcome(device, "unknown", receipt)!;
    expect(health.outcomes.unknown[expected]).toBe(1);
    expect(health.lastOutcome).toMatchObject({ status: expected, code: null });
    expect(health.connectivity).toBe("unknown");
    expect(health.lastContactMs).toBeNull();
    h.store.outcome(device, "unknown", receipt);
    expect(h.store.status(device)?.outcomes.unknown[expected]).toBe(2);
  });

  it("rejects malformed outcome evidence", () => {
    const h = harness();
    const state = createCameraHealthState(accountId, device, "mains", "test", h.clock());
    for (const payload of [{ connectivity: "broken" }, { status: "broken" }, { code: NaN }, { code: 1.5 }]) {
      const input = {
        ...h.evidence({}),
        kind: "outcome",
        connectivity: "unknown",
        status: "other",
        code: null,
        ...payload,
      } as CameraHealthInput;
      expect(reduceCameraHealth(state, input, h.clock())).toBe(state);
    }
  });

  it("bounds entries without eviction, releases capacity and maintains revision ordering on re-registration", () => {
    const h = harness("mains", 1);
    h.push();
    const old = h.store.status(device)!;
    expect(h.store.register("T8000P0000000001", "mains")).toBeUndefined();
    expect(h.store.status(device)).toEqual(old);
    h.store.remove(device);
    expect(h.store.diagnostics()).toEqual({ entries: 0, timers: 0, capacity: 1 });
    const fresh = h.store.register(device, "mains")!;
    expect(fresh.revision).toBeGreaterThan(old.revision);
    expect(fresh.incarnation).toBe(old.incarnation);
    expect(fresh.connectivity).toBe("unknown");
  });

  it("uses random incarnation per store and increasing event revisions for observable changes", () => {
    const h = harness();
    const other = harness();
    expect(h.store.incarnation).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(other.store.incarnation).not.toBe(h.store.incarnation);
    h.push();
    h.observe({ kind: "hub_report" });
    const length = h.events.length;
    h.store.status(device);
    h.observe({ kind: "hub_report" });
    expect(h.events).toHaveLength(length);
    expect(h.events.every((event, i) => i === 0 || event.revision > h.events[i - 1]!.revision)).toBe(true);
    expect(h.events.at(-1)).toEqual({ device, ...h.store.status(device) });
  });

  it("isolates snapshots and event payloads from retained state", () => {
    const h = harness();
    const snapshot = h.push();
    snapshot.outcomes.online.acknowledged = 999;
    h.events.at(-1)!.rssi.value = 99;
    expect(h.store.status(device)?.outcomes.online.acknowledged).toBe(0);
    expect(h.store.status(device)?.rssi.value).toBeNull();
  });

  it("emits expiry without accessor calls using one unreferenced timer", () => {
    vi.useFakeTimers();
    const h = harness();
    h.push();
    expect(h.store.diagnostics().timers).toBe(1);
    h.advance(CAMERA_CONTACT_TTL_MS);
    vi.advanceTimersByTime(CAMERA_CONTACT_TTL_MS);
    expect(h.events.at(-1)).toMatchObject({ connectivity: "unknown", basis: "contact_expired" });
    expect(h.store.diagnostics().timers).toBe(0);
  });

  it("replaces expiry timers and clears all retained work on close", () => {
    vi.useFakeTimers();
    const h = harness();
    h.push();
    h.advance(1);
    h.media();
    expect(vi.getTimerCount()).toBe(1);
    const length = h.events.length;
    h.store.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.store.status(device)).toBeUndefined();
    expect(h.store.register(device, "mains")).toBeUndefined();
    vi.advanceTimersByTime(CAMERA_SUSPECT_TTL_MS);
    expect(h.events).toHaveLength(length);
  });
});
