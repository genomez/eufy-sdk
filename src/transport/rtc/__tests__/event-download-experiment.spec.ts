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

function fixture(options: { file?: (b: Buffer) => void; ack?: number; send?: boolean } = {}) {
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
    signal: controller.signal,
    deadlineMs: performance.now() + 36000,
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

it.each([0, -7])("captures a correlated ACK status %s, waits at most 20 seconds and cancels once", async (ack) => {
  const s = fixture({ ack });
  await vi.advanceTimersByTimeAsync(19999);
  expect(s.sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await s.capture;
  s.candidate.finalize();
  const r = await s.candidate.observe(true);
  expect(r).toMatchObject({
    mode: "download",
    captureOutcome: "capped",
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

it("caps raw FILE evidence at exactly 16 MiB and never sends it to video", async () => {
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
