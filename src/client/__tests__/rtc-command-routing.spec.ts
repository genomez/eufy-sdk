/** Modified for genomez S1 experimental source preview, 2026-10-16. */
import { EventEmitter } from "node:events";
import { DeviceType } from "../../model/device-types.js";
import { buildActions } from "../../model/capabilities/index.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import type { DeviceRecord } from "../device-registry.js";
import type { SirenActions } from "../../model/capabilities/siren.js";
import { RtcCommandRouter } from "../../transport/rtc/command-router.js";
import type { RtcSession } from "../../transport/rtc/session.js";
import { buildPortalHeader, parsePortalHeader, PORTAL_HEADER_LENGTH } from "../../transport/rtc/portal-packet.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import { EufyMega } from "../eufy-mega.js";

const HUB = "T8000P0000000000";
const CAMERA = "T8000P0000000001";
const command: Command = { kind: "set-json", param: 1400, data: { time: 0, type: 2, value: 0 }, channel: 3 };

function fixture(stationModel = "T9000") {
  const client = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  const internals = client as unknown as {
    registry: { list(): EufyDevice[]; devices: EufyDevice[] };
    rtc: { dispatchCommand(sn: string, cmd: Command): Promise<void> };
    p2p: { dispatchCommand(sn: string, cmd: Command): Promise<void> };
    routeCommand(sn: string, cmd: Command): Promise<void>;
    commandContext(sn: string, known: DeviceRecord): Promise<CommandContext>;
  };
  const devices = [
    { sn: HUB, model: stationModel, raw: {} },
    { sn: CAMERA, model: "T8425", stationSn: HUB, raw: { parent_sn: HUB, device_channel: 3 } },
  ] as EufyDevice[];
  internals.registry.devices = devices;
  const rtc = vi.spyOn(internals.rtc, "dispatchCommand").mockResolvedValue();
  const p2p = vi.spyOn(internals.p2p, "dispatchCommand").mockResolvedValue();
  return { internals, rtc, p2p, devices };
}

afterEach(() => vi.restoreAllMocks());

describe("station-owned RTC command routing", () => {
  it.each([HUB, CAMERA])("routes supported station topology through RTC for %s", async (sn) => {
    const { internals, rtc, p2p } = fixture();
    await internals.routeCommand(sn, command);
    expect(rtc).toHaveBeenCalledExactlyOnceWith(sn, command, { deadlineAtMs: undefined });
    expect(p2p).not.toHaveBeenCalled();
  });

  it("keeps another station family on its existing transport", async () => {
    const { internals, rtc, p2p } = fixture("T8030");
    await internals.routeCommand(CAMERA, command);
    expect(p2p).toHaveBeenCalledExactlyOnceWith(CAMERA, command);
    expect(rtc).not.toHaveBeenCalled();
  });

  it("does not infer RTC from a camera model without a supported station", async () => {
    const { internals, rtc, p2p, devices } = fixture();
    devices.shift();
    await internals.routeCommand(CAMERA, command);
    expect(p2p).toHaveBeenCalledExactlyOnceWith(CAMERA, command);
    expect(rtc).not.toHaveBeenCalled();
  });

  it("does not replay an ambiguous RTC failure through P2P", async () => {
    const { internals, rtc, p2p } = fixture();
    rtc.mockRejectedValueOnce(new Error("ACK timed out"));
    await expect(internals.routeCommand(CAMERA, command)).rejects.toThrow("ACK timed out");
    expect(rtc).toHaveBeenCalledTimes(1);
    expect(p2p).not.toHaveBeenCalled();
  });

  it.each(["missing", "shared", "mismatched"])("refuses a %s attached-device channel before sending", async (issue) => {
    const { internals, rtc, p2p, devices } = fixture();
    if (issue === "missing") devices[1]!.raw = { parent_sn: HUB };
    if (issue === "shared") devices.push({ ...devices[1]!, sn: "T8000P0000000002" });
    if (issue === "mismatched") devices[1]!.raw = { parent_sn: HUB, device_channel: 4 };
    await expect(internals.routeCommand(CAMERA, command)).rejects.toThrow("unambiguous attached-device channel");
    expect(rtc).not.toHaveBeenCalled();
    expect(p2p).not.toHaveBeenCalled();
  });
});

describe("S1 attached-camera alarm routing", () => {
  it("derives parent type from the route link, without requiring parent_sn in raw data", async () => {
    const { internals, devices } = fixture();
    devices[0]!.raw = { device_type: DeviceType.STATION_9000 };
    devices[1]!.raw = { device_channel: 3 };
    const context = await internals.commandContext(CAMERA, {
      model: "T8134",
      parentSn: HUB,
      params: {},
      paramUpdatedAt: {},
    });
    expect(context.stationDeviceType).toBe(DeviceType.STATION_9000);
    expect(context.stationModel).toBe("T9000");
    devices.push({ sn: "T8000P0000000002", model: "T8030", raw: { device_type: DeviceType.HB3 } } as EufyDevice);
    devices[1]!.raw = { device_channel: 3, parent_sn: "T8000P0000000002" };
    const conflicting = await internals.commandContext(CAMERA, {
      model: "T8134",
      parentSn: HUB,
      params: {},
      paramUpdatedAt: {},
    });
    expect(conflicting.stationDeviceType).toBe(DeviceType.STATION_9000);
    expect(conflicting.stationModel).toBe("T9000");
    const own = await internals.commandContext(HUB, { model: "T9000", params: {}, paramUpdatedAt: {} });
    expect(own.stationDeviceType).toBeUndefined();
    expect(own.stationModel).toBeUndefined();
    devices[0]!.raw = { device_type: DeviceType.HB3 };
    expect((await internals.commandContext(CAMERA, { params: {}, paramUpdatedAt: {} })).stationDeviceType).toBe(
      DeviceType.HB3,
    );
  });

  it.each(["T8134", "T8214"])(
    "sends %s start and stop through the real RTC 1350 envelope without creating sounding state",
    async (model) => {
      const { internals, rtc, p2p, devices } = fixture();
      devices[1]!.model = model;
      rtc.mockRestore();
      const packets: Buffer[] = [];
      class Session extends EventEmitter {
        isConnected = false;
        async connect() {
          this.isConnected = true;
          this.emit("connected");
        }
        close() {
          this.isConnected = false;
          this.emit("close");
        }
        sendCommand(packet: Buffer) {
          packets.push(packet);
          const header = parsePortalHeader(packet)!;
          queueMicrotask(() =>
            this.emit(
              "commandData",
              Buffer.concat([
                buildPortalHeader(header.commandId, 4, header.channel, header.segment, 1),
                Buffer.alloc(4),
              ]),
              1,
            ),
          );
          return true;
        }
      }
      const router = new RtcCommandRouter({
        identity: () => ({
          authToken: "synthetic",
          userId: "synthetic-user",
          accountUserId: "synthetic-account",
          gtoken: "synthetic",
        }),
        shard: () => "ie-pr",
        country: "CH",
        accountName: () => "Synthetic Home",
        findDevice: (sn) => devices.find((device) => device.sn === sn),
        createSession: () => new Session() as unknown as RtcSession,
        ackTimeoutMs: 100,
        connectTimeoutMs: 200,
      });
      internals.rtc = router;
      const context = await internals.commandContext(CAMERA, {
        model,
        deviceType: DeviceType.CAMERA2,
        parentSn: HUB,
        params: { 1015: "0" },
        paramUpdatedAt: {},
      });
      context.accountName = "Synthetic Home";
      const alarm = buildActions(["siren"], {
        ctx: context,
        sink: { dispatch: (cmd) => internals.routeCommand(CAMERA, cmd) },
        read: () => undefined,
      }).siren as SirenActions;
      try {
        await alarm.trigger!(5);
        expect(alarm.active).toBeUndefined();
        await alarm.stop!();
        expect(alarm.active).toBeUndefined();
        expect(
          packets.map((packet) => {
            const header = parsePortalHeader(packet)!;
            return {
              commandId: header.commandId,
              channel: header.channel,
              body: JSON.parse(packet.subarray(PORTAL_HEADER_LENGTH).toString("utf8")),
            };
          }),
        ).toEqual(
          [5, 0].map((seconds) => ({
            commandId: 1350,
            channel: 3,
            body: {
              account_id: "synthetic-user",
              cmd: 1202,
              mValue3: 0,
              payload: { time_out: seconds, type: 10, channel: 3, username: "Synthetic Home" },
            },
          })),
        );
        expect(p2p).not.toHaveBeenCalled();
      } finally {
        router.close();
      }
    },
  );

  it.each(["T8425", "T8426", "T8416", "T8170", "T8171", "T8161"])(
    "offers no unroutable alarm for attached %s with EAS",
    async (model) => {
      const { internals, rtc, p2p } = fixture();
      const context = await internals.commandContext(CAMERA, {
        model,
        deviceType: DeviceType.CAMERA2,
        parentSn: HUB,
        params: { 1015: "0" },
        paramUpdatedAt: {},
      });
      const alarm = buildActions(["siren"], {
        ctx: context,
        sink: { dispatch: (cmd) => internals.routeCommand(CAMERA, cmd) },
        read: () => undefined,
      }).siren as SirenActions;
      expect(alarm.trigger).toBeUndefined();
      expect(alarm.stop).toBeUndefined();
      expect(rtc).not.toHaveBeenCalled();
      expect(p2p).not.toHaveBeenCalled();
    },
  );
});
