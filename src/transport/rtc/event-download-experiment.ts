import { buildPortalPacket, parsePortalHeader, PortalLinkType } from "./portal-packet.js";
import { PlaybackNativeFrameTiming } from "./playback-telemetry.js";

export const DOWNLOAD_EXPERIMENT_BYTES = 256 * 1024 * 1024;

/** Catalog-bound capture budget with a one-minute minimum and timer-safe ceiling. */
export function downloadCaptureMs(expectedMs = 0): number {
  return Math.min(2147452647, Math.max(60000, expectedMs * 3));
}
let lastDownloadId = 0;

/** Unique process-local millisecond identifiers, independent of portal segment rollover. */
export function nextDownloadId(): number {
  return (lastDownloadId = Math.max(Date.now(), lastDownloadId + 1));
}

/** Public portal record download envelope; station support remains unverified. */
export function downloadRequest(
  account: string,
  record: number,
  camera: string,
  streamId: number,
  downloadId: number,
  segment: number,
  cancel = false,
): Buffer {
  return buildPortalPacket({
    commandId: 1350,
    channel: 255,
    devType: 2,
    segment,
    payload: {
      account_id: account,
      cmd: 1024,
      commandType: 1024,
      payload: cancel
        ? { cmd: 0, cancelId: [{ download_id: downloadId }], backupPath: "abcd" }
        : {
            cmd: 1,
            backupPath: "",
            streamId,
            recordIds: [{ record_id: record, download_id: downloadId, device_sn: camera }],
            videoQuality: 0,
          },
    },
  });
}

/** Signature inference only; no payload prefix, identifiers or raw header values are exposed. */
export function classifyDownloadPrefix(bytes: Buffer): "mp4_ftyp" | "hevc_annex_b" | "other" | "empty" {
  if (!bytes.length) return "empty";
  if (bytes.length >= 8 && bytes.toString("ascii", 4, 8) === "ftyp") return "mp4_ftyp";
  const offset =
    bytes.length >= 4 && bytes.readUInt32BE(0) === 1 ? 4 : bytes.length >= 3 && bytes.readUIntBE(0, 3) === 1 ? 3 : -1;
  if (offset >= 0 && bytes.length >= offset + 2 && !(bytes[offset]! & 0x80) && (bytes[offset + 1]! & 7) !== 0)
    return "hevc_annex_b";
  return "other";
}

/** Bounded complete logical-frame counts and terminal notifications; these never certify playable media. */
export class DownloadEvidence {
  readonly value = {
    ackReceived: false,
    ackStatus: null as number | null,
    cancelAckReceived: false,
    cancelAckStatus: null as number | null,
    cancelAttempted: false,
    cancelSent: false,
    links: [] as { link: number; count: number; bytes: number; firstByteMs: number; lastByteMs: number }[],
    routes: [] as { link: number; channel: number | null; command: number | null; count: number }[],
    ptcsChannels: [] as { channel: number; count: number; bytes: number }[],
    statuses: [] as {
      command: number;
      innerCommand: number;
      subcommand: number | null;
      state: number | null;
      code: number | null;
      count: number;
    }[],
    routeOverflow: 0,
    terminalCommandIds: [] as number[],
    fileBytes: 0,
    firstFileByteMs: null as number | null,
    lastFileByteMs: null as number | null,
    terminalStatus: null as {
      command: number;
      innerCommand: number;
      subcommand: number | null;
      state: number | null;
      code: number | null;
    } | null,
    parsedFrameCount: 0,
    mediaDurationMs: undefined as number | undefined,
    codec: "unknown" as "unknown" | "h264" | "hevc",
    firstBytes: "empty" as ReturnType<typeof classifyDownloadPrefix>,
  };
  private prefix = Buffer.alloc(0);
  private readonly timing = new PlaybackNativeFrameTiming();

  /** Counts complete clear Annex-B video envelopes; timestamp units require catalog agreement. */
  file(frame: Buffer, elapsed: number): void {
    this.value.firstFileByteMs ??= elapsed;
    this.value.lastFileByteMs = elapsed;
    for (let offset = 0; offset + 38 <= frame.length;) {
      const bytes = frame.subarray(offset);
      const h = parsePortalHeader(bytes);
      if (!h || h.paramLength + 16 > bytes.length) break;
      const body = bytes.subarray(16, 16 + h.paramLength);
      if (h.commandId === 1300 && body.length >= 28 && body.readUInt32LE(0) === body.length - 22) {
        const data = body.subarray(22);
        const start = data.readUInt32BE(0) === 1 ? 4 : data.readUIntBE(0, 3) === 1 ? 3 : -1;
        if (start >= 0) {
          const avc = data[start]! & 31;
          const hevc = (data[start]! >>> 1) & 63;
          const codec =
            avc === 7 || avc === 8 ? "h264" : hevc >= 32 && hevc <= 34 ? "hevc" : body[5] === 1 ? "hevc" : "h264";
          if (this.value.codec === "unknown") this.value.codec = codec;
          if (codec === this.value.codec) {
            this.value.parsedFrameCount++;
            this.timing.add(body, elapsed);
          }
        }
      }
      offset += h.paramLength + 16;
    }
  }

  /** A duration is reported only for catalog-consistent advancing native header words. */
  durationMs(expectedMs?: number): number | undefined {
    return expectedMs === undefined ? undefined : this.timing.durationMs(expectedMs);
  }

  packet(channel: number, bytes: number): void {
    const row = this.value.ptcsChannels.find((r) => r.channel === channel);
    if (row) {
      row.count = Math.min(65535, row.count + 1);
      row.bytes = Math.min(Number.MAX_SAFE_INTEGER, row.bytes + bytes);
    } else if (this.value.ptcsChannels.length < 32) this.value.ptcsChannels.push({ channel, count: 1, bytes });
  }

  add(frame: Buffer, link: number, elapsed: number): void {
    const h = parsePortalHeader(frame);
    let row = this.value.links.find((r) => r.link === link);
    if (!row && this.value.links.length < 32) {
      row = { link, count: 0, bytes: 0, firstByteMs: elapsed, lastByteMs: elapsed };
      this.value.links.push(row);
    }
    if (row) {
      row.count = Math.min(65535, row.count + 1);
      row.bytes = Math.min(Number.MAX_SAFE_INTEGER, row.bytes + frame.length);
      row.lastByteMs = elapsed;
    }
    const route = this.value.routes.find(
      (r) => r.link === link && r.channel === (h?.channel ?? null) && r.command === (h?.commandId ?? null),
    );
    if (route) route.count = Math.min(65535, route.count + 1);
    else if (this.value.routes.length < 32)
      this.value.routes.push({ link, channel: h?.channel ?? null, command: h?.commandId ?? null, count: 1 });
    else this.value.routeOverflow = Math.min(65535, this.value.routeOverflow + 1);
    if (h && link === PortalLinkType.NOTIFY && h.paramLength + 16 === frame.length && frame.length <= 16384) {
      try {
        const v = JSON.parse(frame.subarray(16).toString("utf8"));
        const scalar = (n: unknown): number | null =>
          Number.isSafeInteger(n) && (n as number) >= -2147483648 && (n as number) <= 2147483647 ? (n as number) : null;
        const innerCommand = scalar(v?.cmd);
        if (innerCommand !== null) {
          const status = {
            command: h.commandId,
            innerCommand,
            subcommand: scalar(v?.payload?.cmd),
            state: scalar(v?.payload?.state),
            code: scalar(v?.payload?.code),
            count: 1,
          };
          const row = this.value.statuses.find(
            (r) =>
              r.command === status.command &&
              r.innerCommand === innerCommand &&
              r.subcommand === status.subcommand &&
              r.state === status.state &&
              r.code === status.code,
          );
          if (row) row.count = Math.min(65535, row.count + 1);
          else if (this.value.statuses.length < 32) this.value.statuses.push(status);
          if (
            ((innerCommand === 1024 && status.subcommand === 0) ||
              (innerCommand === 6001 && status.state === 2 && (status.code === 14 || status.code === 15))) &&
            !this.value.terminalCommandIds.includes(innerCommand)
          ) {
            this.value.terminalCommandIds.push(innerCommand);
            const { count: _count, ...terminal } = status;
            this.value.terminalStatus ??= terminal;
          }
        }
      } catch {}
    }
    if (link === PortalLinkType.FILE && this.prefix.length < 16) {
      this.prefix = Buffer.concat([this.prefix, frame.subarray(0, 16 - this.prefix.length)]);
      this.value.firstBytes = classifyDownloadPrefix(this.prefix);
    }
  }
}
