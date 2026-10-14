import { afterEach, describe, expect, it, vi } from "vitest";
import { RtcSignalingClient, type RtcSignalingOptions, type SignalingSocketEvent } from "../signaling.js";

const identity = {
  authToken: "",
  userId: "account",
  adminUserId: "member",
  stationSn: "station",
  country: "US",
  shard: "us-pr",
} as const;

function abortable(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

afterEach(() => vi.useRealTimers());

describe("RTC signaling cancellation", () => {
  it.each([false, true])("close aborts the pending request or response body (body=%s)", async (body) => {
    let received: AbortSignal | undefined;
    const reading = Promise.withResolvers<void>();
    const fetchImpl = vi.fn(async (_url, init) => {
      received = init.signal;
      if (!body) {
        reading.resolve();
        return abortable(received!);
      }
      return {
        ok: true,
        status: 200,
        json: () => {
          reading.resolve();
          return abortable(received!);
        },
      };
    }) as unknown as typeof fetch;
    const client = new RtcSignalingClient({ ...identity, fetch: fetchImpl });
    const pending = client.fetchSign();
    const rejected = expect(pending).rejects.toThrow(/closed/);
    await reading.promise;
    client.close();
    expect(received?.aborted).toBe(true);
    await rejected;
  });

  it("aborts the sign request at its deadline and clears its timer", async () => {
    vi.useFakeTimers();
    let received: AbortSignal | undefined;
    const client = new RtcSignalingClient({
      ...identity,
      signTimeoutMs: 25,
      fetch: vi.fn(async (_url, init) => {
        received = init?.signal ?? undefined;
        return abortable(received!);
      }) as typeof fetch,
    } as RtcSignalingOptions);
    const pending = client.fetchSign();
    const rejected = expect(pending).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(25);
    expect(received?.aborted).toBe(true);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles a socket open wait on close and ignores a late open", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (ev: SignalingSocketEvent) => void>();
    const socket = {
      readyState: 1,
      close: vi.fn(),
      send: vi.fn(),
      addEventListener: (name: string, fn: (ev: SignalingSocketEvent) => void) => {
        handlers.set(name, fn);
      },
    };
    const client = new RtcSignalingClient({
      ...identity,
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: "synthetic" }),
      })) as unknown as typeof fetch,
      createSocket: () => socket,
    });
    await client.fetchSign();
    const pending = client.connect();
    const rejected = expect(pending).rejects.toThrow(/closed/);
    client.close();
    await rejected;
    expect(() => handlers.get("open")?.({})).not.toThrow();
    expect(socket.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
