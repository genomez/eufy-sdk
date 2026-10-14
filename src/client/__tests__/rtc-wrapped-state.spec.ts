import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { DeviceRegistry } from "../device-registry.js";
import { rtcStateParameters } from "../rtc-state.js";
import { RtcCommandRouter } from "../../transport/rtc/command-router.js";
import { buildPortalHeader, parsePortalPacket } from "../../transport/rtc/portal-packet.js";
import type { PortalResponse } from "../../transport/rtc/portal-packet.js";
import type { EufyDevice } from "../../core/types.js";
import { Device } from "../../model/device.js";
import { EufyMega } from "../eufy-mega.js";

const HUB = "synthetic-hub";
const CHILD = "synthetic-child";
const ELSEWHERE = "synthetic-other-hub";
const SECOND = "synthetic-second-child";
function roster(): EufyDevice[] {
  return [
    { sn: HUB, model: "T9000", raw: {} },
    { sn: CHILD, model: "T8900", stationSn: HUB, raw: { parent_sn: HUB, device_channel: 0 } },
    { sn: ELSEWHERE, model: "T9000", raw: {} },
  ] as EufyDevice[];
}
function registry(devices = roster()) {
  const out = new DeviceRegistry({} as never);
  (out as unknown as { devices: EufyDevice[] }).devices = devices;
  return out;
}
function parsed(data: unknown, outer = 1351, link = 3, response = 0): PortalResponse {
  const body = Buffer.from(JSON.stringify(data));
  return parsePortalPacket(Buffer.concat([buildPortalHeader(outer, body.length, 77, 0, response), body]), link)!;
}
const parameter = (owner: Record<string, unknown> = { dev_type: 0 }, value: unknown = 1) => ({
  ...owner,
  param_type: 1550,
  param_value: value,
});
const envelope = (payload: unknown) => ({ cmd: 1103, payload });
const directControl = (frame: PortalResponse) => ({ ...frame, commandId: 1103 });

describe("qualified wrapped passive information", () => {
  it("admits exact wrapped information and preserves the same direct control", () => {
    const payload = { params: [parameter()] };
    const frame = parsed(envelope(payload));
    expect(frame).toMatchObject({ commandId: 1351, cmd: 1103, linkType: 3, isResponse: 0, data: envelope(payload) });
    expect(rtcStateParameters(HUB, frame, registry())).toEqual(new Map([[CHILD, { 1550: "1" }]]));
    // Direct information retains the same ownership and value mapping.
    expect(rtcStateParameters(HUB, directControl(frame), registry())).toEqual(new Map([[CHILD, { 1550: "1" }]]));
  });
  it.each([1, 3])("preserves direct 1103 compatibility on link %i", (link) => {
    expect(rtcStateParameters(HUB, parsed({ params: [parameter()] }, 1103, link), registry())).toEqual(
      new Map([[CHILD, { 1550: "1" }]]),
    );
  });
  it.each([
    { label: "string", cmd: "1103" },
    { label: "array", cmd: [1103] },
  ])("refuses parser command coercion at the raw command guard: $label", ({ label, cmd }) => {
    const frame = parsed({ cmd, payload: { params: [parameter()] } });
    expect(frame.cmd).toBe(1103);
    expect(typeof (frame.data as { cmd: unknown }).cmd).not.toBe("number");
    if (label === "array") expect(Array.isArray((frame.data as { cmd: unknown }).cmd)).toBe(true);
    expect(rtcStateParameters(HUB, frame, registry()).size).toBe(0);
  });
  it.each([
    { label: "wrong inner command", data: { cmd: 1104, payload: { params: [parameter()] } }, link: 3, response: 0 },
    { label: "missing inner command", data: { payload: { params: [parameter()] } }, link: 3, response: 0 },
    { label: "wrong link", data: envelope({ params: [parameter()] }), link: 1, response: 0 },
    { label: "response ACK", data: envelope({ params: [parameter()] }), link: 3, response: 1 },
    { label: "text payload", data: envelope("not-json"), link: 3, response: 0 },
    { label: "array envelope", data: [envelope({ params: [parameter()] })], link: 3, response: 0 },
  ])("keeps $label refused at the qualified wrapped gate", ({ data, link, response }) => {
    expect(rtcStateParameters(HUB, parsed(data, 1351, link, response), registry()).size).toBe(0);
  });
});

describe("existing owner and payload guards through the repaired wrapped path", () => {
  const invalidOwners = [
    {},
    { channel: "0" },
    { channel: null },
    { channel: -1 },
    { channel: 0.5 },
    { channel: 42 },
    { channel: 0, device_channel: 255 },
    { channel: 0, dev_type: 255 },
    { device_sn: CHILD, dev_sn: HUB },
    { device_sn: CHILD, channel: 255 },
    { device_sn: ELSEWHERE },
    { device_sn: "synthetic-absent" },
    { device_sn: null, channel: 0 },
  ];
  it.each(invalidOwners)("refuses invalid ownership %j after wrapped admission", (owner) => {
    const frame = parsed(envelope({ params: [parameter(owner)] }));
    expect(rtcStateParameters(HUB, frame, registry()).size).toBe(0);
    expect(rtcStateParameters(HUB, directControl(frame), registry()).size).toBe(0);
  });
  it("accepts agreeing explicit aliases and both station markers without using header channel", () => {
    const frame = parsed(
      envelope({
        params: [
          parameter({ device_sn: CHILD, dev_sn: CHILD, dev_type: 0, channel: 0 }),
          { ...parameter({ dev_type: 255 }), param_type: 1224 },
          { ...parameter({ channel: 1000 }), param_type: 1225 },
        ],
      }),
    );
    expect(rtcStateParameters(HUB, frame, registry())).toEqual(
      new Map([
        [CHILD, { 1550: "1" }],
        [HUB, { 1224: "1", 1225: "1" }],
      ]),
    );
  });
  it.each([false, true])("rejects channel ambiguity regardless of roster order %j", (reverse) => {
    const devices = roster();
    devices.push({ ...devices[1]!, sn: SECOND });
    if (reverse) devices.reverse();
    expect(rtcStateParameters(HUB, parsed(envelope({ params: [parameter()] })), registry(devices)).size).toBe(0);
  });
  it("does not accept a removed target from a stale explicit identifier", () => {
    expect(
      rtcStateParameters(
        HUB,
        parsed(envelope({ params: [parameter({ device_sn: CHILD })] })),
        registry(roster().filter((device) => device.sn !== CHILD)),
      ).size,
    ).toBe(0);
  });
  it.each(["unknown", "non-S1"])("rejects %s parent", (kind) => {
    const devices = roster();
    if (kind === "non-S1") devices[0]!.model = "T8010";
    expect(
      rtcStateParameters(
        kind === "unknown" ? "synthetic-absent" : HUB,
        parsed(envelope({ params: [parameter()] })),
        registry(devices),
      ).size,
    ).toBe(0);
  });
  it.each([
    { label: "null list", params: null },
    { label: "empty list", params: [] },
    { label: "null entry", params: [null] },
    { label: "primitive entry", params: [1] },
    { label: "4097 entry list", params: Array.from({ length: 4097 }, () => parameter()) },
  ])("refuses malformed or unbounded parameter list: $label", ({ label, params }) => {
    if (label === "4097 entry list") expect(params).toHaveLength(4097);
    expect(rtcStateParameters(HUB, parsed(envelope({ params })), registry()).size).toBe(0);
  });
  it.each(["!!!!", "/w==", "Zh==", 123])("refuses invalid bypass data %j", (value) => {
    expect(
      rtcStateParameters(HUB, parsed(envelope({ db_bypass_str: [parameter({ channel: 0 }, value)] })), registry()).size,
    ).toBe(0);
  });
  it("accepts only qualified valid UTF8 bypass bytes", () => {
    expect(
      rtcStateParameters(
        HUB,
        parsed(envelope({ db_bypass_str: [parameter({ channel: 0 }, Buffer.from("1\0").toString("base64"))] })),
        registry(),
      ),
    ).toEqual(new Map([[CHILD, { 1550: "1" }]]));
  });
  it("refuses competing outer information instead of selecting it over the nested payload", () => {
    const frame = parsed({ cmd: 1103, params: [parameter({ dev_type: 255 }, 0)], payload: { params: [parameter()] } });
    expect(rtcStateParameters(HUB, frame, registry()).size).toBe(0);
  });
});

describe("exact wrapped envelope boundaries", () => {
  it.each([
    { label: "string payload", payload: JSON.stringify({ params: [parameter()] }) },
    { label: "null payload", payload: null },
    { label: "array payload", payload: [{ params: [parameter()] }] },
    { label: "deeper payload only", payload: { payload: { params: [parameter()] } } },
    {
      label: "malformed list with valid deeper payload",
      payload: { params: null, payload: { params: [parameter()] } },
    },
    { label: "valid params but malformed bypass", payload: { params: [parameter()], db_bypass_str: null } },
  ])("refuses $label", ({ payload }) => {
    expect(rtcStateParameters(HUB, parsed(envelope(payload)), registry()).size).toBe(0);
  });
  it.each(["params", "db_bypass_str"])("refuses even a malformed competing outer %s", (key) => {
    expect(
      rtcStateParameters(HUB, parsed({ ...envelope({ params: [parameter()] }), [key]: null }), registry()).size,
    ).toBe(0);
  });
  it.each(["cmd", "payload"])("refuses inherited envelope %s", (key) => {
    const data: Record<string, unknown> = { cmd: 1103, payload: { params: [parameter()] } };
    const inherited = Object.create({ [key]: data[key] }) as Record<string, unknown>;
    Object.assign(inherited, data);
    delete inherited[key];
    const frame = { ...parsed(envelope({ params: [parameter()] })), data: inherited };
    expect(rtcStateParameters(HUB, frame, registry()).size).toBe(0);
  });
  it.each(["params", "db_bypass_str"])("refuses an inherited unvalidated %s beside another own valid list", (key) => {
    const other = key === "params" ? "db_bypass_str" : "params";
    const value = key === "db_bypass_str" ? Buffer.from("1").toString("base64") : 1;
    const ownValue = other === "db_bypass_str" ? Buffer.from("1").toString("base64") : 1;
    const payload = Object.assign(Object.create({ [key]: [parameter({ channel: 0 }, value)] }), {
      [other]: [parameter({ channel: 0 }, ownValue)],
    });
    const frame = { ...parsed(envelope({ params: [] })), data: envelope(payload) };
    expect(rtcStateParameters(HUB, frame, registry()).size).toBe(0);
  });
  it.each([
    { label: "parsed cmd mismatches raw", frameCmd: 1104, rawCmd: 1103 },
    { label: "raw cmd mismatches parsed", frameCmd: 1103, rawCmd: 1104 },
    { label: "fractional raw cmd", frameCmd: 1103, rawCmd: 1103.5 },
  ])("refuses $label", ({ frameCmd, rawCmd }) => {
    const frame = parsed(envelope({ params: [parameter()] }));
    expect(
      rtcStateParameters(
        HUB,
        { ...frame, cmd: frameCmd, data: { cmd: rawCmd, payload: { params: [parameter()] } } },
        registry(),
      ).size,
    ).toBe(0);
  });
  it("admits the maximum4096 entries without inventing duplicate parameter state", () => {
    const params = Array.from({ length: 4096 }, () => parameter());
    expect(rtcStateParameters(HUB, parsed(envelope({ params })), registry())).toEqual(
      new Map([[CHILD, { 1550: "1" }]]),
    );
  });
  it("preserves direct helper nested/string compatibility and the unrestricted direct link predicate", () => {
    const frame = parsed({ payload: JSON.stringify({ params: [parameter()] }) }, 1103, 3);
    expect(rtcStateParameters(HUB, { ...frame, linkType: 99 }, registry())).toEqual(new Map([[CHILD, { 1550: "1" }]]));
  });
});

describe("wrapped state through the real facade", () => {
  it("updates the model and overlay while duplicate reports retain observations without duplicate changes", async () => {
    const eufy = new EufyMega({
      email: "test@example.com",
      password: "synthetic",
      autoRealtime: false,
      pollMs: 0,
      storedSnapshotCache: false,
    });
    const internals = eufy as unknown as {
      registry: DeviceRegistry;
      rtc: { deps: { onFrame: (sn: string, frame: PortalResponse) => void } };
      liveDevices: Map<string, WeakRef<Device>>;
      boundParamIds: Map<string, ReadonlySet<number>>;
    };
    const devices = roster();
    devices[1] = { ...devices[1]!, model: "T8425", raw: { parent_sn: HUB, device_channel: 0, device_type: 47 } };
    (internals.registry as unknown as { devices: EufyDevice[] }).devices = devices;
    const device = Device.fromRecord(CHILD, {
      model: "T8425",
      deviceType: 47,
      category: "eufy_security",
      params: { 1400: "0" },
    });
    internals.liveDevices.set(CHILD, new WeakRef(device));
    internals.boundParamIds.set(CHILD, new Set([1400]));
    const changes: unknown[] = [];
    const observations: unknown[] = [];
    const receipts: unknown[] = [];
    eufy.on("propertyChanged", (event) => changes.push(event));
    eufy.on("deviceState", (event) => observations.push(event));
    eufy.on("propertiesObserved", (event) => receipts.push(event));
    try {
      const report = parsed(
        envelope({ params: [{ ...parameter({ device_sn: CHILD, dev_type: 0 }), param_type: 1400 }] }),
      );
      internals.rtc.deps.onFrame(HUB, report);
      internals.rtc.deps.onFrame(HUB, report);
      expect(device.getProperty("light")?.value).toBe(true);
      expect(internals.registry.hasRealtimeState(CHILD)).toBe(true);
      expect(changes).toEqual([{ deviceSn: CHILD, property: "light", value: true }]);
      expect(observations).toHaveLength(2);
      expect(receipts).toHaveLength(2);
      expect(receipts[0]).toMatchObject({ deviceSn: CHILD, source: "rtc", properties: { light: true } });
      internals.rtc.deps.onFrame(HUB, { ...report, cmd: 1104 });
      internals.rtc.deps.onFrame(ELSEWHERE, report);
      expect(changes).toHaveLength(1);
      expect(observations).toHaveLength(2);
      expect(receipts).toHaveLength(2);
    } finally {
      await eufy.disconnect();
    }
  });
});

class FakeSession extends EventEmitter {
  isConnected = false;
  async connect() {
    this.isConnected = true;
    this.emit("connected");
  }
  close() {
    this.isConnected = false;
    this.emit("close");
  }
}
describe("current-session ownership before facade admission", () => {
  it("forwards current wrapped frames but drops a late retired session and a disconnected current session", async () => {
    const sessions: FakeSession[] = [];
    const received: PortalResponse[] = [];
    const router = new RtcCommandRouter({
      identity: () => ({ authToken: "synthetic", userId: "synthetic" }),
      accountName: () => "synthetic",
      shard: () => "synthetic",
      findDevice: (sn) => roster().find((device) => device.sn === sn),
      createSession: () => {
        const session = new FakeSession();
        sessions.push(session);
        return session as never;
      },
      onFrame: (_sn, frame) => received.push(frame),
    });
    const body = Buffer.from(JSON.stringify(envelope({ params: [parameter()] })));
    const wire = Buffer.concat([buildPortalHeader(1351, body.length, 77, 0, 0), body]);
    const lease = await router.sessionFor(HUB);
    sessions[0]!.emit("commandData", wire, 3);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ commandId: 1351, cmd: 1103 });
    sessions[0]!.close();
    sessions[0]!.isConnected = true;
    sessions[0]!.emit("commandData", wire, 3);
    expect(received).toHaveLength(1);
    const replacement = await router.sessionFor(HUB);
    sessions[1]!.emit("commandData", wire, 3);
    expect(received).toHaveLength(2);
    sessions[1]!.isConnected = false;
    sessions[1]!.emit("commandData", wire, 3);
    expect(received).toHaveLength(2);
    lease.release();
    replacement.release();
    router.close();
  });
});
