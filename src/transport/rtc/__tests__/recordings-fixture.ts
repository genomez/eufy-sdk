import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter } from "../command-router.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";
import type { RtcSession } from "../session.js";
import { recordingAccountNamespace, type RecordingReadScope } from "../recordings.js";

export const station = "synthetic-station";
export const cameras = Array.from({ length: 5 }, (_, i) => `synthetic-camera-${i}`);
export const identityKey = new Uint8Array(32).fill(7);
export const scope: RecordingReadScope = {
  stationSn: station,
  cameraSns: new Set(cameras),
  identityKey,
  accountNamespace: recordingAccountNamespace(identityKey, "synthetic-account"),
};
export const row = (extra: Record<string, unknown> = {}) => ({
  device_sn: cameras[0],
  record_id: 1,
  start_time: "2026-10-20 12:00:00",
  end_time: "2026-10-20 12:00:12",
  thumb_path: "/synthetic/cover-a.jpg",
  event_type: 3,
  detect_type: 4,
  ...extra,
});
export const control = { kind: "set-payload" as const, cmd: 1224, payload: { mode_type: 1 }, channel: 0 };

/** Synthetic v1 protocol fixture; all frames are made locally and no session opens a socket. */
export class RecordingSession extends EventEmitter {
  isConnected = false;
  sent: Buffer[] = [];
  ack = true;
  accept = true;
  onSend?: (packet: Buffer) => void;
  async connect() {
    this.isConnected = true;
    this.emit("connected");
  }
  close() {
    this.isConnected = false;
    this.emit("close");
  }
  ackPacket(packet: Buffer, segment?: number) {
    const header = parsePortalHeader(packet)!;
    this.emit(
      "commandData",
      Buffer.concat([
        buildPortalHeader(header.commandId, 4, header.channel, segment ?? header.segment, 1),
        Buffer.alloc(4),
      ]),
      1,
    );
  }
  sendCommand(packet: Buffer) {
    this.sent.push(packet);
    if (this.ack)
      queueMicrotask(() => {
        this.ackPacket(packet);
        if (parsePortalHeader(packet)!.commandId === 1103)
          this.notify({ params: [{ channel: 255, param_type: 1224, param_value: 1 }] }, 1103, 3);
      });
    this.onSend?.(packet);
    return this.accept;
  }
  notify(data: unknown, commandId = 1306, link = 3) {
    const body = Buffer.from(JSON.stringify(data));
    this.emit("commandData", Buffer.concat([buildPortalHeader(commandId, body.length, 255, 0), body]), link);
  }
  table(rows: unknown[], extra: Record<string, unknown> = {}) {
    const request = this.sent
      .filter((p) => parsePortalHeader(p)!.commandId === 1350)
      .map((p) => JSON.parse(p.subarray(16).toString()))
      .findLast((p) => p.cmd === 1306);
    this.notify({
      cmd: 10000,
      table: "history_record_info",
      transaction: request.payload.transaction,
      mIntRet: 0,
      data: rows,
      ...extra,
    });
  }
}

/** Create a healthy observed owner using normal local commands and a qualified information read. */
export async function recordingFixture(extra: Record<string, unknown> = {}): Promise<{
  router: RtcCommandRouter;
  session: RecordingSession;
  devices: Map<string, EufyDevice>;
  onFrame: ReturnType<typeof vi.fn>;
  logger: Record<"debug" | "info" | "warn" | "error", ReturnType<typeof vi.fn>>;
  advance(ms: number): void;
  forbid(): void;
  changeTopology(): void;
  changeAccount(): void;
}> {
  let now = 100_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const devices = new Map<string, EufyDevice>([
    [station, { sn: station, model: "T9000", raw: {} } as EufyDevice],
    ...cameras.map(
      (sn, i) =>
        [sn, { sn, model: "T8425", stationSn: station, raw: { device_channel: i } } as EufyDevice] as [
          string,
          EufyDevice,
        ],
    ),
  ]);
  const session = new RecordingSession();
  const onFrame = vi.fn();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let allowed = true;
  let topology = {};
  let identity = { userId: "synthetic-account", authToken: "synthetic-token" };
  const router = new RtcCommandRouter({
    identity: () => identity,
    shard: () => "us",
    accountName: () => "synthetic",
    findDevice: (sn) => devices.get(sn),
    createSession: () => session as unknown as RtcSession,
    recordings: { enabled: true, stationBinding: station, allowedCameras: new Set(cameras) },
    recordingsAllowed: () => allowed,
    recordingsTopology: () => topology,
    logger,
    onFrame,
    idleCloseMs: 600_000,
    ...extra,
  });
  await router.dispatchCommand(station, control);
  await router.refreshInformation(station);
  now += 61_000;
  session.sent.length = 0;
  onFrame.mockClear();
  return {
    router,
    session,
    devices,
    onFrame,
    logger,
    advance: (ms: number) => {
      now += ms;
    },
    forbid: () => {
      allowed = false;
    },
    changeTopology: () => {
      topology = {};
    },
    changeAccount: () => {
      identity = { ...identity, userId: "synthetic-other" };
    },
  };
}

export async function sent(session: RecordingSession, count = 1) {
  await vi.waitFor(() => expect(session.sent).toHaveLength(count), { interval: 1 });
}
