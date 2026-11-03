import type { RtcSession } from "./session.js";
import { buildPortalPacket, parsePortalPacket, PortalLinkType } from "./portal-packet.js";
import type { EventTableObservation, EventTableReceipt } from "./event-table-candidate.js";

export const THUMB_IMAGE_CAP = 256 * 1024;
export const THUMB_ENVELOPE_CAP = 512 * 1024;
export interface EventThumbnailReceipt {
  outcome: EventTableReceipt["outcome"];
  elapsedMs: number;
  tableElapsedMs: number | null;
  imageElapsedMs: number | null;
  rowCount: number | null;
  imageBytes: number | null;
  jpegValid: boolean;
  width: number | null;
  height: number | null;
  tableResultCode: number | null;
  imageResultCode: number | null;
  ownerContinuous: boolean;
  generationContinuous: boolean;
}
export interface ThumbnailImageResult {
  outcome: EventTableReceipt["outcome"];
  elapsedMs: number;
  deadlineMs: number;
  resultCode: number | null;
  jpeg?: Buffer;
  width?: number;
  height?: number;
}

function rowTime(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  if (/^\d{10}$/.test(value)) return Number(value) * 1000;
  if (/^\d{13}$/.test(value)) return Number(value);
  if (/^\d{14}$/.test(value)) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}.000Z`;
    const time = Date.parse(iso);
    if (Number.isFinite(time) && new Date(time).toISOString() === iso) return time;
  }
  return;
}

/** Only a storage path returned in this invocation may be selected; all values stay in memory. */
export function selectThumbnail(rows: unknown[]): string | undefined {
  let selected: { file: string; time: number } | undefined;
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const file = row.thumb_path,
      time = rowTime(row.start_time);
    if (
      typeof file !== "string" ||
      !file.startsWith("/") ||
      Buffer.byteLength(file) > 2048 ||
      /[\x00-\x20\x7f\\]/.test(file) ||
      file.split("/").some((p) => p === ".." || p === ".") ||
      !/\.jpe?g$/i.test(file) ||
      time === undefined
    )
      continue;
    if (!selected || time > selected.time) selected = { file, time };
  }
  return selected?.file;
}

/** Strict canonical base64, JPEG bounds and SOF geometry; no image decoding or metadata output. */
export function validateThumbnail(content: unknown): { jpeg: Buffer; width: number; height: number } | undefined {
  if (
    typeof content !== "string" ||
    !content.length ||
    content.length > 4 * Math.ceil(THUMB_IMAGE_CAP / 3) ||
    content.length % 4 ||
    /[^A-Za-z0-9+/=]/.test(content)
  )
    return;
  const jpeg = Buffer.from(content, "base64");
  if (
    jpeg.length > THUMB_IMAGE_CAP ||
    jpeg.length < 12 ||
    jpeg.toString("base64") !== content ||
    jpeg.readUInt16BE(0) !== 0xffd8 ||
    jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9
  )
    return;
  let width: number | undefined, height: number | undefined;
  let offset = 2;
  while (offset < jpeg.length - 2) {
    if (jpeg[offset++] !== 0xff) return;
    while (jpeg[offset] === 0xff) offset++;
    const marker = jpeg[offset++];
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0xd9) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > jpeg.length - 2) return;
    const length = jpeg.readUInt16BE(offset);
    if (length < 2 || offset + length > jpeg.length - 2) return;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || length !== 8 + 3 * jpeg[offset + 7]!) return;
      const h = jpeg.readUInt16BE(offset + 3),
        w = jpeg.readUInt16BE(offset + 5);
      if (!w || !h || (width !== undefined && (width !== w || height !== h))) return;
      width = w;
      height = h;
    }
    if (marker === 0xda) return width && height ? { jpeg, width, height } : undefined;
    offset += length;
  }
  return;
}

/** #525 has no notify transaction echo: exact file + owner generation, ACK uses the issued segment. */
export function collectThumbnail(
  session: RtcSession,
  accountId: string,
  segment: number,
  file: string,
  signal: AbortSignal,
  deadlineMs: number,
  continuity: () => { ownerContinuous: boolean; generationContinuous: boolean },
  observation: EventTableObservation,
): Promise<ThumbnailImageResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false,
      sent = false,
      accepted = false,
      ack = false;
    let resultCode: number | null = null,
      seenBytes = 0;
    let answer: ReturnType<typeof validateThumbnail>;
    let release: (() => void) | undefined;
    const finish = (outcome: ThumbnailImageResult["outcome"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release?.();
      session.off("commandData", onData);
      session.off("close", onClose);
      session.off("error", onClose);
      signal.removeEventListener("abort", onAbort);
      resolve({
        outcome,
        deadlineMs,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        resultCode,
        ...(outcome === "success" ? answer : {}),
      });
    };
    const valid = () => {
      if (signal.aborted) {
        onAbort();
        return false;
      }
      if (performance.now() >= deadlineMs) {
        finish(ack ? "ack_only/timeout" : "timeout");
        return false;
      }
      const c = continuity();
      if (!session.isConnected || !c.ownerContinuous || !c.generationContinuous) {
        finish("owner_changed");
        return false;
      }
      return !settled;
    };
    const complete = () => {
      if (accepted && ack && answer && valid()) finish("success");
    };
    const onClose = () => finish("owner_changed");
    const onAbort = () =>
      finish(signal.reason === "deadline" || performance.now() >= deadlineMs ? "timeout" : "abandoned");
    const onData = (bytes: Buffer, link: number) => {
      if (!sent || !valid() || link !== PortalLinkType.COMMAND || bytes.length > 1024) return;
      const p = parsePortalPacket(bytes, link);
      if (p?.commandId !== 1350 || p.channel !== 255 || p.segment !== segment || p.isResponse !== 1) return;
      if (p.errCode !== 0) {
        resultCode = p.errCode ?? null;
        finish("result_nonzero");
        return;
      }
      ack = true;
      complete();
    };
    const timer = setTimeout(
      () => finish(ack ? "ack_only/timeout" : "timeout"),
      Math.max(0, deadlineMs - performance.now()),
    );
    if (!valid()) return;
    release = observation.subscribe((bytes, p) => {
      if (
        !sent ||
        !valid() ||
        p.linkType !== PortalLinkType.NOTIFY ||
        p.commandId !== 1308 ||
        p.channel !== 255 ||
        p.isResponse !== 0
      )
        return;
      if (bytes > THUMB_ENVELOPE_CAP) {
        finish("receive_rejected");
        return;
      }
      const v = p.data as Record<string, unknown> | undefined;
      if (!v || typeof v !== "object" || Array.isArray(v) || v.file !== file) return;
      seenBytes += bytes;
      if (seenBytes > THUMB_ENVELOPE_CAP) {
        finish("receive_rejected");
        return;
      }
      if (v.mIntRet !== undefined && !Number.isSafeInteger(v.mIntRet)) {
        finish("invalid_reply");
        return;
      }
      resultCode = v.mIntRet === undefined ? 0 : (v.mIntRet as number);
      if (resultCode !== 0) {
        finish("result_nonzero");
        return;
      }
      answer = validateThumbnail(v.content);
      if (!answer) {
        finish("invalid_reply");
        return;
      }
      complete();
    });
    session.on("commandData", onData);
    session.on("close", onClose);
    session.on("error", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (!valid()) return;
      const packet = buildPortalPacket({
        commandId: 1350,
        channel: 255,
        segment,
        payload: { account_id: accountId, cmd: 1308, mChannel: 255, mValue3: 0, payload: [{ file }] },
      });
      sent = true;
      observation.issued();
      accepted = session.sendCommand(packet);
      if (!accepted) finish("send_refused");
      else complete();
    } catch {
      finish("send_refused");
    }
  });
}
