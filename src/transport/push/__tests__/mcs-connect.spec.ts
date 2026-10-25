import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mcsRoot } from "../proto.js";
import { MessageTag } from "../message-tags.js";
import { PushLifecycleRecorder } from "../lifecycle-diagnostics.js";

/**
 * The MCS dial's TLS shape — no real socket: `node:tls` is mocked so the options can be read back.
 *
 * Worth pinning because the endpoint answers a connection carrying no SNI with a self-signed
 * certificate named `invalid2.invalid`, and Node never derives SNI from `host`. Verification on plus
 * SNI absent therefore means push cannot connect at all, and a `rejectUnauthorized: false` creeping back
 * in is what this transport was fixed for — so the options are asserted as an exact shape.
 */
const connectArgs: unknown[][] = [];
const sockets: Array<
  EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn<() => void>> }
> = [];

vi.mock("node:tls", () => ({
  default: {
    connect: vi.fn((...args: unknown[]) => {
      connectArgs.push(args);
      const socket = Object.assign(new EventEmitter(), {
        setKeepAlive() {},
        write: vi.fn(),
        destroy: vi.fn(function (this: EventEmitter) {
          this.emit("close", false);
        }),
      });
      sockets.push(socket);
      return socket;
    }),
  },
}));

const { PushClient } = await import("../push-client.js");

/** Send real encoded frames through a mocked TLS socket, including the initial stream version. */
function stream(socket: (typeof sockets)[number]) {
  let first = true;
  return (tag: MessageTag, object: Record<string, unknown> = {}) => {
    const type = mcsRoot().lookupType(`mcs_proto.${MessageTag[tag]}`);
    const frame = Buffer.concat([Buffer.from(first ? [41, tag] : [tag]), type.encodeDelimited(object).finish()]);
    first = false;
    socket.emit("data", frame);
  };
}

function login(client: InstanceType<typeof PushClient>) {
  client.connect();
  const socket = sockets.at(-1)!;
  socket.emit("secureConnect");
  const request = mcsRoot().lookupType("mcs_proto.LoginRequest");
  const sent = request.toObject(request.decodeDelimited(socket.write.mock.calls[0][0].subarray(2)), {
    arrays: true,
  });
  return { socket, sent, receive: stream(socket) };
}

describe("the MCS connection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectArgs.length = 0;
    sockets.length = 0;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("names the host in SNI, which Node does not do on its own, and overrides nothing else", () => {
    new PushClient({ androidId: "1", securityToken: "2" } as never).connect();

    const [port, host, opts] = connectArgs[0] as [number, string, Record<string, unknown>];
    expect(port).toBe(5228);
    expect(opts).toEqual({ servername: host });
  });

  it("drops only the IDs reported in the accepted request, retaining pushes received during login", () => {
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never);
    client.setPersistentIds(["seen-a", "seen-b"]);
    const connection = login(client);
    expect(connection.sent.receivedPersistentId).toEqual(["seen-a", "seen-b"]);
    connection.receive(MessageTag.DataMessageStanza, { from: "synthetic", category: "synthetic", persistentId: "new" });
    connection.receive(MessageTag.LoginResponse, { id: "synthetic" });
    expect(client.getPersistentIds()).toEqual(["new"]);
    client.close();
  });

  it("retains all IDs on rejection and reports them again on the scheduled retry", () => {
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never);
    const error = vi.fn();
    client.on("error", error);
    client.setPersistentIds(["seen"]);
    const connection = login(client);
    connection.receive(MessageTag.DataMessageStanza, { from: "synthetic", category: "synthetic", persistentId: "new" });
    connection.receive(MessageTag.LoginResponse, { id: "synthetic", error: { code: 401, message: "wrong_secret" } });
    expect(client.getPersistentIds()).toEqual(["seen", "new"]);
    expect(error).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    const retry = sockets.at(-1)!;
    expect(sockets).toHaveLength(2);
    retry.emit("secureConnect");
    const request = mcsRoot().lookupType("mcs_proto.LoginRequest");
    const sent = request.toObject(request.decodeDelimited(retry.write.mock.calls[0][0].subarray(2)));
    expect(sent.receivedPersistentId).toEqual(["seen", "new"]);
    stream(retry)(MessageTag.LoginResponse, { id: "synthetic" });
    expect(client.getPersistentIds()).toEqual([]);
    client.close();
  });

  it("recomputes and resets the acknowledged count across reconnects, including empty requests", () => {
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never);
    client.setPersistentIds(["seen-a", "seen-b", "seen-c"]);
    const first = login(client);
    first.receive(MessageTag.LoginResponse, { id: "synthetic" });
    expect(client.getPersistentIds()).toEqual([]);
    first.receive(MessageTag.DataMessageStanza, { from: "synthetic", category: "synthetic", persistentId: "later" });
    first.socket.destroy();
    vi.advanceTimersByTime(5000);
    const second = sockets.at(-1)!;
    second.emit("secureConnect");
    const receive = stream(second);
    receive(MessageTag.DataMessageStanza, { from: "synthetic", category: "synthetic", persistentId: "new" });
    receive(MessageTag.LoginResponse, { id: "synthetic" });
    expect(client.getPersistentIds()).toEqual(["new"]);
    receive(MessageTag.LoginResponse, { id: "synthetic" });
    expect(client.getPersistentIds()).toEqual(["new"]);
    second.destroy();
    vi.advanceTimersByTime(5000);
    const third = sockets.at(-1)!;
    third.emit("secureConnect");
    stream(third)(MessageTag.LoginResponse, { id: "synthetic" });
    expect(client.getPersistentIds()).toEqual([]);
    third.destroy();
    vi.advanceTimersByTime(5000);
    const fourth = sockets.at(-1)!;
    fourth.emit("secureConnect");
    const final = stream(fourth);
    final(MessageTag.DataMessageStanza, { from: "synthetic", category: "synthetic", persistentId: "after-empty" });
    final(MessageTag.LoginResponse, { id: "synthetic" });
    expect(client.getPersistentIds()).toEqual(["after-empty"]);
    client.close();
  });

  it("accepts a login reporting zero IDs", () => {
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never);
    const connection = login(client);
    expect(connection.sent.receivedPersistentId).toEqual([]);
    connection.receive(MessageTag.LoginResponse, { id: "synthetic" });
    expect(client.getPersistentIds()).toEqual([]);
    client.close();
  });

  it("contains a malformed protobuf, retains unacknowledged IDs, and recovers on the normal retry", () => {
    const recorder = new PushLifecycleRecorder();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never, logger, recorder);
    const connected = vi.fn();
    const received = vi.fn();
    const error = vi.fn();
    client.on("connect", connected).on("message", received).on("error", error);
    client.setPersistentIds(["seen-marker"]);
    const first = login(client);
    const goodFrame = Buffer.concat([
      Buffer.from([41, MessageTag.DataMessageStanza]),
      mcsRoot()
        .lookupType("mcs_proto.DataMessageStanza")
        .encodeDelimited({
          from: "synthetic",
          category: "synthetic",
          persistentId: "pending-marker",
        })
        .finish(),
    ]);
    const malformed = Buffer.from([MessageTag.LoginResponse, 6, 0x0a, 0x80, 0x80, 0x80, 0x80, 0x08]);
    const trailingLogin = Buffer.from([MessageTag.LoginResponse, 0]);
    expect(() => first.socket.emit("data", Buffer.concat([goodFrame, malformed, trailingLogin]))).not.toThrow();
    expect(first.socket.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(connected).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(client.getPersistentIds()).toEqual(["seen-marker", "pending-marker"]);
    expect(recorder.diagnostics().recent.slice(-3)).toMatchObject([
      { event: "frame_parse_failed", attempt: 1, errorCode: null },
      { event: "socket_closed", attempt: 1 },
      { event: "reconnect_scheduled", attempt: 1, retryDelayMs: 5000 },
    ]);
    expect(() => first.socket.emit("data", malformed)).not.toThrow();
    expect(first.socket.destroy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    const retry = sockets.at(-1)!;
    retry.emit("secureConnect");
    const request = mcsRoot().lookupType("mcs_proto.LoginRequest");
    expect(request.toObject(request.decodeDelimited(retry.write.mock.calls[0][0].subarray(2)))).toMatchObject({
      receivedPersistentId: ["seen-marker", "pending-marker"],
    });
    const receive = stream(retry);
    receive(MessageTag.LoginResponse, { id: "synthetic" });
    expect(connected).toHaveBeenCalledTimes(1);
    expect(client.getPersistentIds()).toEqual([]);
    receive(MessageTag.DataMessageStanza, { from: "synthetic", category: "synthetic", persistentId: "after-retry" });
    expect(received).toHaveBeenCalledTimes(2);
    expect(client.getPersistentIds()).toEqual(["after-retry"]);
    expect(recorder.diagnostics().recent.filter((row) => row.event === "frame_parse_failed")).toHaveLength(1);
    const evidence = JSON.stringify({
      diagnostics: recorder.diagnostics(),
      logs: Object.values(logger).map((fn) => fn.mock.calls),
    });
    for (const marker of ["seen-marker", "pending-marker", "invalid length encoding", "RangeError"]) {
      expect(evidence).not.toContain(marker);
    }
    client.close();
  });

  it.each([
    ["version", [37, MessageTag.LoginResponse, 0]],
    ["outer varint", [41, MessageTag.LoginResponse, ...Array(10).fill(0x80)]],
    ["negative length", [41, MessageTag.LoginResponse, 0xff, 0xff, 0xff, 0xff, 0x0f]],
    ["truncated protobuf", [41, MessageTag.LoginResponse, 3, 0x0a, 0x04, 0x61]],
  ])("contains an invalid %s frame", (_name, bytes) => {
    const recorder = new PushLifecycleRecorder();
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never, undefined, recorder);
    client.setPersistentIds(["pending"]);
    const { socket } = login(client);
    expect(() => socket.emit("data", Buffer.from(bytes as number[]))).not.toThrow();
    expect(socket.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(client.getPersistentIds()).toEqual(["pending"]);
    expect(
      recorder
        .diagnostics()
        .recent.slice(-3)
        .map((row) => row.event),
    ).toEqual(["frame_parse_failed", "socket_closed", "reconnect_scheduled"]);
    client.close();
  });

  it("retains post-login IDs and ignores data between containment and an asynchronous socket close", () => {
    const recorder = new PushLifecycleRecorder();
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never, undefined, recorder);
    const first = login(client);
    first.receive(MessageTag.LoginResponse, { id: "synthetic" });
    first.receive(MessageTag.DataMessageStanza, { from: "synthetic", category: "synthetic", persistentId: "pending" });
    first.socket.destroy.mockImplementationOnce(() => {});
    const malformed = Buffer.from([MessageTag.LoginResponse, 3, 0x0a, 0x04, 0x61]);
    first.socket.emit("data", malformed);
    first.socket.emit("data", malformed);
    expect(first.socket.destroy).toHaveBeenCalledTimes(1);
    expect(client.getPersistentIds()).toEqual(["pending"]);
    expect(recorder.diagnostics().recent.at(-1)).toMatchObject({ event: "frame_parse_failed", loggedIn: true });
    first.socket.emit("close", false);
    expect(recorder.diagnostics().recent.at(-1)).toMatchObject({ event: "reconnect_scheduled", retryDelayMs: 5000 });
    client.close();
  });

  it.each(["connect", "message", "push"])("propagates a throwing %s listener unchanged", (event) => {
    const recorder = new PushLifecycleRecorder();
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never, undefined, recorder);
    const failure = event === "connect" ? new RangeError("synthetic-listener") : { marker: "synthetic-listener" };
    client.on(event, () => {
      throw failure;
    });
    const connection = login(client);
    let thrown: unknown;
    try {
      connection.receive(event === "connect" ? MessageTag.LoginResponse : MessageTag.DataMessageStanza, {
        id: "synthetic",
        from: "synthetic",
        category: "synthetic",
        persistentId: "pending",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(connection.socket.destroy).not.toHaveBeenCalled();
    expect(recorder.diagnostics().recent.some((row) => row.event === "frame_parse_failed")).toBe(false);
    expect(recorder.diagnostics().recent.some((row) => row.event === "reconnect_scheduled")).toBe(false);
    client.close();
  });

  it("ignores retired-socket data rather than feeding it into the active parser", () => {
    const recorder = new PushLifecycleRecorder();
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never, undefined, recorder);
    const first = login(client);
    const second = login(client);
    const before = recorder.diagnostics();
    expect(() => first.socket.emit("data", Buffer.from([37, MessageTag.LoginResponse, 0]))).not.toThrow();
    expect(first.socket.destroy).not.toHaveBeenCalled();
    expect(second.socket.destroy).not.toHaveBeenCalled();
    expect(recorder.diagnostics()).toEqual(before);
    const connected = vi.fn();
    client.on("connect", connected);
    second.receive(MessageTag.LoginResponse, { id: "synthetic" });
    expect(connected).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("keeps lifecycle history finite across successful acknowledged-ID reconnects", () => {
    const recorder = new PushLifecycleRecorder();
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never, undefined, recorder);
    client.setPersistentIds(["private-id-marker"]);
    for (let i = 0; i < 20; i++) {
      const connection = login(client);
      connection.receive(MessageTag.LoginResponse, { id: "synthetic" });
      expect(client.getPersistentIds()).toEqual([]);
      connection.receive(MessageTag.DataMessageStanza, {
        from: "synthetic",
        category: "synthetic",
        persistentId: "private-id-marker",
      });
      client.close();
    }
    const diagnostics = recorder.diagnostics();
    expect(diagnostics.attempts).toBe(20);
    expect(diagnostics.total).toBe(100);
    expect(diagnostics.evicted).toBe(68);
    expect(diagnostics.recent).toHaveLength(32);
    expect(JSON.stringify(diagnostics)).not.toContain("private-id-marker");
  });
});
