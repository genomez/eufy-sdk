import { describe, expect, it, vi } from "vitest";
import type { Command, CommandReceipt } from "../../../core/contracts.js";
import type { P2PRouterDeps } from "../command-router.js";
import { P2P_ENVELOPE } from "../envelope.js";
import { buildDirectBinaryBody } from "../write-commands.js";
import { ACCOUNT_ID, DEVICE_SN, connectedSession, routerWithSession } from "./session-fixtures.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));

interface Packet {
  method: string;
  args: unknown[];
}

function packet(method: string, ...args: unknown[]): Packet {
  return { method, args };
}

function fixture(observeCommand?: P2PRouterDeps["observeCommand"], keyed = true) {
  const packets: Packet[] = [];
  const send = (method: string) =>
    vi.fn((...args: unknown[]) => {
      packets.push(packet(method, ...args));
      return true;
    });
  const session = Object.assign(connectedSession(keyed), {
    sendRawLevel2Bytes: send("binary"),
    sendRawLevel2: send("raw"),
    sendControlLevel2: send("control"),
    sendSetPayload: send("payload"),
    sendStringPayloadCommand: send("string"),
    sendIntStringCommand: send("int"),
  });
  const router = routerWithSession(session, { deps: { observeCommand } });
  return { router, session, packets };
}

function observer() {
  return { sent: vi.fn(), response: vi.fn(), finish: vi.fn<(receipt: CommandReceipt) => void>() };
}

const scalar = packet("int", 1400, 1, 1, ACCOUNT_ID, 1);
const binary = packet("binary", buildDirectBinaryBody(1, ACCOUNT_ID, 1), 1, 1400, 8);
const directCommand: Command = { kind: "set-param", param: 1400, value: 1, form: "direct-binary", channel: 1 };
const intCommand: Command = { kind: "p2p-int-string", cmd: 1400, value: 1, valueSub: 1, channel: 1 };
const json = JSON.stringify({ commandType: 1400, data: { value: 1 } });
const payload = { value: 1 };
const privacy = Buffer.from(
  JSON.stringify({
    account_id: ACCOUNT_ID,
    cmd: P2P_ENVELOPE.PRIVACY_MODE,
    mChannel: 1,
    mValue3: 0,
    payload: { switch: 1 },
  }),
);
const precursor = Buffer.from("ff00000087030000", "hex");
const routes: { name: string; keyed: boolean; cmd: Command; expected: Packet[] }[] = [
  {
    name: "pinned level-1 scalar",
    keyed: true,
    cmd: { kind: "set-param", param: 1400, value: 1, form: "int-string", channel: 1 },
    expected: Array(5).fill(scalar),
  },
  {
    name: "pinned level-2 scalar",
    keyed: true,
    cmd: directCommand,
    expected: Array(5).fill(binary),
  },
  ...[false, true].map((keyed) => ({
    name: `automatic scalar, keyed=${keyed}`,
    keyed,
    cmd: { kind: "set-param", param: 1400, value: 1, form: "auto", channel: 1 } as const,
    expected: Array(5).fill(keyed ? binary : scalar),
  })),
  ...[false, true].map((keyed) => ({
    name: `JSON control, keyed=${keyed}`,
    keyed,
    cmd: { kind: "set-json", param: 1400, data: { value: 1 }, channel: 1 } as const,
    expected: [
      keyed
        ? packet("raw", json, 1, P2P_ENVELOPE.CONTROL_PAYLOAD)
        : packet("string", P2P_ENVELOPE.CONTROL_PAYLOAD, json, 1),
    ],
  })),
  {
    name: "raw JSON",
    keyed: true,
    cmd: { kind: "set-json-raw", cmd: 1400, data: { value: 1 }, channel: 1 },
    expected: Array(5).fill(packet("raw", JSON.stringify({ account_id: ACCOUNT_ID, value: 1 }), 1, 1400)),
  },
  ...[false, true].map((keyed) => ({
    name: `automatic payload, keyed=${keyed}`,
    keyed,
    cmd: { kind: "set-payload", cmd: 1400, payload, channel: 1, mValue3: 7, form: "auto" } as const,
    expected: Array(5).fill(
      keyed
        ? packet("control", 1400, 1, ACCOUNT_ID, payload, 7)
        : packet("payload", 1400, payload, { accountId: ACCOUNT_ID, channel: 1 }),
    ),
  })),
  {
    name: "level-2 payload",
    keyed: true,
    cmd: { kind: "set-payload", cmd: 1400, payload, channel: 1 },
    expected: Array(5).fill(packet("control", 1400, 1, ACCOUNT_ID, payload, 1400)),
  },
  {
    name: "station scalar",
    keyed: true,
    cmd: { kind: "p2p-station-scalar", cmd: 1235, value: 1, channel: 255 },
    expected: Array(5).fill(packet("binary", buildDirectBinaryBody(1, ACCOUNT_ID), 255, 1235, 8)),
  },
  {
    name: "int-plus-string",
    keyed: false,
    cmd: intCommand,
    expected: [scalar],
  },
  {
    name: "privacy burst",
    keyed: true,
    cmd: { kind: "p2p-privacy-burst", enabled: true, channel: 1 },
    expected: [
      packet("binary", precursor, 255, P2P_ENVELOPE.GET_CAMERA_INFO, 8),
      ...Array(2).fill(packet("binary", privacy, 0, P2P_ENVELOPE.SET_PAYLOAD, 8)),
      ...Array(3).fill(packet("binary", privacy, 1, P2P_ENVELOPE.SET_PAYLOAD, 8)),
      packet("binary", precursor, 0, P2P_ENVELOPE.GET_CAMERA_INFO, 8),
    ],
  },
];

describe("passive P2P command observation", () => {
  it.each(routes)("preserves every packet for $name and finalizes once", async (route) => {
    const observation = observer();
    const begin = vi.fn(() => observation);
    const observed = fixture(begin, route.keyed);
    const baseline = fixture(undefined, route.keyed);

    await baseline.router.dispatchCommand(DEVICE_SN, route.cmd);
    await observed.router.dispatchCommand(DEVICE_SN, route.cmd);

    expect(baseline.packets).toEqual(route.expected);
    expect(observed.packets).toEqual(baseline.packets);
    expect(begin).toHaveBeenCalledExactlyOnceWith(DEVICE_SN);
    expect(observation.sent).toHaveBeenCalledTimes(1);
    expect(observation.response).not.toHaveBeenCalled();
    expect(observation.finish).toHaveBeenCalledExactlyOnceWith({
      status: "acknowledged",
      sendAttempted: true,
      effect: "unconfirmed",
    });
    expect(Object.isFrozen(observation.finish.mock.calls[0]![0])).toBe(true);
  });

  it("captures the state after async device resolution and before the first repeated datagram", async () => {
    const acquired = Promise.withResolvers<void>();
    let state = "unknown";
    let admission: string | undefined;
    const observation = observer();
    observation.sent.mockImplementation(() => {
      admission = state;
    });
    const { router, session, packets } = fixture(() => observation);
    const deviceFor = router.deviceFor.bind(router);
    vi.spyOn(router, "deviceFor").mockImplementation(async (sn) => {
      await acquired.promise;
      return deviceFor(sn);
    });
    session.sendRawLevel2Bytes.mockImplementation((...args) => {
      expect(admission).toBe("suspect");
      state = "online";
      packets.push(packet("binary", ...args));
      return true;
    });

    const pending = router.dispatchCommand(DEVICE_SN, directCommand);
    expect(observation.sent).not.toHaveBeenCalled();
    expect(observation.finish).not.toHaveBeenCalled();
    state = "suspect";
    acquired.resolve();
    await pending;

    expect(packets).toEqual(Array(5).fill(binary));
    expect(state).toBe("online");
    expect(admission).toBe("suspect");
    expect(observation.sent).toHaveBeenCalledTimes(1);
    expect(observation.finish).toHaveBeenCalledTimes(1);
  });

  it("waits for both JSON level selection and the final level-2 acquisition before capturing", async () => {
    const selection = Promise.withResolvers<boolean>();
    const acquisition = Promise.withResolvers<boolean>();
    let state = "unknown";
    let admission: string | undefined;
    const observation = observer();
    observation.sent.mockImplementation(() => {
      admission = state;
    });
    const { router, session, packets } = fixture(() => observation);
    session.awaitLevel2Key
      .mockImplementationOnce(() => selection.promise)
      .mockImplementationOnce(() => acquisition.promise);

    const pending = router.dispatchCommand(DEVICE_SN, {
      kind: "set-json",
      param: 1400,
      data: { value: 1 },
      channel: 1,
    });
    await vi.waitFor(() => expect(session.awaitLevel2Key).toHaveBeenCalledTimes(1));
    expect(observation.sent).not.toHaveBeenCalled();
    state = "online";
    selection.resolve(true);
    await vi.waitFor(() => expect(session.awaitLevel2Key).toHaveBeenCalledTimes(2));
    expect(observation.sent).not.toHaveBeenCalled();
    expect(packets).toEqual([]);
    state = "suspect";
    acquisition.resolve(true);
    await pending;

    expect(admission).toBe("suspect");
    expect(observation.sent).toHaveBeenCalledTimes(1);
    expect(observation.finish).toHaveBeenCalledTimes(1);
    expect(packets).toEqual([packet("raw", json, 1, P2P_ENVELOPE.CONTROL_PAYLOAD)]);
  });

  it("keeps concurrent dispatch admissions and final receipts independent", async () => {
    const acquisition = Promise.withResolvers<void>();
    let state = "unknown";
    const admissions: string[] = [];
    const first = observer();
    const second = observer();
    first.sent.mockImplementation(() => admissions.push(`first:${state}`));
    second.sent.mockImplementation(() => admissions.push(`second:${state}`));
    const begin = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { router, packets } = fixture(begin);
    const deviceFor = router.deviceFor.bind(router);
    vi.spyOn(router, "deviceFor").mockImplementationOnce(async (sn) => {
      await acquisition.promise;
      return deviceFor(sn);
    });

    const pending = router.dispatchCommand(DEVICE_SN, directCommand);
    state = "online";
    await router.dispatchCommand(DEVICE_SN, intCommand);
    expect(first.sent).not.toHaveBeenCalled();
    expect(first.finish).not.toHaveBeenCalled();
    state = "suspect";
    acquisition.resolve();
    await pending;

    expect(admissions).toEqual(["second:online", "first:suspect"]);
    expect(packets).toEqual([scalar, ...Array(5).fill(binary)]);
    expect(first.finish).toHaveBeenCalledTimes(1);
    expect(second.finish).toHaveBeenCalledTimes(1);
  });

  it("finalizes resolution failures without claiming a send", async () => {
    const observation = observer();
    const { router, packets } = fixture(() => observation);
    const failure = new Error("session unavailable");
    vi.spyOn(router, "deviceFor").mockRejectedValue(failure);

    await expect(router.dispatchCommand(DEVICE_SN, directCommand)).rejects.toBe(failure);

    expect(packets).toEqual([]);
    expect(observation.sent).not.toHaveBeenCalled();
    expect(observation.response).not.toHaveBeenCalled();
    expect(observation.finish).toHaveBeenCalledExactlyOnceWith({
      status: "not_sent",
      sendAttempted: false,
      effect: "unconfirmed",
    });
  });

  it("preserves all five unsuccessful sends without manufacturing a rejection or timeout", async () => {
    const observation = observer();
    const { router, session } = fixture(() => observation);
    session.sendRawLevel2Bytes.mockReturnValue(false);

    await expect(router.dispatchCommand(DEVICE_SN, directCommand)).rejects.toThrow(/was never sent/);

    expect(session.sendRawLevel2Bytes.mock.calls).toEqual(Array(5).fill(binary.args));
    expect(observation.sent).toHaveBeenCalledTimes(1);
    expect(observation.response).not.toHaveBeenCalled();
    expect(observation.finish).toHaveBeenCalledExactlyOnceWith({
      status: "not_sent",
      sendAttempted: true,
      effect: "unconfirmed",
    });
  });

  it.each(["command rejected -109 DEV_OFFLINE", "ACK timed out -108"])(
    "does not derive a correlated result from exception text: %s",
    async (message) => {
      const observation = observer();
      const { router, session } = fixture(() => observation);
      const failure = new Error(message);
      session.sendIntStringCommand.mockImplementation(() => {
        throw failure;
      });

      await expect(router.dispatchCommand(DEVICE_SN, intCommand)).rejects.toBe(failure);

      expect(session.sendIntStringCommand).toHaveBeenCalledExactlyOnceWith(...scalar.args);
      expect(observation.sent).toHaveBeenCalledTimes(1);
      expect(observation.response).not.toHaveBeenCalled();
      expect(observation.finish).toHaveBeenCalledExactlyOnceWith({
        status: "not_sent",
        sendAttempted: true,
        effect: "unconfirmed",
      });
    },
  );

  it.each(["begin", "sent", "finish"] as const)("keeps a throwing %s observer passive", async (stage) => {
    const observation = observer();
    const fail = () => {
      throw new Error("observer failure");
    };
    if (stage !== "begin") observation[stage].mockImplementation(fail);
    const { router, packets } = fixture(stage === "begin" ? fail : () => observation);

    await router.dispatchCommand(DEVICE_SN, directCommand);

    expect(packets).toEqual(Array(5).fill(binary));
    if (stage !== "begin") expect(observation.finish).toHaveBeenCalledTimes(1);
  });

  it("supports an observer factory that opts out", async () => {
    const begin = vi.fn(() => undefined);
    const { router, packets } = fixture(begin);

    await router.dispatchCommand(DEVICE_SN, directCommand);

    expect(begin).toHaveBeenCalledExactlyOnceWith(DEVICE_SN);
    expect(packets).toEqual(Array(5).fill(binary));
  });
});

it("captures media observation ownership before asynchronous source acquisition", async () => {
  const { router, session } = fixture();
  const state = router as any;
  const observe = vi.fn();
  const factory = vi.fn(() => observe);
  state.deps.observeLiveMedia = factory;
  const resolved = await state.resolveSession(DEVICE_SN, {});
  const pending = Promise.withResolvers<typeof resolved>();
  vi.spyOn(state, "resolveSession").mockReturnValue(pending.promise);
  const work = router.sharedLiveSourceFor(DEVICE_SN);
  expect(factory).toHaveBeenCalledExactlyOnceWith(DEVICE_SN);
  pending.resolve({ ...resolved, session });
  const source = await work;
  (source as any).opts.onSourceMedia();
  expect(observe).toHaveBeenCalledTimes(1);
  source.dispose();
});
