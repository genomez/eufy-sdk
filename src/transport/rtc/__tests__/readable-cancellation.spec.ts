import { EventEmitter, getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter } from "../command-router.js";
import type { RtcSession } from "../session.js";
import { PORTAL_HEADER_LENGTH, SegmentCounter } from "../portal-packet.js";

function setup(manual = false) {
  const commands: number[] = [];
  let sessions = 0;
  const session = Object.assign(new EventEmitter(), {
    isConnected: false,
    connect: vi.fn(async () => {
      if (!manual) session.ready();
    }),
    ready: () => {
      session.isConnected = true;
      session.emit("connected");
    },
    close: vi.fn(() => {
      session.isConnected = false;
      session.emit("close");
    }),
    sendRaw: () => true,
    sendCommand: (packet: Buffer) => {
      const body = JSON.parse(packet.subarray(PORTAL_HEADER_LENGTH).toString()) as { cmd: number };
      commands.push(body.cmd);
      return true;
    },
  });
  const devices = [
    { sn: "station", model: "T9000" },
    { sn: "camera", stationSn: "station", raw: { device_channel: 1 } },
  ] as EufyDevice[];
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "", userId: "account" }),
    shard: () => "us-pr",
    accountName: () => "member",
    findDevice: (sn) => devices.find((device) => device.sn === sn),
    createSession: () => {
      sessions++;
      return session as unknown as RtcSession;
    },
  });
  return { router, session, commands, sessions: () => sessions, provider: router.mediaProviderFor("camera") };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("RTC readable cancellation", () => {
  it("keeps station connection bounded at twelve seconds before the first-IDR timer exists", async () => {
    vi.useFakeTimers();
    const { router, provider, commands, session } = setup(true);
    try {
      const opening = provider.openReadable!();
      const rejected = expect(opening).rejects.toThrow("did not come up within 12000ms");
      await vi.advanceTimersByTimeAsync(11_999);
      expect(commands).toEqual([]);
      expect(session.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(session.close).toHaveBeenCalled();
      session.ready();
      await vi.advanceTimersByTimeAsync(45_000);
      expect(commands).toEqual([]);
    } finally {
      router.close();
      vi.useRealTimers();
    }
  });

  it("cancels every pending waiter and cannot start from a late connection", async () => {
    const { router, provider, commands, session } = setup(true);
    const controllers = [new AbortController(), new AbortController()];
    const requests = controllers.map((controller) => provider.openReadable!({ signal: controller.signal }));
    const rejected = requests.map((request) => expect(request).rejects.toThrow("cancelled"));
    for (const controller of controllers) controller.abort(new Error("cancelled"));
    await Promise.all(rejected);
    await tick();
    session.ready();
    await tick();
    expect(commands).toEqual([]);
    expect(session.close).toHaveBeenCalled();
    for (const controller of controllers) expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    router.close();
  });

  it("aborts an acquired readable immediately near the 25-second IDR deadline without retry", async () => {
    vi.useFakeTimers();
    const { router, provider, commands } = setup();
    try {
      const controller = new AbortController();
      const readable = await provider.openReadable!({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(24_999);
      expect(commands).toEqual([1003]);
      controller.abort();
      expect(readable.destroyed).toBe(true);
      expect(commands).toEqual([1003, 1004]);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(commands).toEqual([1003, 1004]);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      router.close();
      vi.useRealTimers();
    }
  });

  it("final detach bypasses an ordinary command waiting for an ACK", async () => {
    const { router, provider, commands } = setup();
    const readable = await provider.openReadable!();
    const waiting = router.dispatchCommand("station", {
      kind: "set-payload",
      cmd: 1224,
      payload: { mode_type: 1, user_name: "synthetic" },
      channel: 0,
      mValue3: 0,
    });
    const rejected = expect(waiting).rejects.toThrow();
    await tick();
    expect(commands).toHaveLength(2);
    readable.destroy();
    expect(commands.at(-1)).toBe(1004);
    router.close();
    await rejected;
  });

  it("rejects an already aborted request without creating a station session", async () => {
    const { provider, sessions } = setup();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(provider.openReadable!({ signal: controller.signal })).rejects.toThrow("cancelled");
    expect(sessions()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("cancels a lone pending connection before any media command is sent", async () => {
    const { router, session, commands, provider } = setup(true);
    const controller = new AbortController();
    const pending = provider.openReadable!({ signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    await tick();
    expect(session.close).toHaveBeenCalled();
    expect(commands).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    session.ready();
    await tick();
    expect(commands).toEqual([]);
    router.close();
  });

  it("preserves a same-camera waiter when the first pending reader cancels", async () => {
    const { router, session, commands, provider, sessions } = setup(true);
    const controller = new AbortController();
    const first = provider.openReadable!({ signal: controller.signal });
    const rejected = expect(first).rejects.toThrow("cancelled");
    const second = provider.openReadable!();
    controller.abort(new Error("cancelled"));
    await rejected;
    expect(session.close).not.toHaveBeenCalled();
    session.ready();
    const readable = await second;
    try {
      expect(sessions()).toBe(1);
      expect(commands).toEqual([1003]);
    } finally {
      readable.destroy();
      router.close();
    }
    expect(commands).toEqual([1003, 1004]);
  });

  it("releases a late acquisition without starting media after cancellation", async () => {
    const { router, session, provider, commands } = setup();
    let resolveLease!: (lease: Awaited<ReturnType<RtcCommandRouter["sessionFor"]>>) => void;
    vi.spyOn(router, "sessionFor").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLease = resolve;
        }),
    );
    const release = vi.fn();
    const controller = new AbortController();
    const opening = provider.openReadable!({ signal: controller.signal });
    const rejected = expect(opening).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    resolveLease({
      session: session as unknown as RtcSession,
      seg: new SegmentCounter(),
      accountId: "account",
      release,
    });
    await tick();
    expect(release).toHaveBeenCalledTimes(1);
    expect(commands).toEqual([]);
    router.close();
  });

  it("removes the abort listener when a readable is destroyed normally", async () => {
    const { router, provider, commands } = setup();
    const controller = new AbortController();
    const readable = await provider.openReadable!({ signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    readable.destroy();
    await tick();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    expect(commands).toEqual([1003, 1004]);
    router.close();
  });

  it("aborts only its own reader while another live consumer retains the slot", async () => {
    const { router, provider, commands, sessions } = setup();
    const consumer = await provider.live!();
    const controller = new AbortController();
    const readable = await provider.openReadable!({ signal: controller.signal });
    controller.abort();
    await tick();
    expect(readable.destroyed).toBe(true);
    expect(commands).toEqual([1003]);
    expect(sessions()).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    consumer.stop();
    expect(commands).toEqual([1003, 1004]);
    router.close();
  });

  it("detaches the acquired consumer when readable construction throws", async () => {
    const { router, provider, commands } = setup();
    // Deliberately bypass the public options type to exercise a malformed runtime caller.
    const invalidOptions = { highWaterMark: -1 } as unknown as Parameters<NonNullable<typeof provider.openReadable>>[0];
    await expect(provider.openReadable!(invalidOptions)).rejects.toThrow();
    expect(commands).toEqual([1003, 1004]);
    router.close();
  });
});
