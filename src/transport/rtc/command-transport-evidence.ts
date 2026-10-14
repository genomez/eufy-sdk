import {
  commandHeaderSample,
  type CommandEvidence,
  type CommandEvidenceRecorder,
  type PostTimeoutStatus,
} from "./command-diagnostics.js";
import { parsePortalPacket } from "./portal-packet.js";
import type { RtcSession } from "./session.js";
import { copyRtcTransportDiagnostics, type RtcTransportDiagnostics } from "./transport-diagnostics.js";

interface PassiveObservation {
  onData: (frame: Buffer, linkType: number) => void;
  stop: (reason: PostTimeoutStatus) => void;
}

interface PassiveDispatcher {
  observations: Set<PassiveObservation>;
  onData: (frame: Buffer, linkType: number) => void;
  onClose: () => void;
}

const passiveDispatchers = new WeakMap<RtcSession, PassiveDispatcher>();

/** One passive listener pair per session, removed when its last finite observation ends. */
function attachPassiveObservation(session: RtcSession, observation: PassiveObservation): () => void {
  let dispatcher = passiveDispatchers.get(session);
  if (!dispatcher) {
    const observations = new Set<PassiveObservation>();
    dispatcher = {
      observations,
      onData: (frame, linkType) => {
        for (const active of [...observations]) active.onData(frame, linkType);
      },
      onClose: () => {
        for (const active of [...observations]) active.stop("session_closed");
      },
    };
    passiveDispatchers.set(session, dispatcher);
    session.on("commandData", dispatcher.onData);
    session.on("close", dispatcher.onClose);
  }
  const selected = dispatcher;
  selected.observations.add(observation);
  return () => {
    selected.observations.delete(observation);
    if (selected.observations.size !== 0) return;
    session.off("commandData", selected.onData);
    session.off("close", selected.onClose);
    if (passiveDispatchers.get(session) === selected) passiveDispatchers.delete(session);
  };
}

/** Optional diagnostic capability; neither an absent method nor an exception can affect command work. */
export function selectedTransportSnapshot(session: RtcSession): RtcTransportDiagnostics | null {
  try {
    const read = (session as Partial<RtcSession>).getTransportDiagnostics;
    if (typeof read !== "function") return null;
    const snapshot = read.call(session);
    return snapshot ? copyRtcTransportDiagnostics(snapshot) : null;
  } catch {
    return null;
  }
}

/** Retain numeric headers for thirty seconds without leases, sends or command completion callbacks. */
export function observeTimedOutCommand(
  session: RtcSession,
  row: CommandEvidence,
  recorder: CommandEvidenceRecorder,
  retirement: Set<(reason: PostTimeoutStatus) => void>,
  outerCmd: number,
  innerCmd: number,
  channel: number,
  segment: number,
): void {
  if (row.sendAttemptedAtMs === null || !session.isConnected) return;
  const startedAtMs = Date.now();
  const window = {
    startedAtMs,
    deadlineAtMs: startedAtMs + 30_000,
    finishedAtMs: null as number | null,
    status: "observing" as PostTimeoutStatus,
    receivedFrames: 0,
    invalidFrames: 0,
    headerSamples: [] as NonNullable<CommandEvidence["postTimeout"]>["headerSamples"],
    headerSamplesOmitted: 0,
    transportAtFinish: selectedTransportSnapshot(session),
  };
  row.postTimeout = window;
  const transportEpoch = row.transportBeforeSend?.transportEpoch ?? row.transportAtFinish?.transportEpoch ?? null;
  let stopped = false;
  let detachObservation = () => {};
  const stop = (reason: PostTimeoutStatus) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    detachObservation();
    retirement.delete(stop);
    recorder.stopObserving(row);
    window.status = reason;
    window.finishedAtMs = Date.now();
    window.transportAtFinish = selectedTransportSnapshot(session);
    recorder.updatePostTimeout(row);
  };
  const onData = (frame: Buffer, linkType: number) => {
    try {
      if (stopped) return;
      if (Date.now() >= window.deadlineAtMs) {
        stop("expired");
        return;
      }
      const transport = selectedTransportSnapshot(session);
      if (transportEpoch !== null && transport && transport.transportEpoch !== transportEpoch) {
        stop("transport_replaced");
        return;
      }
      window.transportAtFinish = transport;
      window.receivedFrames++;
      const parsed = parsePortalPacket(frame, linkType);
      if (!parsed) window.invalidFrames++;
      else if (window.headerSamples.length < 16)
        window.headerSamples.push(commandHeaderSample(parsed, linkType, outerCmd, innerCmd, channel, segment));
      else window.headerSamplesOmitted++;
      recorder.updatePostTimeout(row);
    } catch {
      return;
    }
  };
  const timer = setTimeout(() => stop("expired"), 30_000);
  timer.unref?.();
  retirement.add(stop);
  recorder.observe(row, stop);
  detachObservation = attachPassiveObservation(session, { onData, stop });
}
