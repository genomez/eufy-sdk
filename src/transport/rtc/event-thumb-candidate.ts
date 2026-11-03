import type { RtcSession } from "./session.js";
import { buildPortalPacket, parsePortalPacket, PortalLinkType } from "./portal-packet.js";
import type { EventTableObservation, EventTableReceipt } from "./event-table-candidate.js";

export const THUMB_IMAGE_CAP = 512 * 1024;
export const THUMB_ENVELOPE_CAP = 512 * 1024;
export interface ContentDiagnostics {
  contentType: string;
  contentLength: number | null;
  hasStdChars: boolean;
  hasUrlSafeChars: boolean;
  hasWhitespace: boolean;
  hasNewline: boolean;
  hasOtherChars: boolean;
  paddingCount: number;
  lengthMod4: number | null;
  decodedBytes: number | null;
  soi: boolean;
  eoiAtEnd: boolean;
  lastEoiOffsetFromEnd: number | null;
  sofFound: boolean;
  width: number | null;
  height: number | null;
  otherKeyCount: number;
  keys: Record<"content" | "file" | "mIntRet" | "data" | "image" | "size" | "msg", boolean>;
}
export interface EventThumbnailReceipt {
  contentDiagnostics: ContentDiagnostics | null;
  rawSaved?: boolean;
  outcome: EventTableReceipt["outcome"];
  elapsedMs: number;
  tableElapsedMs: number | null;
  imageElapsedMs: number | null;
  rowCount: number | null;
  shapes: ThumbnailShapes;
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
  contentDiagnostics?: ContentDiagnostics;
  jpeg?: Buffer;
  raw?: Buffer;
  width?: number | null;
  height?: number | null;
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
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface ShapeClass {
  pattern: string | null;
  count: number;
  startsWithSlash?: boolean | null;
  extension?: string | null;
  byteLength?: number | null;
}
export interface ThumbnailShapes {
  start_time: { classes: ShapeClass[]; other: number };
  thumb_path: { classes: ShapeClass[]; other: number };
}

/** ASCII values become class symbols; only fixed punctuation and extension categories survive. */
export function thumbnailShapes(rows: unknown[]): ThumbnailShapes {
  const result: ThumbnailShapes = {
    start_time: { classes: [], other: 0 },
    thumb_path: { classes: [], other: 0 },
  };
  for (const raw of rows) {
    const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    for (const field of ["start_time", "thumb_path"] as const) {
      const value = row[field];
      let pattern =
        typeof value === "string"
          ? value
              .replace(/[^A-Za-z0-9/\-_.:,+ ]/gu, "?")
              .replace(/[A-Za-z]/g, "a")
              .replace(/[0-9]/g, "9")
          : null;
      const shape: ShapeClass = { pattern, count: 1 };
      if (field === "thumb_path") {
        pattern = pattern?.replace(/([\s\S])\1+/g, "$1").slice(0, 64) ?? null;
        const ext =
          typeof value === "string" && value.includes(".")
            ? value.slice(value.lastIndexOf(".") + 1).toLowerCase()
            : "none";
        Object.assign(shape, {
          pattern,
          startsWithSlash: typeof value === "string" ? value.startsWith("/") : null,
          extension: ["jpg", "jpeg", "png", "bmp", "dat", "bin", "none"].includes(ext) ? ext : "other",
          byteLength: typeof value === "string" ? Buffer.byteLength(value) : null,
        });
      }
      const bucket = result[field];
      const key = JSON.stringify({ ...shape, count: 1 });
      const existing = bucket.classes.find((entry) => JSON.stringify({ ...entry, count: 1 }) === key);
      if (existing) existing.count++;
      else if (bucket.classes.length < 4) bucket.classes.push(shape);
      else bucket.other++;
    }
  }
  return result;
}

/** Only a storage path returned in this invocation may be selected; all values stay in memory. */
export function selectThumbnail(rows: unknown[]): string | undefined {
  let byId: { file: string; id: number } | undefined;
  let byTime: { file: string; time: number } | undefined;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const file = row.thumb_path,
      time = rowTime(row.start_time);
    if (
      typeof file !== "string" ||
      !file.length ||
      Buffer.byteLength(file) > 2048 ||
      /[\x00-\x1f\x7f-\x9f]/.test(file) ||
      file.split(/[/\\]/).some((p) => p === "..")
    )
      continue;
    if (typeof row.record_id === "number" && Number.isInteger(row.record_id) && (!byId || row.record_id > byId.id))
      byId = { file, id: row.record_id };
    if (time !== undefined && (!byTime || time > byTime.time)) byTime = { file, time };
  }
  return byId?.file ?? byTime?.file;
}

/** Inspect only marker structure; malformed or unknown segments never invalidate an otherwise bounded image. */
function geometry(jpeg: Buffer): { width: number | null; height: number | null } {
  let offset = 2;
  while (offset < jpeg.length - 1) {
    if (jpeg[offset++] !== 0xff) continue;
    while (jpeg[offset] === 0xff) offset++;
    const marker = jpeg[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > jpeg.length) break;
    const length = jpeg.readUInt16BE(offset);
    if (length < 2 || offset + length > jpeg.length) break;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) &&
      length >= 7
    ) {
      return { width: jpeg.readUInt16BE(offset + 5), height: jpeg.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return { width: null, height: null };
}

/** Fixed, value-free diagnostics. Oversized envelopes never reach the decoder. */
export function thumbnailContentDiagnostics(reply: Record<string, unknown>, decode = true): ContentDiagnostics {
  const content = reply.content;
  const text = typeof content === "string" ? content : "";
  const jpeg = decode && typeof content === "string" ? Buffer.from(text, "base64") : undefined;
  const soi = !!jpeg && jpeg.length >= 2 && jpeg.readUInt16BE(0) === 0xffd8;
  const eoi = jpeg?.lastIndexOf(Buffer.from([0xff, 0xd9])) ?? -1;
  const dimensions = soi && jpeg ? geometry(jpeg) : { width: null, height: null };
  const names = ["content", "file", "mIntRet", "data", "image", "size", "msg"] as const;
  return {
    contentType: typeof content,
    contentLength: typeof content === "string" ? content.length : null,
    hasStdChars: /[+/]/.test(text),
    hasUrlSafeChars: /[-_]/.test(text),
    hasWhitespace: /[\x09-\x0d ]/.test(text),
    hasNewline: /[\r\n]/.test(text),
    hasOtherChars: /[^A-Za-z0-9+/_=\x09-\x0d -]/.test(text),
    paddingCount: Math.min(2, (text.match(/=/g) ?? []).length),
    lengthMod4: typeof content === "string" ? content.length % 4 : null,
    decodedBytes: jpeg?.length ?? null,
    soi,
    eoiAtEnd: !!jpeg && eoi >= 0 && eoi === jpeg.length - 2,
    lastEoiOffsetFromEnd: jpeg && eoi >= 0 ? Math.min(4097, jpeg.length - eoi - 2) : null,
    sofFound: dimensions.width !== null,
    ...dimensions,
    otherKeyCount: Object.keys(reply).filter((key) => !(names as readonly string[]).includes(key)).length,
    keys: Object.fromEntries(names.map((key) => [key, Object.hasOwn(reply, key)])) as ContentDiagnostics["keys"],
  };
}

/** Accept bounded SOI/EOI images with relaxed base64 and at most 4096 trailing bytes. */
export function validateThumbnail(
  content: unknown,
): { jpeg: Buffer; width: number | null; height: number | null } | undefined {
  if (typeof content !== "string") return;
  const text = content
    .replace(/[\x09-\x0d ]/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!text.length || text.length > 4 * Math.ceil(THUMB_IMAGE_CAP / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return;
  const bare = text.replace(/=+$/, "");
  if (
    bare.length % 4 === 1 ||
    (text.includes("=") && (text.length % 4 !== 0 || text.length - bare.length !== (4 - (bare.length % 4)) % 4))
  )
    return;
  let jpeg = Buffer.from(text, "base64");
  if (jpeg.length > THUMB_IMAGE_CAP || jpeg.length < 4 || jpeg.readUInt16BE(0) !== 0xffd8) return;
  const eoi = jpeg.lastIndexOf(Buffer.from([0xff, 0xd9]));
  if (eoi < 2 || jpeg.length - eoi - 2 > 4096) return;
  jpeg = jpeg.subarray(0, eoi + 2);
  return { jpeg, ...geometry(jpeg) };
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
    let contentDiagnostics: ContentDiagnostics | undefined;
    let raw: Buffer | undefined;
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
        contentDiagnostics,
        ...(outcome === "invalid_reply" && raw ? { raw } : {}),
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
        const body = p.data as Record<string, unknown> | undefined;
        if (body && !Array.isArray(body) && body.file === file)
          contentDiagnostics = thumbnailContentDiagnostics(body, false);
        finish("receive_rejected");
        return;
      }
      const v = p.data as Record<string, unknown> | undefined;
      if (!v || typeof v !== "object" || Array.isArray(v) || v.file !== file) return;
      contentDiagnostics = thumbnailContentDiagnostics(v, false);
      seenBytes += bytes;
      if (seenBytes > THUMB_ENVELOPE_CAP) {
        finish("receive_rejected");
        return;
      }
      contentDiagnostics = thumbnailContentDiagnostics(v);
      if (
        contentDiagnostics.soi &&
        contentDiagnostics.decodedBytes! <= THUMB_IMAGE_CAP &&
        typeof v.content === "string"
      )
        raw = Buffer.from(v.content, "base64");
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
