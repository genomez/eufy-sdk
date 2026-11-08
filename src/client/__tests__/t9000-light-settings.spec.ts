import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../core/types.js";
import { buildCommand } from "../../model/capabilities/index.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import { RtcCommandRouter } from "../../transport/rtc/command-router.js";
import type { RtcSession } from "../../transport/rtc/session.js";
import { buildPortalHeader, parsePortalHeader, PORTAL_HEADER_LENGTH } from "../../transport/rtc/portal-packet.js";

const context: CommandContext = {
  codec: "camera",
  model: "T8425",
  deviceType: 47,
  channel: 2,
  stationModel: "T9000",
  homeBaseAttached: true,
  capabilities: new Set(["light"]),
  paramIds: new Set([1400, 1401, 1403]),
};

function fixture() {
  const station = { sn: "fixture-station", stationSn: "fixture-station", model: "T9000" } as EufyDevice;
  const camera = { sn: "fixture-camera", stationSn: station.sn, model: "T8425" } as EufyDevice;
  const packets: Buffer[] = [];
  const createSession = vi.fn(() => {
    const session = Object.assign(new EventEmitter(), {
      isConnected: false,
      async connect() {
        session.isConnected = true;
        session.emit("connected");
      },
      sendCommand(packet: Buffer) {
        packets.push(packet);
        const header = parsePortalHeader(packet)!;
        queueMicrotask(() =>
          session.emit(
            "commandData",
            Buffer.concat([buildPortalHeader(header.commandId, 4, header.channel, header.segment, 1), Buffer.alloc(4)]),
            1,
          ),
        );
        return true;
      },
      close() {
        session.isConnected = false;
        session.emit("close");
      },
    });
    return session as unknown as RtcSession;
  });
  const router = new RtcCommandRouter({
    identity: () => ({
      authToken: "synthetic",
      userId: "fixture-user",
      accountUserId: "fixture-user",
      gtoken: "synthetic",
    }),
    shard: () => "ie-pr",
    country: "CH",
    accountName: () => "fixture",
    findDevice: (sn) => (sn === station.sn ? station : sn === camera.sn ? camera : undefined),
    createSession,
  });
  return { router, createSession, packets, camera };
}

describe("T9000 attached light command families", () => {
  it.each([
    ["brightness", 50, 1401, 50],
    ["spotlightEnabled", true, 1403, 1],
    ["colorTemp", 50, 1410, 50],
  ] as const)("%s is a mapped scalar rejected before session acquisition", async (name, value, param, scalar) => {
    const f = fixture();
    try {
      const command = buildCommand(name, value, context)!;
      expect(command).toEqual({ kind: "set-param", param, value: scalar, form: "direct-binary", channel: 2 });
      await expect(f.router.dispatchCommand(f.camera.sn, command)).rejects.toThrow(
        "rtc: set-param is not routable over the T9000 control channel yet (only set-payload or set-json)",
      );
      expect(f.createSession).not.toHaveBeenCalled();
      expect(f.packets).toEqual([]);
    } finally {
      f.router.close();
    }
  });

  it.each([true, false])("light %s retains the exact 1700 JSON payload on the camera channel", async (value) => {
    const f = fixture();
    try {
      await f.router.dispatchCommand(f.camera.sn, buildCommand("light", value, context)!);
      expect(f.packets).toHaveLength(1);
      const packet = f.packets[0]!;
      expect(parsePortalHeader(packet)).toMatchObject({ commandId: 1700, channel: 2, isResponse: 0 });
      expect(packet.subarray(PORTAL_HEADER_LENGTH)).toEqual(
        Buffer.from(
          JSON.stringify({
            account_id: "fixture-user",
            cmd: 1400,
            commandType: 1400,
            data: { time: 0, type: 2, value: value ? 1 : 0 },
          }),
        ),
      );
    } finally {
      f.router.close();
    }
  });

  it.each([0, 101, NaN, Infinity])("brightness rejects out-of-bounds value %s", (value) => {
    expect(() => buildCommand("brightness", value, context)).toThrow();
  });
});
