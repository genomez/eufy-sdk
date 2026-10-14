import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * The MCS dial's TLS shape — no real socket: `node:tls` is mocked so the options can be read back.
 *
 * Worth pinning because the endpoint answers a connection carrying no SNI with a self-signed
 * certificate named `invalid2.invalid`, and Node never derives SNI from `host`. Verification on plus
 * SNI absent therefore means push cannot connect at all, and a `rejectUnauthorized: false` creeping back
 * in is what this transport was fixed for — so the options are asserted as an exact shape.
 */
const connectArgs: unknown[][] = [];

vi.mock("node:tls", () => ({
  default: {
    connect: vi.fn((...args: unknown[]) => {
      connectArgs.push(args);
      const socket = new EventEmitter() as EventEmitter & { setKeepAlive: () => void; write: () => void };
      socket.setKeepAlive = () => {};
      socket.write = () => {};
      return socket;
    }),
  },
}));

const { PushClient } = await import("../push-client.js");

describe("the MCS connection", () => {
  beforeEach(() => {
    connectArgs.length = 0;
  });

  it("names the host in SNI, which Node does not do on its own, and overrides nothing else", () => {
    new PushClient({ androidId: "1", securityToken: "2" } as never).connect();

    const [port, host, opts] = connectArgs[0] as [number, string, Record<string, unknown>];
    expect(port).toBe(5228);
    expect(opts).toEqual({ servername: host });
  });
});
