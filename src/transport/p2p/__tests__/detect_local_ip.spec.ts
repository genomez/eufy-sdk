import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * `P2PSession.detectLocalIp()` (private static, self-IP probe used by the LOOKUP_WITH_KEY self-report)
 * — no real socket: `node:dgram` is mocked to a bare EventEmitter standing in for a UDP socket, with
 * `connect`/`address`/`close` spies so the success/failure/teardown-race paths are all reachable
 * without real network I/O. `localIpPromise` is a process-wide static cache, so it's reset before each
 * test to isolate them.
 */
type FakeSocket = EventEmitter & {
  connect: (port: number, host: string, cb: () => void) => void;
  address: () => { address: string };
  close: () => void;
};

let nextSocket: (() => FakeSocket) | undefined;
const createSocketCalls: string[] = [];

vi.mock("node:dgram", () => ({
  default: {
    createSocket: vi.fn((type: string) => {
      createSocketCalls.push(type);
      return nextSocket ? nextSocket() : makeFakeSocket({ succeed: true, ip: "203.0.113.5" });
    }),
  },
}));

function makeFakeSocket(opts: {
  succeed: boolean;
  ip?: string;
  addressThrows?: boolean;
  closeThrows?: boolean;
}): FakeSocket {
  const s = new EventEmitter() as FakeSocket;
  s.close = vi.fn(() => {
    if (opts.closeThrows) throw new Error("ERR_SOCKET_DGRAM_NOT_RUNNING");
  });
  s.address = vi.fn(() => {
    if (opts.addressThrows) throw new Error("ERR_SOCKET_DGRAM_NOT_RUNNING");
    return { address: opts.ip ?? "" };
  });
  s.connect = vi.fn((_port: number, _host: string, cb: () => void) => {
    if (opts.succeed) queueMicrotask(cb);
    // on !succeed, the caller emits "error" itself to drive the failure path
  });
  return s;
}

const { P2PSession } = await import("../p2p-session.js");
const detectLocalIp = () => (P2PSession as any).detectLocalIp();

describe("P2PSession.detectLocalIp — self-IP probe caching + teardown", () => {
  beforeEach(() => {
    (P2PSession as any).localIpPromise = undefined;
    createSocketCalls.length = 0;
    nextSocket = undefined;
  });

  it("resolves the bound address on a successful probe and caches it (one createSocket call for two detects)", async () => {
    nextSocket = () => makeFakeSocket({ succeed: true, ip: "203.0.113.5" });
    await expect(detectLocalIp()).resolves.toBe("203.0.113.5");
    await expect(detectLocalIp()).resolves.toBe("203.0.113.5");
    expect(createSocketCalls).toHaveLength(1); // second call reused the cached promise, no re-probe
  });

  it("a failed probe resolves undefined and does NOT poison the cache — the next call re-probes", async () => {
    let socket!: FakeSocket;
    nextSocket = () => (socket = makeFakeSocket({ succeed: false }));
    const p1 = detectLocalIp();
    socket.emit("error", new Error("network unreachable"));
    await expect(p1).resolves.toBeUndefined();

    // Second call must re-probe (a fresh socket), not reuse a permanently-undefined cached promise.
    nextSocket = () => makeFakeSocket({ succeed: true, ip: "203.0.113.9" });
    await expect(detectLocalIp()).resolves.toBe("203.0.113.9");
    expect(createSocketCalls).toHaveLength(2);
  });

  it("a timeout resolves undefined without throwing", async () => {
    vi.useFakeTimers();
    try {
      nextSocket = () => makeFakeSocket({ succeed: false }); // connect() never calls back → times out
      const p = detectLocalIp();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a connect callback firing after the timeout already closed the socket does not throw uncaught (address() failing is swallowed)", async () => {
    vi.useFakeTimers();
    try {
      let deferredConnectCb: (() => void) | undefined;
      nextSocket = () => {
        const s = new EventEmitter() as FakeSocket;
        s.close = vi.fn();
        s.address = vi.fn(() => {
          throw new Error("ERR_SOCKET_DGRAM_NOT_RUNNING"); // simulates calling address() post-close
        });
        s.connect = vi.fn((_p: number, _h: string, cb: () => void) => {
          deferredConnectCb = cb; // never fires on its own — invoked manually below, after the timeout
        });
        return s;
      };
      const p = detectLocalIp();
      await vi.advanceTimersByTimeAsync(2000); // timeout wins the race first, closes + resolves undefined
      expect(() => deferredConnectCb?.()).not.toThrow(); // late connect callback must not throw uncaught
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the timeout winning the race first suppresses a later error event — no second close()", async () => {
    vi.useFakeTimers();
    try {
      const socket = makeFakeSocket({ succeed: false, closeThrows: true }); // would throw if called again
      nextSocket = () => socket;
      const p = detectLocalIp();
      await vi.advanceTimersByTimeAsync(2000); // timeout fires first: settled=true, one close()
      expect(() => socket.emit("error", new Error("late"))).not.toThrow(); // settled guard skips a 2nd close()
      expect(socket.close).toHaveBeenCalledTimes(1);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
