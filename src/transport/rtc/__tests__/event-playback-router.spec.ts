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
import { zstdCompressSync } from "node:zlib";
import { normalizeRecordingRows, recordingAccountNamespace } from "../recordings.js";

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
  refusal = "none";
  eof = true;
  corruptMedia = false;
  mediaEnabled = true;
  tableReply = true;
  tableResultCode = 0;
  tableRows: unknown[] = [
    { device_sn: camera, record_id: 40, start_time: "2026-01-15 12:00:00", end_time: "2026-01-15 12:00:01" },
  ];
  attachIngressGuard(guard: RtcIngressGuard | undefined) {
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
      else {
        const outcome = this.framer.recvPacket(packet);
        this.guard?.received?.(outcome);
      }
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
        if (p.data.cmd === 0 && this.refusal !== "none") {
          this.input(1351, {
            cmd: 6001,
            payload: { state: 0, code: 7, ...(this.refusal === "matched" ? { segmen: h.segment } : {}) },
          });
          return;
        }
        if (p.data.cmd === 0 && this.mediaEnabled) {
          this.input(1351, { cmd: 6001, payload: { state: 1, code: 0 } });
          const media = Buffer.alloc(29);
          media.writeUInt32LE(7);
          media[5] = 1;
          Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]).copy(media, 22);
          if (this.corruptMedia) {
            const bad = packetize(Buffer.from("synthetic-invalid-compression"), {
              channel: 4,
              frameId: ++this.counter,
            })[0]!;
            bad.writeUInt16LE(bad.readUInt16LE(18) | 0x0800, 18);
            this.inject(bad);
          } else this.input(1300, media, 4, 101, h.isResponse);
          if (this.eof) this.input(1351, { cmd: 6001, payload: { state: 2, code: 14 } });
        }
        if (p.data.cmd === 3 && this.releaseStatus)
          this.input(1351, { cmd: 6001, payload: { state: 2, code: 15, segmen: p.segmen } });
        return;
      }
      this.input(h.commandId, Buffer.alloc(4), 0, h.channel, 1, h.segment);
      if (p.cmd === 1103) this.input(1103, { params: [] }, 2, 2);
      if (p.cmd === 1306 && this.tableReply)
        this.input(
          1306,
          {
            cmd: 10000,
            table: "history_record_info",
            transaction: p.payload.transaction,
            mIntRet: this.tableResultCode,
            data: this.tableRows,
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

it("exact sealed clip bypasses newest selection and returns typed video after clean release", async () => {
  const { router, session, marker } = await fixture();
  const scope = {
    stationSn: station,
    cameraSns: new Set([camera]),
    identityKey: new Uint8Array(32).fill(7),
    accountNamespace: recordingAccountNamespace(new Uint8Array(32).fill(7), "synthetic"),
  };
  Reflect.get(router, "deps").recordings = { enabled: true, stationBinding: station, allowedCameras: scope.cameraSns };
  const result = normalizeRecordingRows(session.tableRows, scope);
  if (result.status !== "ok") throw Error("fixture");
  const selector = result.rows[0]!.playbackSelector!,
    video = vi.fn();
  const before = session.sent.filter((p) => parsePortalHeader(p)!.commandId === 1350).length;
  const pending = router.readEventPlaybackCandidate(station, {
    ...options(),
    excluded: new Set(),
    clip: { scope, selector, video },
  });
  await vi.advanceTimersByTimeAsync(5100);
  expect(await pending).toMatchObject({
    admissionGate: 0,
    captureOutcome: "eof",
    releaseOutcome: "release_confirmed",
    latchCleared: true,
    reconnectOutcome: "not_needed",
    ingressVideoFrames: 1,
    ingressAudioFrames: 0,
  });
  expect(video).toHaveBeenCalledOnce();
  expect(marker).toEqual([]);
  expect(router.getPlaybackSafetyDiagnostics().reconnect.attempts).toBe(0);
  expect(session.sent.filter((p) => parsePortalHeader(p)!.commandId === 1350)).toHaveLength(before);
});

it("a clip that cannot fit before renewal refuses without start or latch", async () => {
  const { router, session, marker } = await fixture();
  const key = new Uint8Array(32).fill(7),
    scope = {
      stationSn: station,
      cameraSns: new Set([camera]),
      identityKey: key,
      accountNamespace: recordingAccountNamespace(key, "synthetic"),
    };
  Reflect.get(router, "deps").recordings = { enabled: true, stationBinding: station, allowedCameras: scope.cameraSns };
  const result = normalizeRecordingRows(
    [{ ...(session.tableRows[0] as object), end_time: "2026-01-15 12:20:00" }],
    scope,
  );
  if (result.status !== "ok") throw Error("fixture");
  const receipt = await router.readEventPlaybackCandidate(station, {
    ...options(),
    excluded: new Set(),
    clip: { scope, selector: result.rows[0]!.playbackSelector!, video: () => {} },
  });
  expect(receipt).toMatchObject({ admissionGate: 26, startAttempted: false, latchRetained: false });
  expect(marker).toEqual([]);
});

it("direct live callers wait for full-clip cleanup before attaching a consumer", async () => {
  const { router, session, marker } = await fixture();
  session.eof = false;
  const key = new Uint8Array(32).fill(7),
    scope = {
      stationSn: station,
      cameraSns: new Set([camera]),
      identityKey: key,
      accountNamespace: recordingAccountNamespace(key, "synthetic"),
    };
  Reflect.get(router, "deps").recordings = { enabled: true, stationBinding: station, allowedCameras: scope.cameraSns };
  const result = normalizeRecordingRows(session.tableRows, scope);
  if (result.status !== "ok") throw Error("fixture");
  const pulling = router.readEventPlaybackCandidate(station, {
    ...options(),
    excluded: new Set(),
    clip: { scope, selector: result.rows[0]!.playbackSelector!, video: () => {} },
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(marker).toEqual([]);
  const consumer = {},
    attach = vi.fn(() => consumer);
  Reflect.get(router, "lives").set(station, {
    sn: camera,
    pending: 0,
    controller: new AbortController(),
    ready: Promise.resolve({ attach }),
  });
  const live = Reflect.get(router, "attachLive").call(router, camera);
  await vi.advanceTimersByTimeAsync(100);
  expect(attach).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5100);
  expect(await pulling).toMatchObject({
    captureOutcome: "preempted",
    releaseOutcome: "release_confirmed",
    latchCleared: true,
  });
  expect(await live).toBe(consumer);
  expect(attach).toHaveBeenCalledOnce();
  expect(marker).toEqual([]);
});
it.each(["time_refused", "table_failed", "table_timeout", "selectors_exhausted", "admission_after_dispatch"])(
  "no-start %s leaves the playback slot clear and health clean",
  async (refusal) => {
    const { router, session, marker } = await fixture();
    const owner = Reflect.get(router, "sessions").get(station);
    if (refusal === "time_refused")
      session.tableRows = [{ device_sn: camera, record_id: 40, start_time: "invalid", end_time: "invalid" }];
    if (refusal === "table_failed") session.tableResultCode = -1;
    if (refusal === "table_timeout") session.tableReply = false;
    if (refusal === "selectors_exhausted")
      for (let selector = 6; selector <= 249; selector++) owner.playbackSelectors.add(selector);
    let fresh = true;
    const beforeDispatch = vi.fn(() => {
      if (refusal === "admission_after_dispatch") fresh = false;
    });
    const pending = router.readEventPlaybackCandidate(station, { ...options(), beforeDispatch, fresh: () => fresh });
    await vi.advanceTimersByTimeAsync(8100);
    const result = await pending;
    expect(result).toMatchObject({
      startAttempted: false,
      pauseSent: false,
      stopSent: false,
      ownerContinuous: true,
      healthOutcome: "clean",
      cessationOutcome: "not_started",
      releaseOutcome: "not_started",
      latchPersisted: false,
      latchRetained: false,
      latchPersistenceFailed: false,
    });
    if (refusal === "time_refused")
      expect(result).toMatchObject({ captureOutcome: "time_refused", selectionOutcome: "time_invalid" });
    if (refusal === "selectors_exhausted") expect(result.selectionOutcome).toBe("selected");
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(marker).toEqual([]);
    expect(session.sent.filter((packet) => parsePortalHeader(packet)!.commandId === 1700)).toHaveLength(0);
    expect(router.getPlaybackSafetyDiagnostics()).toMatchObject({ unresolved: false, active: false });
  },
);
it("a pre-dispatch marker failure leaves direct live attachment available", async () => {
  const { router, session } = await fixture();
  router.configurePlaybackSafety(false, () => {
    throw Error("synthetic_storage_failure");
  });
  const pending = router.readEventPlaybackCandidate(station, options());
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({
    captureOutcome: "storage_failed",
    startAttempted: false,
    latchRetained: false,
  });
  expect(session.sent.filter((packet) => parsePortalHeader(packet)!.commandId === 1700)).toHaveLength(0);
  expect(router.getPlaybackSafetyDiagnostics()).toMatchObject({ unresolved: false, active: false });
  const consumer = {},
    attach = vi.fn(() => consumer);
  Reflect.get(router, "lives").set(station, {
    sn: camera,
    pending: 0,
    controller: new AbortController(),
    ready: Promise.resolve({ attach }),
  });
  expect(await Reflect.get(router, "attachLive").call(router, camera)).toBe(consumer);
  expect(attach).toHaveBeenCalledOnce();
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
it("qualified release re-latches and refuses live after admitted traffic exceeds the old budget", async () => {
  const { router, session, marker } = await fixture();
  const pending = router.readEventPlaybackCandidate(station, options());
  await vi.advanceTimersByTimeAsync(5100);
  expect(await pending).toMatchObject({
    releaseOutcome: "release_confirmed",
    cessationOutcome: "ceased",
    latchCleared: true,
  });
  expect(marker).toEqual([true, false]);
  const live = packetize(Buffer.concat([buildPortalHeader(1300, 512, 101, 9, 1), Buffer.alloc(512)]), {
    channel: 5,
    frameId: 30000,
    payloadBytes: 1000,
  })[0]!;
  for (let i = 0; i < 16385; i++) session.inject(live);
  expect(router.getPlaybackSafetyDiagnostics().unresolved).toBe(false);
  const bytes = zstdCompressSync(Buffer.concat([buildPortalHeader(1301, 4, 101, 9, 7), Buffer.alloc(4)]));
  const reserved = packetize(bytes, { channel: 4, frameId: 30001, payloadBytes: 1000 });
  expect(reserved).toHaveLength(1);
  reserved[0]!.writeUInt16LE(reserved[0]!.readUInt16LE(18) | 0x0800, 18);
  session.inject(reserved[0]!);
  expect(router.getPlaybackSafetyDiagnostics().unresolved).toBe(true);
  expect(marker).toEqual([true, false, true]);
  await expect(router.mediaProviderFor(camera).live!()).rejects.toThrow("playback_slot_uncertain");
  expect(session.sent.filter((p) => parsePortalHeader(p)!.commandId === 1700)).toHaveLength(3);
});
it("missing release survives a new owner and blocks live while ordinary control remains usable", async () => {
  const { router, session, sessions } = await fixture();
  session.releaseStatus = false;
  const pending = router.readEventPlaybackCandidate(station, options());
  await vi.advanceTimersByTimeAsync(24010);
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
it("dormant safety leaves ordinary, compressed, keepalive and live traffic identical to baseline", async () => {
  const { router, session, marker } = await fixture();
  router.configurePlaybackSafety(false, (value) => marker.push(value), false);
  expect(session.guard).toBeUndefined();
  const baseline = new Session();
  await baseline.connect();
  const trace = (s: Session) => {
    const result: unknown[] = [];
    s.on("commandData", (frame, link) => result.push(["control", frame.toString("hex"), link]));
    s.on("mediaData", (frame, link) => result.push(["live", frame.toString("hex"), link]));
    s.on("keepaliveEcho", () => result.push(["keepalive"]));
    return result;
  };
  const expected = trace(baseline),
    actual = trace(session);
  try {
    let id = 9000;
    for (const [command, route, compressed] of [
      [1350, 0, false],
      [1351, 2, true],
      [1300, 1, false],
      [1301, 5, true],
    ] as const) {
      const data = Buffer.concat([
        buildPortalHeader(command, 4, command >= 1300 && command <= 1301 ? 101 : 0, 0, 1),
        Buffer.alloc(4),
      ]);
      const parts = packetize(compressed ? zstdCompressSync(data) : data, { channel: route, frameId: ++id });
      for (const p of parts) {
        if (compressed) p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
        baseline.inject(p);
        session.inject(p);
      }
    }
    baseline.inject(PORTAL_KEEPALIVE);
    session.inject(PORTAL_KEEPALIVE);
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(5);
    expect(marker).toEqual([]);
    const refresh = router.refreshInformation(station);
    await vi.advanceTimersByTimeAsync(1);
    await refresh;
    expect(session.guard).toBeUndefined();
  } finally {
    baseline.close();
  }
});
it("dormant unresolved state preserves the cross-restart media block required by the latch contract", async () => {
  const { router, session } = await fixture();
  router.configurePlaybackSafety(true, () => {}, false);
  expect(session.guard).toBeDefined();
  await expect(router.mediaProviderFor(camera).live!()).rejects.toThrow("playback_slot_uncertain");
  const control = router.dispatchCommand(camera, { kind: "set-payload", cmd: 1400, payload: { value: 0 }, channel: 2 });
  await vi.advanceTimersByTimeAsync(1);
  await control;
  expect(router.getPlaybackSafetyDiagnostics().unresolved).toBe(true);
});

it("a failed capture drains cleanly and permits another attempt on the same owner", async () => {
  const { router, session, sessions, marker } = await fixture();
  session.corruptMedia = true;
  const beforeDispatch = vi.fn();
  const failed = router.readEventPlaybackCandidate(station, { ...options(), beforeDispatch });
  await vi.advanceTimersByTimeAsync(5100);
  expect(await failed).toMatchObject({
    captureOutcome: "invalid_media",
    boundedMediaObserved: false,
    releaseOutcome: "release_confirmed",
    cessationOutcome: "ceased",
    latchCleared: true,
    unknown: false,
  });
  expect(beforeDispatch).toHaveBeenCalledOnce();
  expect(router.getPlaybackSafetyDiagnostics().unresolved).toBe(false);
  session.corruptMedia = false;
  const next = router.readEventPlaybackCandidate(station, options());
  await vi.advanceTimersByTimeAsync(5100);
  expect(await next).toMatchObject({ captureOutcome: "eof", releaseOutcome: "release_confirmed", latchCleared: true });
  expect(sessions).toHaveLength(1);
  expect(marker).toEqual([true, false, true, false]);
});

function sealedClip(router: RtcCommandRouter, session: Session) {
  const key = new Uint8Array(32).fill(7);
  const scope = {
    stationSn: station,
    cameraSns: new Set([camera]),
    identityKey: key,
    accountNamespace: recordingAccountNamespace(key, "synthetic"),
  };
  Reflect.get(router, "deps").recordings = { enabled: true, stationBinding: station, allowedCameras: scope.cameraSns };
  const result = normalizeRecordingRows(session.tableRows, scope);
  if (result.status !== "ok") throw Error("fixture");
  return { scope, selector: result.rows[0]!.playbackSelector!, video: () => {} };
}

it("names a transient admission refusal when freshness changes before the scheduler recheck", async () => {
  const { router, session } = await fixture();
  let fresh = true;
  const pending = router.readEventPlaybackCandidate(station, {
    ...options(),
    clip: sealedClip(router, session),
    fresh: () => fresh,
    beforeDispatch: () => {
      fresh = false;
    },
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({
    captureOutcome: "not_admitted",
    startAttempted: false,
    admissionGate: 26,
    admissionGateName: "start_not_allowed",
  });
  expect(session.sent.filter((packet) => parsePortalHeader(packet)!.commandId === 1700)).toHaveLength(0);
});

it("duration-complete capture reconnects and re-admits the replacement after observation and a live view", async () => {
  const { router, session, sessions } = await fixture();
  session.eof = false;
  session.releaseStatus = false;
  const clip = sealedClip(router, session),
    video = vi.fn();
  const pending = router.readEventPlaybackCandidate(station, { ...options(), clip: { ...clip, video } });
  await vi.advanceTimersByTimeAsync(1);
  const body = Buffer.alloc(29);
  body.writeUInt32LE(7);
  body[5] = 1;
  Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]).copy(body, 22);
  const input = () => session.input(1300, body, 4, 101, 6);
  for (let i = 0; i < 15; i++) {
    await vi.advanceTimersByTimeAsync(60);
    input();
  }
  await vi.advanceTimersByTimeAsync(850);
  input();
  await vi.advanceTimersByTimeAsync(1);
  for (let i = 0; i < 16; i++) {
    input();
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(await pending).toMatchObject({
    captureOutcome: "complete",
    boundedMediaObserved: true,
    releaseOutcome: "stop_unconfirmed",
    reconnectOutcome: "connected",
  });
  expect(video).toHaveBeenCalledTimes(16);
  const replacement = Reflect.get(router, "sessions").get(station);
  expect(replacement.lastInformationRead).toBeDefined();
  expect(replacement.playbackObservation.ordinaryFrames).toBeGreaterThan(0);
  expect(Reflect.get(router, "playbackHolds").size).toBe(0);
  const refused = await router.readEventPlaybackCandidate(station, { ...options(), clip });
  expect(refused).toMatchObject({ captureOutcome: "not_admitted", admissionGateName: "observation_window" });
  const livePending = router.mediaProviderFor(camera).live!();
  await vi.advanceTimersByTimeAsync(1);
  const consumer = await livePending;
  sessions[1]!.input(1300, body, 5, 101, 1);
  consumer.stop();
  sessions[1]!.inject(PORTAL_KEEPALIVE);
  await vi.advanceTimersByTimeAsync(60001);
  expect(replacement.playbackObservation.prestartSafe()).toBe(true);
  const next = router.readEventPlaybackCandidate(station, { ...options(), clip });
  await vi.advanceTimersByTimeAsync(5100);
  expect(await next).toMatchObject({ admissionGateName: "none", captureOutcome: "eof" });
});

it("no-media unconfirmed clip replaces the session, holds reads and live, then releases without a marker", async () => {
  const { router, session, sessions, marker } = await fixture();
  session.mediaEnabled = false;
  session.releaseStatus = false;
  const clip = sealedClip(router, session);
  const connected = Promise.withResolvers<void>();
  const create = Reflect.get(router, "deps").createSession;
  Reflect.get(router, "deps").createSession = () => {
    const next = create() as Session;
    const connect = next.connect.bind(next);
    next.connect = async () => {
      await connected.promise;
      await connect();
    };
    return next;
  };
  const pulling = router.readEventPlaybackCandidate(station, { ...options(), clip });
  await vi.advanceTimersByTimeAsync(21100);
  expect(router.getPlaybackSafetyDiagnostics()).toMatchObject({ unresolved: true, reconnect: { attempts: 1 } });
  expect(await router.readRecordingCatalog(clip.scope)).toMatchObject({ reason: "busy" });
  const retired = Reflect.get(router, "sessions").get(station);
  let liveSettled = false;
  const live = router.mediaProviderFor(camera).live!().finally(() => {
    liveSettled = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(liveSettled).toBe(false);
  expect(Reflect.get(router, "lives").has(station)).toBe(false);
  expect(retired.leases).toBe(0);
  expect(session.sent.filter((p) => parsePortalHeader(p)!.commandId === 1350)).toHaveLength(0);
  connected.resolve();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pulling).toMatchObject({
    captureOutcome: "no_media",
    startAcknowledged: false,
    releaseOutcome: "stop_unconfirmed",
    reconnectOutcome: "connected",
    ingressVideoFrames: 0,
    ingressAudioFrames: 0,
  });
  const consumer = await live;
  const replacement = Reflect.get(router, "sessions").get(station);
  const entry = Reflect.get(router, "lives").get(station);
  expect(replacement).not.toBe(retired);
  expect(replacement.session).toBe(sessions[1]);
  expect(Reflect.get(entry.live, "opts").session).toBe(replacement.session);
  expect(retired.leases).toBe(0);
  expect(replacement.leases).toBe(1);
  expect(session.sent.filter((p) => parsePortalHeader(p)!.commandId === 1350)).toHaveLength(0);
  const starts = sessions[1]!.sent.filter((p) => parsePortalHeader(p)!.commandId === 1350);
  expect(starts).toHaveLength(1);
  expect(JSON.parse(starts[0]!.subarray(16).toString())).toMatchObject({ cmd: 1003 });
  expect(session.isConnected).toBe(false);
  expect(sessions).toHaveLength(2);
  expect(router.getPlaybackSafetyDiagnostics()).toMatchObject({ unresolved: false, reconnect: { connected: 1 } });
  expect(marker).toEqual([]);
  consumer.stop();
  expect(replacement.leases).toBe(0);
});

it.each(["failed", "timed_out"] as const)(
  "real live acquisition resumes on a fresh owner after %s playback recovery",
  async (outcome) => {
    const { router, session, sessions } = await fixture();
    const retired = Reflect.get(router, "sessions").get(station);
    const connected = Promise.withResolvers<void>();
    if (outcome === "failed") {
      const create = Reflect.get(router, "deps").createSession;
      Reflect.get(router, "deps").createSession = () => {
        const next = create() as Session;
        if (sessions.length === 2) next.connect = () => connected.promise;
        return next;
      };
    } else {
      vi.spyOn(router as unknown as { replaceSession: () => Promise<void> }, "replaceSession").mockImplementation(
        () => new Promise(() => {}),
      );
    }
    const recovering = Reflect.get(router, "reconnectPlayback").call(router, station, retired);
    let liveSettled = false;
    const live = router.mediaProviderFor(camera).live!().finally(() => {
      liveSettled = true;
    });
    await vi.advanceTimersByTimeAsync(outcome === "timed_out" ? 59999 : 100);
    expect(liveSettled).toBe(false);
    expect(Reflect.get(router, "lives").has(station)).toBe(false);
    expect(retired.leases).toBe(0);
    if (outcome === "failed") connected.reject(new Error("synthetic connection failure"));
    await vi.advanceTimersByTimeAsync(1);
    expect(await recovering).toMatchObject({ reconnectOutcome: outcome });
    expect(liveSettled).toBe(true);
    const consumer = await live;
    const current = Reflect.get(router, "sessions").get(station);
    const entry = Reflect.get(router, "lives").get(station);
    expect(current).not.toBe(retired);
    expect(current.session).toBe(sessions.at(-1));
    expect(current.session.isConnected).toBe(true);
    expect(Reflect.get(entry.live, "opts").session).toBe(current.session);
    expect(retired.leases).toBe(0);
    expect(current.leases).toBe(1);
    expect(session.isConnected).toBe(false);
    expect(session.sent.filter((p) => parsePortalHeader(p)!.commandId === 1350)).toHaveLength(0);
    const starts = (current.session as Session).sent.filter((p) => parsePortalHeader(p)!.commandId === 1350);
    expect(starts).toHaveLength(1);
    expect(JSON.parse(starts[0]!.subarray(16).toString())).toMatchObject({ cmd: 1003 });
    expect(router.getPlaybackSafetyDiagnostics().unresolved).toBe(false);
    consumer.stop();
    expect(current.leases).toBe(0);
  },
);

it("uncertain clip bypasses exhausted proactive renewal eligibility and retires on replacement failure", async () => {
  const { router, session } = await fixture();
  session.releaseStatus = false;
  const owner = Reflect.get(router, "sessions").get(station);
  owner.refreshAttempts = 2;
  Reflect.get(router, "deps").createSession = () => {
    throw Error("synthetic connection failure");
  };
  const pending = router.readEventPlaybackCandidate(station, { ...options(), clip: sealedClip(router, session) });
  await vi.advanceTimersByTimeAsync(16100);
  expect(await pending).toMatchObject({ reconnectOutcome: "failed" });
  expect(session.isConnected).toBe(false);
  expect(router.getPlaybackSafetyDiagnostics().unresolved).toBe(false);
});

it("reconnect hard cap releases waiters and retires uncertain ownership even if renewal never settles", async () => {
  const { router, session } = await fixture();
  const owner = Reflect.get(router, "sessions").get(station);
  vi.spyOn(router as unknown as { replaceSession: () => Promise<void> }, "replaceSession").mockImplementation(
    () => new Promise(() => {}),
  );
  const recovering = Reflect.get(router, "reconnectPlayback").call(router, station, owner);
  let finished = false;
  const waiter = Reflect.get(router, "waitForPlaybackReconnect")
    .call(router, station)
    .then(() => {
      finished = true;
    });
  await vi.advanceTimersByTimeAsync(59999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await recovering).toEqual({ reconnectOutcome: "timed_out", reconnectDurationMs: 60000 });
  await waiter;
  expect(session.isConnected).toBe(false);
  expect(router.getPlaybackSafetyDiagnostics()).toMatchObject({ unresolved: false, reconnect: { timedOut: 1 } });
});

it("admits playback after sequential live stops and trailing LIVE media on the same owner", async () => {
  const { router, session } = await fixture();
  for (const target of [camera, "second-camera-synthetic"]) {
    const pending = router.mediaProviderFor(target).live!();
    await vi.advanceTimersByTimeAsync(1);
    const consumer = await pending;
    session.input(1300, Buffer.alloc(22), 5, 101, 1);
    await vi.advanceTimersByTimeAsync(11000);
    session.input(1300, Buffer.alloc(22), 5, 101, 1);
    consumer.stop();
    for (const command of [1300, 1301, 1303]) session.input(command, Buffer.alloc(22), 5, 101, 1);
  }
  await vi.advanceTimersByTimeAsync(20000);
  for (const command of [1300, 1301, 1303]) session.input(command, Buffer.alloc(22), 5, 101, 1);
  expect(Reflect.get(router, "sessions").get(station).liveTargetAmbiguous).toBe(true);
  const next = router.readEventPlaybackCandidate(station, options());
  await vi.advanceTimersByTimeAsync(5100);
  expect(await next).toMatchObject({ admissionGateName: "none", captureOutcome: "eof" });
});

it.each([false, true])("late playback fragments recover a finished clip compressed=%s", async (compressed) => {
  const { router, session, sessions } = await fixture();
  const pending = router.readEventPlaybackCandidate(station, { ...options(), clip: sealedClip(router, session) });
  await vi.advanceTimersByTimeAsync(5100);
  expect(await pending).toMatchObject({ releaseOutcome: "release_confirmed", reconnectOutcome: "not_needed" });
  const frame = Buffer.concat([buildPortalHeader(1300, 5000, 101, 9, 6), Buffer.alloc(5000)]);
  const fragments = packetize(compressed ? zstdCompressSync(frame) : frame, {
    channel: 4,
    frameId: ++session.counter,
    payloadBytes: 8,
  });
  expect(fragments.length).toBeGreaterThan(1);
  if (compressed) for (const p of fragments) p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
  session.inject(fragments.at(-1)!);
  await vi.advanceTimersByTimeAsync(10);
  expect(sessions).toHaveLength(2);
  expect(session.isConnected).toBe(false);
  expect(Reflect.get(router, "sessions").get(station).session).toBe(sessions[1]);
  expect(router.getPlaybackSafetyDiagnostics().reconnect).toMatchObject({ attempts: 1, connected: 1 });
});

it.each([
  ["matched", false],
  ["matched", true],
  ["unmatched", false],
])("clip refusal reconnect safety: %s release=%s", async (refusal, releaseStatus) => {
  const { router, session, sessions } = await fixture();
  session.refusal = refusal;
  session.releaseStatus = releaseStatus as boolean;
  const pending = router.readEventPlaybackCandidate(station, { ...options(), clip: sealedClip(router, session) });
  await vi.advanceTimersByTimeAsync(25000);
  const receipt = await pending;
  expect(receipt).toMatchObject({
    captureOutcome: "start_refused",
    startAcknowledged: false,
    stationRefusalConfirmed: refusal === "matched",
    reconnectOutcome: "connected",
  });
  expect(sessions).toHaveLength(2);
  expect(session.isConnected).toBe(false);
  expect(Reflect.get(router, "sessions").get(station).session).toBe(sessions[1]);
  session.input(1351, { cmd: 6001, payload: { state: 1, code: 0 } });
  expect(Reflect.get(router, "sessions").get(station).session).toBe(sessions[1]);
  expect(router.getPlaybackSafetyDiagnostics().reconnect.attempts).toBe(1);
});
