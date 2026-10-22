import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_ID, connectedSession, DEVICE_SN, routerWithSession } from "./session-fixtures.js";

function harness() {
  const session = Object.assign(connectedSession(), { sendSetPayload: vi.fn() });
  return { session, router: routerWithSession(session) };
}

function frame(channel = 1, commandId = 1351, cmd = 6237, payload: unknown = { code: 0 }) {
  return { channel, commandId, json: { cmd, payload } };
}

afterEach(() => vi.useRealTimers());

describe("P2P query reply attribution", () => {
  it("requires the resolved channel, outer notify and inner command before accepting an object", async () => {
    const { session, router } = harness();
    session.sendSetPayload.mockImplementation(() => {
      session.emit("commandResult", { code: 0, channel: 1 });
      session.emit("data", frame(2));
      session.emit("data", frame(1, 1350));
      session.emit("data", frame(1, 1351, 6238));
      for (const payload of [null, undefined, 0, "status"])
        session.emit("data", { ...frame(), json: { cmd: 6237, payload } });
      session.emit("data", frame(1, 1351, 6237, { code: 0, status: "matched" }));
    });
    await expect(router.p2pQuery(DEVICE_SN, 6237)).resolves.toEqual({ code: 0, status: "matched" });
    expect(session.sendSetPayload).toHaveBeenCalledExactlyOnceWith(6237, {}, { accountId: ACCOUNT_ID, channel: 1 });
    expect(session.listenerCount("data")).toBe(0);
  });

  it("preserves an attributed negative payload without interpreting it as command success", async () => {
    const { session, router } = harness();
    const payload = { code: -106 };
    session.sendSetPayload.mockImplementation(() => session.emit("data", frame(1, 1351, 6237, payload)));
    await expect(router.p2pQuery(DEVICE_SN, 6237)).resolves.toBe(payload);
    expect(session.listenerCount("data")).toBe(0);
  });

  it("cleans up promptly when the unchanged request sender throws", async () => {
    vi.useFakeTimers();
    const { session, router } = harness();
    const error = new Error("synthetic send failure");
    let timersDuringSend = 0;
    session.sendSetPayload.mockImplementation(() => {
      timersDuringSend = vi.getTimerCount();
      throw error;
    });
    await expect(router.p2pQuery(DEVICE_SN, 6237)).rejects.toBe(error);
    expect(session.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(timersDuringSend - 1);
  });

  it("times out and removes its listener when only unattributed replies arrive", async () => {
    vi.useFakeTimers();
    const { session, router } = harness();
    let timersDuringSend = 0;
    session.sendSetPayload.mockImplementation(() => {
      timersDuringSend = vi.getTimerCount();
      session.emit("data", frame(2));
    });
    const query = router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 20 });
    const rejected = expect(query).rejects.toThrow("timeout waiting for p2p query");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(session.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(timersDuringSend - 1);
  });

  it("retains object payload compatibility, including arrays", async () => {
    const { session, router } = harness();
    const payload: unknown[] = [];
    session.sendSetPayload.mockImplementation(() => session.emit("data", frame(1, 1351, 6237, payload)));
    await expect(router.p2pQuery(DEVICE_SN, 6237)).resolves.toBe(payload);
  });
});
