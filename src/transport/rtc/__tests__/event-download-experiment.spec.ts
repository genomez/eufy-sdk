import { afterEach, expect, it, vi } from "vitest";
import { performance as nativePerformance } from "node:perf_hooks";
import { zstdCompressSync } from "node:zlib";
import {
  classifyDownloadPrefix,
  downloadRequest,
  DownloadEvidence,
  nextDownloadId,
  DOWNLOAD_EXPERIMENT_BYTES,
} from "../event-download-experiment.js";
import { EventPlaybackCandidate, reservePlaybackSelectors } from "../event-playback-candidate.js";
import { playbackExperiment } from "../playback-telemetry.js";
import { buildPortalHeader, parsePortalHeader } from "../portal-packet.js";
import { packetize } from "../ptcs-framer.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const experiment = { mode: "download", playSpeed: 1, playType: 1, clientType: "WEB", maxClips: 1 } as const;

function fixture(options: { file?: (b: Buffer) => void; ack?: number; send?: boolean; expectedMs?: number } = {}) {
  vi.useFakeTimers();
  vi.spyOn(nativePerformance, "now").mockImplementation(() => performance.now());
  const controller = new AbortController(),
    sent: Buffer[] = [],
    video = vi.fn(),
    file = vi.fn(options.file),
    latch = vi.fn();
  let segment = 10;
  const candidate = new EventPlaybackCandidate({
    experiment,
    transient: true,
    camera: "camera-synthetic",
    account: "account-synthetic",
    video,
    file,
    expectedMs: options.expectedMs,
    signal: controller.signal,
    deadlineMs: performance.now() + 136000,
    continuous: () => true,
    startAllowed: () => true,
    marker: () => {
      throw Error("unexpected marker");
    },
    latch,
    segment: () => ++segment,
    send: (packet) => {
      sent.push(packet);
      const h = parsePortalHeader(packet)!;
      const status = Buffer.alloc(4);
      status.writeInt32LE(options.ack ?? 0);
      queueMicrotask(() =>
        candidate.ingress.decoded(Buffer.concat([buildPortalHeader(1350, 4, 255, h.segment, 1), status]), 1),
      );
      return options.send !== false;
    },
  });
  const capture = candidate.capture({ record: 40, begin: 1000000 }, [6, 7]);
  return { candidate, capture, controller, sent, video, file, latch };
}

it("accepts flagged plain XZYH video on FILE and ends only on terminal download status", async () => {
  const s = fixture();
  const ack = Buffer.from(JSON.stringify({ cmd: 1024, payload: { code: 0 } }));
  s.candidate.ingress.decoded(Buffer.concat([buildPortalHeader(1351, ack.length, 0, 1), ack]), 3);
  const body = Buffer.alloc(22);
  const data = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x28]);
  body.writeUInt32LE(data.length);
  const raw = Buffer.concat([buildPortalHeader(1300, body.length + data.length, 0, 1), body, data]);
  for (const p of packetize(raw, { channel: 3, frameId: 1, payloadBytes: 20 })) {
    p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
    s.candidate.ingress.native(p);
  }
  await vi.advanceTimersByTimeAsync(25000);
  expect(s.file.mock.calls.map(([b]) => b)).toEqual([raw]);
  expect(s.sent).toHaveLength(1);
  const status = Buffer.from(JSON.stringify({ cmd: 1024, payload: { cmd: 0, code: 0 } }));
  s.candidate.ingress.decoded(Buffer.concat([buildPortalHeader(1351, status.length, 0, 1), status]), 3);
  await s.capture;
  expect(await s.candidate.observe()).toMatchObject({
    captureOutcome: "eof",
    boundedMediaObserved: false,
    download: {
      fileBytes: raw.length,
      firstFileByteMs: 0,
      lastFileByteMs: 0,
      parsedFrameCount: 1,
      codec: "h264",
      terminalStatus: { command: 1351, innerCommand: 1024, subcommand: 0, state: null, code: 0 },
    },
  });
});

it("retains FILE data past a minute with a 3x catalog bound and reports native duration", async () => {
  const s = fixture({ expectedMs: 40000 });
  for (let i = 0; i < 80; i++) {
    const body = Buffer.alloc(22);
    const data = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x28]);
    body.writeUInt32LE(data.length);
    body.writeUInt32LE(i * 500, 14);
    s.candidate.ingress.decoded(Buffer.concat([buildPortalHeader(1300, 22 + data.length, 0, 1), body, data]), 2);
    if (i < 79) await vi.advanceTimersByTimeAsync(1000);
  }
  expect(s.sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(41000);
  await s.capture;
  expect(await s.candidate.observe()).toMatchObject({
    captureOutcome: "capped",
    download: { parsedFrameCount: 80, mediaDurationMs: 40000, firstFileByteMs: 0, lastFileByteMs: 79000 },
  });
});

it.each(["playback", "download"] as const)("accepts %s experiments with no run limit", (mode) => {
  const { maxClips: _max, ...unlimited } = experiment;
  expect(playbackExperiment({ ...unlimited, mode })).toEqual({ ...unlimited, mode });
});

it("builds the exact public portal record and cancel JSON with fresh header segments", () => {
  const packet = downloadRequest("account-synthetic", 40, "camera-synthetic", 6, 1234567890000, 11);
  const payload = {
    account_id: "account-synthetic",
    cmd: 1024,
    commandType: 1024,
    payload: {
      cmd: 1,
      backupPath: "",
      streamId: 6,
      recordIds: [{ record_id: 40, download_id: 1234567890000, device_sn: "camera-synthetic" }],
      videoQuality: 0,
    },
  };
  expect(packet.subarray(16).toString()).toBe(JSON.stringify(payload));
  expect(parsePortalHeader(packet)).toEqual({
    commandId: 1350,
    paramLength: Buffer.byteLength(JSON.stringify(payload)),
    channel: 255,
    segment: 11,
    isResponse: 0,
    devType: 2,
  });
  const cancel = downloadRequest("account-synthetic", 40, "camera-synthetic", 6, 1234567890000, 12, true);
  expect(parsePortalHeader(cancel)).toMatchObject({
    commandId: 1350,
    channel: 255,
    segment: 12,
    isResponse: 0,
    devType: 2,
  });
  expect(cancel.subarray(16).toString()).toBe(
    JSON.stringify({
      account_id: "account-synthetic",
      cmd: 1024,
      commandType: 1024,
      payload: { cmd: 0, cancelId: [{ download_id: 1234567890000 }], backupPath: "abcd" },
    }),
  );
});

it("reuses reserved playback selectors without reuse during owner lifetime and generates unique ids", () => {
  const used = new Set<number>();
  expect(reservePlaybackSelectors(used)).toEqual([6, 7]);
  expect(reservePlaybackSelectors(used)).toEqual([8, 9]);
  expect(
    JSON.parse(downloadRequest("synthetic", 40, "synthetic", 8, 100, 1).subarray(16).toString()).payload.streamId,
  ).toBe(8);
  const a = nextDownloadId(),
    b = nextDownloadId();
  expect(b).toBeGreaterThan(a);
});

it.each([0, -7])("captures ACK status %s, bounds capture at 60 seconds and cancels once", async (ack) => {
  const s = fixture({ ack });
  await vi.advanceTimersByTimeAsync(59999);
  expect(s.sent).toHaveLength(ack === 0 ? 1 : 2);
  await vi.advanceTimersByTimeAsync(1);
  await s.capture;
  s.candidate.finalize();
  const r = await s.candidate.observe(true);
  expect(r).toMatchObject({
    mode: "download",
    captureOutcome: ack === 0 ? "capped" : "start_refused",
    boundedMediaObserved: false,
    accepted: false,
    latchRetained: true,
    download: { ackReceived: true, ackStatus: ack, cancelAttempted: true, cancelSent: true },
  });
  expect(s.sent).toHaveLength(2);
  expect(JSON.parse(s.sent[1]!.subarray(16).toString()).payload.cancelId[0].download_id).toBe(
    JSON.parse(s.sent[0]!.subarray(16).toString()).payload.recordIds[0].download_id,
  );
  expect(s.video).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("caps raw FILE evidence at exactly 256 MiB and never sends it to video", async () => {
  const s = fixture();
  s.candidate.ingress.decoded(Buffer.alloc(DOWNLOAD_EXPERIMENT_BYTES + 100), 2);
  await s.capture;
  const r = await s.candidate.observe();
  expect(r.download?.fileBytes).toBe(DOWNLOAD_EXPERIMENT_BYTES);
  expect(s.file.mock.calls[0]![0]).toHaveLength(DOWNLOAD_EXPERIMENT_BYTES);
  expect(s.video).not.toHaveBeenCalled();
  expect(s.sent).toHaveLength(2);
  expect(s.candidate.ingress.decoded(Buffer.from("late-synthetic"), 2)).toBe(false);
  expect(s.file).toHaveBeenCalledOnce();
});

it.each(["abort", "storage", "send"])("cancels on %s without media readiness", async (reason) => {
  const s = fixture({
    ...(reason === "storage"
      ? {
          file: () => {
            throw Error("synthetic");
          },
        }
      : {}),
    send: reason !== "send",
  });
  if (reason === "abort") s.controller.abort();
  if (reason === "storage") s.candidate.ingress.decoded(Buffer.alloc(10), 2);
  await s.capture;
  expect(await s.candidate.observe()).toMatchObject({
    captureOutcome: reason === "abort" ? "preempted" : reason === "storage" ? "storage_failed" : "start_refused",
    boundedMediaObserved: false,
    download: { cancelAttempted: true },
  });
  expect(s.sent).toHaveLength(2);
});

it("uses strict bounded PTCS reassembly for compressed and fragmented raw FILE frames", async () => {
  const s = fixture();
  const raw = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, ...Array(2000).fill(0)]);
  for (const compressed of [false, true]) {
    const packets = packetize(compressed ? zstdCompressSync(raw) : raw, {
      channel: 3,
      frameId: compressed ? 2 : 1,
      payloadBytes: 40,
    });
    for (const p of packets) {
      if (compressed) p.writeUInt16LE(p.readUInt16LE(18) | 0x0800, 18);
      expect(s.candidate.ingress.native(p)).toBe(false);
    }
  }
  expect(s.file.mock.calls.map(([b]) => b)).toEqual([raw, raw]);
  expect(s.candidate.receipt.download).toMatchObject({
    fileBytes: raw.length * 2,
    firstBytes: "mp4_ftyp",
    links: [{ link: 2, count: 2, bytes: raw.length * 2 }],
  });
  s.controller.abort();
  await s.capture;
  await s.candidate.observe();
});

it("classifies signatures without retaining any raw prefix or identifier", () => {
  expect(classifyDownloadPrefix(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))).toBe("mp4_ftyp");
  expect(classifyDownloadPrefix(Buffer.from([0, 0, 0, 1, 0x26, 1]))).toBe("hevc_annex_b");
  expect(classifyDownloadPrefix(Buffer.from("account-synthetic"))).toBe("other");
  const e = new DownloadEvidence();
  for (let i = 0; i < 40; i++) e.add(Buffer.concat([buildPortalHeader(1303 + i, 0, i, 1), Buffer.alloc(0)]), 3, i);
  e.add(Buffer.from("account-synthetic"), 2, 41);
  expect(e.value.routes).toHaveLength(32);
  expect(e.value.routeOverflow).toBe(9);
  expect(e.value.terminalCommandIds).toEqual([]);
  const notify = Buffer.from(JSON.stringify({ cmd: 1024, payload: { cmd: 0, private: "account-synthetic" } }));
  e.add(Buffer.concat([buildPortalHeader(1351, notify.length, 0, 1), notify]), 3, 42);
  expect(e.value.terminalCommandIds).toEqual([1024]);
  expect(JSON.stringify(e.value)).not.toContain("account");
});

it("rejects unsupported modes and defaults existing experiment tuples to playback", () => {
  expect(playbackExperiment(undefined)).toBeUndefined();
  expect(playbackExperiment({ ...experiment, mode: "playback" })?.mode).toBe("playback");
  expect(() => playbackExperiment({ ...experiment, mode: "other" })).toThrow();
});
