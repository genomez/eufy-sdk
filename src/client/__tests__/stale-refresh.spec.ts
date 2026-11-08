import { beforeEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { DeviceRegistry } from "../device-registry.js";
import type { Device } from "../../model/device.js";

const CAMERA = "T8425P0000000000";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** Real registry snapshots and model announcements; only external requests and command delivery are faked. */
async function fixture(initial: boolean, guard = false) {
  const model = guard ? "T9000" : "T8425";
  const deviceType = guard ? 27 : 47;
  const param = guard ? 1224 : 1400;
  const property = guard ? "armingMode" : "light";
  const raw = (value: boolean) => (guard ? (value ? "0" : "1") : value ? "1" : "0");
  const cloud = { params: { [param]: raw(initial), 1142: "-70" } as Record<number, string> };
  const post = vi.fn(async (_service: string, path: string) =>
    path.endsWith("get_house_list")
      ? { house_infos: [] }
      : {
          devices: [
            {
              device_sn: CAMERA,
              device_model: model,
              device_type: deviceType,
              station_sn: CAMERA,
              category: "eufy_security",
              params: Object.entries(cloud.params).map(([id, value]) => ({
                param_type: Number(id),
                param_value: value,
              })),
            },
          ],
        },
  );
  const eufy = new EufyMega({ email: "test@example.com", password: "synthetic", cacheTtlMs: 1000 });
  const client = eufy as any;
  client.registry = new DeviceRegistry({
    onError: (error) => {
      throw error;
    },
    mega: {
      post,
      getDeviceParamList: vi.fn(async () => ({
        params: Object.entries(cloud.params).map(([id, value]) => ({
          param_type: Number(id),
          param_value: value,
        })),
      })),
    } as never,
  });
  vi.spyOn(client, "commandContext").mockResolvedValue({
    model,
    category: "eufy_security",
    deviceType,
    codec: guard ? "station" : "camera",
    channel: 0,
    paramIds: new Set([param, 1142]),
  });
  const dispatch = vi.fn(async () => {});
  vi.spyOn(client, "commandSinkFor").mockReturnValue({ dispatch });
  vi.spyOn(client, "mediaProviderFor").mockReturnValue(undefined);
  vi.spyOn(client, "ff09SettingsReaderFor").mockReturnValue(undefined);
  vi.spyOn(client, "awaitFirstRealtimeState").mockResolvedValue(undefined);
  await client.registry.pollChanges();
  const dev = await eufy.getDevice(CAMERA);
  const values: unknown[] = [dev.getProperty(property)?.value];
  const errors: unknown[] = [];
  eufy.on("error", (error) => errors.push(error));
  eufy.on("propertyChanged", (event) => {
    if (event.property === property) values.push(event.value);
  });
  const report = (value: boolean) => client.applyRealtimeState(CAMERA, { [param]: raw(value) });
  return { eufy, client, cloud, dev, values, errors, report, dispatch };
}

/** Hold a fully captured registry result before its awaiting caller can adopt it. */
function holdResult(owner: any, method: "record" | "pollChanges") {
  const captured = deferred<void>();
  const release = deferred<void>();
  const original = owner[method].bind(owner);
  vi.spyOn(owner, method).mockImplementationOnce(async (...args: unknown[]) => {
    const snapshot = await original(...args);
    captured.resolve();
    await release.promise;
    return snapshot;
  });
  return { captured: captured.promise, release: () => release.resolve() };
}

/** Trigger and then drain the model's actual background freshness callback. */
function staleRead(dev: Device) {
  for (const value of (dev as any).state.values()) value.ts -= 10_000;
  dev.getProperty("light");
}

async function drainRefresh(dev: Device) {
  await vi.waitFor(() => expect((dev as any).refreshInFlight).toBe(false));
}

describe("snapshots captured before newer light reports", () => {
  beforeEach(() => vi.restoreAllMocks());

  for (const initial of [false, true]) {
    for (const overlay of [false, true]) {
      it(`freshness preserves ${!initial} after an older ${initial} snapshot (overlay=${overlay})`, async () => {
        const f = await fixture(initial);
        if (overlay) f.report(initial);
        const held = holdResult(f.client.registry, "record");
        staleRead(f.dev);
        await held.captured;
        await f.eufy.setProperty(CAMERA, "light", !initial);
        expect(f.dispatch).toHaveBeenCalledOnce();
        f.report(!initial);
        held.release();
        await drainRefresh(f.dev);

        expect.soft(f.values).toEqual([initial, !initial]);
        expect(f.dev.getProperty("light")?.value).toBe(!initial);
        expect(f.errors).toEqual([]);
      });
    }

    it(`poll preserves a newer ${!initial} report and its overlay`, async () => {
      const f = await fixture(initial);
      f.cloud.params[1400] = initial ? "0" : "1";
      await f.client.registry.pollChanges();
      f.report(initial);
      f.cloud.params[1400] = initial ? "1" : "0";
      const held = holdResult(f.client.registry, "pollChanges");
      const poll = f.client.pollOnce();
      await held.captured;
      f.report(!initial);
      held.release();
      await poll;

      expect.soft(f.values).toEqual([initial, !initial]);
      expect.soft(f.dev.getProperty("light")?.value).toBe(!initial);
      expect(f.client.registry.knownParam(CAMERA, 1400)).toBe(initial ? "0" : "1");
      staleRead(f.dev);
      await drainRefresh(f.dev);
      expect(f.values).toEqual([initial, !initial]);
      expect(f.errors).toEqual([]);
    });
  }

  it("freshness accepts unrelated cloud changes while preserving a newer light report", async () => {
    const f = await fixture(false);
    f.cloud.params[1142] = "-55";
    const held = holdResult(f.client.registry, "record");
    staleRead(f.dev);
    await held.captured;
    f.report(true);
    held.release();
    await drainRefresh(f.dev);
    expect(f.dev.getProperty("light")?.value).toBe(true);
    expect(f.dev.getProperty("wifiRssi")?.value).toBe(-55);
    expect(f.values).toEqual([false, true]);
  });

  it("a later poll can still supersede an earlier realtime light value", async () => {
    const f = await fixture(false);
    f.report(true);
    f.cloud.params[1400] = "1";
    await f.client.pollOnce();
    f.cloud.params[1400] = "0";
    await f.client.pollOnce();
    staleRead(f.dev);
    await drainRefresh(f.dev);
    expect(f.values).toEqual([false, true, false]);
    expect(f.dev.getProperty("light")?.value).toBe(false);
    expect(f.errors).toEqual([]);
  });

  it("a same-value report supersedes an older poll without blocking unrelated parameters", async () => {
    const f = await fixture(false);
    f.cloud.params[1400] = "1";
    f.cloud.params[1142] = "-55";
    const held = holdResult(f.client.registry, "pollChanges");
    const poll = f.client.pollOnce();
    await held.captured;
    f.report(false);
    held.release();
    await poll;
    expect(f.values).toEqual([false]);
    expect(f.dev.getProperty("light")?.value).toBe(false);
    expect(f.dev.getProperty("wifiRssi")?.value).toBe(-55);
    expect(f.errors).toEqual([]);
  });

  for (const path of ["record", "pollChanges"] as const) {
    it(`preserves a cloud-confirmed write completed after an older ${path} snapshot`, async () => {
      const f = await fixture(false);
      if (path === "pollChanges") {
        f.cloud.params[1400] = "1";
        await f.client.registry.pollChanges();
        f.cloud.params[1400] = "0";
      }
      const held = holdResult(f.client.registry, path);
      const poll = path === "pollChanges" ? f.client.pollOnce() : undefined;
      if (!poll) staleRead(f.dev);
      await held.captured;
      f.cloud.params[1400] = "1";
      await f.client.registry.getDevices();
      expect(
        await f.client.refreshEventState(CAMERA, {
          param: 1400,
          property: "light",
          expected: 1,
          observed: true,
          timeoutMs: 100,
        }),
      ).toBe(true);
      expect(f.dev.getProperty("light")?.value).toBe(true);
      held.release();
      if (poll) await poll;
      else await drainRefresh(f.dev);
      expect(f.dev.getProperty("light")?.value).toBe(true);
      expect(f.values).toEqual([false, true]);
      expect(f.errors).toEqual([]);
    });
  }

  it("discards a freshness snapshot superseded by a completed poll", async () => {
    const f = await fixture(false);
    const held = holdResult(f.client.registry, "record");
    staleRead(f.dev);
    await held.captured;
    f.cloud.params[1400] = "1";
    await f.client.pollOnce();
    held.release();
    await drainRefresh(f.dev);
    expect(f.dev.getProperty("light")?.value).toBe(true);
    expect(f.values).toEqual([false, true]);
  });
});

describe("freshness supersession recovery", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("retries a corrective off record after an unchanged poll", async () => {
    const f = await fixture(true);
    // The per-device endpoint is ahead of the unchanged bulk-list endpoint.
    vi.spyOn(f.client.registry.mega, "getDeviceParamList").mockResolvedValue({
      params: [{ param_type: 1400, param_value: "0" }],
    });
    const held = holdResult(f.client.registry, "record");
    staleRead(f.dev);
    await held.captured;
    await f.client.pollOnce();
    held.release();
    await drainRefresh(f.dev);
    expect(f.dev.getProperty("light")?.value).toBe(false);
    expect(f.values).toEqual([true, false]);
    expect(f.errors).toEqual([]);
  });

  it("retries from the registry rather than adopting a superseded stale on", async () => {
    const f = await fixture(false);
    f.cloud.params[1400] = "1";
    const held = holdResult(f.client.registry, "record");
    staleRead(f.dev);
    await held.captured;
    f.cloud.params[1400] = "0";
    await f.client.pollOnce();
    held.release();
    await drainRefresh(f.dev);
    expect(f.dev.getProperty("light")?.value).toBe(false);
    expect(f.values).toEqual([false]);
    expect(f.errors).toEqual([]);
  });

  it("does not bypass a newer same-value report to apply corrective cloud off", async () => {
    const f = await fixture(true);
    f.cloud.params[1400] = "0";
    const held = holdResult(f.client.registry, "record");
    staleRead(f.dev);
    await held.captured;
    f.report(true);
    held.release();
    await drainRefresh(f.dev);
    expect(f.dev.getProperty("light")?.value).toBe(true);
    expect(f.values).toEqual([true]);
    expect(f.errors).toEqual([]);
  });

  it("still accepts an eligible stale cloud on after an ACK with no new report", async () => {
    const f = await fixture(false);
    await f.eufy.setProperty(CAMERA, "light", false);
    f.cloud.params[1400] = "1";
    staleRead(f.dev);
    await drainRefresh(f.dev);
    expect(f.values).toEqual([false, true]);
    expect(f.dev.getProperty("light")?.value).toBe(true);
    expect(f.errors).toEqual([]);
  });

  it("does not retry a lifecycle-invalidated freshness result", async () => {
    const f = await fixture(true);
    f.cloud.params[1400] = "0";
    const held = holdResult(f.client.registry, "record");
    staleRead(f.dev);
    await held.captured;
    const calls = f.client.registry.record.mock.calls.length;
    f.client.realtimeEpoch++;
    held.release();
    await drainRefresh(f.dev);
    expect(f.client.registry.record.mock.calls.length).toBe(calls);
    expect(f.dev.getProperty("light")?.value).toBe(true);
  });

  for (const initial of [false, true]) {
    it(`protects a newer ${initial} report during the retry`, async () => {
      const f = await fixture(initial);
      vi.spyOn(f.client.registry.mega, "getDeviceParamList").mockResolvedValue({
        params: [{ param_type: 1400, param_value: initial ? "0" : "1" }],
      });
      const first = deferred<void>();
      const firstRelease = deferred<void>();
      const second = deferred<void>();
      const secondRelease = deferred<void>();
      const original = f.client.registry.record.bind(f.client.registry);
      let count = 0;
      vi.spyOn(f.client.registry, "record").mockImplementation(async (...args: unknown[]) => {
        const snapshot = await original(...args);
        const attempt = ++count;
        if (attempt === 1) {
          first.resolve();
          await firstRelease.promise;
        } else if (attempt === 2) {
          second.resolve();
          await secondRelease.promise;
        }
        return snapshot;
      });
      staleRead(f.dev);
      await first.promise;
      await f.client.pollOnce();
      firstRelease.resolve();
      await second.promise;
      f.report(initial);
      secondRelease.resolve();
      await drainRefresh(f.dev);
      expect(f.dev.getProperty("light")?.value).toBe(initial);
      expect(f.values).toEqual([initial]);
      expect(f.errors).toEqual([]);
    });
  }

  it("limits retries when every record is crossed by another poll", async () => {
    const f = await fixture(true);
    f.cloud.params[1400] = "0";
    await f.client.registry.pollChanges();
    const original = f.client.registry.record.bind(f.client.registry);
    const record = vi.spyOn(f.client.registry, "record").mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      await f.client.pollOnce();
      return result;
    });
    staleRead(f.dev);
    await drainRefresh(f.dev);
    expect(record).toHaveBeenCalledTimes(2);
    expect(f.dev.getProperty("light")?.value).toBe(true);
    expect(f.values).toEqual([true]);
  });
});

describe("model construction revision ownership", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rejects a captured OFF when a newer report no longer has an available registry value", async () => {
    const f = await fixture(false);
    const held = holdResult(f.client.registry, "record");
    const pending = f.eufy.getDevice(CAMERA);
    const rejection = expect(pending).rejects.toThrow("Device construction superseded by unavailable parameter");
    await held.captured;
    f.report(true);
    vi.spyOn(f.client.registry, "knownParam").mockReturnValue(undefined);
    held.release();
    await rejection;
    expect(f.client.liveDevices.get(CAMERA).deref()).toBe(f.dev);
    expect(f.dev.getProperty("light")?.value).toBe(true);
  });

  it("keeps a newer unrecognized light value unknown across a captured OFF", async () => {
    const f = await fixture(false);
    const held = holdResult(f.client.registry, "record");
    const pending = f.eufy.getDevice(CAMERA);
    await held.captured;
    f.client.applyRealtimeState(CAMERA, { 1400: "unknown-fixture-value" });
    held.release();
    const dev = await pending;
    expect(dev.getProperty("light")?.value).toBe("unknown-fixture-value");
    expect(dev.light!()!.isOn).toBeUndefined();
  });

  for (const guard of [false, true]) {
    const property = guard ? "armingMode" : "light";
    const confirmed = guard ? 0 : true;
    for (const stage of ["record", "context"] as const) {
      it(`preserves converged ${property} without a live model across a held ${stage}`, async () => {
        const f = await fixture(false, guard);
        const param = guard ? 1224 : 1400;
        const raw = guard ? "0" : "1";
        f.client.liveDevices.delete(CAMERA);
        const held = stage === "record" ? holdResult(f.client.registry, "record") : holdContext(f.client);
        const pending = f.eufy.getDevice(CAMERA);
        await held.captured;
        f.cloud.params[param] = raw;
        f.client.registry.listFetchedAtMs = 0;
        vi.spyOn(f.client, "rtcDevice").mockReturnValue(false);
        expect(
          await f.client.refreshEventState(CAMERA, {
            event: "propertyChanged",
            property,
            param,
            expected: Number(raw),
            observed: confirmed,
            timeoutMs: 1000,
          }),
        ).toBe(true);
        expect(f.client.registry.knownParam(CAMERA, param)).toBe(raw);
        held.release();
        const dev = await pending;
        expect(dev.getProperty(property)?.value).toBe(confirmed);
        expect(f.client.liveDevices.get(CAMERA).deref()).toBe(dev);
        expect(f.client.realtimeParamIds.get(dev).get(param)).toBeGreaterThan(0);
        expect((await f.eufy.getDevice(CAMERA)).getProperty(property)?.value).toBe(confirmed);
        if (!guard) expect(dev.light!()!.isOn).toBe(true);
      });

      it(`preserves newer ${property} across a held ${stage}`, async () => {
        const f = await fixture(false, guard);
        const held = stage === "record" ? holdResult(f.client.registry, "record") : holdContext(f.client);
        const pending = f.eufy.getDevice(CAMERA);
        await held.captured;
        f.report(true);
        held.release();
        const dev = await pending;
        expect(dev.getProperty(property)?.value).toBe(confirmed);
        expect(f.client.liveDevices.get(CAMERA).deref()).toBe(dev);
        expect(f.values).toEqual([guard ? 1 : false, confirmed]);
      });
    }

    it(`records a same-value newer ${property} report without a live model`, async () => {
      const f = await fixture(true, guard);
      f.client.liveDevices.delete(CAMERA);
      f.cloud.params[guard ? 1224 : 1400] = guard ? "1" : "0";
      const held = holdResult(f.client.registry, "record");
      const pending = f.eufy.getDevice(CAMERA);
      await held.captured;
      f.report(true);
      held.release();
      const dev = await pending;
      expect(dev.getProperty(property)?.value).toBe(confirmed);
      expect(f.values).toEqual([confirmed]);
    });

    it(`preserves a same-value ${property} report even when no valued event is emitted`, async () => {
      const f = await fixture(true, guard);
      f.cloud.params[guard ? 1224 : 1400] = guard ? "1" : "0";
      const held = holdResult(f.client.registry, "record");
      const pending = f.eufy.getDevice(CAMERA);
      await held.captured;
      f.report(true);
      held.release();
      const dev = await pending;
      expect(dev.getProperty(property)?.value).toBe(confirmed);
      expect(f.values).toEqual([confirmed]);
    });

    it(`reconciles overlapping ${property} constructions from the registry owner`, async () => {
      const f = await fixture(false, guard);
      const held = holdResult(f.client.registry, "record");
      const earlier = f.eufy.getDevice(CAMERA);
      await held.captured;
      const later = await f.eufy.getDevice(CAMERA);
      f.report(true);
      held.release();
      const dev = await earlier;
      expect(later.getProperty(property)?.value).toBe(confirmed);
      expect(dev.getProperty(property)?.value).toBe(confirmed);
      expect(f.client.liveDevices.get(CAMERA).deref()).toBe(dev);
      expect(f.client.realtimeParamIds.get(dev).get(guard ? 1224 : 1400)).toBeGreaterThan(0);
    });
  }

  for (const change of ["account", "runtime"] as const) {
    for (const stage of ["record", "context"] as const) {
      it(`rejects ${change} replacement during ${stage} without installing the captured model`, async () => {
        const f = await fixture(false);
        const held = stage === "record" ? holdResult(f.client.registry, "record") : holdContext(f.client);
        const pending = f.eufy.getDevice(CAMERA);
        const rejection = expect(pending).rejects.toThrow("Device construction superseded");
        await held.captured;
        if (change === "runtime") f.client.realtimeEpoch++;
        else vi.spyOn(f.client.mega, "auth", "get").mockReturnValue({ userId: "replacement-fixture" });
        held.release();
        await rejection;
        expect(f.client.liveDevices.get(CAMERA).deref()).toBe(f.dev);
      });
    }
  }
});

/** Hold context binding to exercise reports and scope changes after the record await. */
function holdContext(client: any) {
  const captured = deferred<void>();
  const release = deferred<void>();
  const original = client.commandContext.bind(client);
  vi.spyOn(client, "commandContext").mockImplementationOnce(async (...args: unknown[]) => {
    const context = await original(...args);
    captured.resolve();
    await release.promise;
    return context;
  });
  return { captured: captured.promise, release: () => release.resolve() };
}
