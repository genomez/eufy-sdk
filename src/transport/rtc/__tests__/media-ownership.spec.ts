import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RtcCommandRouter } from "../command-router.js";
import type { RtcSession } from "../session.js";
import type { EufyDevice } from "../../../core/types.js";
import { PORTAL_HEADER_LENGTH } from "../portal-packet.js";

function setup() {
  const commands: number[] = [];
  const session = Object.assign(new EventEmitter(), {
    isConnected: false,
    connect: async () => {
      session.isConnected = true;
      session.emit("connected");
    },
    close: () => {
      session.isConnected = false;
      session.emit("close");
    },
    sendRaw: () => true,
    sendCommand: (packet: Buffer) => {
      try {
        const body = JSON.parse(packet.subarray(PORTAL_HEADER_LENGTH).toString()) as { cmd: number };
        commands.push(body.cmd);
      } catch {
        return true;
      }
      return true;
    },
  });
  const devices = [
    { sn: "station", model: "T9000" },
    { sn: "camera-a", stationSn: "station", raw: { device_channel: 1 } },
    { sn: "camera-b", stationSn: "station", raw: { device_channel: 5 } },
  ] as EufyDevice[];
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "", userId: "account" }),
    shard: () => "us-pr",
    accountName: () => "member",
    findDevice: (sn) => devices.find((device) => device.sn === sn),
    createSession: () => session as unknown as RtcSession,
  });
  return { router, session, commands };
}

describe("RTC media slot ownership", () => {
  it("does not attach to a released owner after another camera reserves the slot", async () => {
    const { router, commands } = setup();
    const provider = router.mediaProviderFor("camera-a");
    const first = await provider.live!();
    const pending = provider.live!();
    const rejected = expect(pending).rejects.toThrow(/slot was released/);
    first.stop();
    const replacement = await router.mediaProviderFor("camera-b").live!();
    replacement.on("error", vi.fn());
    try {
      await rejected;
      expect(commands.filter((cmd) => cmd === 1003)).toHaveLength(2);
    } finally {
      replacement.stop();
      router.close();
    }
  });

  it("releases a slot after setup fails so another camera can retry", async () => {
    const { router, session } = setup();
    vi.spyOn(session, "connect").mockRejectedValueOnce(new Error("synthetic connect failure"));
    try {
      await expect(router.mediaProviderFor("camera-a").live!()).rejects.toThrow("synthetic connect failure");
      const consumer = await router.mediaProviderFor("camera-b").live!();
      consumer.stop();
    } finally {
      router.close();
    }
  });

  it("cancels an opening slot when the router closes", async () => {
    const { router, session, commands } = setup();
    vi.spyOn(session, "connect").mockImplementation(async () => {});
    const opening = router.mediaProviderFor("camera-a").live!();
    const rejected = expect(opening).rejects.toThrow(/closed/);
    router.close();
    await rejected;
    expect(commands.filter((cmd) => cmd === 1003)).toHaveLength(0);
  });

  it("shares a pending camera start and stops only after its last consumer leaves", async () => {
    const { router, commands } = setup();
    const provider = router.mediaProviderFor("camera-a");
    const consumers = await Promise.all([provider.live!(), provider.live!()]);
    for (const consumer of consumers) consumer.on("error", vi.fn());
    try {
      expect(commands.filter((cmd) => cmd === 1003)).toHaveLength(1);
      consumers[0]!.stop();
      expect(commands.filter((cmd) => cmd === 1004)).toHaveLength(0);
      consumers[1]!.stop();
      expect(commands.filter((cmd) => cmd === 1004)).toHaveLength(1);
    } finally {
      for (const consumer of consumers) consumer.stop();
      router.close();
    }
  });

  it("refuses a second camera on the fixed play slot until the first releases it", async () => {
    const { router } = setup();
    const first = await router.mediaProviderFor("camera-a").live!();
    first.on("error", vi.fn());
    try {
      await expect(router.mediaProviderFor("camera-b").live!()).rejects.toThrow(/already in use/);
      first.stop();
      const second = await router.mediaProviderFor("camera-b").live!();
      second.stop();
    } finally {
      first.stop();
      router.close();
    }
  });
});
