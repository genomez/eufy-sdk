import { afterEach, describe, expect, it, vi } from "vitest";
import { performance as nativePerformance } from "node:perf_hooks";
import { EventPlaybackCandidate } from "../event-playback-candidate.js";
import { PlaybackIngress } from "../playback-ingress.js";
import { buildPortalHeader } from "../portal-packet.js";
import { packetize } from "../ptcs-framer.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
let frameId = 0;
const media = (size = 50, command = 1300, selector = 6) =>
  Buffer.concat([buildPortalHeader(command, size, 101, 9, selector), Buffer.alloc(size)]);
const packets = (bytes: Buffer, payloadBytes = 1000) =>
  packetize(bytes, { channel: 4, frameId: ++frameId, payloadBytes });
function ingress() {
  let now = 0;
  const delivered = vi.fn(),
    end = vi.fn();
  const guard = new PlaybackIngress({ now: () => now, media: delivered, end });
  guard.reserve(6, 7);
  guard.capturing = true;
  return {
    guard,
    delivered,
    end,
    clock: (v: number) => {
      now = v;
    },
  };
}

describe("offline retained-state and budget matrix", () => {
  it.each([false, true])("assembles reordered and duplicate fragments reversed=%s", (reversed) => {
    const s = ingress(),
      parts = packets(media(4000));
    if (reversed) parts.reverse();
    s.guard.native(parts[0]);
    s.guard.native(parts[0]);
    for (const p of parts.slice(1)) s.guard.native(p);
    expect(s.delivered).toHaveBeenCalledOnce();
    expect(s.guard.evidence.unknown).toBe(false);
    expect(s.guard.observationComplete()).toBe(true);
  });
  it("accepts tiny fragments within the shared position limit", () => {
    const s = ingress();
    for (const p of packets(media(50), 1)) s.guard.native(p);
    expect(s.delivered).toHaveBeenCalledOnce();
  });
  it("refuses a fragment position beyond the strict limit", () => {
    const s = ingress(),
      p = packets(media())[0]!;
    p.writeUInt16LE(16384, 16);
    expect(s.guard.native(p)).toBe(false);
    expect(s.guard.evidence.unknown).toBe(false);
    expect(s.delivered).not.toHaveBeenCalled();
  });
  it("refuses a ninth simultaneous partial without collecting", () => {
    const s = ingress();
    for (let n = 0; n < 9; n++) s.guard.native(packets(media(5000))[0]);
    expect(s.guard.evidence.unknown).toBe(false);
    expect(s.delivered).not.toHaveBeenCalled();
  });
  it.each([1300, 1301])("charges the combined frame cap for media %s", (command) => {
    const s = ingress();
    for (let n = 0; n < 257; n++) for (const p of packets(media(1, command))) s.guard.native(p);
    expect(s.delivered).toHaveBeenCalledTimes(256);
    expect(s.guard.evidence.mediaFrames).toBe(256);
    expect(s.end).toHaveBeenCalledWith("capped");
  });
  it("charges the combined byte cap before collecting a whole over-budget frame", () => {
    const s = ingress();
    for (let n = 0; n < 9; n++) for (const p of packets(media(262128))) s.guard.native(p);
    expect(s.delivered).toHaveBeenCalledTimes(8);
    expect(s.guard.evidence.mediaBytes).toBe(2097152);
    expect(s.end).toHaveBeenCalledWith("capped");
  });
  it.each(["bytes", "messages"])("all-route cutoff preserves ordinary control at %s limit", (which) => {
    const s = ingress();
    if (which === "bytes") s.guard.evidence.nativeBytes = 4194303;
    else s.guard.evidence.nativeMessages = 16383;
    const control = Buffer.concat([buildPortalHeader(1350, 4, 0, 9, 0), Buffer.alloc(4)]);
    expect(s.guard.native(control)).toBe(true);
    expect(s.guard.evidence.cutoff).toBe(true);
    expect(s.guard.decoded(control, 1)).toBe(true);
    for (const p of packets(media())) s.guard.native(p);
    expect(s.delivered).not.toHaveBeenCalled();
  });
  it.each([undefined, "opaque", Buffer.alloc(4)])("unclassifiable input invalidates cessation", (value) => {
    const s = ingress();
    s.clock(4999);
    expect(s.guard.native(value)).toBe(false);
    expect(s.guard.lastPlausibleMs).toBe(4999);
    expect(s.guard.observationComplete()).toBe(false);
  });
  it("stale observation cannot qualify silence", () => {
    const s = ingress();
    s.clock(4999);
    s.guard.stale();
    expect(s.guard.observationComplete()).toBe(false);
    expect(s.guard.lastPlausibleMs).toBe(4999);
  });
});

function candidate(remaining = 24000) {
  vi.useFakeTimers();
  vi.spyOn(nativePerformance, "now").mockImplementation(() => performance.now());
  const controller = new AbortController(),
    sent: number[] = [],
    markers: boolean[] = [];
  let continuous = true,
    segment = 0;
  const c = new EventPlaybackCandidate({
    deadlineMs: performance.now() + remaining,
    continuous: () => continuous,
    startAllowed: () => true,
    signal: controller.signal,
    account: "synthetic",
    segment: () => ++segment,
    marker: (v) => {
      markers.push(v);
    },
    latch: () => {},
    send: (p) => {
      sent.push(JSON.parse(p.subarray(16).toString()).data.cmd);
      return true;
    },
  });
  return {
    c,
    controller,
    sent,
    markers,
    loseOwner: () => {
      continuous = false;
    },
  };
}
describe("offline absolute deadline and cessation matrix", () => {
  it.each([0, 14999])("refuses start with remaining=%s without a latch or send", async (remaining) => {
    const s = candidate(remaining);
    await s.c.capture({ record: 40, begin: 1000000 }, [6, 7]);
    expect(s.sent).toEqual([]);
    expect(s.markers).toEqual([]);
    await s.c.observe();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("admits at the exact minimum while preserving cleanup authority after abort", async () => {
    const s = candidate(15000),
      run = s.c.capture({ record: 40, begin: 1000000 }, [6, 7]);
    s.controller.abort();
    await run;
    expect(s.sent).toEqual([0, 1, 3]);
    const result = s.c.observe();
    await vi.advanceTimersByTimeAsync(24010);
    expect((await result).releaseOutcome).toBe("stop_unconfirmed");
  });
  it("no video ends capture at five seconds and not just before it", async () => {
    const s = candidate(),
      run = s.c.capture({ record: 40, begin: 1000000 }, [6, 7]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.sent).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(s.sent).toEqual([0, 1, 3]);
    expect(s.c.receipt.captureOutcome).toBe("no_media");
    const result = s.c.observe();
    await vi.advanceTimersByTimeAsync(24010);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("valid video permits capture only up to the eight-second boundary", async () => {
    const s = candidate(),
      run = s.c.capture({ record: 40, begin: 1000000 }, [6, 7]);
    const bytes = media(29);
    bytes.writeUInt32LE(7, 16);
    bytes[21] = 1;
    Buffer.from([0, 0, 0, 1, 0x26, 1, 0x80]).copy(bytes, 38);
    for (const p of packets(bytes)) s.c.ingress.native(p);
    await vi.advanceTimersByTimeAsync(7999);
    expect(s.sent).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(s.sent).toEqual([0, 1, 3]);
    const result = s.c.observe();
    await vi.advanceTimersByTimeAsync(24010);
    await result;
  });
  it("cleanup never sends at hard expiry", async () => {
    const s = candidate(),
      run = s.c.capture({ record: 40, begin: 1000000 }, [6, 7]);
    vi.setSystemTime(24000);
    vi.spyOn(nativePerformance, "now").mockReturnValue(24000);
    s.controller.abort();
    await run;
    expect(s.sent).toEqual([0]);
    const result = await s.c.observe();
    expect(result.latchRetained).toBe(true);
  });
  it("owner loss at cleanup keeps the latch and never moves sends", async () => {
    const s = candidate(),
      run = s.c.capture({ record: 40, begin: 1000000 }, [6, 7]);
    s.loseOwner();
    s.controller.abort();
    await run;
    expect(s.sent).toEqual([0]);
    expect((await s.c.observe()).releaseOutcome).toBe("release_unknown");
  });
  it("late fragments immediately before five seconds prevent false cessation", async () => {
    const s = candidate(),
      run = s.c.capture({ record: 40, begin: 1000000 }, [6, 7]);
    s.controller.abort();
    await run;
    const result = s.c.observe();
    await vi.advanceTimersByTimeAsync(4999);
    s.c.ingress.native(packets(media(5000))[0]);
    await vi.advanceTimersByTimeAsync(19011);
    expect((await result).cessationOutcome).toBe("cessation_unknown");
    expect(s.c.receipt.latchRetained).toBe(true);
  });
});
