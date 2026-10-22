/** Modified for genomez S1 experimental source preview, 2026-10-14. */
/**
 * The single, concrete {@link Device} class.
 *
 * There are **no subclasses**. A device's behaviour is entirely determined by its resolved
 * `{ codec, capabilities, properties }` (see `resolveDevice`). Code asks
 * `device.has("light")` / `device.getProperty("battery")` — never `instanceof FloodlightCamera`.
 *
 * Live state is held as a flat map of `PropertyValue`, updated by feeding raw param maps
 * (from the cloud record or P2P notifications) into {@link Device.applyParams}. Params the model
 * doesn't recognise are **not dropped** — they are kept as `unknown_<paramType>` passthrough, so
 * coverage can grow later without losing data today (the graceful-unknown rule, applied to params).
 *
 * @module model/device
 */

import type {
  Capability,
  CachedDeviceEvidence,
  CachedEvidenceCardinality,
  CachedEvidenceEntry,
  CachedEvidenceProjection,
  CachedParameterShapeEvidence,
  CachedShapeRefusal,
  CachedShapeSlot,
  CachedShapeValueKind,
  CloudRecord,
  CommandContext,
  ParamEncoding,
  ParamValue,
  PropertyChange,
  PropertyValueType,
  PropertySpec,
  PropertyValue,
  ResolvedDevice,
} from "./types.js";
import { types as nodeTypes } from "node:util";
import type { CommandSink, MediaProvider, Ff09SettingsReader, RawDpCodec } from "../core/contracts.js";
import { noopLogger, type Logger } from "../core/logger.js";
import { structuralEqual } from "../core/util.js";
import { resolveDevice } from "./registry.js";
import {
  buildActions,
  scalarPropertySpec,
  scalarPropertyValue,
  accessorNamesFor,
  describeCapabilities,
  claimedParams,
  mergeProperties,
  STATION_OWNED_CAPABILITIES,
  type DeviceActionMap,
  type CapabilityAccessors,
  type DeviceManifest,
} from "./capabilities/index.js";
import type { MemberDeps } from "./capabilities/members.js";
import type { AvailabilityContext } from "./capabilities/types.js";
import { paramDef, namespaceForCodec, type ParamNamespace } from "./param-namespace.js";
import { SECURITY_PARAMS } from "./param-dictionary.js";
import { CAMERA, CAMERA_MEMBERS } from "./capabilities/camera.js";

/**
 * Decode an encoded wire value (base64-wrapped JSON or a JSON string) to its structured form —
 * e.g. motion-detection zones, privacy zones, guard-mode configs. Falls back to the raw string if
 * decoding fails, so a malformed value never throws.
 */
function decodeEncoded(raw: string | number | boolean, encoding: ParamEncoding): ParamValue {
  const s = String(raw);
  try {
    if (encoding === "base64+json") {
      return JSON.parse(Buffer.from(s, "base64").toString("utf8")) as ParamValue;
    }
    return JSON.parse(s) as ParamValue; // "json"
  } catch {
    return s;
  }
}

/** Prefix used for params that have no `PropertySpec` mapping yet. */
export const UNKNOWN_PARAM_PREFIX = "unknown_";

/** A raw param map as delivered by the cloud / P2P: param_type → raw value. */
export type RawParams = Record<number | string, string | number | boolean>;

/** A supplied model record may carry a separately sourced realtime parameter overlay. */
type ReadRecord = CloudRecord & { dpParams?: RawParams };

/**
 * Coerce a raw wire value to the declared `PropertySpec.type`. Wire values arrive as strings (cloud)
 * or numbers (P2P); this normalises them. A `number`/`enum` whose raw value is not numeric — a
 * HomeBase sometimes returns a raw string / JSON blob where a scalar is expected — is kept as the raw
 * string (never lie-cast to `NaN`) and logged at `warn`: the typed getters (`readNum`) surface a
 * non-number as `undefined`, so the log is the only signal of the mismatch. `logger` defaults silent.
 */
function coerceByType(
  type: PropertyValueType,
  raw: string | number | boolean,
  name?: string,
  logger: Logger = noopLogger,
): boolean | number | string {
  switch (type) {
    case "bool":
      return raw === true || raw === 1 || raw === "1" || raw === "true";
    case "number":
    case "enum": {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
      logger.warn(
        `[device] property "${name ?? "?"}" declared "${type}" but wire value is not numeric — keeping raw`,
        raw,
      );
      return String(raw);
    }
    case "string":
    default:
      return String(raw);
  }
}

function coerce(
  spec: PropertySpec,
  raw: string | number | boolean,
  invert = false,
  logger: Logger = noopLogger,
): boolean | number | string {
  // A custom decode (e.g. a bitfield the app reinterprets) fully owns the value — no type-coerce/invert.
  if (spec.decode) return spec.decode(raw);
  // A structured payload is stored verbatim and read by the capability's getter, so its declared type
  // describes the ANSWER and not the wire. Coercion still runs — a base64 string is not a number, so it
  // passes through unchanged — but it is not a mistake worth logging. See `PropertySpec.raw`.
  const v = coerceByType(spec.type, raw, spec.name, spec.raw ? noopLogger : logger);
  // A `bool` param that is a disable flag reads inverted ("0"/false ⇒ TRUE). `invert` comes from
  // the spec (its own paramType) or the matched read-alias — see specByParam construction.
  return spec.type === "bool" && invert ? !v : v;
}

/**
 * Whether two property manifests have the same meaning, including contextual aliases and polarity.
 */
function sameManifest(a: readonly PropertySpec[], b: readonly PropertySpec[]): boolean {
  if (a.length !== b.length) return false;
  const byName = new Map(b.map((p) => [p.name, p]));
  return a.every((p) => structuralEqual(p, byName.get(p.name)));
}

/** Structural evidence deliberately excludes stored text, object fields and timestamps. */
function cachedEntryKind(value: unknown): Omit<CachedEvidenceEntry, "binding"> {
  if (typeof value === "number")
    return Number.isFinite(value) ? { kind: "finite-number", numericValue: value } : { kind: "nonfinite-number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (typeof value === "string") {
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ? Number(value) : NaN;
    return Number.isFinite(number) ? { kind: "numeric-string", numericValue: number } : { kind: "string" };
  }
  if (value === null) return { kind: "null" };
  return { kind: Array.isArray(value) ? "array" : "object" };
}

/** Multiplicity is a fact, never a selection of a newest-looking entry. */
function cachedCardinality(count: number): CachedEvidenceCardinality {
  return count === 0 ? "none" : count === 1 ? "one" : "multiple";
}

/** A fixed refusal, never a retained value or an exception raised by inspected data. */
class ShapeRefusal extends Error {
  constructor(readonly reason: CachedShapeRefusal) {
    super(reason);
  }
}

/** Proxy recognition precedes every object operation, including revoked proxies. */
function shapeRecord(value: unknown): asserts value is Record<string, unknown> {
  if (nodeTypes.isProxy(value)) throw new ShapeRefusal("proxy");
  if (typeof value !== "object" || value === null) throw new ShapeRefusal("unsupported-container");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new ShapeRefusal("nonplain-prototype");
}

/** Only fixed primitive classes or shallow, proxy-guarded container classes are returned. */
function shapeKind(value: unknown): CachedShapeValueKind {
  if (nodeTypes.isProxy(value)) throw new ShapeRefusal("proxy");
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isFinite(value) ? "finite-number" : "nonfinite-number";
  if (typeof value === "string") {
    const numeric =
      value.length <= 128 &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) &&
      Number.isFinite(Number(value));
    return numeric ? "numeric-string" : "string";
  }
  if (typeof value !== "object") return "unsupported";
  if (Array.isArray(value)) return "array";
  shapeRecord(value);
  return "record";
}

/** Fixed-slot inspection never evaluates an accessor or traverses an arbitrary prototype chain. */
function shapeSlot(record: Record<string, unknown>, key: string): { slot: CachedShapeSlot; value?: unknown } {
  shapeRecord(record);
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor) return "value" in descriptor ? { slot: "own-data", value: descriptor.value } : { slot: "accessor" };
  if (Object.getPrototypeOf(record) === Object.prototype && Object.getOwnPropertyDescriptor(Object.prototype, key))
    return { slot: "inherited" };
  return { slot: "missing" };
}

/** Retained holder fields must be present own data, including an explicitly undefined payload. */
function shapeHolderField(holder: Record<string, unknown>, key: string): unknown {
  const field = shapeSlot(holder, key);
  if (field.slot === "missing") throw new ShapeRefusal("holder-missing-field");
  if (field.slot === "inherited") throw new ShapeRefusal("holder-inherited-field");
  if (field.slot === "accessor") throw new ShapeRefusal("holder-accessor-field");
  return field.value;
}

/** Own fields in trusted binding metadata are checked without evaluating callbacks. */
function shapeMetadataField(record: unknown, key: string): unknown {
  shapeRecord(record);
  const field = shapeSlot(record, key);
  if (field.slot !== "own-data" && field.slot !== "missing") throw new ShapeRefusal("projection-binding");
  return field.value;
}

/** The retained member's function identity binds the inspection to the unchanged decoder. */
const SHAPE_RECORDING_DECODER = CAMERA_MEMBERS.recordingQuality.decode;

/** Canonical read metadata is captured from its retained declaration without invoking its callbacks. */
const SHAPE_RECORDING_METADATA = {
  member: Object.getOwnPropertyDescriptors(CAMERA_MEMBERS.recordingQuality),
  spec: Object.getOwnPropertyDescriptors(CAMERA.properties!.find((spec) => spec.paramType === 2731)!),
  decodedValues: Object.getOwnPropertyDescriptors(CAMERA_MEMBERS.recordingQuality.decodedValues),
  enumValues: Object.getOwnPropertyDescriptors(CAMERA_MEMBERS.recordingQuality.enumValues),
};

/** The declared zero parameter's own-data identity and name bind its foreign-holder exception. */
const SHAPE_SECURITY_ZERO_METADATA = (() => {
  try {
    const entry = shapeSlot(SECURITY_PARAMS, "0");
    if (entry.slot !== "own-data") return undefined;
    shapeRecord(entry.value);
    const name = shapeSlot(entry.value, "name");
    if (
      name.slot !== "own-data" ||
      typeof name.value !== "string" ||
      name.value === "recordingQuality" ||
      name.value === `${UNKNOWN_PARAM_PREFIX}2731`
    )
      return undefined;
    return { definition: entry.value, name: name.value, descriptors: Object.getOwnPropertyDescriptors(entry.value) };
  } catch {
    return undefined;
  }
})();

/** Known metadata keys and shallow values must remain own data with their retained identities. */
function guardShapeMetadata(record: unknown, expected: object, array = false): void {
  if (nodeTypes.isProxy(record)) throw new ShapeRefusal("projection-binding");
  if (array) {
    if (!Array.isArray(record) || Object.getPrototypeOf(record) !== Array.prototype)
      throw new ShapeRefusal("projection-binding");
  } else shapeRecord(record);
  const actual = Object.getOwnPropertyDescriptors(record);
  const keys = Reflect.ownKeys(expected);
  if (Reflect.ownKeys(actual).length !== keys.length) throw new ShapeRefusal("projection-binding");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(actual, key)?.value as PropertyDescriptor | undefined;
    const baseline = Object.getOwnPropertyDescriptor(expected, key)?.value as PropertyDescriptor;
    if (!descriptor || !("value" in descriptor) || descriptor.value !== baseline.value)
      throw new ShapeRefusal("projection-binding");
  }
}

/** Writable internally, detached and readonly at the public diagnostic boundary. */
type ShapeResult = { -readonly [Key in keyof CachedParameterShapeEvidence]: CachedParameterShapeEvidence[Key] };

/** Every stage starts explicitly unvisited; later refusals retain reached facts. */
function emptyParameterShape(): ShapeResult {
  return {
    recipe: "recording-quality-shape-v1",
    status: "unsupported-binding",
    refusal: null,
    rootKind: "not-reached",
    modeSlot: "not-reached",
    modeKind: "not-reached",
    modeConversion: "not-reached",
    selectedSlot: "not-reached",
    selectedKind: "not-reached",
    qualitySlot: "not-reached",
    qualityKind: "not-reached",
    qualityDomain: "not-reached",
    decoderDecision: "not-reached",
  };
}

/**
 * A eufy device: one class, capability-driven. Construct from a resolved record (or a raw
 * `CloudRecord` via {@link Device.fromRecord}), then feed it param updates.
 */
export class Device {
  /** Serial number (station/device SN). */
  readonly sn: string;
  /**
   * The station this device's traffic belongs to: its parent HomeBase, or its own {@link sn} when it has none.
   *
   * Set from the record's `parentSn`, which is present only for a device that hangs off a base. An omitted parent
   * leaves the last known value; an explicit empty parent makes the device standalone. It starts at this
   * device's own serial and every device therefore has a station.
   */
  stationSn: string;
  /** Resolved command-codec family. */
  codec!: ResolvedDevice["codec"];
  /** Resolved capability set. Widens if the device later reports evidence for more. */
  capabilities!: readonly Capability[];
  /** Merged property schema (one entry per known property this device exposes). */
  properties!: readonly PropertySpec[];
  /**
   * What the user named this device in the app (`device_name`), falling back to {@link modelName} when
   * the record carries none.
   */
  name!: string;
  /** Model / T-code from the record ("T8410"), when known. */
  model?: string;
  /** The model's display name ("Indoor Cam Pan & Tilt") — the product this unit is one of. */
  modelName!: string;
  /** Which resolver tier produced the codec/caps. */
  source!: ResolvedDevice["source"];

  /** Fast capability lookup. */
  private capSet!: ReadonlySet<Capability>;
  /** propertyName → spec, for applyParams. */
  private specByName!: ReadonlyMap<string, PropertySpec>;
  /**
   * paramType → { spec, invert } for applyParams. Includes each spec's own `paramType` (invert
   * from the spec) plus any `readAliases` (invert from the alias) so a property that rides
   * different wire ids across device families still resolves to one named value.
   */
  private specByParam!: ReadonlyMap<number, { spec: PropertySpec; invert: boolean }>;
  /**
   * Params a resolved capability declares that this device's schema does not carry — withheld by a
   * member's gate, so not named from the param dictionary either. See {@link Device.applyParams}.
   */
  private withheld: ReadonlySet<number> = new Set();
  /** Which param namespace this device's ids live in (clean DPs vs security P2P). */
  private namespace!: ParamNamespace;
  /** Actual reported IDs retained independently of values, in their own parameter namespaces. */
  private readonly reportedIds = new Map<ParamNamespace, Set<number>>();
  /** Last stated classification and topology facts; partial records do not erase them. */
  private recordFacts: Omit<CloudRecord, "params" | "dpParams"> = {};
  /** Parent identity supplied by the roster owner, independently of this device's parameter evidence. */
  private stationContext?: Pick<AvailabilityContext, "stationDeviceType" | "stationModel">;
  /** The record's `device_name` as stated, before the {@link modelName} fallback is applied. */
  private deviceName?: string;
  /** Live property values, keyed by property name (or `unknown_<pt>`). */
  private readonly state = new Map<string, PropertyValue>();
  /**
   * Bound action objects per capability the device HAS, keyed by camelCased capability id
   * (`light`, `ptz`, `camera`). Empty until {@link bindActions} runs — a bare model object
   * (no network) has no actions. Populated by `EufyMega.getDevice`; surfaced through the fluent
   * `dev.<cap>()` accessors ({@link CapabilityAccessors}).
   */
  private actionMap: Partial<DeviceActionMap> = {};
  /** Existing binding providers reused when record evidence changes the read surface. */
  private binding?: MemberDeps;
  /**
   * Whether {@link bindActions} has run — published through {@link describe} because an unbound device
   * has no bound objects to enumerate, and "exposes nothing" and "not wired up yet" are different
   * answers a caller has to be able to tell apart.
   */
  private bound = false;
  /** Bound context and optional synchronous payload decoder for scalar cached reads. */
  private propertyReadContext: AvailabilityContext = {};
  /** Supplied read-context membership, separate from retained evidence used to install getters. */
  private diagnosticReadParamIds = new Set<number>();
  private propertyRawDp?: RawDpCodec;

  /**
   * Read-through freshness policy (injected by the facade via {@link setFreshnessPolicy}; the model
   * stays transport-free — it only calls the supplied `refresh`). Default: caching OFF
   * (`staleAfterMs = Infinity`), so a bare model object never triggers a fetch and existing behaviour
   * is unchanged until the client wires a policy.
   */
  private staleAfterMs = Infinity;
  private refresher?: () => Promise<void>;
  /** Guards against firing more than one background refresh at a time (coalesces rapid stale reads). */
  private refreshInFlight = false;
  /**
   * Host-supplied diagnostics sink. Defaults to {@link noopLogger} (silent) so a bare model object
   * stays quiet; the facade passes its own `logger` through {@link fromRecord}. Used to WARN when a
   * wire value doesn't match its declared `PropertySpec.type` (see {@link coerceByType}).
   */
  private readonly logger: Logger;

  constructor(sn: string, resolved: ResolvedDevice, logger: Logger = noopLogger) {
    this.sn = sn;
    this.stationSn = sn;
    this.logger = logger;
    this.resolveInto(resolved);
  }

  /**
   * Adopt a resolution: the capability set, the property schema, and everything derived from them.
   *
   * Shared by the constructor and {@link reresolve} so a widened device is indistinguishable from one
   * that resolved that way to begin with — a second derivation path here would be a slow-drifting bug,
   * since only the re-resolve case would exercise it.
   */
  private resolveInto(resolved: ResolvedDevice): void {
    this.codec = resolved.codec;
    this.propertyReadContext = {
      ...this.propertyReadContext,
      codec: resolved.codec,
      capabilities: new Set(resolved.capabilities),
    };
    this.capabilities = resolved.capabilities;
    this.properties = resolved.properties;
    this.modelName = resolved.name;
    this.name = this.deviceName ?? resolved.name;
    this.source = resolved.source;
    this.capSet = new Set(resolved.capabilities);
    this.specByName = new Map(resolved.properties.map((p) => [p.name, p]));
    const byParam = new Map<number, { spec: PropertySpec; invert: boolean }>();
    for (const p of resolved.properties) {
      // Own param first (wins on conflict), then read-aliases. First writer wins so an earlier
      // capability's own param is never clobbered by a later capability's alias.
      if (!byParam.has(p.paramType)) byParam.set(p.paramType, { spec: p, invert: p.invert ?? false });
      for (const a of p.readAliases ?? [])
        if (!byParam.has(a.paramType)) byParam.set(a.paramType, { spec: p, invert: a.invert ?? false });
    }
    this.specByParam = byParam;
    this.withheld = new Set([...claimedParams(resolved.capabilities)].filter((pt) => !byParam.has(pt)));
    this.namespace = namespaceForCodec(resolved.codec);
    this.installAccessors();
  }

  /**
   * Re-resolve against a fresher record and adopt the result if the capability set grew.
   *
   * A capability is granted on evidence the device reports, so a device that hadn't reported a param
   * when it was first resolved lacks the capability that param proves — and would keep lacking it for
   * the object's whole lifetime, even as the value itself started arriving. Re-resolving on fresh
   * evidence closes that: the accessor appears, already bound if the device is bound.
   *
   * Within a parameter namespace, only ever widens. A param the device stops reporting does not retract
   * a capability, because the cloud record can lose a field for reasons that have nothing to do with the
   * hardware, and revoking an accessor a caller already holds is worse than keeping a quiet one.
   *
   * A classification into another namespace adopts that namespace's capabilities and evidence instead.
   * A bound device rebuilds its objects against the current facts without fetching another record.
   * Returns the capabilities gained, empty when no capability was added.
   */
  reresolve(rec: CloudRecord): Capability[] {
    this.adoptIdentity(rec);
    const dpParams = (rec as ReadRecord).dpParams;
    const current = { ...this.recordFacts, params: rec.params, dpParams };
    const next = resolveDevice(current);
    const namespace = namespaceForCodec(next.codec);
    this.rememberReported(namespace, rec.params);
    this.rememberReported(namespace, dpParams);
    const gained = next.capabilities.filter((c) => !this.capSet.has(c));
    const capabilities = (
      namespace === this.namespace ? [...new Set([...this.capabilities, ...next.capabilities])] : next.capabilities
    ).filter(
      (capability) => !(current.parentSn && next.codec !== "station" && STATION_OWNED_CAPABILITIES.has(capability)),
    );
    const properties = mergeProperties(capabilities, {
      ...this.recordFacts,
      ...this.stationContext,
      codec: next.codec,
      capabilities: new Set(capabilities),
      paramIds: this.reportedIds.get(namespace),
      homeBaseAttached: this.stationSn !== this.sn,
    });
    if (
      gained.length ||
      next.codec !== this.codec ||
      next.name !== this.modelName ||
      next.source !== this.source ||
      !sameManifest(properties, this.properties)
    )
      this.resolveInto({ ...next, capabilities, properties });
    this.propertyReadContext = {
      ...this.propertyReadContext,
      ...this.stationContext,
      model: this.recordFacts.model,
      deviceType: this.recordFacts.deviceType,
      category: this.recordFacts.category,
      paramIds: new Set(this.reportedIds.get(this.namespace)),
      homeBaseAttached: this.stationSn !== this.sn,
    };
    if (this.binding) this.rebuildBinding();
    return gained;
  }

  /** Re-project the manifest and bound members when the covering station's identity changes. */
  setStationContext(ctx: Pick<AvailabilityContext, "stationDeviceType" | "stationModel">): void {
    if (
      this.stationContext &&
      this.stationContext.stationDeviceType === ctx.stationDeviceType &&
      this.stationContext.stationModel === ctx.stationModel
    )
      return;
    this.stationContext = { stationDeviceType: ctx.stationDeviceType, stationModel: ctx.stationModel };
    this.reresolve({});
  }

  /** Retain only actual supplied IDs, without manufacturing values or an observation timestamp. */
  private rememberReported(namespace: ParamNamespace, params: RawParams | undefined): void {
    const ids = this.reportedIds.get(namespace) ?? new Set<number>();
    for (const key of Object.keys(params ?? {})) {
      const id = Number(key);
      if (Number.isFinite(id)) ids.add(id);
    }
    this.reportedIds.set(namespace, ids);
  }

  /** Current classification and reported-ID evidence over the supplied route context. */
  private bindingContext(ctx: CommandContext): CommandContext {
    const catalogContext = ctx.dpCatalog ? ctx : this.binding?.ctx;
    return {
      ...ctx,
      ...this.stationContext,
      codec: this.codec,
      model: this.recordFacts.model,
      deviceType: this.recordFacts.deviceType,
      category: this.recordFacts.category,
      name: this.deviceName ?? ctx.name,
      homeBaseAttached: this.recordFacts.parentSn !== undefined ? this.stationSn !== this.sn : ctx.homeBaseAttached,
      dpCatalog:
        catalogContext?.codec === this.codec &&
        catalogContext.model === this.recordFacts.model &&
        catalogContext.category === this.recordFacts.category
          ? catalogContext.dpCatalog
          : undefined,
      paramIds: new Set(this.reportedIds.get(this.namespace)),
      capabilities: new Set(this.capabilities),
    };
  }

  /** Rebuild with the current record facts and existing providers, leaving every stored value untouched. */
  private rebuildBinding(): void {
    if (!this.binding) return;
    const previous = this.binding.ctx;
    const ctx = this.bindingContext(previous);
    const comparable = (value: CommandContext) =>
      Object.fromEntries(
        Object.entries({
          ...value,
          paramIds: [...value.paramIds].sort((a, b) => a - b),
          capabilities: value.capabilities ? [...value.capabilities].sort() : undefined,
        }).filter(([, fact]) => fact !== undefined),
      );
    if (structuralEqual(comparable(previous), comparable(ctx))) return;
    this.binding = { ...this.binding, ctx };
    this.propertyReadContext = ctx;
    this.actionMap = buildActions(this.capabilities, this.binding);
  }

  /**
   * Wire this device to a {@link CommandSink} so its semantic action objects become live
   * (`device.light?.on()`). `ctx` carries the evidence a capability uses to resolve the right
   * command variant. Called by `EufyMega.getDevice`; a raw model object left unbound simply has
   * no action objects (all accessors return `undefined`). `ff09Settings` reads that frame family's
   * settings over whichever transport the device has; `rawDp` reads the structured payloads a few params
   * carry in place of a scalar. Both are optional and both are named for the job, not the caller — a
   * read needing one returns `undefined` without it. See `CapabilityModule.actions`'s doc before
   * threading a third. The final `buildActions` arg is the live-state reader backing the capabilities' typed
   * read getters (`dev.battery()?.level`): it closes over `this.getProperty`, so a getter built once
   * here stays current as realtime/poll updates land in `this.state`.
   */
  bindActions(
    ctx: CommandContext,
    sink: CommandSink,
    media?: MediaProvider,
    ff09Settings?: Ff09SettingsReader,
    rawDp?: RawDpCodec,
  ): void {
    this.adoptIdentity({
      deviceType: ctx.deviceType,
      model: ctx.model,
      category: ctx.category,
      name: ctx.name,
    });
    const ids = this.reportedIds.get(this.namespace) ?? new Set<number>();
    for (const id of ctx.paramIds) if (Number.isFinite(id)) ids.add(id);
    this.reportedIds.set(this.namespace, ids);
    this.binding = {
      ctx: this.bindingContext(ctx),
      sink,
      read: (name) => this.getProperty(name),
      media,
      ff09Settings,
      rawDp,
    };
    this.actionMap = buildActions(this.capabilities, this.binding);
    this.propertyReadContext = this.binding.ctx;
    this.diagnosticReadParamIds = new Set(ctx.paramIds);
    this.propertyRawDp = rawDp;
    this.bound = true;
  }

  /**
   * Install the fluent capability accessors (`dev.ptz()`, `dev.light()`, …) once, for EVERY
   * known accessor name — each reads `this.actionMap` live, so an accessor returns `undefined`
   * (never "not a function") on an unbound device or one lacking the capability, and starts
   * returning the action object after {@link bindActions}. Capability-agnostic: the names come
   * from the barrel projection {@link accessorNamesFor}, so `device.ts` never names a
   * capability. The single cast here is the only place the {@link CapabilityAccessors} types erase.
   */
  private installAccessors(): void {
    for (const name of accessorNamesFor(new Set(this.capabilities))) {
      (this as unknown as Record<string, () => unknown>)[name] = () => this.actionMap[name];
    }
  }

  /** Build a Device from a raw cloud record (runs the 3-tier resolver). */
  static fromRecord(sn: string, rec: CloudRecord, logger: Logger = noopLogger): Device {
    const dev = new Device(sn, resolveDevice(rec), logger);
    dev.adoptIdentity(rec);
    dev.rememberReported(dev.namespace, (rec as ReadRecord).dpParams);
    if (rec.params) dev.applyParams(rec.params);
    return dev;
  }

  /**
   * Take the unit's own identity — its name and model code — from the record.
   *
   * Separate from {@link resolveInto} because the resolver answers about the PRODUCT: it has no
   * `device_name` to give, and re-running it must not replace "Dining room" with "Indoor Cam Pan &
   * Tilt". Re-applied on every {@link reresolve} so a rename in the app lands on the next refresh.
   *
   * A record that omits a field is silent about it rather than asserting it went away — the same
   * reasoning that keeps {@link reresolve} from retracting a capability — so an omission keeps the last
   * known value and only a stated one replaces it.
   */
  private adoptIdentity(rec: CloudRecord): void {
    for (const key of Object.keys(rec.params ?? {})) this.diagnosticReadParamIds.add(Number(key));
    const classificationChanged =
      (rec.model !== undefined && rec.model !== this.recordFacts.model) ||
      (rec.category !== undefined && rec.category !== this.recordFacts.category);
    this.recordFacts = {
      deviceType: rec.deviceType ?? (classificationChanged ? undefined : this.recordFacts.deviceType),
      model: rec.model ?? this.recordFacts.model,
      category: rec.category ?? this.recordFacts.category,
      name: rec.name ?? this.recordFacts.name,
      parentSn: rec.parentSn ?? this.recordFacts.parentSn,
    };
    this.model = rec.model ?? this.model;
    this.propertyReadContext = {
      ...this.propertyReadContext,
      model: this.model,
      deviceType: this.recordFacts.deviceType,
      category: rec.category ?? this.propertyReadContext.category,
      paramIds: new Set([...(this.propertyReadContext.paramIds ?? []), ...Object.keys(rec.params ?? {}).map(Number)]),
    };
    this.deviceName = rec.name ?? this.deviceName;
    this.name = this.deviceName ?? this.modelName;
    this.stationSn = rec.parentSn !== undefined ? rec.parentSn || this.sn : this.stationSn;
  }

  /** Does this device have the given capability? */
  has(cap: Capability): boolean {
    return this.capSet.has(cap);
  }

  /** Is the given property name part of this device's schema? */
  hasProperty(name: string): boolean {
    return this.specByName.has(name);
  }

  /**
   * Wire a read-through freshness policy. When a cached property is older than `staleAfterMs`, a
   * `getProperty`/`getProperties` read schedules ONE coalesced background `refresh()` (the facade
   * supplies it, choosing the cheapest live transport) and returns the last-known value immediately —
   * reads never block. Push / P2P realtime updates refresh `ts` themselves via {@link applyParams}, so
   * a device kept fresh by realtime never re-fetches (a fresh entry is never stale). Keeps `model/`
   * transport-free: the device only calls the injected callback.
   */
  setFreshnessPolicy(policy: { staleAfterMs: number; refresh: () => Promise<void> }): void {
    this.staleAfterMs = policy.staleAfterMs;
    this.refresher = policy.refresh;
  }

  /** Scalar schemas derived from the typed member reads; unexposed parameters remain explicitly marked. */
  getPropertySpecs(): readonly PropertySpec[] {
    return this.properties.map((spec) => scalarPropertySpec(this.capabilities, spec, this.propertyReadContext));
  }

  /** A typed cached scalar. Does not schedule a refresh or expose unknown parameters. */
  getPropertyValue(name: string): boolean | number | string | undefined {
    const spec = this.specByName.get(name);
    if (!spec) return undefined;
    return scalarPropertyValue(this.capabilities, spec, {
      ctx: this.propertyReadContext,
      read: (key) => this.state.get(key),
      rawDp: this.propertyRawDp,
    });
  }

  /**
   * Detached evidence for at most 64 positive safe-integer parameter ids, deduplicated in input order.
   * Reads retained state and metadata synchronously without freshness work or fluent getter execution.
   * Context membership describes the supplied read context, not retained getter evidence or report
   * history. Each id retains at most 16
   * structural entries; multiple surviving slots remain ambiguous. Numeric-string values are diagnostic
   * parses of stored text. No original wire representation, identity, text, object fields or ages are returned.
   */
  getCachedEvidence(paramTypes: readonly number[]): CachedDeviceEvidence {
    if (
      !Array.isArray(paramTypes) ||
      paramTypes.length > 64 ||
      Array.from(paramTypes).some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
      throw new TypeError("Cached evidence requires at most 64 positive safe-integer parameter ids");
    const reads = this.describe().details.flatMap((detail) => detail.reads);
    const ids = [...new Set(paramTypes)];
    const grouped = new Map<number, PropertyValue[]>();
    for (const entry of this.state.values()) {
      if (!ids.includes(entry.paramType)) continue;
      const entries = grouped.get(entry.paramType) ?? [];
      entries.push(entry);
      grouped.set(entry.paramType, entries);
    }
    const deviceType = this.propertyReadContext.deviceType;
    return {
      bound: this.bound,
      ...(Number.isSafeInteger(deviceType) && deviceType! > 0 ? { deviceType } : {}),
      namespace: this.namespace,
      topology: this.stationSn !== this.sn ? "attached" : "self-or-unknown",
      parameters: ids.map((paramType) => {
        const spec = this.specByParam.get(paramType)?.spec;
        const entries = grouped.get(paramType) ?? [];
        const scalarSpec = spec ? scalarPropertySpec(this.capabilities, spec, this.propertyReadContext) : undefined;
        const value = spec ? this.getPropertyValue(spec.name) : undefined;
        const numericValue = typeof value === "number" && Number.isFinite(value) ? value : undefined;
        const projection: CachedEvidenceProjection = {
          kind:
            numericValue !== undefined
              ? "finite-number"
              : typeof value === "boolean"
                ? "boolean"
                : typeof value === "string"
                  ? "string"
                  : "undefined",
          ...(numericValue !== undefined ? { numericValue } : {}),
          enumDomain:
            scalarSpec?.enumValues && numericValue !== undefined
              ? Object.hasOwn(scalarSpec.enumValues, numericValue)
                ? "in-domain"
                : "outside-domain"
              : "not-enumerated",
        };
        return {
          paramType,
          readContextContains: this.diagnosticReadParamIds.has(paramType),
          cacheCardinality: cachedCardinality(entries.length),
          entries: entries.slice(0, 16).map((entry): CachedEvidenceEntry => ({
            binding:
              spec?.name === entry.name && !spec.unexposed
                ? "schema"
                : entry.name.startsWith(UNKNOWN_PARAM_PREFIX)
                  ? "unknown"
                  : "dictionary-or-unexposed",
            ...cachedEntryKind(entry.value),
          })),
          entriesTruncated: entries.length > 16,
          schema: spec !== undefined,
          installedReadCardinality: cachedCardinality(
            spec ? reads.filter((read) => read.property === spec.name).length : 0,
          ),
          projection,
        };
      }),
    };
  }

  /**
   * Synchronous shape classification for the held security recording-quality parameter only.
   * No values, computed keys, identities, ages or exception text are returned. Holder and payload
   * objects are proxy-guarded and inspected through own data descriptors; unsafe structures refuse.
   * Finite foreign passthroughs and the declared zero holder require producer-coherent own names;
   * their payloads are not inspected. Canonical recording-quality slots remain strictly guarded.
   * Primitive mode conversion follows the retained decoder mechanically, without changing it.
   */
  getCachedParameterShape(paramType: number): CachedParameterShapeEvidence {
    const result = emptyParameterShape();
    if (this.namespace !== "security" || paramType !== 2731) return result;
    try {
      let target: { holder: Record<string, unknown>; key: string } | undefined;
      for (const [key, holder] of this.state) {
        shapeRecord(holder);
        const id = shapeHolderField(holder, "paramType");
        if (typeof id !== "number" || !Number.isFinite(id)) throw new ShapeRefusal("holder-invalid-field");
        if (!Number.isSafeInteger(id) || id <= 0) {
          const name = shapeHolderField(holder, "name");
          if (
            typeof key !== "string" ||
            typeof name !== "string" ||
            name !== key ||
            key === "recordingQuality" ||
            key === `${UNKNOWN_PARAM_PREFIX}${paramType}` ||
            this.specByParam.has(id)
          )
            throw new ShapeRefusal("holder-invalid-field");
          const definition = this.withheld.has(id) ? { slot: "missing" as const } : shapeSlot(SECURITY_PARAMS, `${id}`);
          if (definition.slot === "missing") {
            if (key !== `${UNKNOWN_PARAM_PREFIX}${id}`) throw new ShapeRefusal("holder-invalid-field");
          } else {
            if (
              id !== 0 ||
              definition.slot !== "own-data" ||
              SHAPE_SECURITY_ZERO_METADATA === undefined ||
              definition.value !== SHAPE_SECURITY_ZERO_METADATA.definition ||
              key !== SHAPE_SECURITY_ZERO_METADATA.name
            )
              throw new ShapeRefusal("holder-invalid-field");
            guardShapeMetadata(definition.value, SHAPE_SECURITY_ZERO_METADATA.descriptors);
          }
          continue;
        }
        if (id !== paramType) continue;
        if (target) {
          result.status = "cache-multiple";
          return result;
        }
        target = { holder, key };
      }
      if (!target) {
        result.status = "cache-absent";
        return result;
      }
      const name = shapeHolderField(target.holder, "name");
      if (typeof name !== "string" || name !== target.key) throw new ShapeRefusal("holder-invalid-field");
      const raw = shapeHolderField(target.holder, "value");
      result.rootKind = shapeKind(raw);
      if (result.rootKind !== "record") {
        result.status = "root-not-record";
        if (result.rootKind !== "array" && result.rootKind !== "unsupported") this.guardShapeProjection(target.holder);
        return result;
      }
      result.status = "inspected";
      const mode = shapeSlot(raw as Record<string, unknown>, "cur_mode");
      result.modeSlot = mode.slot;
      if (mode.slot === "inherited") throw new ShapeRefusal("inherited-slot");
      if (mode.slot === "accessor") throw new ShapeRefusal("accessor-slot");
      result.modeKind = shapeKind(mode.value);
      if (
        mode.value !== null &&
        mode.value !== undefined &&
        !["boolean", "number", "string"].includes(typeof mode.value)
      ) {
        result.modeConversion = "refused";
        throw new ShapeRefusal("unsupported-mode-type");
      }
      if (typeof mode.value === "string" && mode.value.length > 128) {
        result.modeConversion = "refused";
        throw new ShapeRefusal("mode-text-bound");
      }
      const converted = Number(mode.value);
      result.modeConversion = !converted
        ? "fallback"
        : typeof mode.value === "number"
          ? "direct-number"
          : "coerced-primitive";
      const selectedKey = `mode_${converted || 0}`;
      if (selectedKey.length > 32) throw new ShapeRefusal("mode-key-bound");
      const selected = shapeSlot(raw as Record<string, unknown>, selectedKey);
      result.selectedSlot = selected.slot;
      if (selected.slot === "inherited") throw new ShapeRefusal("inherited-slot");
      if (selected.slot === "accessor") throw new ShapeRefusal("accessor-slot");
      result.decoderDecision = "unavailable";
      if (selected.slot === "missing") {
        this.guardShapeProjection(target.holder);
        return result;
      }
      result.selectedKind = shapeKind(selected.value);
      if (result.selectedKind === "array") throw new ShapeRefusal("unsupported-container");
      if (result.selectedKind !== "record") {
        this.guardShapeProjection(target.holder);
        return result;
      }
      const quality = shapeSlot(selected.value as Record<string, unknown>, "quality");
      result.qualitySlot = quality.slot;
      if (quality.slot === "inherited") throw new ShapeRefusal("inherited-slot");
      if (quality.slot === "accessor") throw new ShapeRefusal("accessor-slot");
      if (quality.slot === "missing") {
        this.guardShapeProjection(target.holder);
        return result;
      }
      result.qualityKind = shapeKind(quality.value);
      const numeric = typeof quality.value === "number" || result.qualityKind === "numeric-string";
      const number = numeric ? Number(quality.value) : undefined;
      result.qualityDomain = numeric
        ? number === 1 || number === 2 || number === 3
          ? "in-domain"
          : "outside-domain"
        : "not-numeric";
      result.decoderDecision =
        typeof quality.value === "number"
          ? result.qualityDomain === "in-domain"
            ? "would-accept-numeric-tier"
            : "would-reject-numeric-tier"
          : "would-reject-nonnumeric-quality";
      this.guardShapeProjection(target.holder);
      return result;
    } catch (error) {
      result.status = "inspection-refused";
      result.refusal = error instanceof ShapeRefusal ? error.reason : "inspection-failed";
      result.decoderDecision = "refused";
      return result;
    }
  }

  /** Canonical projection metadata and a present read slot must bind to the inspected holder. */
  private guardShapeProjection(holder: Record<string, unknown>): void {
    try {
      const binding = this.specByParam.get(2731);
      if (binding === undefined) return;
      const spec = shapeMetadataField(binding, "spec");
      guardShapeMetadata(spec, SHAPE_RECORDING_METADATA.spec);
      if (
        shapeMetadataField(binding, "invert") !== false ||
        shapeMetadataField(spec, "name") !== "recordingQuality" ||
        shapeMetadataField(spec, "paramType") !== 2731 ||
        shapeMetadataField(spec, "type") !== "string" ||
        shapeMetadataField(spec, "raw") !== true ||
        this.specByName.get("recordingQuality") !== spec
      )
        throw new ShapeRefusal("projection-binding");
      for (const field of ["decode", "readAliases", "readsFrom", "property", "unexposed", "invert"])
        if (shapeMetadataField(spec, field) !== undefined) throw new ShapeRefusal("projection-binding");
      const member = shapeMetadataField(CAMERA_MEMBERS, "recordingQuality");
      guardShapeMetadata(member, SHAPE_RECORDING_METADATA.member);
      guardShapeMetadata(shapeMetadataField(member, "decodedValues"), SHAPE_RECORDING_METADATA.decodedValues, true);
      guardShapeMetadata(shapeMetadataField(member, "enumValues"), SHAPE_RECORDING_METADATA.enumValues);
      if (
        shapeMetadataField(member, "param") !== 2731 ||
        shapeMetadataField(member, "type") !== "string" ||
        shapeMetadataField(member, "decode") !== SHAPE_RECORDING_DECODER
      )
        throw new ShapeRefusal("projection-binding");
      for (const field of [
        "property",
        "readsFrom",
        "readAliases",
        "available",
        "readAvailable",
        "enumValuesFor",
        "coerce",
        "kind",
        "unit",
        "invert",
        "writtenElsewhere",
        "unexposed",
        "writeOnly",
      ])
        if (shapeMetadataField(member, field) !== undefined) throw new ShapeRefusal("projection-binding");
      const canonical = this.state.get("recordingQuality");
      if (canonical !== undefined && canonical !== (holder as unknown as PropertyValue))
        throw new ShapeRefusal("projection-binding");
    } catch {
      throw new ShapeRefusal("projection-binding");
    }
  }

  /** Typed cached scalars for declared properties only, without refresh side effects. */
  getPropertyValues(): Readonly<Record<string, boolean | number | string | undefined>> {
    return Object.fromEntries(this.properties.map((spec) => [spec.name, this.getPropertyValue(spec.name)]));
  }

  /** Typed scalars whose backing parameters occur in this report, including unchanged values. */
  observedProperties(params: RawParams): PropertyChange[] {
    return this.announcements(
      [...this.state.entries()].filter(([, value]) => Object.hasOwn(params, value.paramType)).map(([name]) => name),
    );
  }

  /**
   * Low-level property read by name — the untyped escape hatch. The typed fluent capability getters
   * (`dev.battery()?.level`, `dev.contact()?.open`) answer the value already narrowed to its declared
   * type where the property is exposed by a capability; this answers the loose `PropertyValue.value`
   * (`boolean|number|string|object`). It is the only read for an unbound model object (no live client →
   * no `dev.<cap>()`) and for a param not yet surfaced on a capability. Returns `undefined` if never
   * observed.
   */
  getProperty(name: string): PropertyValue | undefined {
    const v = this.state.get(name);
    if (v && Date.now() - v.ts > this.staleAfterMs) this.scheduleRefresh();
    return v;
  }

  /**
   * Snapshot of all current property values (named + unknown passthrough) — the untyped bulk read, for
   * diagnostics / discovery. The typed fluent capability getters (`dev.battery()?.level`, …) answer one
   * specific known property; this loose map answers every observed value at once. Under a freshness
   * policy, schedules a background refresh when the OLDEST observed value is stale (one fetch covers
   * every param) and returns the current snapshot immediately.
   */
  getProperties(): Record<string, PropertyValue> {
    if (this.refresher && !this.refreshInFlight) {
      let oldest: number | undefined;
      for (const v of this.state.values()) oldest = oldest === undefined ? v.ts : Math.min(oldest, v.ts);
      if (oldest !== undefined && Date.now() - oldest > this.staleAfterMs) this.scheduleRefresh();
    }
    return Object.fromEntries(this.state);
  }

  /**
   * Fire the injected background refresh at most once at a time (coalescing rapid stale reads). The
   * refresh calls {@link applyParams}, which updates each value's `ts` — so subsequent reads see fresh
   * entries and stop re-triggering until the next staleness window. Fire-and-forget; never throws to
   * the reader (a failed refresh just leaves the last-known value in place).
   */
  private scheduleRefresh(): void {
    if (!this.refresher || this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      void this.refresher().finally(() => {
        this.refreshInFlight = false;
      });
    } catch {
      // A refresher that throws SYNCHRONOUSLY (violating its `Promise<void>` contract) would otherwise
      // leave `refreshInFlight` stuck true — bricking every future refresh — and propagate to the
      // reader. Reset the flag and swallow it so a read never throws and refresh self-heals next time.
      this.refreshInFlight = false;
    }
  }

  /**
   * Apply a raw param map (cloud record or P2P notification). Known params update their named
   * property; unrecognised params are retained as `unknown_<paramType>` so nothing is lost.
   *
   * Naming precedence: this device's own `PropertySpec` (curated), then the param dictionary for its
   * namespace, then the `unknown_<paramType>` passthrough. The dictionary def is consulted even where a
   * spec exists, because `encoding` lives there.
   *
   * A param a resolved capability's gate WITHHELD takes the passthrough instead of its dictionary name.
   * The gate decided the read does not describe this device, the dictionary names it what the member
   * would have, and republishing it there hands a caller a reading indistinguishable from one the device
   * really answered. A capability that never resolved withholds nothing: a param arriving before its
   * capability is still the device's own, and keeps its dictionary name.
   *
   * @param params param_type → raw value.
   * @param ts observation time (epoch ms); defaults to `Date.now()`.
   * @returns the list of property names whose value changed.
   */
  applyParams(params: RawParams, ts: number = Date.now()): string[] {
    this.rememberReported(this.namespace, params);
    const changed: string[] = [];
    for (const [rawKey, rawVal] of Object.entries(params)) {
      const pt = Number(rawKey);
      if (!Number.isFinite(pt)) continue;
      // Naming precedence: a capability's PropertySpec (curated) → the param dictionary (all
      // known ids in this namespace) → `unknown_<pt>` passthrough (never dropped). The dict def is
      // always consulted (even when a capability spec exists) because `encoding` lives there.
      const hit = this.specByParam.get(pt);
      const spec = hit?.spec;
      const def = this.withheld.has(pt) ? undefined : paramDef(this.namespace, pt);
      const name = spec ? spec.name : def ? def.name : `${UNKNOWN_PARAM_PREFIX}${pt}`;
      const value: ParamValue = def?.encoding
        ? decodeEncoded(rawVal, def.encoding) // base64+json / json → structured object
        : spec
          ? coerce(spec, rawVal, hit!.invert, this.logger)
          : def
            ? coerceByType(def.type, rawVal, def.name, this.logger)
            : String(rawVal);
      const prev = this.state.get(name);
      // Compare structurally (order-insensitive) so a decoded object whose keys come back reordered
      // doesn't read as "changed" and flap a downstream update — see `structuralEqual`.
      const changedVal = prev === undefined || !structuralEqual(prev.value, value);
      this.state.set(name, { name, paramType: pt, value, ts });
      if (changedVal) changed.push(name);
    }
    return changed;
  }

  /**
   * Which of these changed property names are worth ANNOUNCING, each with the value
   * {@link getPropertyValue} now serves for it — the second half of an {@link applyParams} call, and the input
   * a facade turns into a property-change event.
   *
   * Only a name in this device's own schema survives, and EVERY name in it does. The schema is what the
   * SDK published and {@link getProperty} serves every entry of, so announcing one is honest; a
   * dictionary-named param and an `unknown_<paramType>` passthrough are things the SDK makes no claim
   * about, and announcing either would promise a value it never agreed to serve. Diagnostics reach those
   * through `inspectParams`.
   *
   * Nothing is withheld for being uninteresting, here or in a capability's own table. Which of a device's
   * truths a host acts on is the host's call: a withheld value cannot be recovered, where an unwanted one
   * costs a caller one comparison on the name.
   *
   * The value uses the pure cached scalar projection, including the member's decoder and visibility
   * rules. Missing or invalid data produces a valueless announcement. This does not invoke a fluent
   * getter or schedule a background refresh.
   *
   * Kept beside the state and the schema rather than in a caller, because both are here; a caller doing
   * the join would be re-deriving what this object already holds. Says nothing about the previous value:
   * a caller that needs the delta already holds it, because it was told last time.
   */
  announcements(changed: readonly string[]): PropertyChange[] {
    const out: PropertyChange[] = [];
    for (const name of changed) {
      const spec = this.specByName.get(name);
      if (!spec) continue;
      const value = this.getPropertyValue(name);
      out.push(value === undefined ? { property: name } : { property: name, value });
    }
    return out;
  }

  /**
   * What this device exposes, as data — every installed read with what its value MEANS, every offerable
   * action with what it accepts, and every event each capability emits.
   *
   * Beside {@link toJSON} rather than folded into it, because the two answer different questions and
   * `toJSON` fires on every implicit `JSON.stringify` (an event payload, a log line) where the shape is
   * not wanted. This one carries **shape only** — no values; read those through the capability getters
   * it names.
   *
   * The reads and actions are the ones this device actually installed, so a caller can offer everything
   * listed: a write the device gave no evidence for, or one whose wire is not confirmed, is absent
   * rather than described. An unbound device (no live client) has nothing bound to enumerate and answers
   * `bound: false` with empty `details`. `details` is resolved against this device's own facts (codec,
   * model, capabilities), so a per-device enum domain (e.g. `workingMode`) carries the same options the
   * property schema does.
   */
  describe(): DeviceManifest {
    return {
      sn: this.sn,
      name: this.name,
      model: this.model,
      modelName: this.modelName,
      codec: this.codec,
      source: this.source,
      bound: this.bound,
      capabilities: [...this.capabilities],
      details: describeCapabilities(this.actionMap, {
        codec: this.codec,
        model: this.model,
        capabilities: new Set(this.capabilities),
        homeBaseAttached: this.stationSn !== this.sn,
      }),
    };
  }

  /** Plain-object view: serial, name, resolved codec/source, capabilities, and every current property value. */
  toJSON(): Record<string, unknown> {
    return {
      sn: this.sn,
      name: this.name,
      codec: this.codec,
      source: this.source,
      capabilities: [...this.capabilities],
      properties: this.getProperties(),
    };
  }
}

/**
 * Declaration merge: give {@link Device} the fluent capability accessors (`dev.ptz()`,
 * `dev.light()`, `dev.camera()`, …) with full IDE typing, WITHOUT `device.ts` naming a single
 * capability. The accessor names + return types come from {@link CapabilityAccessors} (a projection
 * of the capability modules in the barrel); `bindActions` installs the matching closures at runtime.
 * Adding a capability adds an accessor here automatically — no edit to this file.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Device extends CapabilityAccessors {}
