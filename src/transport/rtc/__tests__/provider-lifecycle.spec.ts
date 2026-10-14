import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter } from "../command-router.js";
import type { RtcSession } from "../session.js";
import { PORTAL_HEADER_LENGTH, SegmentCounter } from "../portal-packet.js";

const decoder = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: decoder.spawn, spawnSync: vi.fn() }));
vi.mock("../../p2p/readable-egress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../p2p/readable-egress.js")>();
  return {
    ...actual,
    openReadableFromConsumer: (...args: Parameters<typeof actual.openReadableFromConsumer>) => {
      const readable = actual.openReadableFromConsumer(...args);
      readable.on("error", () => {});
      return readable;
    },
  };
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(manual = false) {
  const commands: number[] = [];
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
      commands.push((JSON.parse(packet.subarray(PORTAL_HEADER_LENGTH).toString()) as { cmd: number }).cmd);
      return true;
    },
  });
  const devices = [
    { sn: "station", model: "T9000" },
    { sn: "camera", stationSn: "station", raw: { device_channel: 1 } },
    { sn: "other", stationSn: "station", raw: { device_channel: 2 } },
  ] as EufyDevice[];
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "", userId: "account" }),
    shard: () => "us-pr",
    accountName: () => "member",
    findDevice: (sn) => devices.find((d) => d.sn === sn),
    createSession: () => session as unknown as RtcSession,
  });
  return { router, session, commands, provider: router.mediaProviderFor("camera") };
}
afterEach(() => decoder.spawn.mockReset());
describe("RTC provider request lifetime", () => {
  it.each(["live", "snapshotLive"] as const)(
    "%s rejects an already aborted request without starting a session",
    async (method) => {
      const f = setup();
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      decoder.spawn.mockImplementation(() => {
        throw new Error("unexpected decoder");
      });
      try {
        await expect(f.provider[method]!({ signal: controller.signal })).rejects.toThrow("cancelled");
        expect(f.session.connect).not.toHaveBeenCalled();
        expect(decoder.spawn).not.toHaveBeenCalled();
      } finally {
        f.router.close();
      }
    },
  );
  it("direct live cancellation during connection settles and cannot send a late start", async () => {
    const f = setup(true);
    const controller = new AbortController();
    const opening = f.provider.live!({ signal: controller.signal });
    let settled = false;
    const observed = opening.then(
      (c) => {
        settled = true;
        c.stop();
      },
      () => {
        settled = true;
      },
    );
    controller.abort(new Error("cancelled"));
    await tick();
    try {
      expect(settled).toBe(true);
      expect(f.commands).toEqual([]);
    } finally {
      f.session.ready();
      await observed;
      f.router.close();
    }
    expect(f.commands).toEqual([]);
  });
  it("aborting a direct live consumer preserves an independent readable", async () => {
    const f = setup();
    const controller = new AbortController();
    const c = await f.provider.live!({ signal: controller.signal });
    const stopped = vi.fn();
    c.on("stop", stopped);
    const readable = await f.provider.openReadable!();
    try {
      controller.abort();
      await tick();
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(readable.destroyed).toBe(false);
      expect(f.commands).toEqual([1003]);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      readable.destroy();
      c.stop();
      f.router.close();
    }
    expect(f.commands).toEqual([1003, 1004]);
  });
  it("router close aborts a pending slot immediately and releases any late lease", async () => {
    const f = setup();
    let resolve!: (lease: Awaited<ReturnType<RtcCommandRouter["sessionFor"]>>) => void;
    vi.spyOn(f.router, "sessionFor").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const opening = f.provider.openReadable!();
    let settled = false;
    const release = vi.fn();
    const observed = opening.then(
      (r) => {
        settled = true;
        r.destroy();
      },
      () => {
        settled = true;
      },
    );
    f.router.close();
    await tick();
    try {
      expect(settled).toBe(true);
      expect(f.commands).toEqual([]);
    } finally {
      resolve({ session: f.session as unknown as RtcSession, seg: new SegmentCounter(), accountId: "member", release });
      await observed;
      await tick();
    }
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.commands).toEqual([]);
  });
  it("router close stops every reader even if a session emits no close event", async () => {
    const f = setup();
    f.session.close.mockImplementation(() => {
      f.session.isConnected = false;
    });
    const first = await f.provider.openReadable!();
    const second = await f.provider.openReadable!();
    first.resume();
    second.resume();
    f.router.close();
    await tick();
    expect(first.readableEnded || first.destroyed).toBe(true);
    expect(second.readableEnded || second.destroyed).toBe(true);
    expect(f.session.listenerCount("mediaData")).toBe(0);
    expect(f.session.listenerCount("commandData")).toBe(0);
    first.destroy();
    second.destroy();
  });
  it("snapshot abort kills its decoder, releases its readable and preserves a sibling live", async () => {
    const f = setup();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    decoder.spawn.mockReturnValue(child);
    const sibling = await f.provider.live!();
    const controller = new AbortController();
    const snapshot = f.provider.snapshotLive({ signal: controller.signal });
    let settled = false;
    const observed = snapshot.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await tick();
    controller.abort(new Error("cancelled"));
    await tick();
    try {
      expect(settled).toBe(true);
      expect(child.kill).toHaveBeenCalled();
      expect(f.commands).toEqual([1003]);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      child.emit("close");
      await observed;
      sibling.stop();
      f.router.close();
    }
    expect(f.commands).toEqual([1003, 1004]);
  });
  it("decoder spawn failure releases the acquired slot", async () => {
    const f = setup();
    decoder.spawn.mockImplementation(() => {
      throw new Error("synthetic spawn failure");
    });
    try {
      await expect(f.provider.snapshotLive()).rejects.toThrow("synthetic spawn failure");
      expect(f.commands).toEqual([1003, 1004]);
    } finally {
      f.router.close();
    }
  });
});
