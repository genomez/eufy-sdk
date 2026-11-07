import type { IcePolicy } from "./peer.js";
import { iceCandidateType } from "./scall-sdp.js";

export type IceCandidateKind = "host" | "srflx" | "prflx" | "relay" | "unknown";
export type EstablishmentDeadline = "connection" | "signaling_auth" | "local_answer" | "replacement";
export interface IceEstablishmentDiagnostics {
  policy: IcePolicy;
  grantOfferOrder: "grant_first" | "offer_first" | "grant_only" | "offer_only" | "neither";
  grantAtMs: number | null;
  offerAtMs: number | null;
  peerInitializations: Array<{ atMs: number; turnConfigured: boolean }>;
  /** Observed SDP and trickle occurrences, including rejected types and repeated candidates. */
  candidates: { local: Record<IceCandidateKind, number>; remote: Record<IceCandidateKind, number> };
  selectedPair: { local?: IceCandidateKind; remote?: IceCandidateKind };
  transitions: Array<{ layer: "ice" | "connection"; state: string; atMs: number }>;
  dtls: {
    source: "connection_state_proxy";
    nativeStateAvailable: false;
    transitions: Array<{ state: string; atMs: number }>;
    iceConnectedAtMs: number | null;
    connectionConnectedAtMs: number | null;
  };
  deadlines: Array<{ kind: EstablishmentDeadline; atMs: number }>;
  evicted: number;
}

/** Fixed-storage, allowlisted establishment evidence; candidate strings are never retained. */
export class IceEstablishmentRecorder {
  private readonly start = performance.now();
  private first: "grant" | "offer" | null = null;
  private readonly evidence: IceEstablishmentDiagnostics;

  constructor(policy: IcePolicy) {
    const counts = () => ({ host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 });
    this.evidence = {
      policy: policy === "all" || policy === "relay" ? policy : "host-only",
      grantOfferOrder: "neither",
      grantAtMs: null,
      offerAtMs: null,
      peerInitializations: [],
      candidates: { local: counts(), remote: counts() },
      selectedPair: {},
      transitions: [],
      dtls: {
        source: "connection_state_proxy",
        nativeStateAvailable: false,
        transitions: [],
        iceConnectedAtMs: null,
        connectionConnectedAtMs: null,
      },
      deadlines: [],
      evicted: 0,
    };
  }

  private elapsed(): number {
    return Math.max(0, Math.round(performance.now() - this.start));
  }

  order(kind: "grant" | "offer"): void {
    this.first ??= kind;
    const key = kind === "grant" ? "grantAtMs" : "offerAtMs";
    this.evidence[key] ??= this.elapsed();
    const both = this.evidence.grantAtMs !== null && this.evidence.offerAtMs !== null;
    this.evidence.grantOfferOrder = both ? (this.first === "grant" ? "grant_first" : "offer_first") : `${kind}_only`;
  }

  initialized(turnConfigured: boolean): void {
    this.append(this.evidence.peerInitializations, { atMs: this.elapsed(), turnConfigured });
  }

  candidate(side: "local" | "remote", candidate: string): void {
    const type = iceCandidateType(candidate);
    const kind = this.kind(type);
    this.evidence.candidates[side][kind] = Math.min(Number.MAX_SAFE_INTEGER, this.evidence.candidates[side][kind] + 1);
  }

  selected(pair: { local?: string; remote?: string }): void {
    if (pair.local) this.evidence.selectedPair.local = this.kind(pair.local);
    if (pair.remote) this.evidence.selectedPair.remote = this.kind(pair.remote);
  }

  transition(layer: "ice" | "connection", state: string): void {
    if (
      !["new", "checking", "connecting", "connected", "completed", "disconnected", "failed", "closed"].includes(state)
    )
      return;
    const atMs = this.elapsed();
    this.append(this.evidence.transitions, { layer, state, atMs });
    if (layer === "connection")
      this.append(this.evidence.dtls.transitions, { state: state === "disconnected" ? "closed" : state, atMs });
    if (layer === "ice" && (state === "connected" || state === "completed"))
      this.evidence.dtls.iceConnectedAtMs ??= atMs;
    if (layer === "connection" && state === "connected") this.evidence.dtls.connectionConnectedAtMs ??= atMs;
  }

  deadline(kind: EstablishmentDeadline): void {
    this.append(this.evidence.deadlines, { kind, atMs: this.elapsed() });
  }

  snapshot(): IceEstablishmentDiagnostics {
    return structuredClone(this.evidence);
  }

  private kind(value: string): IceCandidateKind {
    return value === "host" || value === "srflx" || value === "prflx" || value === "relay" ? value : "unknown";
  }

  private append<T>(target: T[], item: T): void {
    target.push(item);
    if (target.length > 32) {
      target.shift();
      this.evidence.evicted = Math.min(Number.MAX_SAFE_INTEGER, this.evidence.evicted + 1);
    }
  }
}
