import { describe, expect, it, vi } from "vitest";
import { Device } from "../model/device.js";
import { buildCommand } from "../model/capabilities/index.js";
import { bind } from "../model/capabilities/__tests__/bind.js";
import { rotateCommand, type PtzActions, type PtzDirection } from "../model/capabilities/ptz.js";
import type { CommandContext } from "../model/capabilities/types.js";
import type { MediaProvider } from "../core/contracts.js";
import {
  connectedSession,
  routerWithSession,
  ACCOUNT_ID,
  DEVICE_SN,
  STATION_SN,
} from "../transport/p2p/__tests__/session-fixtures.js";

const models = [
  { model: "T8425", deviceType: 47, channel: 3, attached: true },
  { model: "T8170", deviceType: 48, channel: 3, attached: true },
  { model: "T8426", deviceType: 87, channel: 4, attached: true },
  { model: "T8416", deviceType: 104, channel: 5, attached: true },
  { model: "T8171", deviceType: 88, channel: 0, attached: false },
];
const directions: Array<[PtzDirection, number]> = [
  ["left", 1],
  ["right", 2],
  ["up", 3],
  ["down", 4],
];
const context = (device: (typeof models)[number]): CommandContext => ({
  ...device,
  codec: "camera",
  capabilities: new Set(["ptz"]),
  paramIds: new Set(),
});

/** Connected in-memory sessions; no endpoint discovery or sockets are used. */
function wire(device: (typeof models)[number]) {
  const session = connectedSession(device.attached);
  const level1 = vi.fn<(command: number, json: string, channel: number) => void>();
  const level2 = vi.fn<(json: string, channel: number, command: number) => boolean>(() => true);
  Object.assign(session, { sendStringPayloadCommand: level1, sendRawLevel2: level2 });
  const stationSn = device.attached ? STATION_SN : DEVICE_SN;
  const raw = { device_channel: device.channel, member: { admin_user_id: ACCOUNT_ID } };
  const router = routerWithSession(session, {
    register: false,
    deps: {
      listDevices: () =>
        [
          { sn: DEVICE_SN, stationSn, model: device.model, raw },
          ...(device.attached ? [{ sn: STATION_SN, stationSn, model: "T9000", raw: { member: raw.member } }] : []),
        ] as never,
    },
  });
  (router as unknown as { manager: { register: (sn: string, value: unknown) => void } }).manager.register(
    stationSn,
    session,
  );
  return { router, session, level1, level2 };
}

describe.each(models)("$model type $deviceType PTZ", (device) => {
  it("detects from exact type with no model hints or reported preset params", () => {
    expect(Device.fromRecord(DEVICE_SN, { deviceType: device.deviceType }).has("ptz")).toBe(true);
  });

  it("publishes preset movement only when its wire is supported", () => {
    const dev = Device.fromRecord(DEVICE_SN, { model: device.model, deviceType: device.deviceType });
    dev.bindActions(context(device), { dispatch: async () => {} });
    const ptz = dev.describe().details.find((detail) => detail.accessor === "ptz")!;
    const actions = [...ptz.actions.map((action) => action.name), ...ptz.undescribedActions];
    expect(actions).toContain("left");
    expect(actions.includes("preset.preview")).toBe(device.deviceType !== 87);
  });

  it.each(directions)("sends byte-exact %s JSON on the resolved device channel", async (direction, code) => {
    const f = wire(device);
    const { acts, sent } = bind<PtzActions>("ptz", context(device));
    const expected =
      device.deviceType === 87
        ? `{"commandType":6030,"data":{"cmd_type":1,"rotate_type":${code}}}`
        : `{"commandType":6030,"data":{"cmd_type":1,"rotate_type":${code},"zoom":1}}`;
    const command = rotateCommand(direction, context(device));
    expect(command).toMatchObject({ channel: device.channel });
    await f.router.dispatchCommand(DEVICE_SN, command);
    if (device.attached) {
      expect(f.level2.mock.calls).toEqual([[expected, device.channel, 1700]]);
      expect(f.level1).not.toHaveBeenCalled();
    } else {
      expect(f.level1.mock.calls).toEqual([[1700, expected, device.channel]]);
      expect(f.level2).not.toHaveBeenCalled();
    }
    await acts[direction]();
    expect(sent).toEqual([command]);
  });

  if (device.deviceType !== 87) {
    it("preserves all preset command payloads, including the distinct preview motion command", async () => {
      const f = wire(device);
      const { acts, sent } = bind<PtzActions>("ptz", context(device));
      const preset = acts.preset!();
      await preset.preview(2);
      await preset.goto(2);
      await preset.save(2);
      await preset.delete(2);
      await preset.setDefault(2);
      expect(sent).toEqual([
        { kind: "set-json", param: 6035, data: { value: 2 }, channel: device.channel },
        { kind: "set-json", param: 6032, data: { settingstate: 0, value: 2 }, channel: device.channel },
        { kind: "set-json", param: 6097, data: { value: 2 }, channel: device.channel },
        { kind: "set-json", param: 6032, data: { settingstate: 0, value: 2 }, channel: device.channel },
        { kind: "set-json", param: 6033, data: { value: 2 }, channel: device.channel },
        { kind: "set-payload", cmd: 6242, payload: { index: 2, settingstate: 0 }, channel: device.channel },
      ]);
      const expected = [
        '{"commandType":6035,"data":{"value":2}}',
        '{"commandType":6032,"data":{"settingstate":0,"value":2}}',
        '{"commandType":6097,"data":{"value":2}}',
        '{"commandType":6032,"data":{"settingstate":0,"value":2}}',
        '{"commandType":6033,"data":{"value":2}}',
      ];
      for (const command of sent.slice(0, 5)) await f.router.dispatchCommand(DEVICE_SN, command);
      const payloads = device.attached
        ? f.level2.mock.calls.map((call) => call[0])
        : f.level1.mock.calls.map((call) => call[1]);
      expect(payloads).toEqual(expected);
    });

    it("queries preset IDs and preserves arbitrary returned slot indices", async () => {
      const query = vi.fn(async () => ({
        points: [
          { index: 0, enable: 1 },
          { index: 3, enable: 1 },
        ],
      }));
      const media = { p2pControlQuery: query } as unknown as MediaProvider;
      const { acts } = bind<PtzActions>("ptz", context(device), { media });
      expect(await acts.preset!().list!()).toEqual([
        { id: 0, raw: { index: 0, enable: 1 } },
        { id: 3, raw: { index: 3, enable: 1 } },
      ]);
      expect(query.mock.calls).toEqual([[6034, { value: 0 }, undefined]]);
    });
  }
});

describe("T8426 rotation-only surface", () => {
  const ctx = context(models[2]!);
  it("withholds the unconfirmed preset namespace even with a query provider", () => {
    const { acts } = bind<PtzActions>("ptz", ctx, { media: { p2pControlQuery: vi.fn() } as unknown as MediaProvider });
    expect(acts.preset).toBeUndefined();
  });
  it.each(["gotoPreset", "previewPreset", "deletePreset", "setDefaultPosition"])("refuses the %s intent", (action) => {
    expect(buildCommand(action, 2, ctx)).toBeUndefined();
  });
  it("ignores the rotate zoom argument without adding an unsupported field", () => {
    expect(rotateCommand("left", ctx, 2)).toEqual({
      kind: "set-json",
      param: 6030,
      data: { cmd_type: 1, rotate_type: 1 },
      channel: 4,
    });
  });
});

it.each([32, 33, 63, 64, 34, 37, 62])(
  "does not infer PTZ for fixed camera type %i from presetZone alone",
  (deviceType) => {
    expect(Device.fromRecord(DEVICE_SN, { deviceType, params: { 6201: "1" } }).has("ptz")).toBe(false);
  },
);
