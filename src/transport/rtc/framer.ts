/** Modified for genomez S1 experimental source preview, 2026-10-14. */
/**
 * What sits between a portal packet and the WebRTC data channel.
 *
 * The hub does not read raw `XZYH` packets off `WebrtcDataChannel`: the portal runs them through its
 * own framing layer first — a "PTCS" packetiser with padding and forward-error-correction groups, which
 * the web client ships as a WebAssembly module (`libsctp`). Inbound, the same layer reassembles frames
 * and tags each with the logical channel it arrived on (command / notify / file / …).
 *
 * The SDK does not ship Anker's module: `ptcs-framer.ts` is a clean-room implementation of the same
 * wire format, written from that module's observed input/output. This interface is the seam: a framer
 * turns one outbound portal packet into wire packets and turns inbound wire packets back into frames,
 * and the session neither knows nor cares which implementation is behind it.
 */

import { isPortalPacket, PortalLinkType } from "./portal-packet.js";

/**
 * Numeric receive observations; counters saturate at the maximum safe integer. Rejections count the
 * first failing admission condition per packet; expiry counts discarded incomplete frames.
 */
export interface FramingDiagnostics {
  /** Packets received while initialized, including bare frames and non-PTCS traffic. */
  receivedPackets: number;
  /** Bare portal packets passed through without reassembly. */
  barePackets: number;
  /** Non-PTCS traffic without a recognized framing envelope; not a rejection category. */
  nonPtcsPackets: number;
  admittedFragments: number;
  duplicateFragments: number;
  /** Completed reassemblies and bare frames, counted before the delivery callback. */
  completedFrames: number;
  invalidMetadata: number;
  conflicts: number;
  frameLimit: number;
  fragmentLimit: number;
  bufferLimit: number;
  capacity: number;
  decompression: number;
  /** Incomplete frames dropped at the idle or absolute deadline. */
  expiry: number;
  pendingFrames: number;
  bufferedBytes: number;
}

/** Copy only finite numeric observations, with no packet data or additional properties. */
export function copyFramingDiagnostics(snapshot: FramingDiagnostics): FramingDiagnostics {
  return {
    receivedPackets: framingCount(snapshot.receivedPackets),
    barePackets: framingCount(snapshot.barePackets),
    nonPtcsPackets: framingCount(snapshot.nonPtcsPackets),
    admittedFragments: framingCount(snapshot.admittedFragments),
    duplicateFragments: framingCount(snapshot.duplicateFragments),
    completedFrames: framingCount(snapshot.completedFrames),
    invalidMetadata: framingCount(snapshot.invalidMetadata),
    conflicts: framingCount(snapshot.conflicts),
    frameLimit: framingCount(snapshot.frameLimit),
    fragmentLimit: framingCount(snapshot.fragmentLimit),
    bufferLimit: framingCount(snapshot.bufferLimit),
    capacity: framingCount(snapshot.capacity),
    decompression: framingCount(snapshot.decompression),
    expiry: framingCount(snapshot.expiry),
    pendingFrames: framingCount(snapshot.pendingFrames),
    bufferedBytes: framingCount(snapshot.bufferedBytes),
  };
}

/** Normalize an observation to a nonnegative safe integer. */
function framingCount(value: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
    : 0;
}

export interface PortalFramer {
  /** Arm the two callbacks; resolves once `sendFrame` may be called. */
  init(onWirePacket: (packet: Buffer) => void, onFrame: (frame: Buffer, linkType: number) => void): Promise<void>;
  isReady(): boolean;
  /** One outbound portal packet → zero or more wire packets through `onWirePacket`. */
  sendFrame(portalPacket: Buffer): void;
  /** One inbound wire packet → zero or more frames through `onFrame`. */
  recvPacket(wirePacket: Buffer): void;
  /** Detached receive observations; reading does not advance expiry or alter admission. */
  getDiagnostics?(): FramingDiagnostics;
  destroy(): void;
}

export type PortalFramerFactory = () => PortalFramer;

/**
 * The identity framer: portal packets go on the wire as they are, and a wire packet that starts with
 * `XZYH` is a frame. This is what the portal's own client falls back to for a frame that arrives
 * un-wrapped. Kept as a diagnostic option: with it, the hub's *acknowledgements* are readable (it answers
 * unwrapped), while whether it *accepts* unwrapped commands is a question only the hardware can answer.
 */
export class PassthroughFramer implements PortalFramer {
  private onWire?: (packet: Buffer) => void;
  private onFrame?: (frame: Buffer, linkType: number) => void;
  private ready = false;

  async init(
    onWirePacket: (packet: Buffer) => void,
    onFrame: (frame: Buffer, linkType: number) => void,
  ): Promise<void> {
    this.onWire = onWirePacket;
    this.onFrame = onFrame;
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  sendFrame(portalPacket: Buffer): void {
    if (!this.ready) throw new Error("framer not initialised");
    this.onWire?.(portalPacket);
  }

  recvPacket(wirePacket: Buffer): void {
    if (!this.ready) return;
    if (isPortalPacket(wirePacket)) this.onFrame?.(wirePacket, PortalLinkType.COMMAND);
  }

  destroy(): void {
    this.ready = false;
    this.onWire = undefined;
    this.onFrame = undefined;
  }
}
