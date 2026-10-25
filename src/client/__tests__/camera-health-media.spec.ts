import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../core/types.js";
import type { Capability } from "../../model/index.js";
import { CameraHealthIngress } from "../camera-health-ingress.js";
import { CAMERA_CONTACT_TTL_MS, CameraHealthStore, type CameraHealthEvent } from "../camera-health.js";

const device = "T8425P0000000000";
const origin = 1_700_000_000_000;
const stores: CameraHealthStore[] = [];

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(origin);
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const events: CameraHealthEvent[] = [];
  const registry = {
    list: vi.fn(() => [{ sn: device, model: "T8425", deviceClass: "camera" }] as EufyDevice[]),
    capabilitiesForDevice: () => new Set<Capability>(),
    conflicts: () => [] as string[],
    serialForFrame: () => device,
  };
  const ingress = new CameraHealthIngress("synthetic-account", registry, (event) => events.push(event));
  stores.push(ingress.store);
  const media = ingress.live(device)!;
  const advance = (ms: number) => {
    monotonic += ms;
    vi.advanceTimersByTime(ms);
  };
  return { ingress, registry, media, events, advance };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bounded source media contact publication", () => {
  it("bounds ten minutes at 15 frames per second and expires five minutes after the final frame", () => {
    const f = fixture();
    f.media();
    let elapsed = 0;
    for (let frame = 1; frame < 9_000; frame++) {
      const next = Math.floor((frame * 1_000) / 15);
      f.advance(next - elapsed);
      elapsed = next;
      f.media();
    }
    expect(f.events).toHaveLength(11);
    expect(f.events.at(-1)?.connectivity).toBe("online");
    expect(origin + elapsed - f.events.at(-1)!.lastContactMs!).toBeLessThan(60_000);
    f.advance(CAMERA_CONTACT_TTL_MS - 1);
    expect(f.ingress.status(device)?.connectivity).toBe("online");
    f.advance(1);
    expect(f.events.at(-1)).toMatchObject({
      connectivity: "unknown",
      basis: "contact_expired",
      lastContactMs: origin + elapsed,
    });
    expect(f.ingress.store.diagnostics().timers).toBe(0);
  });

  it("does no registry scan, clone, serialization or timer allocation for an unpublished frame", () => {
    const f = fixture();
    f.media();
    const clone = vi.spyOn(globalThis, "structuredClone");
    const stringify = vi.spyOn(JSON, "stringify");
    const timer = vi.spyOn(globalThis, "setTimeout");
    f.registry.list.mockClear();
    f.advance(1);
    f.media();
    expect(f.registry.list).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    expect(f.events).toHaveLength(2);
  });

  it("publishes state and diagnostic changes immediately inside the contact window", () => {
    const f = fixture();
    f.media();
    f.advance(1);
    f.media();
    const count = f.events.length;
    const evidence = { accountId: "synthetic-account", device, receivedAtMs: Date.now() };
    f.ingress.store.observe(device, { ...evidence, kind: "hub_offline", correlated: true, code: -109 });
    expect(f.events).toHaveLength(count + 1);
    expect(f.events.at(-1)).toMatchObject({ connectivity: "suspect", lastContactMs: origin + 1 });
    f.advance(1);
    f.media();
    expect(f.events.at(-1)).toMatchObject({ connectivity: "online", basis: "media", lastContactMs: origin + 2 });
    for (const change of [
      { kind: "hub_report" },
      { kind: "cloud_params" },
      { kind: "rssi", value: -42 },
      { kind: "rssi", value: -100 },
      { kind: "raw_status", p1131: true },
    ] as const) {
      const previous = f.events.length;
      f.ingress.store.observe(device, { ...evidence, ...change, receivedAtMs: Date.now() });
      expect(f.events).toHaveLength(previous + 1);
    }
    const previous = f.events.length;
    f.ingress.store.outcome(device, "online", { status: "acknowledged", sendAttempted: true, effect: "unconfirmed" });
    expect(f.events).toHaveLength(previous + 1);
    expect(f.events.at(-1)?.lastOutcome?.status).toBe("acknowledged");
    f.ingress.store.parent(device, "disconnected");
    expect(f.events.at(-1)?.basis).toBe("parent_unassessable");
  });

  it("keeps exact reducer contact within the window for expiry and later source publication", () => {
    const f = fixture();
    f.ingress.media(device);
    f.advance(30_000);
    f.ingress.media(device);
    expect(f.events.at(-1)?.lastContactMs).toBe(origin);
    f.advance(CAMERA_CONTACT_TTL_MS - 1);
    expect(f.ingress.status(device)?.connectivity).toBe("online");
    f.advance(1);
    expect(f.events.at(-1)).toMatchObject({ basis: "contact_expired", lastContactMs: origin + 30_000 });
  });
});
