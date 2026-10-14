import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PushLifecycleRecorder } from "../lifecycle-diagnostics.js";
import { MessageTag } from "../message-tags.js";

const sockets: Array<EventEmitter & { destroy: () => void; write: ReturnType<typeof vi.fn> }> = [];
vi.mock("node:tls", () => ({
  default: {
    connect: vi.fn(() => {
      const socket = Object.assign(new EventEmitter(), {
        setKeepAlive() {},
        write: vi.fn(),
        destroy(this: EventEmitter) {
          this.emit("close", false);
        },
      });
      sockets.push(socket);
      return socket;
    }),
  },
}));
const { PushClient } = await import("../push-client.js");

function setup(recorder = new PushLifecycleRecorder()) {
  const client = new PushClient({ androidId: "1", securityToken: "2" } as never, undefined, recorder);
  client.on("error", () => {});
  client.connect();
  const message = (tag: MessageTag, object = {}) => (client as any).parser.emit("message", { tag, object });
  return { client, recorder, message, socket: sockets.at(-1)! };
}

describe("push lifecycle evidence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("records reset, close and the unchanged five-second retry, then a successful new attempt", () => {
    const { recorder, socket, message } = setup();
    socket.emit("secureConnect");
    message(MessageTag.LoginResponse);
    socket.emit("error", Object.assign(new Error("private-marker"), { code: "ECONNRESET" }));
    socket.emit("close", true);
    const rows = recorder.diagnostics().recent;
    expect(rows.map((r) => r.event)).toEqual([
      "connecting",
      "tls_connected",
      "login_accepted",
      "socket_error",
      "socket_closed",
      "reconnect_scheduled",
    ]);
    expect(rows[3]).toMatchObject({ errorCode: "ECONNRESET", loggedIn: true, attempt: 1 });
    expect(rows[4]).toMatchObject({ hadError: true, closing: false });
    expect(rows[5].retryDelayMs).toBe(5000);
    vi.advanceTimersByTime(4999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1].emit("secureConnect");
    message(MessageTag.LoginResponse);
    expect(recorder.diagnostics().recent.at(-1)).toMatchObject({ event: "login_accepted", attempt: 2 });
    expect(JSON.stringify(recorder.diagnostics())).not.toContain("private-marker");
  });

  it("separates a protocol Close from a socket close with no known cause", () => {
    const a = setup();
    a.message(MessageTag.Close);
    expect(a.recorder.diagnostics().recent.map((r) => r.event)).toEqual([
      "connecting",
      "server_close",
      "socket_closed",
      "reconnect_scheduled",
    ]);
    const b = setup();
    b.socket.emit("close", false);
    expect(b.recorder.diagnostics().recent.map((r) => r.event)).toEqual([
      "connecting",
      "socket_closed",
      "reconnect_scheduled",
    ]);
  });

  it("retains login rejection without its raw body and preserves the second retry delay", () => {
    const a = setup();
    a.message(MessageTag.LoginResponse, { error: { message: "private-marker" } });
    vi.advanceTimersByTime(5000);
    a.message(MessageTag.LoginResponse, { error: { message: "private-marker" } });
    expect(a.recorder.diagnostics().recent.at(-1)).toMatchObject({ event: "reconnect_scheduled", retryDelayMs: 10000 });
    expect(JSON.stringify(a.recorder.diagnostics())).not.toContain("private-marker");
  });

  it("marks requested shutdown and cancels a pending reconnect without changing transport behavior", () => {
    const a = setup();
    a.socket.emit("close", false);
    a.client.close();
    const rows = a.recorder.diagnostics().recent;
    expect(rows.at(-2)).toMatchObject({ event: "close_requested", closing: true });
    expect(rows.at(-1)).toMatchObject({ event: "socket_closed", closing: true });
    vi.advanceTimersByTime(600000);
    expect(sockets).toHaveLength(1);
  });

  it("attributes late socket callbacks to their original attempt", () => {
    const a = setup();
    a.client.connect();
    a.socket.emit("error", { code: "private-marker" });
    expect(a.recorder.diagnostics().recent.at(-1)).toMatchObject({
      event: "socket_error",
      attempt: 1,
      staleSocket: true,
      errorCode: "other",
    });
  });

  it("bounds retained history across successive clients and returns detached snapshots", () => {
    const recorder = new PushLifecycleRecorder();
    for (let i = 0; i < 20; i++) {
      const a = setup(recorder);
      a.client.close();
    }
    const data = recorder.diagnostics();
    expect(data.attempts).toBe(20);
    expect(data.total).toBe(60);
    expect(data.recent).toHaveLength(32);
    expect(data.evicted).toBe(28);
    data.recent[0].attempt = 999;
    data.recent.pop();
    expect(recorder.diagnostics().recent).toHaveLength(32);
    expect(recorder.diagnostics().recent[0].attempt).not.toBe(999);
  });
});
