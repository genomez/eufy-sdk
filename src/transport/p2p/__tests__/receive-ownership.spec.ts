import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameMessage, P2PDataTypeHeader, RequestMessageType, ResponseMessageType } from "../codec.js";
import { P2PSession } from "../p2p-session.js";

const { createSocket } = vi.hoisted(() => ({ createSocket: vi.fn() }));
vi.mock("node:dgram", () => ({ default: { createSocket } }));

const peer = { address: "synthetic-peer.invalid", port: 1234 };

function fakeSocket() {
  return Object.assign(new EventEmitter(), {
    bind: vi.fn((done: () => void) => done()),
    setBroadcast: vi.fn(),
    address: vi.fn(() => ({ port: 2345 })),
    send: vi.fn((_packet: Buffer, _port: number, _host: string, _done: (error: Error | null) => void) => {}),
    close: vi.fn((done: () => void) => done()),
  });
}

function sessionWith(socket: ReturnType<typeof fakeSocket>) {
  createSocket.mockReturnValueOnce(socket);
  return new P2PSession({ stationSn: "synthetic-station", p2pDid: "XXXXXXX-000000-XXXXX", noBroadcast: true });
}

function completeEnd(socket: ReturnType<typeof fakeSocket>) {
  const end = socket.send.mock.calls.find(([packet]) => packet.subarray(0, 2).equals(RequestMessageType.END));
  expect(end).toBeDefined();
  end![3](null);
}

function dataPacket(sequence: number) {
  const header = Buffer.alloc(4);
  P2PDataTypeHeader.VIDEO.copy(header);
  header.writeUInt16BE(sequence, 2);
  return frameMessage(ResponseMessageType.DATA, header);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(
    P2PSession as unknown as { detectLocalIp(): Promise<string | undefined> },
    "detectLocalIp",
  ).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("P2P socket receive ownership", () => {
  it.each([
    ["CAM_ID", ResponseMessageType.CAM_ID],
    ["TURN_SERVER_CAM_ID", ResponseMessageType.TURN_SERVER_CAM_ID],
  ] as const)("ignores a delayed handshake during END drain (%s)", async (_name, handshake) => {
    const socket = fakeSocket();
    const session = sessionWith(socket);
    await session.connect();
    socket.emit("message", frameMessage(ResponseMessageType.TURN_SERVER_CAM_ID), peer);
    expect(session.isConnected).toBe(true);
    const connected = vi.fn();
    session.on("connect", connected);
    const closing = session.close();
    const sends = socket.send.mock.calls.length;
    socket.emit("message", frameMessage(handshake), peer);
    expect(session.isConnected).toBe(false);
    expect(connected).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(sends);
    expect(vi.getTimerCount()).toBe(1);
    completeEnd(socket);
    await closing;
    await session.close();
    expect(session.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps old packets and errors out of a reconnected lifecycle", async () => {
    const socket = fakeSocket();
    const replacement = fakeSocket();
    const session = sessionWith(socket);
    await session.connect();
    socket.emit("message", frameMessage(ResponseMessageType.TURN_SERVER_CAM_ID), peer);
    const closing = session.close();
    createSocket.mockReturnValueOnce(replacement);
    await session.connect();
    const connected = vi.fn();
    const error = vi.fn();
    session.on("connect", connected);
    session.on("error", error);
    const timers = vi.getTimerCount();
    socket.emit("message", frameMessage(ResponseMessageType.CAM_ID), peer);
    socket.emit("message", frameMessage(ResponseMessageType.TURN_SERVER_CAM_ID), peer);
    socket.emit("message", frameMessage(ResponseMessageType.PING), peer);
    socket.emit("error", new Error("synthetic old socket error"));
    expect(session.isConnected).toBe(false);
    expect(connected).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(replacement.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timers);
    replacement.emit("message", frameMessage(ResponseMessageType.TURN_SERVER_CAM_ID), peer);
    expect(connected).toHaveBeenCalledTimes(1);
    replacement.emit("message", dataPacket(7), peer);
    const state = session as unknown as { lastSeqByType: Map<number, number> };
    expect(state.lastSeqByType.get(1)).toBe(7);
    const sends = replacement.send.mock.calls.length;
    socket.emit("message", dataPacket(42), peer);
    socket.emit("message", frameMessage(ResponseMessageType.PING), peer);
    expect(state.lastSeqByType.get(1)).toBe(7);
    expect(replacement.send).toHaveBeenCalledTimes(sends);
    completeEnd(socket);
    await closing;
    expect(session.isConnected).toBe(true);
    expect(replacement.close).not.toHaveBeenCalled();
    const replacementClose = session.close();
    completeEnd(replacement);
    await replacementClose;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resume a socket bind after close invalidates it", async () => {
    const socket = fakeSocket();
    let bound!: () => void;
    socket.bind.mockImplementation((done) => {
      bound = done;
    });
    const session = sessionWith(socket);
    const connecting = session.connect();
    await session.close();
    bound();
    await connecting;
    expect(socket.address).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(session.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not apply an old address probe to a reconnected lifecycle", async () => {
    let resolveProbe!: (host: string) => void;
    vi.mocked(
      (P2PSession as unknown as { detectLocalIp(): Promise<string | undefined> }).detectLocalIp,
    ).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );
    const socket = fakeSocket();
    const session = sessionWith(socket);
    await session.connect();
    await session.close();
    createSocket.mockReturnValueOnce(fakeSocket());
    await session.connect();
    resolveProbe("synthetic-old-route.invalid");
    await Promise.resolve();
    expect((session as unknown as { selfAddress?: unknown }).selfAddress).toBeUndefined();
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
