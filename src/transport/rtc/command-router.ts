/** Modified for genomez S1 experimental source preview, 2026-10-14. */
/**
 * RTC command router — drives a **HomeBase Professional S1 (T9000)** over the portal's WebRTC data
 * channel instead of P2P.
 *
 * The T9000 has no reachable P2P endpoint (every `device.set` over P2P times out), but it accepts the
 * app/portal's control channel: sign → WS join → scall → SDP answer → ICE → DTLS → SCTP data channels,
 * with commands riding `WebrtcDataChannel` as portal packets (see `portal-packet.ts`).
 *
 * ⚠️ ICE policy MUST be `relay` (or `all` with the relay reachable): the hub completes DTLS **only
 * through TURN**. On a host-only pair ICE connects and the DTLS handshake times out, every time
 * (measured on firmware 4.4.0.4, 2026-09-25 — a full night of negatives that all traced back to a
 * host-only default). The relay is granted by the hub itself in the scall `status:100` reply.
 *
 * `set-payload` intents use the `1350` envelope with `{account_id, cmd, mValue3, payload}`.
 * `set-json` intents use the `1700` envelope with `{account_id, cmd, commandType, data}`.
 * Station commands use channel `255`; attached-device commands preserve their device channel while
 * sharing the parent station's connection and member identity. Other command kinds are refused.
 *
 * One session per station, reused across commands and closed after {@link RtcCommandRouterDeps.idleCloseMs}
 * of inactivity. Sends on a session are serialised. An ACK must arrive on the command link with the
 * response flag, expected outer command, channel and matching request segment. A control-payload
 * request may instead complete on its correlated JSON result: notify link, notify envelope, inner
 * command, channel and segment must all match. Receipt does not establish physical movement.
 */
import {
  CommandEvidenceRecorder,
  commandHeaderSample,
  commandOutcome,
  type CommandEvidence,
  type CommandTargetContext,
  type PostTimeoutStatus,
} from "./command-diagnostics.js";
import { observeTimedOutCommand, selectedTransportSnapshot } from "./command-transport-evidence.js";
import type { Command } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import type { Logger } from "../../core/logger.js";
import { RtcSession, type RtcSessionOptions } from "./session.js";
import { buildPortalPacket, parsePortalPacket, SegmentCounter, type PortalResponse } from "./portal-packet.js";
import {
  renewalFailure,
  retainedRenewalFailure,
  type RenewalEvidence,
  type RenewalPhase,
  type RenewalFailure,
  type RenewalFailureRetention,
} from "./renewal-diagnostics.js";
import { markRetiredInformationRead } from "./retired-information-read.js";
import { connectionDeadline } from "./connection-deadline.js";
import { informationPayload } from "./camera-info.js";
import { RtcLive, type RtcLiveConsumer } from "./live.js";
import { openReadableFromConsumer } from "../p2p/readable-egress.js";
import type { Consumer } from "../p2p/shared-live-source.js";
import { rtcSnapshot } from "./snapshot.js";
import type { FfmpegLevel } from "../ffmpeg.js";
import type { MediaProvider, LiveStreamConsumer } from "../../core/contracts.js";

import { PORTAL_CMD_SET_PAYLOAD, PORTAL_STATION_CHANNEL } from "./commands.js";
import { collectStorageCandidate } from "./storage-candidate.js";
import {
  InformationReadEvidence,
  informationReadFailure,
  type InformationOperationEvidence,
  type InformationExchangeOutcome,
  type RtcReadDiagnostics,
} from "./read-diagnostics.js";

/** The control envelope carrying an opaque commandType and data object. */
const PORTAL_CMD_CONTROL_PAYLOAD = 1700;

/** The envelope carrying a control command's correlated JSON result. */
const PORTAL_CMD_NOTIFY_PAYLOAD = 1351;

export interface RtcIdentity {
  authToken: string;
  userId: string;
  /** The cloud `user_id` the gtoken derives from (falls back to `userId`). */
  accountUserId?: string;
  /** The `gtoken` header value, when the caller already derives it (same as its HTTP calls). */
  gtoken?: string;
}

export interface RtcCommandRouterDeps {
  /** The logged-in session's credentials; `undefined` while logged out. */
  identity: () => RtcIdentity | undefined;
  /** The mega shard the account signs on (`"ie-pr"`, `"eu-pr"`, `"us-pr"`) — picks the smart host. */
  shard: () => string;
  /** ISO country sent on the sign request (default `US`). */
  country?: string;
  /** The acting account name commands attribute themselves to (`user_name`). */
  accountName: () => string;
  /** Resolve a device record by serial (model, adminUserId, stationSn). */
  findDevice: (sn: string) => EufyDevice | undefined;
  logger?: Logger;
  /** `relay` (default) or `all`. Never `host-only` — see the module doc. */
  icePolicy?: "relay" | "all";
  /** How long a sent command waits for its ACK and any required information response (default 8 s). */
  ackTimeoutMs?: number;
  /** Whole command deadline, including session acquisition, queueing and ACK (default 20 s; maximum 60 s). */
  commandTimeoutMs?: number;
  /**
   * How long to wait for the session to come up (default 12 s). A healthy hub answers in ~2 s; the
   * default sits under the ~15 s timeout a typical host applies to a service call, so a hub outage
   * surfaces as this router's own error rather than the caller's timeout.
   */
  connectTimeoutMs?: number;
  /** Maximum call retries during session setup (the session default is preserved when omitted). */
  maxCallRetries?: number;
  /** Close an idle station session after this long (default 60 s). */
  idleCloseMs?: number;
  /** Optional proactive replacement age; permits one health-gated retry. Zero disables replacement (default). */
  sessionRefreshMs?: number;
  onError?: (e: Error) => void;
  /** Validated inbound frames from the current station session. */
  onFrame?: (stationSn: string, frame: PortalResponse) => void;
  /** ffmpeg for the live still (default `ffmpeg` on PATH). */
  ffmpegPath?: string;
  ffmpegLogLevel?: FfmpegLevel;
  /** Session factory (tests inject a fake). */
  createSession?: (opts: RtcSessionOptions) => RtcSession;
}

interface StationSession {
  storageCandidateOwner: { identity: RtcIdentity; accountId: string; model: string | undefined };
  session: RtcSession;
  generation: number;
  lastInformationReceivedAtMs?: number;
  seg: SegmentCounter;
  ready: Promise<void>;
  /** Serialises command and information exchanges on the shared station session. */
  queue: Promise<unknown>;
  idle?: ReturnType<typeof setTimeout>;
  /** Holders (a live view) that keep the session from idle-closing. */
  leases: number;
  /** A failed information exchange prevents another temporal-only read on this generation. */
  informationTainted?: boolean;
  connectedAtMs?: number;
  /** Finite event category; the original Error is never retained. */
  lastSessionError?: RenewalFailure;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshPending?: boolean;
  refreshAttempts?: number;
  /** Earliest second attempt after a connection-stage failure. */
  refreshRetryAtMs?: number;
  /** Successful complete read on this generation; ACK alone is insufficient. */
  lastInformationRead?: { startedAtMs: number; finishedAtMs: number };
  replacement?: { controller: AbortController; candidate?: StationSession };
  idleWaiters: Set<() => void>;
  diagnosticRetirement: Set<(reason: PostTimeoutStatus) => void>;
  detach: () => void;
}

/** Finite observations of proactive station-session replacements. */
export interface RtcSessionRefreshDiagnostics {
  attempts: number;
  successes: number;
  failures: number;
  deferred: number;
  lastStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
  lastSessionAgeMs: number | null;
  lastOutcome: "success" | "failed" | "cancelled" | null;
  lastAttempt: RenewalEvidence | null;
  lastFailure: RenewalEvidence | null;
  /** Completed attempts in chronological order, retaining at most 32 detached rows. */
  recent: RenewalEvidence[];
  evicted: number;
  /** Versioned failure-only evidence; absent when ownership counters are unavailable. */
  failureRetention?: RenewalFailureRetention;
}

interface LiveSlot {
  sn: string;
  ready: Promise<RtcLive>;
  controller: AbortController;
  pending: number;
  attached: boolean;
  release?: () => void;
  live?: RtcLive;
}

/** Bounds the complete information read, including connection and queue waiting. */
export interface InformationRefreshOptions {
  signal?: AbortSignal;
  /** Positive integer milliseconds, at most 60 seconds; defaults to 15 seconds. */
  timeoutMs?: number;
}

/** An accepted request followed or preceded by a notification in the same read window. */
export interface InformationRefreshResult {
  frame: PortalResponse;
  notificationCorrelation: "temporal-only";
}

/** Await work without retaining an abort listener after either side settles. */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new Error("RTC operation aborted"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}

/** Anonymous process-local ordinal; never derived from connection or account data. */
let nextRefreshOwnerIncarnation = 0;

export class RtcCommandRouter {
  private readonly storageCandidateSessions = new WeakSet<StationSession>();
  private commandEvidence = new CommandEvidenceRecorder();
  private readonly readEvidence = new InformationReadEvidence();
  private readonly sessions = new Map<string, StationSession>();
  private readonly lives = new Map<string, LiveSlot>();

  private readonly refreshOwnerIncarnation = ++nextRefreshOwnerIncarnation;
  private epoch = 0;
  private nextSessionGeneration = 0;
  private refreshStats: RtcSessionRefreshDiagnostics = this.emptyRefreshStats();

  constructor(private readonly deps: RtcCommandRouterDeps) {
    const interval = deps.sessionRefreshMs ?? 0;
    if (!Number.isSafeInteger(interval) || (interval !== 0 && (interval < 30_000 || interval > 600_000)))
      throw new RangeError("RTC session refresh must be zero or between 30000 and 600000 milliseconds");
  }

  /** Detached counters for bounded session replacement attempts. */
  getSessionRefreshDiagnostics(): RtcSessionRefreshDiagnostics {
    const retention = this.refreshStats.failureRetention;
    const safeRetention =
      retention &&
      Number.isSafeInteger(retention.ownerIncarnation) &&
      retention.ownerIncarnation > 0 &&
      [
        retention.ownerEpoch,
        retention.failedCompletions,
        retention.cancelledCompletions,
        retention.evictedFailures,
      ].every((value) => Number.isSafeInteger(value) && value >= 0);
    return {
      ...this.refreshStats,
      failureRetention: safeRetention
        ? { ...retention, recentFailures: retention.recentFailures.map((entry) => ({ ...entry })) }
        : undefined,
      lastAttempt: this.refreshStats.lastAttempt ? { ...this.refreshStats.lastAttempt } : null,
      lastFailure: this.refreshStats.lastFailure ? { ...this.refreshStats.lastFailure } : null,
      recent: this.refreshStats.recent.map((entry) => ({ ...entry })),
    };
  }

  private emptyRefreshStats(): RtcSessionRefreshDiagnostics {
    return {
      attempts: 0,
      successes: 0,
      failures: 0,
      deferred: 0,
      lastStartedAtMs: null,
      lastFinishedAtMs: null,
      lastSessionAgeMs: null,
      lastOutcome: null,
      lastAttempt: null,
      lastFailure: null,
      recent: [],
      evicted: 0,
      failureRetention: {
        version: 1,
        ownerIncarnation: this.refreshOwnerIncarnation,
        ownerEpoch: this.epoch,
        failedCompletions: 0,
        cancelledCompletions: 0,
        evictedFailures: 0,
        recentFailures: [],
      },
    };
  }

  /** Passive, bounded information-exchange observations without connection identifiers. */
  getReadDiagnostics(): RtcReadDiagnostics {
    return this.readEvidence.snapshot();
  }

  /** Detached control-operation evidence; reading it starts no operation. */
  getCommandDiagnostics() {
    return this.commandEvidence.snapshot();
  }

  /** Existing anonymous command context; lookup does not create or retain an untouched target. */
  getCommandTarget(sn: string): CommandTargetContext | undefined {
    return this.commandEvidence.lookupTarget(sn);
  }

  /** A T9000 station itself. */
  static claimsDevice(dev: EufyDevice): boolean {
    return /^T9000/i.test(dev.model ?? "") && (!dev.stationSn || dev.stationSn === dev.sn);
  }

  /** A device attached to a T9000 station and sharing its control channel. */
  static claimsMedia(dev: EufyDevice, stationOf: (sn: string) => EufyDevice | undefined): boolean {
    if (!dev.stationSn || dev.stationSn === dev.sn) return false;
    const station = stationOf(dev.stationSn);
    return !!station && RtcCommandRouter.claimsDevice(station);
  }

  /** Validated command budget shared by facade queueing and the transport exchange. */
  get commandTimeoutMs(): number {
    const timeoutMs = this.deps.commandTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new RangeError("RTC command timeout must be an integer between 1 and 60000 milliseconds");
    return timeoutMs;
  }

  /** Dispatch within the configured budget and any earlier absolute deadline. */
  async dispatchCommand(sn: string, cmd: Command, options: { deadlineAtMs?: number } = {}): Promise<void> {
    const budget = this.commandTimeoutMs;
    const deadlineAtMs = options.deadlineAtMs ?? Date.now() + budget;
    if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 0)
      throw new RangeError("RTC command deadline must be a non-negative integer timestamp");
    const timeoutMs = Math.min(budget, deadlineAtMs - Date.now());
    if (timeoutMs <= 0) throw new Error("RTC command timed out before send");
    if (cmd.kind !== "set-payload" && cmd.kind !== "set-json") {
      throw new Error(
        `rtc: ${cmd.kind} is not routable over the T9000 control channel yet (only set-payload or set-json)`,
      );
    }
    const dev = this.deps.findDevice(sn);
    const stationSn = dev?.stationSn || sn;
    const station = this.deps.findDevice(stationSn);
    if (!dev || !station || !RtcCommandRouter.claimsDevice(station))
      throw new Error("RTC command requires a known T9000 station or attached device");
    const channel = stationSn === sn ? PORTAL_STATION_CHANNEL : cmd.channel;
    if (
      !Number.isInteger(channel) ||
      channel < 0 ||
      channel > PORTAL_STATION_CHANNEL ||
      (stationSn !== sn && channel === PORTAL_STATION_CHANNEL)
    )
      throw new RangeError("RTC command requires a valid device channel");
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot drive ${sn}`);
    const member = ((station.raw ?? {}) as { member?: { admin_user_id?: unknown } }).member;
    const adminUserId = (typeof member?.admin_user_id === "string" && member.admin_user_id) || identity.userId;
    const evidenceEpoch = this.epoch;
    const outerCmd = cmd.kind === "set-json" ? PORTAL_CMD_CONTROL_PAYLOAD : PORTAL_CMD_SET_PAYLOAD;
    const innerCmd = cmd.kind === "set-json" ? cmd.param : cmd.cmd;
    const evidence = this.commandEvidence.begin(sn, stationSn === sn ? "station" : "attached", innerCmd, outerCmd);
    evidence.expectedChannel = channel;
    let outcome: ReturnType<typeof commandOutcome> = "success";
    const deadline = new AbortController();
    let sent = false;
    const timerArmedAtMs = Date.now();
    const diagnosticDeadlineAtMs = Math.min(deadlineAtMs, timerArmedAtMs + timeoutMs);
    const timer = setTimeout(
      () =>
        deadline.abort(
          new Error(sent ? "RTC command timed out after send; outcome unknown" : "RTC command timed out before send"),
        ),
      timeoutMs,
    );
    let st: StationSession | undefined;
    try {
      st = await this.stationSession(stationSn, adminUserId, identity, deadline.signal);
      this.commandEvidence.markTiming(evidence, "acquiredAtMicros");
      deadline.signal.throwIfAborted();
      evidence.sessionGeneration = st.generation;
      evidence.phase = "queue";
      evidence.sessionAgeMs = Math.max(0, Date.now() - (st.connectedAtMs ?? Date.now()));
      const payload =
        cmd.kind === "set-json"
          ? { account_id: adminUserId, cmd: cmd.param, commandType: cmd.param, data: cmd.data }
          : { account_id: adminUserId, cmd: cmd.cmd, mValue3: cmd.mValue3 ?? 0, payload: cmd.payload };
      const segment = st.seg.next();
      evidence.expectedSegment = segment;
      const packet = buildPortalPacket({
        commandId: outerCmd,
        channel,
        segment,
        payload,
      });
      const current = st;
      this.commandEvidence.markTiming(evidence, "queuedAtMicros");
      const run = st.queue.then(() => {
        deadline.signal.throwIfAborted();
        if (Date.now() >= deadlineAtMs) throw new Error("RTC command timed out before send");
        return this.sendAwaitAck(
          stationSn,
          current,
          packet,
          outerCmd,
          innerCmd,
          channel,
          segment,
          deadline.signal,
          evidence,
          timerArmedAtMs,
          diagnosticDeadlineAtMs,
          () => {
            sent = true;
          },
        );
      });
      st.queue = run.catch(() => undefined);
      await untilAborted(run, deadline.signal);
    } catch (error) {
      outcome = commandOutcome(error);
      throw error;
    } finally {
      if (evidenceEpoch === this.epoch) this.commandEvidence.finish(evidence, outcome);
      clearTimeout(timer);
      if (st) this.release(stationSn, st);
    }
  }

  /** One investigative storage read on an existing idle session, with no acquisition or retry. */
  async readStorageCandidate(
    stationSn: string,
    opts: InformationRefreshOptions & { ownerMatches?: () => boolean } = {},
  ) {
    const timeoutMs = opts.timeoutMs ?? 8_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000)
      throw new RangeError("Storage candidate timeout must be between 1 and 15000 milliseconds");
    opts.signal?.throwIfAborted();
    const device = this.deps.findDevice(stationSn);
    if (!device || !RtcCommandRouter.claimsDevice(device))
      throw new Error("Storage candidate requires a T9000 station");
    const st = this.sessions.get(stationSn);
    if (!st || !st.session.isConnected || st.informationTainted)
      throw new Error("Storage candidate requires an existing healthy session");
    if (st.leases !== 0 || st.replacement) throw new Error("Storage candidate session busy");
    if (this.storageCandidateSessions.has(st)) throw new Error("Storage candidate already attempted on this session");
    const identity = this.deps.identity();
    if (!identity) throw new Error("Storage candidate requires existing login");
    const member = ((device.raw ?? {}) as { member?: { admin_user_id?: unknown } }).member;
    const accountId = (typeof member?.admin_user_id === "string" && member.admin_user_id) || identity.userId;
    if (!this.storageCandidateOwnerMatches(stationSn, st))
      throw new Error("Storage candidate session ownership changed");
    if (opts.ownerMatches && !opts.ownerMatches()) throw new Error("Storage telemetry ownership changed");
    const deadline = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(new Error("Storage candidate deadline expired")), timeoutMs);
    st.leases++;
    if (st.idle) clearTimeout(st.idle);
    let exchangeStarted = false;
    let run: Promise<Awaited<ReturnType<typeof collectStorageCandidate>>> | undefined;
    try {
      run = st.queue.then(() => {
        signal.throwIfAborted();
        if (this.sessions.get(stationSn) !== st || !st.session.isConnected)
          throw new Error("Storage candidate session retired");
        if (!this.storageCandidateOwnerMatches(stationSn, st))
          throw new Error("Storage candidate session ownership changed");
        if (opts.ownerMatches && !opts.ownerMatches()) throw new Error("Storage telemetry ownership changed");
        exchangeStarted = true;
        return collectStorageCandidate(
          st.session,
          accountId,
          st.seg.next(),
          signal,
          () => this.storageCandidateSessions.add(st),
          stationSn,
          () =>
            this.sessions.get(stationSn) === st &&
            this.storageCandidateOwnerMatches(stationSn, st) &&
            (!opts.ownerMatches || opts.ownerMatches()),
        );
      });
      st.queue = run.catch(() => undefined);
      return await untilAborted(run, signal);
    } catch (error) {
      if (exchangeStarted && run) return await run;
      throw error;
    } finally {
      clearTimeout(timer);
      this.release(stationSn, st);
    }
  }

  private storageCandidateOwnerMatches(sn: string, st: StationSession): boolean {
    const device = this.deps.findDevice(sn);
    const identity = this.deps.identity();
    if (
      !device ||
      !identity ||
      device.sn !== sn ||
      !RtcCommandRouter.claimsDevice(device) ||
      device.model !== st.storageCandidateOwner.model
    )
      return false;
    const owner = st.storageCandidateOwner.identity;
    if (
      identity.authToken !== owner.authToken ||
      identity.userId !== owner.userId ||
      identity.accountUserId !== owner.accountUserId ||
      identity.gtoken !== owner.gtoken
    )
      return false;
    const member = ((device.raw ?? {}) as { member?: { admin_user_id?: unknown } }).member;
    const account = (typeof member?.admin_user_id === "string" && member.admin_user_id) || identity.userId;
    return account === st.storageCandidateOwner.accountId;
  }

  /** Refresh information on a station, preserving the notification's temporal-only correlation. */
  async refreshInformation(stationSn: string, opts: InformationRefreshOptions = {}): Promise<InformationRefreshResult> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new RangeError("RTC information timeout must be an integer between 1 and 60000 milliseconds");
    opts.signal?.throwIfAborted();
    const device = this.deps.findDevice(stationSn);
    if (!device || !RtcCommandRouter.claimsDevice(device))
      throw new Error("RTC information requires a supported station");
    const deadline = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(new Error("RTC information read timed out")), timeoutMs);
    const epoch = this.epoch;
    const startedAtMs = Date.now();
    let phase: InformationOperationEvidence["phase"] = "acquisition";
    let failure: InformationOperationEvidence["failure"] = null;
    let completed = false;
    const transmission = { attempted: false };
    let observedSession: StationSession | undefined;
    let operationError: unknown;
    let lease: Awaited<ReturnType<RtcCommandRouter["sessionFor"]>> | undefined;
    try {
      const acquiring = this.sessionFor(stationSn, { signal });
      observedSession = this.sessions.get(stationSn);
      lease = await acquiring;
      phase = "queue";
      signal.throwIfAborted();
      const st = this.sessions.get(stationSn);
      if (!st || st.session !== lease.session) throw new Error("RTC information session closed");
      const current = lease;
      const run = st.queue.then(async () => {
        signal.throwIfAborted();
        if (this.sessions.get(stationSn) !== st || !st.session.isConnected)
          throw new Error("RTC information session closed");
        if (st.informationTainted) throw new Error("RTC information read unavailable until the session retires");
        phase = "exchange";
        return this.readInformation(st, current.accountId, current.seg.next(), signal, "current", transmission);
      });
      st.queue = run.catch(() => undefined);
      const result = await untilAborted(run, signal);
      completed = true;
      return result;
    } catch (error) {
      failure = informationReadFailure(error);
      operationError = error;
      throw error;
    } finally {
      if (epoch === this.epoch) {
        const finishedAtMs = Date.now();
        this.readEvidence.recordOperation({
          startedAtMs,
          finishedAtMs,
          elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
          phase,
          outcome: completed ? "success" : "failed",
          attempted: transmission.attempted,
          failure,
          sessionError: observedSession?.lastSessionError ?? null,
          closeOriginAtFinish: observedSession?.session.closeOrigin ?? null,
        });
      }
      clearTimeout(timer);
      lease?.release();
      if (
        operationError instanceof Error &&
        failure === "information_response_timeout" &&
        transmission.attempted &&
        !signal.aborted &&
        epoch === this.epoch &&
        observedSession?.informationTainted &&
        observedSession.leases === 0 &&
        !observedSession.session.isConnected &&
        this.sessions.get(stationSn) !== observedSession
      )
        markRetiredInformationRead(operationError);
    }
  }

  /** Wait for both the request's ACK and a qualified information notification on the current session. */
  private readInformation(
    st: StationSession,
    accountId: string,
    segment: number,
    signal: AbortSignal,
    purpose: "current" | "replacement" = "current",
    transmission?: { attempted: boolean },
  ): Promise<InformationRefreshResult> {
    if (!accountId.trim() || Buffer.byteLength(accountId) > 128)
      return Promise.reject(new Error("RTC information account unavailable"));
    return new Promise((resolve, reject) => {
      let acknowledged = false;
      let information: PortalResponse | undefined;
      let settled = false;
      let attempted = false;
      const startedAtMs = Date.now();
      const sessionAgeMs = Math.max(0, startedAtMs - (st.connectedAtMs ?? startedAtMs));
      const otherLeases = Math.max(0, st.leases - 1);
      let receivedFrames = 0;
      let invalidPortalFrames = 0;
      let otherCommandFrames = 0;
      let matchedAcknowledgments = 0;
      let informationFrames = 0;
      let otherInformationFrames = 0;
      let unmatchedAcknowledgments = 0;
      let invalidInformation = 0;
      let ackElapsedMs: number | null = null;
      let informationElapsedMs: number | null = null;
      let informationReceivedAtMs: number | null = null;
      let currentAtArrival: boolean | null = null;
      const finish = (
        error?: unknown,
        outcome: InformationExchangeOutcome = error === undefined ? "success" : "error",
      ) => {
        if (settled) return;
        settled = true;
        const finishedAtMs = Date.now();
        this.readEvidence.record({
          purpose,
          startedAtMs,
          finishedAtMs,
          elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
          sessionAgeMs,
          sessionGeneration: st.generation,
          informationReceivedAtMs,
          currentAtArrival,
          otherLeases,
          outcome,
          attempted,
          acknowledged,
          informationReceived: information !== undefined,
          ackElapsedMs,
          informationElapsedMs,
          receivedFrames,
          invalidPortalFrames,
          otherCommandFrames,
          matchedAcknowledgments,
          informationFrames,
          otherInformationFrames,
          unmatchedAcknowledgments,
          invalidInformation,
        });
        if (error !== undefined && attempted) st.informationTainted = true;
        if (error === undefined && purpose === "current") st.lastInformationRead = { startedAtMs, finishedAtMs };
        clearTimeout(timer);
        st.session.off("commandData", onData);
        st.session.off("close", onClose);
        st.session.off("error", onError);
        signal.removeEventListener("abort", onAbort);
        if (error !== undefined) reject(error);
        else resolve({ frame: information!, notificationCorrelation: "temporal-only" });
      };
      const onData = (bytes: Buffer, linkType: number) => {
        if (signal.aborted || !st.session.isConnected) return;
        receivedFrames++;
        const frame = parsePortalPacket(bytes, linkType);
        if (!frame) {
          invalidPortalFrames++;
          return;
        }
        if (frame.commandId !== 1103) {
          otherCommandFrames++;
          return;
        }
        if (linkType === 1 && frame.isResponse === 1 && frame.channel === 255 && frame.segment === segment) {
          matchedAcknowledgments++;
          if (frame.errCode !== 0) {
            finish(new Error("RTC information request rejected"), "rejected");
            return;
          }
          acknowledged = true;
          ackElapsedMs ??= Math.max(0, Date.now() - startedAtMs);
        } else if ((linkType === 1 || linkType === 3) && frame.isResponse === 0 && informationPayload(frame.data)) {
          informationFrames++;
          information = frame;
          informationReceivedAtMs ??= Date.now();
          currentAtArrival ??= [...this.sessions.values()].includes(st);
          st.lastInformationReceivedAtMs = informationReceivedAtMs;
          informationElapsedMs ??= Math.max(0, Date.now() - startedAtMs);
        } else if (frame.isResponse === 1) {
          unmatchedAcknowledgments++;
        } else if (frame.isResponse === 0) {
          invalidInformation++;
        } else {
          otherInformationFrames++;
        }
        if (acknowledged && information) finish();
      };
      const onClose = () => finish(new Error("RTC information session closed"), "closed");
      const onError = (error: Error) => finish(error);
      const onAbort = () => finish(signal.reason ?? new Error("RTC information read aborted"), "aborted");
      const timer = setTimeout(
        () => finish(new Error("RTC information response timed out"), "timeout"),
        this.deps.ackTimeoutMs ?? 8_000,
      );
      st.session.on("commandData", onData);
      st.session.on("close", onClose);
      st.session.on("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        const packet = buildPortalPacket({
          commandId: 1103,
          channel: 255,
          segment,
          payload: { value: 255, value1: 0, account_id: accountId },
        });
        attempted = true;
        if (transmission) transmission.attempted = true;
        if (!st.session.sendCommand(packet)) finish(new Error("RTC information send failed"), "send_failed");
      } catch (error) {
        finish(error ?? new Error("RTC information send failed"));
      }
    });
  }

  /** Tear down every station session (logout / shutdown). */
  close(): void {
    this.epoch++;
    const slots = [...this.lives.values()];
    this.lives.clear();
    let failure: unknown;
    for (const slot of slots) {
      slot.controller.abort(new Error("RTC router closed"));
      try {
        slot.live?.close(new Error("RTC router closed"));
      } catch (error) {
        failure ??= error;
      }
    }
    this.commandEvidence.close();
    for (const [sn, st] of this.sessions) this.drop(sn, st);
    this.readEvidence.clear();
    this.commandEvidence = new CommandEvidenceRecorder();
    this.nextSessionGeneration = 0;
    this.refreshStats = this.emptyRefreshStats();
    if (failure !== undefined) throw failure;
  }

  private sendAwaitAck(
    sn: string,
    st: StationSession,
    packet: Buffer,
    outerCmd: number,
    innerCmd: number,
    channel: number,
    segment: number,
    signal: AbortSignal,
    evidence: CommandEvidence,
    timerArmedAtMs: number,
    diagnosticDeadlineAtMs: number,
    onSend: () => void,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.sessions.get(sn) !== st || !st.session.isConnected)
      return Promise.reject(new Error(`rtc: ${sn} session closed before command send`));
    evidence.phase = "exchange";
    this.commandEvidence.markTiming(evidence, "exchangeStartedAtMicros");
    const timeoutMs = this.deps.ackTimeoutMs ?? 8_000;
    return new Promise<void>((resolve, reject) => {
      const onData = (frame: Buffer, linkType: number) => {
        evidence.receivedFrames++;
        const p = parsePortalPacket(frame, linkType);
        if (!p) {
          evidence.invalidFrames++;
          return;
        }
        this.commandEvidence.recordHeader(
          evidence,
          commandHeaderSample(p, linkType, outerCmd, innerCmd, channel, segment),
        );
        if (p.segment !== segment) {
          evidence.otherSegments++;
          return;
        }
        if (p.channel !== channel) {
          evidence.otherChannels++;
          return;
        }
        if (linkType !== 1 && linkType !== 3) {
          evidence.otherLinks++;
          return;
        }
        const acknowledgement = linkType === 1 && p.commandId === outerCmd && p.isResponse === 1;
        const notification =
          outerCmd === PORTAL_CMD_CONTROL_PAYLOAD &&
          linkType === 3 &&
          p.commandId === PORTAL_CMD_NOTIFY_PAYLOAD &&
          p.isResponse === 0 &&
          p.cmd === innerCmd &&
          typeof p.data === "object" &&
          p.data !== null &&
          !Array.isArray(p.data) &&
          "payload" in p.data &&
          typeof p.data.payload === "object" &&
          p.data.payload !== null &&
          !Array.isArray(p.data.payload);
        if (!acknowledgement && !notification) {
          if (
            (linkType === 1 && p.commandId !== outerCmd) ||
            (linkType === 3 && (outerCmd !== PORTAL_CMD_CONTROL_PAYLOAD || p.commandId !== PORTAL_CMD_NOTIFY_PAYLOAD))
          )
            evidence.otherEnvelopes++;
          else if ((linkType === 1 && p.isResponse !== 1) || (linkType === 3 && p.isResponse !== 0))
            evidence.otherResponseFlags++;
          else if (p.cmd !== innerCmd) evidence.otherParameters++;
          else evidence.invalidResultPayloads++;
          return;
        }
        if (acknowledgement) evidence.matchedAcks++;
        else evidence.matchedResults++;
        cleanup();
        if (p.errCode && p.errCode !== 0) {
          evidence.rejectionCode = p.errCode;
          reject(new Error(`rtc: ${sn} rejected cmd ${innerCmd} (err ${p.errCode})`));
        } else {
          this.deps.logger?.debug?.(`[rtc] ${sn} cmd ${innerCmd} acked`);
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`rtc: ${sn} session closed while waiting for cmd ${innerCmd} ACK`));
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason ?? new Error("RTC command aborted"));
      };
      const timer = setTimeout(() => {
        cleanup();
        observeTimedOutCommand(
          st.session,
          evidence,
          this.commandEvidence,
          st.diagnosticRetirement,
          outerCmd,
          innerCmd,
          channel,
          segment,
        );
        reject(new Error("RTC command ACK timed out; outcome unknown"));
      }, timeoutMs);
      const cleanup = () => {
        evidence.transportAtFinish = selectedTransportSnapshot(st.session);
        clearTimeout(timer);
        st.session.off("commandData", onData);
        st.session.off("close", onClose);
        signal.removeEventListener("abort", onAbort);
        this.touch(sn, st);
      };
      st.session.on("commandData", onData);
      st.session.on("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        signal.throwIfAborted();
        evidence.transportBeforeSend = selectedTransportSnapshot(st.session);
        evidence.sendAttemptedAtMs = Date.now();
        this.commandEvidence.markTiming(evidence, "sendAttemptedAtMicros");
        const remaining = diagnosticDeadlineAtMs - evidence.sendAttemptedAtMs;
        evidence.remainingBudgetAtSendMs =
          evidence.sendAttemptedAtMs >= timerArmedAtMs && Number.isSafeInteger(remaining)
            ? Math.max(0, remaining)
            : null;
        onSend();
        if (!st.session.sendCommand(packet)) {
          cleanup();
          reject(new Error(`rtc: ${sn} command channel not open, cmd ${innerCmd} not sent`));
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private async stationSession(
    sn: string,
    adminUserId: string,
    identity: RtcIdentity,
    signal?: AbortSignal,
  ): Promise<StationSession> {
    signal?.throwIfAborted();
    let st = this.sessions.get(sn);
    if (!st) {
      st = this.createStationSession(sn, adminUserId, identity);
      this.sessions.set(sn, st);
    }
    st.leases++;
    if (st.idle) clearTimeout(st.idle);
    try {
      await untilAborted(st.ready, signal);
      st.connectedAtMs ??= Date.now();
      this.armRefresh(sn, st);
      signal?.throwIfAborted();
      if (this.sessions.get(sn) !== st || !st.session.isConnected) throw new Error("RTC session closed while opening");
    } catch (e) {
      this.release(sn, st);
      if (st.leases === 0) this.drop(sn, st);
      throw e;
    }
    return st;
  }

  /** Create one session without making it the current command owner. */
  private createStationSession(
    sn: string,
    adminUserId: string,
    identity: RtcIdentity,
    replacement = false,
  ): StationSession {
    const maxCallRetries = replacement ? 0 : this.deps.maxCallRetries;
    if (
      maxCallRetries !== undefined &&
      (!Number.isSafeInteger(maxCallRetries) || maxCallRetries < 0 || maxCallRetries > 3)
    )
      throw new RangeError("RTC call retries must be an integer between 0 and 3");
    const session = (this.deps.createSession ?? ((o: RtcSessionOptions) => new RtcSession(o)))({
      authToken: identity.authToken,
      userId: identity.userId,
      accountUserId: identity.accountUserId,
      gtoken: identity.gtoken,
      stationSn: sn,
      adminUserId,
      shard: this.deps.shard() as never,
      country: this.deps.country ?? "US",
      channelId: 0,
      maxCallRetries,
      logger: this.deps.logger,
      peer: { logger: this.deps.logger, icePolicy: this.deps.icePolicy ?? "relay" },
    });
    const connectTimeoutMs = this.deps.connectTimeoutMs ?? 12_000;
    const created: StationSession = {
      storageCandidateOwner: {
        identity: { ...identity },
        accountId: adminUserId,
        model: this.deps.findDevice(sn)?.model,
      },
      session,
      generation: ++this.nextSessionGeneration,
      seg: new SegmentCounter(),
      ready: Promise.resolve(),
      queue: Promise.resolve(),
      leases: 0,
      idleWaiters: new Set(),
      diagnosticRetirement: new Set(),
      detach: () => {},
    };
    const onData = (bytes: Buffer, linkType: number) => {
      if (this.sessions.get(sn) !== created || !session.isConnected) return;
      const frame = parsePortalPacket(bytes, linkType);
      if (frame) this.deps.onFrame?.(sn, frame);
    };
    const onError = (error: Error) => {
      created.lastSessionError = renewalFailure(error);
      if (this.sessions.get(sn) === created) this.deps.onError?.(error);
    };
    const onClose = () => {
      for (const stop of [...created.diagnosticRetirement]) stop("session_closed");
      if (created.idle) clearTimeout(created.idle);
      this.cancelRefresh(sn, created);
      created.detach();
      if (this.sessions.get(sn) === created) this.sessions.delete(sn);
    };
    created.detach = () => {
      session.off("commandData", onData);
      session.off("error", onError);
      session.off("close", onClose);
    };
    session.on("commandData", onData);
    session.on("error", onError);
    session.on("close", onClose);
    created.ready = this.bringUp(sn, session, connectTimeoutMs).then(() => {
      created.connectedAtMs = Date.now();
    });
    return created;
  }

  /**
   * Permit the initial replacement or one retry after a fresh complete read begun after failure.
   * Retry exhaustion never closes a usable original; normal read failure and idle cleanup still apply.
   */
  private canRefresh(st: StationSession): boolean {
    const attempts = st.refreshAttempts ?? 0;
    if (st.informationTainted || !st.session.isConnected) return false;
    if (attempts === 0) return true;
    const read = st.lastInformationRead;
    return (
      attempts === 1 &&
      st.refreshRetryAtMs !== undefined &&
      read !== undefined &&
      read.startedAtMs > st.refreshRetryAtMs - 30_000 &&
      Date.now() >= read.finishedAtMs &&
      Date.now() - read.finishedAtMs <= 30_000
    );
  }

  /** Schedule replacement with a thirty-second retry cooldown, deferring while an operation holds it. */
  private armRefresh(sn: string, st: StationSession): void {
    const interval = this.deps.sessionRefreshMs ?? 0;
    if (
      !interval ||
      st.refreshTimer ||
      !this.canRefresh(st) ||
      st.replacement ||
      st.connectedAtMs === undefined ||
      this.sessions.get(sn) !== st
    )
      return;
    const dueAt = st.refreshRetryAtMs ?? st.connectedAtMs + interval;
    const delay = Math.max(0, dueAt - Date.now());
    st.refreshTimer = setTimeout(() => {
      st.refreshTimer = undefined;
      if (this.sessions.get(sn) !== st || !this.canRefresh(st)) return;
      if (st.leases > 0) {
        if (!st.refreshPending) this.refreshStats.deferred++;
        st.refreshPending = true;
        return;
      }
      st.refreshPending = false;
      void this.replaceSession(sn, st);
    }, delay);
    st.refreshTimer.unref?.();
  }

  /** Wait only for existing operations; no request or command is replayed. */
  private waitForIdle(st: StationSession, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (st.leases === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        st.idleWaiters.delete(done);
        signal.removeEventListener("abort", aborted);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(signal.reason);
      };
      st.idleWaiters.add(done);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  /** Verify a replacement within fifteen seconds, then adopt it only between operations. */
  private async replaceSession(sn: string, original: StationSession): Promise<void> {
    if (this.sessions.get(sn) !== original || original.replacement || !this.canRefresh(original)) return;
    const retryProof = original.refreshAttempts === 1 ? original.lastInformationRead : undefined;
    original.refreshAttempts = (original.refreshAttempts ?? 0) + 1;
    const attemptOrdinal = original.refreshAttempts;
    original.refreshRetryAtMs = undefined;
    const epoch = this.epoch;
    const started = Date.now();
    const replacement: NonNullable<StationSession["replacement"]> = { controller: new AbortController() };
    original.replacement = replacement;
    const signal = replacement.controller.signal;
    const timeout = setTimeout(
      () => replacement.controller.abort(new Error("RTC session replacement timed out")),
      15_000,
    );
    this.refreshStats.attempts++;
    this.refreshStats.lastStartedAtMs = started;
    this.refreshStats.lastSessionAgeMs = Math.max(0, started - (original.connectedAtMs ?? started));
    let adopted = false;
    let adoptedAtMs: number | null = null;
    let phase: RenewalPhase = "connect";
    let failure: RenewalFailure | null = null;
    let informationVerified = false;
    let outcome: RtcSessionRefreshDiagnostics["lastOutcome"] = "failed";
    try {
      const identity = this.deps.identity();
      if (!identity) throw new Error("RTC session replacement unavailable");
      const member = ((this.deps.findDevice(sn)?.raw ?? {}) as { member?: { admin_user_id?: unknown } }).member;
      const accountId = (typeof member?.admin_user_id === "string" && member.admin_user_id) || identity.userId;
      const candidate = this.createStationSession(sn, accountId, identity, true);
      replacement.candidate = candidate;
      await untilAborted(candidate.ready, signal);
      signal.throwIfAborted();
      phase = "information";
      await this.readInformation(candidate, accountId, candidate.seg.next(), signal, "replacement");
      informationVerified = true;
      phase = "idle";
      await this.waitForIdle(original, signal);
      signal.throwIfAborted();
      phase = "adoption";
      if (
        epoch !== this.epoch ||
        this.sessions.get(sn) !== original ||
        original.leases !== 0 ||
        !candidate.session.isConnected ||
        this.deps.identity()?.userId !== identity.userId
      )
        throw new Error("RTC session replacement superseded");
      original.replacement = undefined;
      this.sessions.set(sn, candidate);
      adoptedAtMs = Date.now();
      adopted = true;
      outcome = "success";
      this.armRefresh(sn, candidate);
      this.touch(sn, candidate);
      this.drop(sn, original);
    } catch (error) {
      failure = renewalFailure(error);
      if (epoch !== this.epoch || this.sessions.get(sn) !== original) outcome = "cancelled";
    } finally {
      const candidateConnected = replacement.candidate?.session.isConnected === true;
      const candidateCloseOrigin = replacement.candidate?.session.closeOrigin ?? null;
      clearTimeout(timeout);
      if (original.replacement === replacement) original.replacement = undefined;
      if (!adopted && replacement.candidate) this.drop(sn, replacement.candidate);
      if (epoch === this.epoch) {
        if (adopted) this.refreshStats.successes++;
        else this.refreshStats.failures++;
        this.refreshStats.lastFinishedAtMs = Date.now();
        this.refreshStats.lastOutcome = outcome;
        const evidence: RenewalEvidence = {
          attemptOrdinal,
          retryProofStartedAtMs: retryProof?.startedAtMs ?? null,
          retryProofFinishedAtMs: retryProof?.finishedAtMs ?? null,
          startedAtMs: started,
          finishedAtMs: this.refreshStats.lastFinishedAtMs,
          elapsedMs: Math.max(0, this.refreshStats.lastFinishedAtMs - started),
          originalSessionAgeMs: Math.max(0, started - (original.connectedAtMs ?? started)),
          originalSessionGeneration: original.generation,
          candidateSessionGeneration: replacement.candidate?.generation ?? null,
          candidateInformationReceivedAtMs: replacement.candidate?.lastInformationReceivedAtMs ?? null,
          adoptedAtMs,
          originalLeasesAtFinish: original.leases,
          candidateConnected,
          candidateCloseOrigin,
          sessionError: replacement.candidate?.lastSessionError ?? null,
          informationVerified,
          phase,
          outcome,
          failure,
        };
        this.refreshStats.lastAttempt = evidence;
        this.refreshStats.recent.push({ ...evidence });
        if (this.refreshStats.recent.length > 32) {
          this.refreshStats.recent.shift();
          this.refreshStats.evicted += 1;
        }
        if (!adopted) this.refreshStats.lastFailure = { ...evidence };
        const retention = this.refreshStats.failureRetention;
        if (retention && outcome === "failed") {
          retention.failedCompletions++;
          retention.recentFailures.push(retainedRenewalFailure(evidence, retention.failedCompletions));
          if (retention.recentFailures.length > 32) {
            retention.recentFailures.shift();
            retention.evictedFailures++;
          }
        } else if (retention && outcome === "cancelled") {
          retention.cancelledCompletions++;
        }
        if (
          outcome === "failed" &&
          phase === "connect" &&
          original.refreshAttempts === 1 &&
          (failure === "connect_timeout" ||
            failure === "session_closed" ||
            failure === "signaling_486" ||
            failure === "signaling_408") &&
          evidence.sessionError !== "other" &&
          this.sessions.get(sn) === original
        ) {
          original.refreshRetryAtMs = evidence.finishedAtMs + 30_000;
        }
      }
    }
  }

  /** Cancel only this generation's timer and replacement, preserving another current owner. */
  private cancelRefresh(sn: string, st: StationSession): void {
    if (st.refreshTimer) clearTimeout(st.refreshTimer);
    st.refreshTimer = undefined;
    const pending = st.replacement;
    if (pending) {
      st.replacement = undefined;
      pending.controller.abort(new Error("RTC session replacement cancelled"));
      if (pending.candidate) this.drop(sn, pending.candidate);
    }
  }

  /**
   * One bounded bring-up: the session is up when its command channel opens, and it fails — with the
   * session closed and every listener gone — when `connect()` throws, the session closes first, or the
   * deadline passes. A single promise, so an early failure cannot leave a second one rejecting unheard.
   */
  private bringUp(sn: string, session: RtcSession, connectTimeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.off("connected", onConnected);
        session.off("close", onClose);
        if (err) {
          try {
            session.close();
          } catch {
            /* already gone */
          }
          reject(err);
        } else {
          this.deps.logger?.info?.(`[rtc] ${sn} command channel up (${this.deps.icePolicy ?? "relay"})`);
          resolve();
        }
      };
      const onConnected = () => finish();
      const onClose = () => finish(new Error(`rtc: ${sn} session closed before the command channel opened`));
      const timer = setTimeout(() => finish(connectionDeadline(sn, connectTimeoutMs)), connectTimeoutMs);
      session.once("connected", onConnected);
      session.once("close", onClose);
      Promise.resolve()
        .then(() => {
          if (!settled) return session.connect();
        })
        .catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
    });
  }

  private touch(sn: string, st: StationSession): void {
    if (st.idle) clearTimeout(st.idle);
    if (this.sessions.get(sn) !== st) return;
    if (st.leases > 0) return; // a live view holds the session open
    if (st.informationTainted) {
      this.drop(sn, st);
      return;
    }
    this.armRefresh(sn, st);
    const idleMs = this.deps.idleCloseMs ?? 60_000;
    st.idle = setTimeout(() => this.drop(sn, st), idleMs);
    st.idle.unref?.();
  }

  /**
   * The station's session for media that must ride the SAME session as the commands (one RTC session per
   * account), with a lease that keeps it from idle-closing until released.
   */
  async sessionFor(
    stationSn: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ session: RtcSession; seg: SegmentCounter; accountId: string; release: () => void }> {
    const dev = this.deps.findDevice(stationSn);
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot open ${stationSn}`);
    const member = ((dev?.raw ?? {}) as { member?: { admin_user_id?: unknown } }).member;
    const accountId = (typeof member?.admin_user_id === "string" && member.admin_user_id) || identity.userId;
    const st = await this.stationSession(stationSn, accountId, identity, opts.signal);
    let released = false;
    return {
      session: st.session,
      seg: st.seg,
      accountId,
      release: () => {
        if (released) return;
        released = true;
        this.release(stationSn, st);
      },
    };
  }

  /** Share the station's fixed play slot with consumers of the same camera. */
  private async attachLive(sn: string, signal?: AbortSignal): Promise<RtcLiveConsumer> {
    signal?.throwIfAborted();
    const dev = this.deps.findDevice(sn);
    if (!dev?.stationSn) throw new Error(`rtc live: ${sn} is not attached to a station`);
    const raw = (dev.raw ?? {}) as { device_channel?: unknown };
    const channel = typeof raw.device_channel === "number" ? raw.device_channel : Number(raw.device_channel);
    if (!Number.isInteger(channel)) throw new Error(`rtc live: ${sn} has no device_channel`);
    const stationSn = dev.stationSn;
    let entry = this.lives.get(stationSn);
    if (entry && entry.sn !== sn) throw new Error("rtc live: station play slot already in use by another camera");
    if (!entry) {
      const controller = new AbortController();
      const created: LiveSlot = {
        sn,
        controller,
        pending: 0,
        attached: false,
        ready: this.sessionFor(stationSn, { signal: controller.signal }).then((lease) => {
          created.release = lease.release;
          if (controller.signal.aborted || this.lives.get(stationSn) !== created) {
            lease.release();
            throw new Error("rtc live: closed while opening the station play slot");
          }
          return (created.live = new RtcLive({
            session: lease.session,
            seg: lease.seg,
            stationSn,
            channel,
            accountId: lease.accountId,
            logger: this.deps.logger,
            onIdle: () => {
              if (this.lives.get(stationSn) === created) this.lives.delete(stationSn);
              lease.release();
            },
          }));
        }),
      };
      entry = created;
      this.lives.set(stationSn, entry);
    }
    entry.pending++;
    try {
      const live = await untilAborted(
        entry.ready,
        signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal,
      );
      signal?.throwIfAborted();
      if (this.lives.get(stationSn) !== entry) throw new Error("rtc live: station play slot was released");
      const consumer = live.attach();
      entry.attached = true;
      return consumer;
    } finally {
      entry.pending--;
      // One cancelled waiter must not revoke another reader or an existing live view.
      if (entry.pending === 0 && !entry.attached) {
        if (this.lives.get(stationSn) === entry) this.lives.delete(stationSn);
        entry.controller.abort(new Error("RTC live acquisition ended without a consumer"));
        entry.release?.();
      }
    }
  }

  /**
   * A {@link MediaProvider} for a camera on a T9000: live video over the station's control channel
   * (HEVC Annex B). Recording, talkback and P2P queries have no wire here yet and are refused.
   */
  mediaProviderFor(sn: string): MediaProvider {
    const unsupported = (what: string) =>
      new Error(`${what} is not available for a T9000 camera over the control channel`);
    const attach = (signal?: AbortSignal): Promise<RtcLiveConsumer> => this.attachLive(sn, signal);
    const openReadable: NonNullable<MediaProvider["openReadable"]> = async (opts) => {
      const signal = opts?.signal;
      const consumer = await attach(signal);
      try {
        signal?.throwIfAborted();
        const readable = openReadableFromConsumer(consumer as unknown as Consumer, opts);
        const onAbort = () => readable.destroy();
        const detachAbort = () => signal?.removeEventListener("abort", onAbort);
        readable.once("close", detachAbort);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          signal.throwIfAborted();
        }
        return readable;
      } catch (error) {
        consumer.detach();
        throw error;
      }
    };
    return {
      live: async (opts): Promise<LiveStreamConsumer> => {
        const signal = opts?.signal;
        const consumer = await attach(signal);
        const onAbort = () => consumer.detach();
        const onStop = () => signal?.removeEventListener("abort", onAbort);
        consumer.once("stop", onStop);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          consumer.detach();
          signal.throwIfAborted();
        }
        return consumer;
      },
      openReadable,
      snapshotLive: (opts) =>
        rtcSnapshot((signal) => openReadable({ signal }), {
          signal: opts?.signal,
          timeoutMs: opts?.timeoutMs,
          executable: this.deps.ffmpegPath,
          level: this.deps.ffmpegLogLevel,
          logger: this.deps.logger,
        }),
      record: async () => {
        throw unsupported("record");
      },
      recordFragments: () => {
        throw unsupported("recordFragments");
      },
      talkback: async () => {
        throw unsupported("talkback");
      },
      p2pQuery: async () => {
        throw unsupported("p2pQuery");
      },
    } as MediaProvider;
  }

  private release(sn: string, st: StationSession): void {
    st.leases = Math.max(0, st.leases - 1);
    if (st.leases === 0) for (const notify of [...st.idleWaiters]) notify();
    this.touch(sn, st);
  }

  private drop(sn: string, st: StationSession): void {
    for (const stop of [...st.diagnosticRetirement]) stop("retired");
    this.cancelRefresh(sn, st);
    if (st.idle) clearTimeout(st.idle);
    if (this.sessions.get(sn) === st) this.sessions.delete(sn);
    st.detach();
    try {
      st.session.close();
    } catch {
      /* already gone */
    }
  }
}
