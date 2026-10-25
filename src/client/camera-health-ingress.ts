import type { CommandReceipt } from "../core/contracts.js";
import type { EufyDevice } from "../core/types.js";
import { cameraPowerEvidence } from "../model/index.js";
import type { PushEvent } from "../transport/push/types.js";
import type { DeviceRegistry } from "./device-registry.js";
import {
  CAMERA_CONTACT_TTL_MS,
  CameraHealthStore,
  type CameraHealth,
  type CameraHealthEvidence,
  type CameraStatusSource,
} from "./camera-health.js";

/** HomeBase status assessment models; only T8425 power loss/rejoin was qualified live. T8426 is untested. */
const HUB_STATUS_MODELS = new Set(["T8425", "T8426"]);

type EvidenceData<T = CameraHealthEvidence> = T extends CameraHealthEvidence
  ? Omit<T, "accountId" | "device" | "receivedAtMs">
  : never;

/** Receipt-only evidence wiring; none of these methods initiates transport work. */
export class CameraHealthIngress {
  readonly store: CameraHealthStore;
  private readonly bindings = new Map<string, { key: string; token: object }>();
  private readonly parents = new Map<string, Partial<Record<"rtc" | "p2p", "connected" | "disconnected">>>();

  constructor(
    private readonly accountId: string,
    private readonly registry: Pick<DeviceRegistry, "list" | "capabilitiesForDevice" | "serialForFrame" | "conflicts">,
    event: (event: CameraHealth & { device: string }) => void,
  ) {
    this.store = new CameraHealthStore({ accountId, event });
  }

  status(sn: string): CameraHealth | undefined {
    const device = this.registry.list().find((item) => item.sn === sn);
    if (device?.deviceClass !== "camera" || this.registry.conflicts().includes(sn)) {
      this.bindings.delete(sn);
      this.store.remove(sn);
      return undefined;
    }
    const power = cameraPowerEvidence(device.model, this.registry.capabilitiesForDevice(sn) ?? new Set());
    const hubStatusQualified =
      power === "mains" &&
      HUB_STATUS_MODELS.has((device.model ?? "").toUpperCase()) &&
      device.stationSn !== undefined &&
      device.stationSn !== sn &&
      this.registry.list().some((parent) => parent.sn === device.stationSn && parent.deviceClass === "homebase");
    const raw = device.raw as Record<string, unknown> | undefined;
    const key = JSON.stringify([
      device.stationSn || sn,
      device.model,
      device.category,
      device.realtime,
      raw?.device_channel ?? null,
      raw?.device_type ?? null,
      hubStatusQualified,
    ]);
    const previous = this.bindings.get(sn);
    if (previous && previous.key !== key) {
      this.store.remove(sn);
      this.bindings.delete(sn);
    }
    const health = this.store.register(sn, power, hubStatusQualified);
    if (health && !this.bindings.has(sn)) {
      this.bindings.set(sn, { key, token: {} });
      if (this.parents.has(device.stationSn || sn))
        return this.store.parent(sn, this.parentState(device.stationSn || sn));
    }
    return health;
  }

  private observe(sn: string, evidence: EvidenceData): void {
    if (!this.status(sn)) return;
    this.store.observe(sn, { ...evidence, accountId: this.accountId, device: sn, receivedAtMs: Date.now() });
  }

  /** Hub status describes the HomeBase's assessment; cloud caches and report receipt never prove child contact. */
  params(sn: string, params: Readonly<Record<number, string>>, source?: CameraStatusSource): void {
    if (source) this.observe(sn, { kind: source });
    if (Object.hasOwn(params, 1142)) {
      const raw = params[1142];
      const value = typeof raw === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()) ? Number(raw) : null;
      this.observe(sn, { kind: "rssi", value: Number.isSafeInteger(value) ? value : null });
    }
    const raw: EvidenceData<Extract<CameraHealthEvidence, { kind: "raw_status" }>> = {
      kind: "raw_status",
    };
    for (const [id, key] of [
      [1131, "p1131"],
      [1182, "p1182"],
    ] as const) {
      if (!Object.hasOwn(params, id)) continue;
      try {
        const value: unknown = JSON.parse(params[id]!);
        if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) raw[key] = value;
      } catch {}
    }
    if (Object.keys(raw).length > 1) this.observe(sn, { ...raw, source });
  }

  /** A connected session keeps the parent usable; recovery still requires fresh child evidence. */
  parent(station: string, transport: "connected" | "disconnected" | "unknown", source: "rtc" | "p2p" = "rtc"): void {
    const devices = this.registry
      .list()
      .filter(
        (device) =>
          device.deviceClass === "camera" && (device.stationSn || device.sn) === station && this.status(device.sn),
      );
    if (!devices.length) return;
    const states = this.parents.get(station) ?? {};
    if (transport === "unknown") delete states[source];
    else states[source] = transport;
    this.parents.set(station, states);
    const aggregate = this.parentState(station);
    for (const device of devices) this.store.parent(device.sn, aggregate);
  }

  private parentState(station: string): "connected" | "disconnected" | "unknown" {
    const states = this.parents.get(station);
    if (states?.rtc === "connected" || states?.p2p === "connected") return "connected";
    return states?.rtc === "disconnected" || states?.p2p === "disconnected" ? "disconnected" : "unknown";
  }

  /** Newly decoded source frames, before any consumer cache or prebuffer, are device-specific contact. */
  media(sn: string): void {
    this.observe(sn, { kind: "media", qualified: true, live: true, cached: false, prebuffered: false });
  }

  /** Source ownership is bound before media acquisition, not inferred again from a later serial match. */
  live(sn: string): (() => void) | undefined {
    if (!this.status(sn)) return undefined;
    const token = this.bindings.get(sn)?.token;
    return () => {
      if (token !== undefined && this.bindings.get(sn)?.token === token) this.store.media(sn);
    };
  }

  private current(sn: string, token: object | undefined): boolean {
    return this.status(sn) !== undefined && token !== undefined && this.bindings.get(sn)?.token === token;
  }

  /** Only detection events with explicit, consistent child attribution and producer time qualify. */
  push(
    sn: string | undefined,
    station: string | undefined,
    payload: Record<string, unknown>,
    eventType: number | undefined,
    envelopeTime?: unknown,
    envelopeDeviceSn?: unknown,
  ): void {
    if (!sn || !Number.isSafeInteger(eventType) || eventType! < 3101 || eventType! > 3112) return;
    const device = this.registry.list().find((item) => item.sn === sn);
    if (!device || device.deviceClass !== "camera") return;
    const owner = device.stationSn || device.sn;
    if (station !== undefined && station !== owner) return;
    const serials = [envelopeDeviceSn, payload.device_sn, payload.deviceSn].filter((value) => value !== undefined);
    if (!serials.length || serials.some((value) => value !== sn)) return;
    if ([payload.station_sn, payload.stationSn, payload.s].some((value) => value !== undefined && value !== owner))
      return;
    const channels = [payload.channel, payload.device_channel, payload.c].filter((value) => value !== undefined);
    if (
      channels.some(
        (value) => !Number.isSafeInteger(value) || this.registry.serialForFrame(owner, value as number) !== sn,
      )
    )
      return;
    const times = [envelopeTime, payload.event_time, payload.create_time, payload.trigger_time].filter(
      (value) => value !== undefined,
    );
    if (!times.length) return;
    const stamps = times.map((value) => {
      if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return NaN;
      const numeric = Number(value);
      return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    });
    const now = Date.now();
    if (
      stamps.some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value > now || now - value >= CAMERA_CONTACT_TTL_MS,
      )
    )
      return;
    this.observe(sn, { kind: "push", qualified: true, childOrigin: true, observedAtMs: Math.min(...stamps) });
  }

  cloudPush(event: PushEvent): void {
    const envelope = event.raw?.payload;
    if (envelope?.device_sn !== undefined && envelope.device_sn !== event.deviceSn) return;
    if (envelope?.station_sn !== undefined && envelope.station_sn !== event.stationSn) return;
    this.push(
      event.deviceSn,
      event.stationSn,
      event.payload,
      event.eventType,
      envelope?.event_time,
      envelope?.device_sn,
    );
  }

  /** Each transport attempt captures its own state immediately before sending and finalizes once. */
  command(sn: string) {
    let admission = this.status(sn)?.connectivity;
    if (!admission) return undefined;
    const token = this.bindings.get(sn)?.token;
    let finished = false;
    let responded = false;
    return {
      sent: () => {
        if (this.current(sn, token)) admission = this.status(sn)?.connectivity ?? admission;
      },
      response: (receipt: CommandReceipt) => {
        if (responded || !this.current(sn, token)) return;
        responded = true;
        if (receipt.sendAttempted && receipt.status === "rejected" && receipt.rejectionCode === -109)
          this.observe(sn, { kind: "hub_offline", correlated: true, code: -109 });
      },
      finish: (receipt: CommandReceipt) => {
        if (finished) return;
        finished = true;
        if (!this.current(sn, token)) return;
        this.store.outcome(sn, admission!, receipt);
      },
    };
  }

  /** Complete roster replacement retires removed camera state without retaining identifiers. */
  roster(devices: readonly EufyDevice[]): void {
    const conflicts = new Set(this.registry.conflicts());
    const cameras = devices
      .filter((device) => device.deviceClass === "camera")
      .filter((device) => !conflicts.has(device.sn))
      .map((device) => device.sn);
    const present = new Set(cameras);
    const stations = new Set(
      devices.filter((device) => present.has(device.sn)).map((device) => device.stationSn || device.sn),
    );
    for (const station of this.parents.keys()) if (!stations.has(station)) this.parents.delete(station);
    for (const sn of this.bindings.keys()) if (!present.has(sn)) this.bindings.delete(sn);
    this.store.retain(cameras);
    for (const sn of cameras) if (this.bindings.has(sn)) this.status(sn);
  }
}
