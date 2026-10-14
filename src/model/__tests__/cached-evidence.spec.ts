import { beforeEach, describe, expect, it, vi } from "vitest";
import { Device } from "../device.js";
import type {
  CachedDeviceEvidence,
  CachedParameterShapeEvidence,
  PropertySpec,
  PropertyValue,
  ResolvedDevice,
} from "../types.js";
import { CAMERA_MEMBERS } from "../capabilities/camera.js";
import { SECURITY_PARAMS } from "../param-dictionary.js";

const serial = "T8000P0000000000";
const quality = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const sink = {
  dispatch: vi.fn(async () => {
    throw new Error("unexpected dispatch");
  }),
};
const one = (device: Device, param: number) => device.getCachedEvidence([param]).parameters[0]!;

function bind(device: Device, ids: number[]) {
  device.bindActions({ codec: device.codec, model: device.model, channel: 0, paramIds: new Set(ids) }, sink);
}

function synthetic(properties: PropertySpec[] = [], codec: ResolvedDevice["codec"] = "camera") {
  return new Device(serial, { codec, capabilities: [], properties, name: "synthetic model", source: "inferred" });
}

describe("held cached model evidence", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("never schedules stale refreshes or invokes bound getters, while the normal path proves the tripwire works", async () => {
    const device = Device.fromRecord(serial, {
      model: "T8425",
      params: { 2731: quality({ cur_mode: 0, mode_0: { quality: 2 } }) },
    });
    bind(device, [2731]);
    const getter = vi.fn(() => {
      throw new Error("fluent getter executed");
    });
    Object.defineProperty(device.camera?.()!, "recordingQuality", { get: getter, configurable: true });
    const refresh = vi.fn(async () => {});
    device.setFreshnessPolicy({ staleAfterMs: -1, refresh });
    const property = vi.spyOn(device, "getProperty");
    const properties = vi.spyOn(device, "getProperties");
    const json = vi.spyOn(device, "toJSON");
    const timer = vi.spyOn(globalThis, "setTimeout");
    for (let index = 0; index < 3; index++) {
      expect(one(device, 2731)).toMatchObject({
        schema: true,
        cacheCardinality: "one",
        installedReadCardinality: "one",
        entries: [{ binding: "schema", kind: "object" }],
        projection: { kind: "finite-number", numericValue: 2, enumDomain: "in-domain" },
      });
    }
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(property).not.toHaveBeenCalled();
    expect(properties).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    expect(sink.dispatch).not.toHaveBeenCalled();
    device.getProperty("recordingQuality");
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps unbound, absent read, installed read and invalid projection distinct", () => {
    const device = Device.fromRecord(serial, { model: "T8425" });
    expect(device.getCachedEvidence([2731]).bound).toBe(false);
    expect(one(device, 2731)).toMatchObject({
      schema: true,
      cacheCardinality: "none",
      installedReadCardinality: "none",
    });
    bind(device, []);
    device.applyParams({ 2731: quality({ private_marker: "synthetic-session", cur_mode: 0 }) });
    expect(one(device, 2731)).toMatchObject({
      readContextContains: false,
      installedReadCardinality: "none",
      entries: [{ kind: "object" }],
      projection: { kind: "undefined" },
    });
    bind(device, [2731]);
    expect(one(device, 2731).installedReadCardinality).toBe("one");
    expect(JSON.stringify(device.getCachedEvidence([2731]))).not.toContain("private_marker");
    expect(JSON.stringify(device.getCachedEvidence([2731]))).not.toContain("synthetic-session");
  });

  it.each([1, 2, 128, 256, 3])("reports numeric storage separately from enum domain for %i", (value) => {
    const device = Device.fromRecord(serial, { model: "T8410", params: { 6046: String(value) } });
    expect(one(device, 6046)).toMatchObject({
      entries: [{ kind: "finite-number", numericValue: value }],
      projection: {
        kind: "finite-number",
        numericValue: value,
        enumDomain: value <= 2 ? "in-domain" : "outside-domain",
      },
    });
  });

  it("separates dictionary telemetry from typed reads and keeps namespace ownership", () => {
    const camera = Device.fromRecord(serial, { model: "T8425", params: { 1142: "-48", 1019: "1" } });
    bind(camera, [1142, 1019]);
    expect(one(camera, 1142)).toMatchObject({
      schema: true,
      installedReadCardinality: "one",
      entries: [{ binding: "schema", kind: "finite-number", numericValue: -48 }],
      projection: { kind: "finite-number", numericValue: -48, enumDomain: "not-enumerated" },
    });
    // HDR remains dictionary-only: reporting it does not create a typed capability read.
    expect(one(camera, 1019)).toMatchObject({
      schema: false,
      installedReadCardinality: "none",
      entries: [{ binding: "dictionary-or-unexposed", kind: "boolean" }],
      projection: { kind: "undefined" },
    });
    const clean = synthetic([], "vacuum");
    clean.applyParams({ 1142: "-48" });
    expect(clean.getCachedEvidence([1142]).namespace).toBe("clean");
    expect(one(clean, 1142)).toMatchObject({
      schema: false,
      entries: [{ binding: "unknown", kind: "numeric-string", numericValue: -48 }],
    });
    const life = synthetic([], "light");
    expect(life.getCachedEvidence([2731, 6046, 1142]).namespace).toBe("life");
  });

  it.each(["", " ", "0x10", "Infinity", "1e999", "private text"])(
    "never diagnostic-parses nonliteral text %j",
    (value) => {
      const device = synthetic();
      device.applyParams({ 99999: value });
      expect(one(device, 99999).entries).toEqual([{ binding: "unknown", kind: "string" }]);
    },
  );

  it.each(["-12.5", "+0.5", ".5", "1e2"])(
    "diagnostic-parses finite literal text %j without publishing text",
    (value) => {
      const device = synthetic();
      device.applyParams({ 99999: value });
      expect(one(device, 99999).entries).toEqual([
        { binding: "unknown", kind: "numeric-string", numericValue: Number(value) },
      ]);
      expect(one(device, 99999).projection.kind).toBe("undefined");
    },
  );

  it("classifies arrays, null, boolean and nonfinite interpreted values without contents", () => {
    const device = Device.fromRecord(serial, { model: "T8425" });
    device.applyParams({ 2731: quality(["synthetic-canary"]), 99998: "synthetic-name" });
    expect(one(device, 2731).entries[0]!.kind).toBe("array");
    device.applyParams({ 2731: quality(null) });
    expect(one(device, 2731).entries[0]!.kind).toBe("null");
    const custom = synthetic([
      { name: "flag", paramType: 99995, type: "bool", writable: false },
      { name: "nonfinite", paramType: 99994, type: "number", writable: false, decode: () => NaN },
    ]);
    custom.applyParams({ 99995: true, 99994: 1 });
    expect(one(custom, 99995).entries[0]!.kind).toBe("boolean");
    expect(one(custom, 99994).entries[0]).toEqual({ binding: "schema", kind: "nonfinite-number" });
    expect(JSON.stringify(device.getCachedEvidence([2731, 99998]))).not.toContain("synthetic-name");
  });

  it("keeps retained duplicate slots ambiguous after re-resolution instead of selecting a timestamp", () => {
    const device = new Device(serial, {
      codec: "camera",
      capabilities: ["camera"],
      properties: [],
      name: "synthetic",
      source: "inferred",
    });
    device.applyParams({ 2731: quality({ cur_mode: 0, mode_0: { quality: 1 } }) }, 999999);
    device.reresolve({ model: "T8425", params: { 2731: "synthetic" } });
    device.applyParams({ 2731: quality({ cur_mode: 0, mode_0: { quality: 2 } }) }, 0);
    expect(one(device, 2731)).toMatchObject({ cacheCardinality: "multiple", entriesTruncated: false });
    expect(one(device, 2731).entries.map((entry) => entry.binding)).toEqual(["unknown", "schema"]);
  });

  it("counts duplicate installed metadata without executing either fluent getter", () => {
    const device = Device.fromRecord(serial, { model: "T8425" });
    bind(device, [2731]);
    const manifest = device.describe();
    const descriptor = manifest.details.find((detail) =>
      detail.reads.some((read) => read.property === "recordingQuality"),
    )!;
    vi.spyOn(device, "describe").mockReturnValue({ ...manifest, details: [descriptor, descriptor] });
    expect(one(device, 2731).installedReadCardinality).toBe("multiple");
  });

  it("does not confuse current context membership with retained cache or lifetime history", () => {
    const device = Device.fromRecord(serial, { model: "T8425", deviceType: 47, params: { 6046: "1" } });
    expect(one(device, 6046).readContextContains).toBe(true);
    bind(device, [2731]);
    expect(one(device, 6046)).toMatchObject({ readContextContains: false, cacheCardinality: "one" });
    expect(one(device, 2731)).toMatchObject({ readContextContains: true, cacheCardinality: "none" });
    device.applyParams({ 1142: -51 });
    expect(one(device, 1142).readContextContains).toBe(false);
    device.reresolve({ model: "T8425", deviceType: 47, params: { 1142: "-51" } });
    expect(one(device, 1142).readContextContains).toBe(true);
    bind(device, []);
    expect(one(device, 1142).readContextContains).toBe(false);
  });

  it("keeps an empty held cache empty and does not refresh absent entries", async () => {
    const device = synthetic();
    const refresh = vi.fn(async () => {});
    device.setFreshnessPolicy({ staleAfterMs: -1, refresh });
    expect(device.getCachedEvidence([99999]).parameters).toMatchObject([{ cacheCardinality: "none", schema: false }]);
    expect(device.getCachedEvidence([99999]).parameters).toMatchObject([{ cacheCardinality: "none", schema: false }]);
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    expect(device.getProperties()).toEqual({});
  });

  it("classifies projected text without exporting text or false numeric evidence", () => {
    const device = synthetic([{ name: "text", paramType: 99992, type: "string", writable: false }]);
    device.applyParams({ 99992: "synthetic-session-canary" });
    vi.spyOn(device, "getPropertyValue").mockReturnValue("synthetic-session-canary");
    expect(one(device, 99992).projection).toEqual({ kind: "string", enumDomain: "not-enumerated" });
    expect(JSON.stringify(device.getCachedEvidence([99992]))).not.toContain("synthetic-session-canary");
  });

  it("returns detached structures, bounded requests and no identities", () => {
    const device = Device.fromRecord(serial, {
      model: "T8410",
      name: "private-synthetic-name",
      deviceType: 31,
      parentSn: "T8000P0000000001",
      params: { 6046: "128" },
    });
    const result = device.getCachedEvidence([6046, 6046]) as {
      parameters: Array<{ entries: Array<{ numericValue?: number }>; readContextContains: boolean }>;
    } & CachedDeviceEvidence;
    expect(result.parameters).toHaveLength(1);
    result.parameters[0]!.entries[0]!.numericValue = 999;
    result.parameters[0]!.readContextContains = false;
    expect(one(device, 6046)).toMatchObject({ readContextContains: true, entries: [{ numericValue: 128 }] });
    expect(result).toMatchObject({ deviceType: 31, topology: "attached" });
    const serialized = JSON.stringify(result);
    for (const canary of [serial, "T8000P0000000001", "private-synthetic-name", "T8410"])
      expect(serialized).not.toContain(canary);
    for (const ids of [[0], [-1], [NaN], [1.5], [Infinity], Array(65).fill(1), Array(1), ["1"]])
      expect(() => device.getCachedEvidence(ids as number[])).toThrow(TypeError);
    expect(() => device.getCachedEvidence(Array(1))).toThrow(TypeError);
    expect(() => device.getCachedEvidence(null as never)).toThrow(TypeError);
    expect(synthetic().getCachedEvidence([]).parameters).toEqual([]);
  });
});

type ShapeInternals = {
  state: Map<string, PropertyValue>;
  specByParam: Map<number, { spec: PropertySpec; invert: boolean }>;
  specByName: Map<string, PropertySpec>;
  withheld: ReadonlySet<number>;
};
const internals = (device: Device) => device as unknown as ShapeInternals;
const shapeKeys = [
  "recipe",
  "status",
  "refusal",
  "rootKind",
  "modeSlot",
  "modeKind",
  "modeConversion",
  "selectedSlot",
  "selectedKind",
  "qualitySlot",
  "qualityKind",
  "qualityDomain",
  "decoderDecision",
].sort();

function shaped(value: unknown, model = "T8425") {
  const device = Device.fromRecord(serial, { model, params: { 2731: quality({}) } });
  device.getProperty("recordingQuality")!.value = value as PropertyValue["value"];
  return device;
}

function assertShape(result: CachedParameterShapeEvidence, expected: Partial<CachedParameterShapeEvidence>) {
  expect(Object.keys(result).sort()).toEqual(shapeKeys);
  expect(result.recipe).toBe("recording-quality-shape-v1");
  expect(result.refusal === null).toBe(result.status !== "inspection-refused");
  expect(Object.values(result).every((value) => value === null || typeof value === "string")).toBe(true);
  expect(result).toMatchObject(expected);
}

function trapProxy(revoked = false) {
  const trap = vi.fn(() => {
    throw new Error("private-proxy-canary");
  });
  const pair = Proxy.revocable({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap });
  if (revoked) pair.revoke();
  return { value: pair.proxy, trap };
}

describe("held recording-quality shape", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([
    ["0", 0, "single"],
    ["-0", -0, "single"],
    ["00", 0, "single"],
    ["0x0", 0, "single"],
    ["-1", -1, "unknown_-1"],
    ["-01", -1, "unknown_-1"],
    ["1.5", 1.5, "unknown_1.5"],
    ["1.50", 1.5, "unknown_1.5"],
    ["9007199254740992", 9007199254740992, "unknown_9007199254740992"],
    ["9.007199254740992e15", 9007199254740992, "unknown_9007199254740992"],
    ["1e21", 1e21, "unknown_1e+21"],
    ["1e-7", 1e-7, "unknown_1e-7"],
    ["999999", 999999, "unknown_999999"],
  ] as const)("inspects producer-created foreign %s without changing quality reads", (rawKey, id, name) => {
    for (const targetPresent of [false, true]) {
      for (const foreignFirst of [false, true]) {
        const device = Device.fromRecord(serial, { model: "T8425" });
        const foreign = () => expect(device.applyParams({ [rawKey]: "private-foreign-payload" }, 17)).toEqual([name]);
        const target = () => {
          if (targetPresent) device.applyParams({ 2731: quality({ mode_0: { quality: 2 } }) }, 23);
        };
        if (foreignFirst) {
          foreign();
          target();
        } else {
          target();
          foreign();
        }
        expect(internals(device).state.get(name)).toMatchObject({ name, paramType: id });
        expect(device.getPropertyValue("recordingQuality")).toBe(targetPresent ? 2 : undefined);
        const result = device.getCachedParameterShape(2731);
        assertShape(result, {
          status: targetPresent ? "inspected" : "cache-absent",
          rootKind: targetPresent ? "record" : "not-reached",
          decoderDecision: targetPresent ? "would-accept-numeric-tier" : "not-reached",
        });
        expect(device.getPropertyValue("recordingQuality")).toBe(targetPresent ? 2 : undefined);
        for (const marker of [name, rawKey, "private-foreign-payload", serial, "T8425", '"ts"'])
          expect(JSON.stringify(result)).not.toContain(marker);
      }
    }
  });

  it("distinguishes declared zero from withheld zero passthrough without a spec", () => {
    for (const targetPresent of [false, true]) {
      const device = targetPresent ? shaped({ mode_0: { quality: 2 } }) : synthetic();
      internals(device).withheld = new Set([0]);
      expect(internals(device).specByParam.has(0)).toBe(false);
      expect(device.applyParams({ 0: "private-withheld-zero" })).toEqual(["unknown_0"]);
      assertShape(device.getCachedParameterShape(2731), { status: targetPresent ? "inspected" : "cache-absent" });
      internals(device).withheld = new Set();
      assertShape(device.getCachedParameterShape(2731), {
        status: "inspection-refused",
        rootKind: "not-reached",
      });
    }
  });

  it.each([0, -1, 1.5, 9007199254740992, 1e21])(
    "refuses an exceptional-id spec without reading its binding (%s)",
    (id) => {
      const device = shaped({ mode_0: { quality: 2 } });
      device.applyParams({ [id]: "private-foreign" });
      const getter = vi.fn(() => {
        throw new Error("private-exceptional-spec");
      });
      internals(device).specByParam.set(id, {
        get spec() {
          return getter();
        },
        get invert() {
          return getter();
        },
      });
      assertShape(device.getCachedParameterShape(2731), {
        status: "inspection-refused",
        rootKind: "not-reached",
      });
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, 9007199254740992, 1e21])(
    "keeps protected target keys and names outside the exception (%s)",
    (id) => {
      for (const reserved of ["recordingQuality", "unknown_2731"]) {
        for (const protect of ["key", "name", "both"]) {
          for (const targetPresent of [false, true]) {
            const device = targetPresent ? shaped({ mode_0: { quality: 2 } }) : synthetic();
            const foreignName = id === 0 ? "single" : `unknown_${id}`;
            internals(device).state.set(protect === "name" ? foreignName : reserved, {
              name: protect === "key" ? foreignName : reserved,
              paramType: id,
              value: "private-forged-target",
              ts: 0,
            });
            assertShape(device.getCachedParameterShape(2731), {
              status: "inspection-refused",
              refusal: "holder-invalid-field",
              rootKind: "not-reached",
            });
          }
        }
      }
    },
  );

  it.each([
    ["single", "single", -1],
    ["unknown_-1", "unknown_1.5", -1],
    ["unknown_-01", "unknown_-01", -1],
    ["alias", "unknown_-1", -1],
    ["unknown_-1", "alias", -1],
    ["single", "alias", 0],
    ["alias", "single", 0],
  ] as const)("refuses forged foreign naming %s/%s/%s", (key, name, paramType) => {
    const device = shaped({ mode_0: { quality: 2 } });
    internals(device).state.set(key, { name, paramType, value: "private-forged-name", ts: 0 });
    assertShape(device.getCachedParameterShape(2731), {
      status: "inspection-refused",
      refusal: "holder-invalid-field",
      rootKind: "not-reached",
    });
  });

  it.each(["missing", "accessor", "inherited"])("guards foreign own name (%s)", (slot) => {
    const device = shaped({ mode_0: { quality: 2 } });
    device.applyParams({ "-1": "private-foreign" });
    const holder = internals(device).state.get("unknown_-1")!;
    const getter = vi.fn(() => {
      throw new Error("private-foreign-name");
    });
    delete (holder as unknown as Record<string, unknown>).name;
    if (slot === "accessor") Object.defineProperty(holder, "name", { get: getter });
    if (slot === "inherited") Object.defineProperty(Object.prototype, "name", { get: getter, configurable: true });
    try {
      assertShape(device.getCachedParameterShape(2731), {
        status: "inspection-refused",
        refusal: `holder-${slot}-field` as CachedParameterShapeEvidence["refusal"],
        rootKind: "not-reached",
      });
      expect(getter).not.toHaveBeenCalled();
    } finally {
      if (slot === "inherited") delete (Object.prototype as Record<string, unknown>).name;
    }
  });

  it.each(["entry-accessor", "name-accessor", "proxy", "revoked", "identity", "name", "missing", "inherited"])(
    "refuses changed dictionary zero metadata (%s) without callbacks",
    (mutation) => {
      const device = shaped({ mode_0: { quality: 2 } });
      expect(device.applyParams({ 0: "private-zero" })).toEqual(["single"]);
      const entry = Object.getOwnPropertyDescriptor(SECURITY_PARAMS, "0")!;
      const definition = entry.value as Record<string, unknown>;
      const name = Object.getOwnPropertyDescriptor(definition, "name")!;
      const inherited = Object.getOwnPropertyDescriptor(Object.prototype, "0");
      const getter = vi.fn(() => {
        throw new Error("private-dictionary-zero");
      });
      const proxy = trapProxy(mutation === "revoked");
      try {
        if (mutation === "entry-accessor")
          Object.defineProperty(SECURITY_PARAMS, "0", { get: getter, configurable: true });
        else if (mutation === "name-accessor")
          Object.defineProperty(definition, "name", { get: getter, configurable: true });
        else if (mutation === "proxy" || mutation === "revoked")
          Object.defineProperty(SECURITY_PARAMS, "0", { ...entry, value: proxy.value });
        else if (mutation === "identity")
          Object.defineProperty(SECURITY_PARAMS, "0", { ...entry, value: { ...definition } });
        else if (mutation === "name") Object.defineProperty(definition, "name", { ...name, value: "private-name" });
        else {
          delete SECURITY_PARAMS[0];
          if (mutation === "inherited")
            Object.defineProperty(Object.prototype, "0", {
              value: {
                get name() {
                  return getter();
                },
              },
              writable: true,
              configurable: true,
            });
        }
        assertShape(device.getCachedParameterShape(2731), {
          status: "inspection-refused",
          rootKind: "not-reached",
          decoderDecision: "refused",
        });
        expect(getter).not.toHaveBeenCalled();
        expect(proxy.trap).not.toHaveBeenCalled();
      } finally {
        if (inherited) Object.defineProperty(Object.prototype, "0", inherited);
        else delete (Object.prototype as Record<string, unknown>)["0"];
        Object.defineProperty(definition, "name", name);
        Object.defineProperty(SECURITY_PARAMS, "0", entry);
      }
    },
  );

  it.each(["own-data", "accessor", "inherited"])(
    "rejects newly dictionary-owned unknown foreign ids (%s) without reading metadata",
    (slot) => {
      const device = shaped({ mode_0: { quality: 2 } });
      device.applyParams({ "-1": "private-foreign" });
      const getter = vi.fn(() => {
        throw new Error("private-dictionary-foreign");
      });
      const owner = slot === "inherited" ? Object.prototype : SECURITY_PARAMS;
      const original = Object.getOwnPropertyDescriptor(owner, "-1");
      Object.defineProperty(owner, "-1", {
        ...(slot === "own-data"
          ? {
              value: {
                get name() {
                  return getter();
                },
              },
            }
          : { get: getter }),
        configurable: true,
      });
      try {
        assertShape(device.getCachedParameterShape(2731), {
          status: "inspection-refused",
          rootKind: "not-reached",
        });
        expect(getter).not.toHaveBeenCalled();
        internals(device).withheld = new Set([-1]);
        assertShape(device.getCachedParameterShape(2731), { status: "inspected" });
        expect(getter).not.toHaveBeenCalled();
      } finally {
        if (original) Object.defineProperty(owner, "-1", original);
        else delete (owner as Record<string, unknown>)["-1"];
      }
    },
  );

  it("ignores coherent foreign payloads and timestamps, including withheld zero", () => {
    for (const targetPresent of [false, true]) {
      for (const withheldZero of [false, true]) {
        const device = targetPresent ? shaped({ mode_0: { quality: 2 } }) : synthetic();
        if (withheldZero) internals(device).withheld = new Set([0]);
        const getter = vi.fn(() => {
          throw new Error("private-foreign-payload-or-time");
        });
        const names = device.applyParams({ 0: "private-zero", "-1": "private-negative", "1.5": "private-fractional" });
        for (const name of names) {
          const holder = internals(device).state.get(name)!;
          for (const field of ["value", "ts"])
            Object.defineProperty(holder, field, { get: getter, configurable: true });
        }
        const query = vi.spyOn(device, "getPropertyValue").mockImplementation(() => {
          throw new Error("private-normal-decoder");
        });
        assertShape(device.getCachedParameterShape(2731), { status: targetPresent ? "inspected" : "cache-absent" });
        expect(getter).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
      }
    }
  });

  it("rejects nonprimitive and nonfinite foreign ids without conversion hooks", () => {
    const hook = vi.fn(() => {
      throw new Error("private-id-coercion");
    });
    const object = { valueOf: hook, toString: hook, [Symbol.toPrimitive]: hook };
    for (const id of [object, new Number(-1), "-1", -1n, Symbol("private-id"), NaN, Infinity, -Infinity, null]) {
      const device = shaped({ mode_0: { quality: 2 } });
      internals(device).state.set("unknown_-1", {
        name: "unknown_-1",
        paramType: id as number,
        value: "private-foreign",
        ts: 0,
      });
      assertShape(device.getCachedParameterShape(2731), {
        status: "inspection-refused",
        refusal: "holder-invalid-field",
        rootKind: "not-reached",
      });
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it("rejects nonprimitive foreign keys and names without string conversion", () => {
    const hook = vi.fn(() => {
      throw new Error("private-name-coercion");
    });
    const object = { toString: hook, valueOf: hook, [Symbol.toPrimitive]: hook };
    for (const [key, name] of [
      [object, "unknown_-1"],
      ["unknown_-1", object],
      [object, object],
    ]) {
      const device = shaped({ mode_0: { quality: 2 } });
      internals(device).state.set(key as string, {
        name: name as string,
        paramType: -1,
        value: "private-foreign",
        ts: 0,
      });
      assertShape(device.getCachedParameterShape(2731), {
        status: "inspection-refused",
        refusal: "holder-invalid-field",
        rootKind: "not-reached",
      });
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it("retains unknown target inspection without canonical schema beside producer-created foreign holders", () => {
    const device = synthetic();
    internals(device).withheld = new Set([2731]);
    expect(device.applyParams({ 0: "private-zero", "-1": "private-negative" })).toEqual(["single", "unknown_-1"]);
    expect(device.applyParams({ 2731: "private-target" })).toEqual(["unknown_2731"]);
    internals(device).state.get("unknown_2731")!.value = { mode_0: { quality: 2 } };
    assertShape(device.getCachedParameterShape(2731), { status: "inspected", qualityDomain: "in-domain" });
    expect(device.getPropertyValue("recordingQuality")).toBeUndefined();
  });

  it.each([0, -1, 2730, 6046, NaN, Infinity, 2731.5, "2731", null, {}, Symbol("private-input")])(
    "rejects an unsupported parameter without inspecting holders (%s)",
    (id) => {
      const device = shaped({});
      const proxy = trapProxy();
      internals(device).state.set("recordingQuality", proxy.value as PropertyValue);
      assertShape(device.getCachedParameterShape(id as number), {
        status: "unsupported-binding",
        rootKind: "not-reached",
        decoderDecision: "not-reached",
      });
      expect(proxy.trap).not.toHaveBeenCalled();
    },
  );

  it.each(["vacuum", "light", "printer", "display"] as ResolvedDevice["codec"][])(
    "keeps another namespace's 2731 opaque (%s)",
    (codec) => {
      const device = synthetic([], codec);
      const proxy = trapProxy();
      internals(device).state.set("unknown_2731", proxy.value as PropertyValue);
      assertShape(device.getCachedParameterShape(2731), { status: "unsupported-binding", rootKind: "not-reached" });
      expect(proxy.trap).not.toHaveBeenCalled();
    },
  );

  it("keeps absence and safe duplicate ids separate without reading either payload", () => {
    assertShape(synthetic().getCachedParameterShape(2731), { status: "cache-absent", rootKind: "not-reached" });
    const device = shaped({});
    const getter = vi.fn(() => {
      throw new Error("private-holder-value");
    });
    Object.defineProperty(device.getProperty("recordingQuality")!, "value", { get: getter });
    internals(device).state.set("second", {
      name: "second",
      paramType: 2731,
      get value() {
        return getter();
      },
      ts: 0,
    });
    assertShape(device.getCachedParameterShape(2731), { status: "cache-multiple", rootKind: "not-reached" });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["holder", "root", "selected", "quality"])("refuses %s proxies without any traps", (position) => {
    for (const revoked of [false, true]) {
      const proxy = trapProxy(revoked);
      const device = shaped(
        position === "root"
          ? proxy.value
          : {
              cur_mode: 0,
              mode_0: position === "selected" ? proxy.value : { quality: position === "quality" ? proxy.value : 2 },
            },
      );
      if (position === "holder") internals(device).state.set("recordingQuality", proxy.value as PropertyValue);
      assertShape(device.getCachedParameterShape(2731), {
        status: "inspection-refused",
        refusal: "proxy",
        decoderDecision: "refused",
      });
      expect(proxy.trap).not.toHaveBeenCalled();
    }
  });

  it.each(["paramType", "name", "value"])("guards matching holder %s descriptors", (field) => {
    for (const slot of ["missing", "accessor", "inherited"] as const) {
      const device = shaped({});
      const holder = device.getProperty("recordingQuality")!;
      const getter = vi.fn(() => {
        throw new Error("private-holder-canary");
      });
      delete (holder as unknown as Record<string, unknown>)[field];
      if (slot === "accessor") Object.defineProperty(holder, field, { get: getter });
      if (slot === "inherited") Object.defineProperty(Object.prototype, field, { get: getter, configurable: true });
      try {
        assertShape(device.getCachedParameterShape(2731), {
          status: "inspection-refused",
          refusal: `holder-${slot}-field`,
          rootKind: "not-reached",
        });
        expect(getter).not.toHaveBeenCalled();
      } finally {
        if (slot === "inherited") delete (Object.prototype as Record<string, unknown>)[field];
      }
    }
  });

  it.each([0, -1, "2731", NaN, Infinity, -Infinity, 1.5, 9007199254740992, 1e21, undefined, null])(
    "rejects invalid held id %s",
    (id) => {
      const device = shaped({});
      (device.getProperty("recordingQuality") as unknown as Record<string, unknown>).paramType = id;
      assertShape(device.getCachedParameterShape(2731), {
        status: "inspection-refused",
        refusal: "holder-invalid-field",
        rootKind: "not-reached",
      });
    },
  );

  it("refuses an unrelated unsafe holder before assuming its id is non-target", () => {
    const device = synthetic();
    const getter = vi.fn(() => {
      throw new Error("private-unrelated-id");
    });
    internals(device).state.set("other", {
      name: "other",
      get paramType() {
        return getter();
      },
      value: 1,
      ts: 0,
    });
    internals(device).state.set("target", {
      name: "target",
      paramType: 2731,
      value: { mode_0: { quality: 1 } },
      ts: 0,
    });
    assertShape(device.getCachedParameterShape(2731), {
      status: "inspection-refused",
      refusal: "holder-accessor-field",
      rootKind: "not-reached",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects mismatched names and nonplain holders before reading payloads", () => {
    const device = shaped({});
    device.getProperty("recordingQuality")!.name = "other";
    assertShape(device.getCachedParameterShape(2731), { refusal: "holder-invalid-field" });
    Object.setPrototypeOf(device.getProperty("recordingQuality")!, { private_marker: true });
    assertShape(device.getCachedParameterShape(2731), { refusal: "nonplain-prototype", rootKind: "not-reached" });
  });

  it.each([
    [undefined, "undefined"],
    [null, "null"],
    [false, "boolean"],
    [2, "finite-number"],
    [NaN, "nonfinite-number"],
    [Infinity, "nonfinite-number"],
    ["2", "numeric-string"],
    ["high", "string"],
    [[], "array"],
    [2n, "unsupported"],
    [() => {}, "unsupported"],
  ])("classifies scalar/array roots without a nested decision (%s)", (value, kind) => {
    assertShape(shaped(value).getCachedParameterShape(2731), {
      status: "root-not-record",
      rootKind: kind as CachedParameterShapeEvidence["rootKind"],
      modeSlot: "not-reached",
      qualityDomain: "not-reached",
      decoderDecision: "not-reached",
    });
  });

  it.each([
    0,
    -0,
    1,
    2,
    -2,
    NaN,
    Infinity,
    -Infinity,
    "1",
    "0x10",
    "1e2",
    "",
    " ",
    "private-mode",
    true,
    false,
    null,
    undefined,
  ])("matches safe Number(mode)||0 mechanics without exporting it (%s)", (mode) => {
    const number = Number(mode);
    const key = `mode_${number || 0}`;
    const value = { cur_mode: mode, [key]: { quality: 2 }, private_marker: "private-payload" };
    const result = shaped(value).getCachedParameterShape(2731);
    assertShape(result, {
      status: "inspected",
      modeSlot: "own-data",
      modeConversion: !number ? "fallback" : typeof mode === "number" ? "direct-number" : "coerced-primitive",
      selectedSlot: "own-data",
      qualityDomain: "in-domain",
      decoderDecision: "would-accept-numeric-tier",
    });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("distinguishes missing mode, selected and quality slots from present undefined", () => {
    assertShape(shaped({ mode_0: { quality: 1 } }).getCachedParameterShape(2731), {
      modeSlot: "missing",
      modeKind: "undefined",
      modeConversion: "fallback",
      decoderDecision: "would-accept-numeric-tier",
    });
    assertShape(shaped({ cur_mode: 1 }).getCachedParameterShape(2731), {
      selectedSlot: "missing",
      selectedKind: "not-reached",
      qualitySlot: "not-reached",
      decoderDecision: "unavailable",
    });
    assertShape(shaped({ mode_0: {} }).getCachedParameterShape(2731), {
      qualitySlot: "missing",
      qualityKind: "not-reached",
      qualityDomain: "not-reached",
      decoderDecision: "unavailable",
    });
    assertShape(shaped({ mode_0: { quality: undefined } }).getCachedParameterShape(2731), {
      qualitySlot: "own-data",
      qualityKind: "undefined",
      qualityDomain: "not-numeric",
      decoderDecision: "would-reject-nonnumeric-quality",
    });
  });

  it.each(["mode", "selected", "quality"])("never evaluates %s accessors/inherited slots", (position) => {
    for (const inherited of [false, true]) {
      const getter = vi.fn(() => {
        throw new Error("private-slot-getter");
      });
      const nested: Record<string, unknown> = { quality: 2 };
      const root: Record<string, unknown> = { cur_mode: 0, mode_0: nested };
      const object = position === "quality" ? nested : root;
      const key = position === "mode" ? "cur_mode" : position === "selected" ? "mode_0" : "quality";
      delete object[key];
      Object.defineProperty(inherited ? Object.prototype : object, key, { get: getter, configurable: true });
      try {
        const result = shaped(root).getCachedParameterShape(2731);
        assertShape(result, {
          status: "inspection-refused",
          refusal: inherited ? "inherited-slot" : "accessor-slot",
          rootKind: "record",
          decoderDecision: "refused",
        });
        expect(
          result[position === "mode" ? "modeSlot" : position === "selected" ? "selectedSlot" : "qualitySlot"],
        ).toBe(inherited ? "inherited" : "accessor");
        expect(getter).not.toHaveBeenCalled();
      } finally {
        if (inherited) delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  });

  it.each([null, undefined, false, 2, "private-selected", () => {}, 1n])(
    "keeps nonrecord selected %s unavailable",
    (selected) => {
      assertShape(shaped({ mode_0: selected }).getCachedParameterShape(2731), {
        status: "inspected",
        selectedSlot: "own-data",
        qualitySlot: "not-reached",
        decoderDecision: "unavailable",
      });
    },
  );

  it("refuses selected arrays and nonplain containers without consulting quality", () => {
    const getter = vi.fn(() => {
      throw new Error("private-quality-getter");
    });
    const selected: unknown[] = [];
    Object.defineProperty(selected, "quality", { get: getter });
    assertShape(shaped({ mode_0: selected }).getCachedParameterShape(2731), {
      refusal: "unsupported-container",
      selectedSlot: "own-data",
      selectedKind: "array",
      qualitySlot: "not-reached",
    });
    assertShape(shaped(new Date()).getCachedParameterShape(2731), {
      refusal: "nonplain-prototype",
      rootKind: "not-reached",
    });
    assertShape(shaped({ mode_0: new Date() }).getCachedParameterShape(2731), {
      refusal: "nonplain-prototype",
      rootKind: "record",
      selectedSlot: "own-data",
      selectedKind: "not-reached",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("accepts null-prototype records and ignores arbitrary unrelated contents", () => {
    const root = Object.assign(Object.create(null), { mode_0: Object.assign(Object.create(null), { quality: 3 }) });
    const getter = vi.fn(() => {
      throw new Error("private-unrelated-getter");
    });
    Object.defineProperty(root, "private_marker", { get: getter });
    assertShape(shaped(root).getCachedParameterShape(2731), {
      status: "inspected",
      decoderDecision: "would-accept-numeric-tier",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    [1, "finite-number", "in-domain", "would-accept-numeric-tier"],
    [2, "finite-number", "in-domain", "would-accept-numeric-tier"],
    [3, "finite-number", "in-domain", "would-accept-numeric-tier"],
    [0, "finite-number", "outside-domain", "would-reject-numeric-tier"],
    [128, "finite-number", "outside-domain", "would-reject-numeric-tier"],
    [NaN, "nonfinite-number", "outside-domain", "would-reject-numeric-tier"],
    [Infinity, "nonfinite-number", "outside-domain", "would-reject-numeric-tier"],
    ["2", "numeric-string", "in-domain", "would-reject-nonnumeric-quality"],
    ["1e2", "numeric-string", "outside-domain", "would-reject-nonnumeric-quality"],
    ["0x2", "string", "not-numeric", "would-reject-nonnumeric-quality"],
    ["1e999", "string", "not-numeric", "would-reject-nonnumeric-quality"],
    ["private-quality", "string", "not-numeric", "would-reject-nonnumeric-quality"],
    ["2".repeat(129), "string", "not-numeric", "would-reject-nonnumeric-quality"],
    [null, "null", "not-numeric", "would-reject-nonnumeric-quality"],
    [false, "boolean", "not-numeric", "would-reject-nonnumeric-quality"],
    [[], "array", "not-numeric", "would-reject-nonnumeric-quality"],
    [{}, "record", "not-numeric", "would-reject-nonnumeric-quality"],
    [2n, "unsupported", "not-numeric", "would-reject-nonnumeric-quality"],
  ])("classifies nested quality without widening decoder acceptance (%s)", (value, kind, domain, decision) => {
    assertShape(shaped({ mode_0: { quality: value } }).getCachedParameterShape(2731), {
      status: "inspected",
      qualitySlot: "own-data",
      qualityKind: kind as CachedParameterShapeEvidence["qualityKind"],
      qualityDomain: domain as CachedParameterShapeEvidence["qualityDomain"],
      decoderDecision: decision as CachedParameterShapeEvidence["decoderDecision"],
    });
  });

  it("never coerces mode objects and bounds text before conversion", () => {
    const hook = vi.fn(() => {
      throw new Error("private-coercion-canary");
    });
    for (const mode of [
      { valueOf: hook, toString: hook, toJSON: hook, [Symbol.toPrimitive]: hook },
      [],
      () => {},
      2n,
      Symbol(),
    ])
      assertShape(shaped({ cur_mode: mode }).getCachedParameterShape(2731), {
        refusal: "unsupported-mode-type",
        modeSlot: "own-data",
        modeConversion: "refused",
        selectedSlot: "not-reached",
      });
    assertShape(shaped({ cur_mode: "1".repeat(129) }).getCachedParameterShape(2731), {
      refusal: "mode-text-bound",
      modeKind: "string",
      modeConversion: "refused",
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it("refuses a different canonical read holder by identity without touching its unsafe value", () => {
    const device = shaped({});
    const canonical = device.getProperty("recordingQuality")!;
    canonical.paramType = 6046;
    const getter = vi.fn(() => {
      throw new Error("private-other-holder-value");
    });
    Object.defineProperty(canonical, "value", { get: getter });
    internals(device).state.set("unknown_2731", {
      name: "unknown_2731",
      paramType: 2731,
      value: { mode_0: { quality: 2 } },
      ts: 0,
    });
    assertShape(device.getCachedParameterShape(2731), {
      refusal: "projection-binding",
      rootKind: "record",
      qualityDomain: "in-domain",
      qualityKind: "finite-number",
      decoderDecision: "refused",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("permits an absent canonical slot or absent admitted schema without inventing a projection", () => {
    const device = shaped({ mode_0: { quality: 2 } });
    const holder = device.getProperty("recordingQuality")!;
    internals(device).state.delete("recordingQuality");
    holder.name = "unknown_2731";
    internals(device).state.set(holder.name, holder);
    assertShape(device.getCachedParameterShape(2731), {
      status: "inspected",
      decoderDecision: "would-accept-numeric-tier",
    });
    expect(device.getPropertyValue("recordingQuality")).toBeUndefined();
    const unknown = synthetic();
    internals(unknown).state.set("unknown_2731", holder);
    assertShape(unknown.getCachedParameterShape(2731), { status: "inspected", qualityDomain: "in-domain" });
  });

  it.each([
    "name",
    "paramType",
    "type",
    "raw",
    "decode",
    "readAliases",
    "readsFrom",
    "property",
    "unexposed",
    "invert",
    "kind",
    "unit",
    "enumValues",
    "provenance",
    "writable",
    "description",
    "private_extra",
  ])("fails closed on changed/accessor canonical metadata %s", (field) => {
    for (const accessor of [false, true]) {
      const device = shaped({ mode_0: { quality: 2 } });
      const spec = internals(device).specByParam.get(2731)!.spec;
      const getter = vi.fn(() => {
        throw new Error("private-metadata-getter");
      });
      if (accessor) Object.defineProperty(spec, field, { get: getter, configurable: true });
      else (spec as unknown as Record<string, unknown>)[field] = "private-changed-metadata";
      assertShape(device.getCachedParameterShape(2731), { refusal: "projection-binding", qualityDomain: "in-domain" });
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it("refuses proxy or mismatched admitted metadata without reflecting it", () => {
    const device = shaped("high");
    const proxy = trapProxy();
    internals(device).specByParam.set(2731, proxy.value as { spec: PropertySpec; invert: boolean });
    assertShape(device.getCachedParameterShape(2731), {
      refusal: "projection-binding",
      rootKind: "string",
      modeSlot: "not-reached",
    });
    expect(proxy.trap).not.toHaveBeenCalled();
    const other = shaped({ mode_0: { quality: 2 } });
    internals(other).specByName.set("recordingQuality", { ...internals(other).specByParam.get(2731)!.spec });
    assertShape(other.getCachedParameterShape(2731), { refusal: "projection-binding", qualityDomain: "in-domain" });
  });

  it("refuses a changed member alias/borrow/decoder without executing it", () => {
    for (const field of [
      "property",
      "readsFrom",
      "readAliases",
      "decode",
      "available",
      "readAvailable",
      "enumValuesFor",
      "coerce",
      "kind",
      "unit",
      "enumValues",
      "provenance",
      "invert",
      "write",
      "writtenElsewhere",
      "description",
      "decodedKind",
      "decodedValues",
      "private_extra",
    ] as const) {
      const device = shaped({ mode_0: { quality: 2 } });
      const original = Object.getOwnPropertyDescriptor(CAMERA_MEMBERS.recordingQuality, field);
      const getter = vi.fn(() => {
        throw new Error("private-member-getter");
      });
      Object.defineProperty(CAMERA_MEMBERS.recordingQuality, field, { get: getter, configurable: true });
      try {
        assertShape(device.getCachedParameterShape(2731), {
          refusal: "projection-binding",
          qualityDomain: "in-domain",
        });
        expect(getter).not.toHaveBeenCalled();
      } finally {
        if (original) Object.defineProperty(CAMERA_MEMBERS.recordingQuality, field, original);
        else delete (CAMERA_MEMBERS.recordingQuality as unknown as Record<string, unknown>)[field];
      }
    }
  });

  it.each(["readAvailable", "enumValuesFor", "coerce"])(
    "refuses a newly inserted %s callback without executing it",
    (field) => {
      const device = shaped({ mode_0: { quality: 2 } });
      const callback = vi.fn(() => {
        throw new Error("private-metadata-callback");
      });
      Object.defineProperty(CAMERA_MEMBERS.recordingQuality, field, { value: callback, configurable: true });
      try {
        assertShape(device.getCachedParameterShape(2731), {
          refusal: "projection-binding",
          qualityDomain: "in-domain",
          decoderDecision: "refused",
        });
        expect(callback).not.toHaveBeenCalled();
      } finally {
        delete (CAMERA_MEMBERS.recordingQuality as unknown as Record<string, unknown>)[field];
      }
    },
  );

  it.each(["readAvailable", "enumValuesFor", "coerce", "kind", "unit", "writtenElsewhere"])(
    "refuses inherited canonical metadata %s without evaluating it",
    (field) => {
      const device = shaped({ mode_0: { quality: 2 } });
      const getter = vi.fn(() => {
        throw new Error("private-inherited-metadata");
      });
      Object.defineProperty(Object.prototype, field, { get: getter, configurable: true });
      try {
        assertShape(device.getCachedParameterShape(2731), {
          refusal: "projection-binding",
          qualityDomain: "in-domain",
        });
        expect(getter).not.toHaveBeenCalled();
      } finally {
        delete (Object.prototype as Record<string, unknown>)[field];
      }
    },
  );

  it.each(["decodedValues", "enumValues"] as const)("refuses replaced %s proxies without metadata traps", (field) => {
    const device = shaped({ mode_0: { quality: 2 } });
    const original = Object.getOwnPropertyDescriptor(CAMERA_MEMBERS.recordingQuality, field)!;
    const proxy = trapProxy();
    Object.defineProperty(CAMERA_MEMBERS.recordingQuality, field, { value: proxy.value, configurable: true });
    try {
      assertShape(device.getCachedParameterShape(2731), { refusal: "projection-binding", qualityDomain: "in-domain" });
      expect(proxy.trap).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(CAMERA_MEMBERS.recordingQuality, field, original);
    }
  });

  it.each(["decodedValues", "enumValues"] as const)("refuses mutated %s slots without evaluating getters", (field) => {
    const device = shaped({ mode_0: { quality: 2 } });
    const table = CAMERA_MEMBERS.recordingQuality[field];
    const key = field === "decodedValues" ? "0" : "1";
    const original = Object.getOwnPropertyDescriptor(table, key)!;
    const getter = vi.fn(() => {
      throw new Error("private-nested-metadata");
    });
    Object.defineProperty(table, key, { get: getter, configurable: true });
    try {
      assertShape(device.getCachedParameterShape(2731), { refusal: "projection-binding", qualityDomain: "in-domain" });
      expect(getter).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(table, key, original);
    }
  });

  it("refuses an overridden numeric-domain array method before legacy .some can execute", () => {
    const device = shaped({ mode_0: { quality: 2 } });
    const callback = vi.fn(() => {
      throw new Error("private-array-method");
    });
    Object.defineProperty(CAMERA_MEMBERS.recordingQuality.decodedValues, "some", {
      value: callback,
      configurable: true,
    });
    try {
      assertShape(device.getCachedParameterShape(2731), { refusal: "projection-binding", qualityDomain: "in-domain" });
      expect(callback).not.toHaveBeenCalled();
    } finally {
      delete (CAMERA_MEMBERS.recordingQuality.decodedValues as unknown as Record<string, unknown>).some;
    }
  });

  it("is detached, state-preserving and independent of query APIs, actions and timers", async () => {
    const device = shaped({ cur_mode: 0, mode_0: { quality: 2 } });
    bind(device, [2731]);
    const holder = device.getProperty("recordingQuality")!;
    const initial = JSON.stringify(holder);
    const getter = vi.fn(() => {
      throw new Error("private-fluent-getter");
    });
    Object.defineProperty(device.camera?.()!, "recordingQuality", { get: getter, configurable: true });
    const refresh = vi.fn(async () => {});
    device.setFreshnessPolicy({ staleAfterMs: -1, refresh });
    const spies = ["getCachedEvidence", "describe", "getPropertyValue", "getProperty", "getProperties", "toJSON"].map(
      (method) =>
        vi.spyOn(device, method as "getProperties").mockImplementation(() => {
          throw new Error("private-query-canary");
        }),
    );
    const timer = vi.spyOn(globalThis, "setTimeout");
    const result = device.getCachedParameterShape(2731) as {
      -readonly [K in keyof CachedParameterShapeEvidence]: CachedParameterShapeEvidence[K];
    };
    assertShape(result, { status: "inspected", decoderDecision: "would-accept-numeric-tier" });
    result.rootKind = "unsupported";
    expect(device.getCachedParameterShape(2731).rootKind).toBe("record");
    expect(JSON.stringify(holder)).toBe(initial);
    await Promise.resolve();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    expect(sink.dispatch).not.toHaveBeenCalled();
    const serialized = JSON.stringify(device.getCachedParameterShape(2731));
    for (const marker of [
      serial,
      "T8425",
      "recordingQuality",
      "paramType",
      "cur_mode",
      "mode_0",
      'quality"',
      "numericValue",
      "timestamp",
      "private-",
    ])
      expect(serialized).not.toContain(marker);
  });

  it.each(["T8425", "T8170", "T8410"])("does not select semantics by HomeBase/model family (%s)", (model) => {
    assertShape(shaped({ mode_0: { quality: 2 } }, model).getCachedParameterShape(2731), {
      status: "inspected",
      qualityDomain: "in-domain",
      decoderDecision: "would-accept-numeric-tier",
    });
  });
});
