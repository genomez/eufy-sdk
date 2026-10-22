import type dgram from "node:dgram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { RequestMessageType } from "../codec.js";

function fakeSocket() {
  return {
    send: vi.fn((_packet: Buffer, _port: number, _host: string, _done: (error: Error | null) => void) => {}),
    close: vi.fn((done: () => void) => done()),
  };
}

function sessionWith(socket?: ReturnType<typeof fakeSocket>, peer = true) {
  const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX" });
  Object.assign(session, {
    socket,
    connected: true,
    ...(peer ? { connectAddress: { host: "synthetic-peer.invalid", port: 1234 } } : {}),
    level2Key: Buffer.alloc(32, 1),
  });
  return session;
}

function endCallback(socket: ReturnType<typeof fakeSocket>) {
  return socket.send.mock.calls.at(-1)![3];
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("P2P captured socket close drain", () => {
  it("queues attached STOP then END on the same socket and waits for local END completion", async () => {
    const socket = fakeSocket();
    const session = sessionWith(socket);
    const closed = vi.fn();
    session.on("close", closed);
    session.stopLiveMedia(2, "0".repeat(40));
    const closing = session.close();
    const settled = vi.fn();
    void closing.then(settled);
    const packets = socket.send.mock.calls.map(([packet]) => packet);
    expect(packets).toHaveLength(2);
    expect(packets[0]!.subarray(0, 2)).toEqual(RequestMessageType.DATA);
    expect(packets[0]!.readUInt16LE(12)).toBe(1350);
    expect(packets[0]![20]).toBe(2);
    expect(packets[1]!.subarray(0, 2)).toEqual(RequestMessageType.END);
    await Promise.resolve();
    expect(socket.close).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    endCallback(socket)(null);
    await closing;
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes when the END callback reports an error", async () => {
    const socket = fakeSocket();
    const closing = sessionWith(socket).close();
    endCallback(socket)(new Error("synthetic send failure"));
    await closing;
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes when sending END throws synchronously", async () => {
    const socket = fakeSocket();
    socket.send.mockImplementation(() => {
      throw new Error("synthetic send throw");
    });
    const session = sessionWith(socket);
    const closed = vi.fn();
    session.on("close", closed);
    await session.close();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes after 250 ms without a callback and ignores late repeated callbacks", async () => {
    const socket = fakeSocket();
    const session = sessionWith(socket);
    const closed = vi.fn();
    session.on("close", closed);
    const closing = session.close();
    await vi.advanceTimersByTimeAsync(249);
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    endCallback(socket)(null);
    endCallback(socket)(new Error("synthetic late error"));
    await session.close();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares completion with concurrent callers through socket disposal", async () => {
    const socket = fakeSocket();
    let disposed!: () => void;
    socket.close.mockImplementation((done) => {
      disposed = done;
    });
    const session = sessionWith(socket);
    const first = session.close();
    const second = session.close();
    expect(second).toBe(first);
    const settled = vi.fn();
    void second.then(settled);
    endCallback(socket)(null);
    await Promise.resolve();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    disposed();
    await Promise.all([first, second]);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(session.close()).toBe(first);
  });

  it("closes without sending when no peer was established", async () => {
    const socket = fakeSocket();
    await sessionWith(socket, false).close();
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("announces close once without a socket even when a peer address remains", async () => {
    const session = sessionWith();
    const closed = vi.fn();
    session.on("close", closed);
    await session.close();
    await session.close();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("announces close even when socket disposal throws", async () => {
    const socket = fakeSocket();
    socket.close.mockImplementation(() => {
      throw new Error("synthetic already closed");
    });
    const session = sessionWith(socket, false);
    const closed = vi.fn();
    session.on("close", closed);
    await session.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("lets a close observer reenter close without another send or disposal", async () => {
    const socket = fakeSocket();
    const session = sessionWith(socket);
    let reentered: Promise<void> | undefined;
    const observer = vi.fn(() => {
      reentered = session.close();
    });
    session.on("close", observer);
    const closing = session.close();
    endCallback(socket)(null);
    await closing;
    expect(reentered).toBe(closing);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("preserves a replacement socket installed while END is draining", async () => {
    const socket = fakeSocket();
    const replacement = fakeSocket();
    const session = sessionWith(socket);
    const closing = session.close();
    Object.assign(session, { socket: replacement });
    endCallback(socket)(null);
    await closing;
    expect((session as unknown as { socket: dgram.Socket }).socket).toBe(replacement);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(replacement.send).not.toHaveBeenCalled();
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("preserves socket ownership installed by a close observer", async () => {
    const socket = fakeSocket();
    const replacement = fakeSocket();
    const session = sessionWith(socket);
    session.on("close", () => {
      Object.assign(session, { socket: replacement });
    });
    const closing = session.close();
    endCallback(socket)(null);
    await closing;
    expect((session as unknown as { socket: dgram.Socket }).socket).toBe(replacement);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("gives a replacement lifecycle its own close completion during close-event reentrancy", async () => {
    const socket = fakeSocket();
    const replacement = fakeSocket();
    const session = sessionWith(socket);
    let replacementClose: Promise<void> | undefined;
    session.once("close", () => {
      Object.assign(session, { socket: replacement, closed: false, connected: true });
      replacementClose = session.close();
    });
    const originalClose = session.close();
    endCallback(socket)(null);
    await originalClose;
    expect(replacementClose).toBeDefined();
    expect(replacementClose).not.toBe(originalClose);
    expect(session.close()).toBe(replacementClose);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).not.toHaveBeenCalled();
    endCallback(replacement)(null);
    await replacementClose;
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invalidates generation, key, retained packets and timers before END completes", async () => {
    const socket = fakeSocket();
    const session = sessionWith(socket);
    const tick = vi.fn();
    const timerFields = [
      "lookupTimer",
      "heartbeatTimer",
      "connectTimer",
      "audioRetransmitTimer",
      "liveStartRetransmitTimer",
    ];
    for (const field of timerFields) Object.assign(session, { [field]: setInterval(tick, 10) });
    const state = session as unknown as {
      connectionGeneration: number;
      level2Seq: number;
      socket?: dgram.Socket;
      unackedAudio: Map<number, unknown>;
      unackedLiveStarts: Map<number, unknown>;
      pendingByDataType: Map<number, unknown>;
      lastSeqByType: Map<number, number>;
    };
    state.level2Seq = 7;
    state.unackedAudio.set(1, {});
    state.unackedLiveStarts.set(1, {});
    state.pendingByDataType.set(1, {});
    state.lastSeqByType.set(1, 4);
    const generation = state.connectionGeneration;
    const closing = session.close();
    expect(session.isConnected).toBe(false);
    expect(session.hasLevel2Key).toBe(false);
    expect(state.connectionGeneration).toBe(generation + 1);
    expect(state.level2Seq).toBe(0);
    expect(state.socket).toBeUndefined();
    for (const retained of [
      state.unackedAudio,
      state.unackedLiveStarts,
      state.pendingByDataType,
      state.lastSeqByType,
    ]) {
      expect(retained.size).toBe(0);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(tick).not.toHaveBeenCalled();
    endCallback(socket)(null);
    await closing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles pending key waiters before the END drain completes", async () => {
    const socket = fakeSocket();
    const session = sessionWith(socket);
    Object.assign(session, { level2Key: undefined, level2Pending: true });
    const waiting = session.awaitLevel2Key(1000);
    const closing = session.close();
    await expect(waiting).resolves.toBe(false);
    expect(socket.close).not.toHaveBeenCalled();
    endCallback(socket)(null);
    await closing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles an immediate send callback without retaining the drain timer", async () => {
    const socket = fakeSocket();
    socket.send.mockImplementation((_packet, _port, _host, done) => done(null));
    await sessionWith(socket).close();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
