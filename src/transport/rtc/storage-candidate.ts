import type { RtcSession } from "./session.js";
import { buildPortalPacket, parsePortalPacket, type PortalResponse } from "./portal-packet.js";

const HDD_FIELDS = [
  "disk_size_1024",
  "video_used",
  "system_size",
  "system_size_data",
  "disk_size",
  "parted_status",
  "disk_used",
  "data_used_percent",
  "health",
] as const;
const EMMC_FIELDS = ["disk_size", "data_used_percent", "video_used", "health"] as const;
type Raw = number | string | null;
export type RawStorageCandidate = Partial<Record<(typeof HDD_FIELDS)[number], Raw>>;
export interface StorageObservation {
  /** Local arrival of the first accepted medium notification, never ACK completion time. */
  receivedAtMs: number;
  correlation: "time-associated";
  exactlyCorrelated: false;
  units: "unqualified";
  hdd?: RawStorageCandidate;
  emmc?: Partial<Record<(typeof EMMC_FIELDS)[number], Raw>>;
}
export interface StorageCandidateEvidence {
  acknowledged: boolean;
  /** Local attempt evidence, including send refusal; does not prove wire delivery. */
  sent: boolean;
  sendAccepted?: boolean;
  observedCandidates: number;
  evicted: number;
  candidates: Array<{
    commandLink: boolean;
    notifyLink: boolean;
    response: boolean;
    channelMatch: boolean;
    segmentMatch: boolean;
    station: "match" | "mismatch" | "absent" | "invalid";
    layout: "direct" | "body" | "none" | "ambiguous";
    nestedCommandMatch: boolean;
    result: "zero" | "nonzero" | "absent" | "invalid";
    bodyObject: boolean;
    hddObject: boolean;
    emmcInfoType: string;
    removableInfoType: string;
    fieldTypes: Record<string, string>;
    emmcFieldTypes: Record<string, string>;
  }>;
}
export class StorageCandidateError extends Error {
  constructor(
    message: string,
    readonly evidence: StorageCandidateEvidence,
  ) {
    super(message);
  }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function scalar(value: unknown): value is Raw {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      value.length <= 64 &&
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
      Number.isFinite(Number(value)))
  );
}
function fieldType(value: unknown): string {
  return value === undefined ? "absent" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}
/** Legacy S1 dialect on an existing owner. Notifications remain temporal observations. */
export function collectStorageCandidate(
  session: RtcSession,
  accountId: string,
  segment: number,
  signal: AbortSignal,
  attempted: () => void,
  stationSn: string,
  ownerMatches: () => boolean,
): Promise<{ observation: StorageObservation; evidence: StorageCandidateEvidence }> {
  if (!accountId.trim() || Buffer.byteLength(accountId) > 128)
    return Promise.reject(new Error("Storage account unavailable"));
  if (!/^T9000[A-Za-z0-9]{1,32}$/.test(stationSn) || !Number.isInteger(segment) || segment < 1 || segment > 255)
    return Promise.reject(new Error("Storage station or segment unavailable"));
  const evidence: StorageCandidateEvidence = {
    acknowledged: false,
    sent: false,
    observedCandidates: 0,
    evicted: 0,
    candidates: [],
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let observation: StorageObservation | undefined;
    const finish = (failure?: string) => {
      if (settled) return;
      settled = true;
      session.off("commandData", onData);
      session.off("close", onClose);
      session.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(new StorageCandidateError(failure, evidence));
      else resolve({ observation: observation!, evidence });
    };
    const healthyOwner = () => {
      try {
        return session.isConnected && ownerMatches();
      } catch {
        return false;
      }
    };
    const maybeFinish = () => {
      if (evidence.sendAccepted && evidence.acknowledged && observation) {
        if (signal.aborted) finish("Storage candidate aborted or deadline expired");
        else if (!healthyOwner()) finish("Storage candidate session ownership changed");
        else finish();
      }
    };
    const onData = (bytes: Buffer, link: number) => {
      if (settled || !evidence.sent) return;
      const receivedAtMs = Date.now();
      if (signal.aborted) {
        finish("Storage candidate aborted or deadline expired");
        return;
      }
      if (!healthyOwner()) {
        finish("Storage candidate session ownership changed");
        return;
      }
      if (bytes.length > 65_536) {
        if (
          link === 3 &&
          bytes.length >= 16 &&
          bytes.subarray(0, 4).toString() === "XZYH" &&
          bytes.readUInt16LE(4) === 1351
        )
          finish("Storage candidate exceeds byte bound");
        return;
      }
      const frame: PortalResponse | undefined = parsePortalPacket(bytes, link);
      if (!frame) return;
      if (
        link === 1 &&
        frame.commandId === 1350 &&
        frame.isResponse === 1 &&
        frame.channel === 0 &&
        frame.segment === segment
      ) {
        if (frame.errCode !== 0) {
          finish("Storage request rejected");
          return;
        }
        evidence.acknowledged = true;
      } else if (frame.commandId === 1351 && frame.cmd === 1307) {
        const envelope = object(frame.data),
          payload = object(envelope?.payload);
        const direct = payload && (Object.hasOwn(payload, "hdd_info") || Object.hasOwn(payload, "emmc_info"));
        const ambiguousLayout = !!direct && Object.hasOwn(payload, "body");
        const body = direct ? payload : object(payload?.body),
          hdd = object(body?.hdd_info),
          emmc = object(body?.emmc_info);
        const result =
          payload?.mIntRet === undefined
            ? "absent"
            : typeof payload.mIntRet !== "number" || !Number.isSafeInteger(payload.mIntRet)
              ? "invalid"
              : payload.mIntRet === 0
                ? "zero"
                : "nonzero";
        const stations = [envelope, payload, body].flatMap((value) =>
          value ? ["station_sn", "stationSn"].flatMap((key) => (Object.hasOwn(value, key) ? [value[key]] : [])) : [],
        );
        const station = !stations.length
          ? "absent"
          : stations.some((value) => typeof value !== "string")
            ? "invalid"
            : stations.every((value) => value === stationSn)
              ? "match"
              : "mismatch";
        const types = Object.fromEntries(HDD_FIELDS.map((field) => [field, fieldType(hdd?.[field])]));
        const emmcTypes = Object.fromEntries(EMMC_FIELDS.map((field) => [field, fieldType(emmc?.[field])]));
        evidence.observedCandidates = Math.min(Number.MAX_SAFE_INTEGER, evidence.observedCandidates + 1);
        if (evidence.candidates.length === 32) {
          evidence.candidates.shift();
          evidence.evicted = Math.min(Number.MAX_SAFE_INTEGER, evidence.evicted + 1);
        }
        evidence.candidates.push({
          commandLink: link === 1,
          notifyLink: link === 3,
          response: frame.isResponse !== 0,
          channelMatch: frame.channel === 0,
          segmentMatch: frame.segment === segment,
          station,
          layout: ambiguousLayout ? "ambiguous" : direct ? "direct" : body ? "body" : "none",
          nestedCommandMatch: payload?.cmd === 11001,
          result,
          bodyObject: !!body,
          hddObject: !!hdd,
          emmcInfoType: fieldType(body?.emmc_info),
          removableInfoType: fieldType(body?.move_disk_info),
          fieldTypes: types,
          emmcFieldTypes: emmcTypes,
        });
        if (
          link !== 3 ||
          (frame.isResponse !== 0 && frame.isResponse !== 1) ||
          station === "mismatch" ||
          station === "invalid" ||
          !body
        )
          return;
        if (ambiguousLayout) {
          finish("Storage candidate has ambiguous payload layout");
          return;
        }
        if (payload?.cmd !== undefined && payload.cmd !== 11001) return;
        if (result === "nonzero") {
          finish("Storage data result rejected");
          return;
        }
        if (result === "invalid") {
          finish("Storage data result invalid");
          return;
        }
        if ((body.hdd_info !== undefined && !hdd) || (body.emmc_info !== undefined && !emmc)) {
          finish("Storage candidate has invalid medium object");
          return;
        }
        const value: StorageObservation = {
          receivedAtMs,
          correlation: "time-associated",
          exactlyCorrelated: false,
          units: "unqualified",
        };
        for (const [name, source, fields] of [
          ["hdd", hdd, HDD_FIELDS],
          ["emmc", emmc, EMMC_FIELDS],
        ] as const) {
          if (!source) continue;
          const selected: Record<string, Raw> = {};
          for (const field of fields) {
            const item = source[field];
            if (item === undefined) continue;
            if (!scalar(item)) {
              finish("Storage candidate has invalid allowlisted field");
              return;
            }
            selected[field] = item;
          }
          if (Object.keys(selected).length) value[name] = selected;
        }
        if (!value.hdd && !value.emmc) return;
        if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs <= 0) {
          finish("Storage notification arrival time invalid");
          return;
        }
        observation ??= value;
      }
      maybeFinish();
    };
    const onClose = () => finish("Storage session closed");
    const onError = () => finish("Storage session error");
    const onAbort = () => finish("Storage candidate aborted or deadline expired");
    session.on("commandData", onData);
    session.on("close", onClose);
    session.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    if (!healthyOwner()) {
      finish("Storage candidate session ownership changed");
      return;
    }
    try {
      const packet = buildPortalPacket({
        commandId: 1350,
        channel: 0,
        segment,
        payload: { account_id: accountId, cmd: 1307, mChannel: 0, mValue3: 0, payload: { version: 0, cmd: 11001 } },
      });
      evidence.sent = true;
      attempted();
      evidence.sendAccepted = session.sendCommand(packet);
      if (!evidence.sendAccepted) finish("Storage send refused");
      else maybeFinish();
    } catch {
      finish("Storage send failed");
    }
  });
}
