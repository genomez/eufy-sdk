import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { RtcCommandRouter } from "../command-router.js";
import type { RtcSession } from "../session.js";
import type { RtcIngressGuard } from "../playback-ingress.js";
import type { EufyDevice } from "../../../core/types.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";
import { packetize, PtcsFramer } from "../ptcs-framer.js";
import { PORTAL_KEEPALIVE } from "../portal-keepalive.js";
import { performance as nativePerformance } from "node:perf_hooks";

const station = "T9000SYNTHETIC",
  camera = "camera-synthetic";
const owners: RtcCommandRouter[] = [];
afterEach(() => {
  owners.splice(0).forEach((r) => r.close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
class Session extends EventEmitter {
  isConnected = false;
  sent: Buffer[] = [];
  guard?: RtcIngressGuard;
  framer = new PtcsFramer();
  counter = 0;
  releaseStatus = true;
  eof = true;
  attachIngressGuard(guard: RtcIngressGuard) {
    this.guard = guard;
  }
  async connect() {
    await this.framer.init(
      () => {},
      (frame, link) => {
        if (this.guard && !this.guard.decoded(frame, link)) return;
        this.emit(link === 4 || link === 5 || link === 2 ? "mediaData" : "commandData", frame, link);
      },
    );
    this.isConnected = true;
    this.emit("connected");
  }
  close() {
    this.isConnected = false;
    this.framer.destroy();
    this.emit("close");
  }
  inject(packet: Buffer) {
    if (!this.guard || this.guard.native(packet)) {
      if (packet.equals(PORTAL_KEEPALIVE)) this.emit("keepaliveEcho");
      else this.framer.recvPacket(packet);
    }
  }
  input(command: number, body: unknown, route = 2, channel = 0, selector = 0, segment = 0) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    for (const p of packetize(
      Buffer.concat([buildPortalHeader(command, data.length, channel, segment, selector), data]),
      { channel: route, frameId: ++this.counter, payloadBytes: 40 },
    ))
      this.inject(p);
  }
  sendCommand(packet: Buffer) {
    this.sent.push(packet);
    const h = parsePortalHeader(packet)!,
      p = h.commandId === 1103 ? { cmd: 1103 } : JSON.parse(packet.subarray(16).toString());
    queueMicrotask(() => {
      if (h.commandId === 1700) {
        this.input(1700, Buffer.alloc(132), 0, 255, 1, h.segment);
        if (p.data.cmd === 0) {
          this.input(1351, { cmd: 6001, payload: { state: 1, code: 0 } });
          const media = Buffer.alloc(29);
          media.writeUInt32LE(7);
          media[5] = 1;
          Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]).copy(media, 22);
          this.input(1300, media, 4, 101, h.isResponse);
          if (this.eof) this.input(1351, { cmd: 6001, payload: { state: 2, code: 14 } });
        }
        if (p.data.cmd === 3 && this.releaseStatus)
          this.input(1351, { cmd: 6001, payload: { state: 2, code: 15, segmen: p.segmen } });
        return;
      }
      this.input(h.commandId, Buffer.alloc(4), 0, h.channel, 1, h.segment);
      if (p.cmd === 1103) this.input(1103, { params: [] }, 2, 2);
      if (p.cmd === 1306)
        this.input(
          1306,
          {
            cmd: 10000,
            table: "history_record_info",
            transaction: p.payload.transaction,
            mIntRet: 0,
            data: [
              { device_sn: camera, record_id: 40, start_time: "2026-01-15 12:00:00", end_time: "2026-01-15 12:00:01" },
            ],
          },
          2,
          255,
        );
    });
    return true;
  }
}
async function fixture() {
  vi.useFakeTimers();
  vi.spyOn(nativePerformance, "now").mockImplementation(() => performance.now());
  const sessions: Session[] = [],
    marker: boolean[] = [];
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "synthetic", userId: "synthetic" }),
    accountName: () => "synthetic",
    shard: () => "us",
    idleCloseMs: 900000,
    sessionRefreshMs: 600000,
    findDevice: (sn) =>
      ({ sn, stationSn: station, model: sn === station ? "T9000" : "T8425", raw: { device_channel: 2 } }) as EufyDevice,
    createSession: () => {
      const session = new Session();
      sessions.push(session);
      return session as unknown as RtcSession;
    },
  });
  owners.push(router);
  router.configurePlaybackSafety(false, (value) => marker.push(value));
  const read = router.refreshInformation(station);
  await vi.advanceTimersByTimeAsync(1);
  await read;
  sessions[0]!.inject(PORTAL_KEEPALIVE);
  await vi.advanceTimersByTimeAsync(60001);
  const owner = Reflect.get(router, "sessions").get(station);
  expect({
    continuous: Reflect.get(router, "storageCandidateOwnerMatches").call(router, station, owner),
    connected: owner.session.isConnected,
    pending: owner.pendingExchanges === 0,
    replacement: !owner.replacement,
    refresh: !owner.refreshPending,
    renewal: owner.connectedAtMs + 600000 - Date.now() > 30000,
  }).toEqual({ continuous: true, connected: true, pending: true, replacement: true, refresh: true, renewal: true });
  expect({
    marker: !!Reflect.get(router, "playbackMarker"),
    latch: !Reflect.get(router, "playbackUnresolved"),
    playback: Reflect.get(router, "playbackProbes").size === 0,
    table: Reflect.get(router, "eventTableProbes").size === 0,
    live: Reflect.get(router, "lives").size === 0,
    taint: !owner.informationTainted,
    renewal:
      (owner.refreshBusyCooldownAtMs ?? owner.refreshRetryAtMs ?? owner.connectedAtMs + 600000) - Date.now() > 30000,
  }).toEqual({ marker: true, latch: true, playback: true, table: true, live: true, taint: true, renewal: true });
  expect({
    covered: performance.now() - owner.playbackObservation.observedSinceMs >= 60000,
    ordinary: owner.playbackObservation.ordinaryFrames > 0,
    keepalive: owner.playbackObservation.keepalives > 0,
    ingressSafe: owner.playbackObservation.prestartSafe(),
    information: !!owner.lastInformationRead,
    idle: owner.scheduler.idle,
    leases: owner.leases === 0,
  }).toEqual({
    covered: true,
    ordinary: true,
    keepalive: true,
    ingressSafe: true,
    information: true,
    idle: true,
    leases: true,
  });
  return { router, session: sessions[0]!, sessions, marker };
}
const options = () => ({
  enabled: true,
  cameras: new Set([camera]),
  excluded: new Set(["excluded-synthetic"]),
  fresh: () => true,
});
it("full current-table/start/pause/next-selector stop path uses one original owner and releases its scheduler", async () => {
  const { router, session, sessions, marker } = await fixture();
  const enqueue = vi.spyOn(Reflect.get(router, "sessions").get(station).scheduler, "enqueue");
  const opts = options();
  const fresh = vi.fn(opts.fresh);
  opts.fresh = fresh;
  const pending = router.readEventPlaybackCandidate(station, opts);
  await vi.advanceTimersByTimeAsync(5100);
  expect((await pending).admissionGate).toBe(0);
  expect(fresh).toHaveBeenCalled();
  expect(enqueue).toHaveBeenCalledOnce();
  const result = await pending;
  expect(result).toMatchObject({
    captureOutcome: "eof",
    releaseOutcome: "release_confirmed",
    cessationOutcome: "ceased",
    boundedMediaObserved: true,
    latchCleared: true,
  });
  expect(marker).toEqual([true, false]);
  expect(sessions).toHaveLength(1);
  const playback = session.sent.filter((p) => parsePortalHeader(p)!.commandId === 1700);
  expect(playback.map((p) => JSON.parse(p.subarray(16).toString()).data.cmd)).toEqual([0, 1, 3]);
  expect(playback.map((p) => parsePortalHeader(p)!.isResponse)).toEqual([6, 6, 7]);
  expect(router.getPlaybackSafetyDiagnostics()).toMatchObject({ unresolved: false, active: false });
});
it("missing release survives a new owner and blocks live while ordinary control remains usable", async () => {
  const { router, session, sessions } = await fixture();
  session.releaseStatus = false;
  const pending = router.readEventPlaybackCandidate(station, options());
  await vi.advanceTimersByTimeAsync(5100);
  expect((await pending).releaseOutcome).toBe("stop_unconfirmed");
  await expect(router.mediaProviderFor(camera).live!()).rejects.toThrow("playback_slot_uncertain");
  session.close();
  const control = router.dispatchCommand(camera, { kind: "set-payload", cmd: 1400, payload: { value: 0 }, channel: 2 });
  await vi.advanceTimersByTimeAsync(1);
  await control;
  expect(sessions).toHaveLength(2);
  expect(router.getPlaybackSafetyDiagnostics().unresolved).toBe(true);
});
it("queued correction demand preempts capture and gets the scheduler immediately after both cleanup sends", async () => {
  const { router, session } = await fixture();
  session.eof = false;
  const pending = router.readEventPlaybackCandidate(station, options());
  await vi.advanceTimersByTimeAsync(1);
  const before = performance.now();
  const correction = router.dispatchCommand(camera, {
    kind: "set-payload",
    cmd: 1400,
    payload: { value: 0 },
    channel: 2,
  });
  await vi.advanceTimersByTimeAsync(1);
  await correction;
  expect(performance.now() - before).toBeLessThan(100);
  const kinds = session.sent.map((p) => {
    const h = parsePortalHeader(p)!;
    if (h.commandId === 1103) return 1103;
    const data = JSON.parse(p.subarray(16).toString());
    return h.commandId === 1700 ? data.data.cmd : data.cmd;
  });
  expect(kinds.slice(-4)).toEqual([0, 1, 3, 1400]);
  await vi.advanceTimersByTimeAsync(5100);
  expect((await pending).captureOutcome).toBe("preempted");
});
