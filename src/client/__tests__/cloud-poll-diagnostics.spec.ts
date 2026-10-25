import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";

const empty = () => ({ params: [], added: [], removed: [], reported: [] });

/** The registry and all disposal boundaries are fake; only the existing timer executes. */
function fixture(pollMs = 100) {
  const eufy = new EufyMega({ email: "test@example.invalid", password: "synthetic", autoRealtime: false, pollMs });
  const client = eufy as any;
  const poll = vi.spyOn(client.registry, "pollChanges").mockResolvedValue(empty());
  vi.spyOn(client.registry, "list").mockReturnValue([]);
  vi.spyOn(client, "closeMqttTransports").mockResolvedValue(undefined);
  vi.spyOn(client.p2p, "closeAll").mockResolvedValue(undefined);
  return { eufy, client, poll, diagnostics: () => eufy.getStateRefreshDiagnostics().cloudPoll };
}

describe("passive cloud poll scheduling evidence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps disabled retry evidence empty while cloud polling runs", async () => {
    const f = fixture();
    f.client.schedulePoll();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.eufy.getStateRefreshDiagnostics()).toMatchObject({
      nextRetryAtMs: null,
      retryAttempt: 0,
      retryReason: null,
      scheduledPaused: false,
      cloudPoll: { enabled: true },
    });
    await f.eufy.disconnect();
  });

  it("reports actual arm/fire/end/rearm and detached reads without extra work or timers", async () => {
    const f = fixture();
    expect(f.diagnostics()).toEqual({
      enabled: false,
      intervalMs: 100,
      scheduledAtMs: null,
      nextDueAtMs: null,
      inFlight: false,
    });
    f.client.schedulePoll();
    const armed = f.diagnostics();
    expect(armed).toEqual({
      enabled: true,
      intervalMs: 100,
      scheduledAtMs: 1_000,
      nextDueAtMs: 1_100,
      inFlight: false,
    });
    armed.nextDueAtMs = 0;
    for (let i = 0; i < 10; i++) expect(f.diagnostics().nextDueAtMs).toBe(1_100);
    expect(f.poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    let finish!: (result: ReturnType<typeof empty>) => void;
    f.poll.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(f.diagnostics()).toEqual({
      enabled: true,
      intervalMs: 100,
      scheduledAtMs: null,
      nextDueAtMs: null,
      inFlight: true,
    });
    expect(vi.getTimerCount()).toBe(0);
    finish(empty());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.diagnostics()).toEqual({
      enabled: true,
      intervalMs: 100,
      scheduledAtMs: 1_100,
      nextDueAtMs: 1_200,
      inFlight: false,
    });
    await f.eufy.disconnect();
    expect(f.diagnostics()).toEqual({
      enabled: false,
      intervalMs: 100,
      scheduledAtMs: null,
      nextDueAtMs: null,
      inFlight: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("covers interval cancellation, rearm and teardown cancellation in the same epoch", async () => {
    const f = fixture();
    f.eufy.setPollInterval(200);
    expect(f.diagnostics().nextDueAtMs).toBe(1_200);
    f.eufy.setPollInterval(0);
    expect(f.diagnostics()).toMatchObject({ enabled: false, intervalMs: 0, nextDueAtMs: null, scheduledAtMs: null });
    expect(vi.getTimerCount()).toBe(0);
    f.eufy.setPollInterval(300);
    expect(f.diagnostics().nextDueAtMs).toBe(1_300);
    await f.client.teardownRealtime();
    expect(f.diagnostics()).toMatchObject({ enabled: false, nextDueAtMs: null, scheduledAtMs: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late old-epoch poll cannot clear or resurrect successor scheduling or in-flight evidence", async () => {
    const f = fixture();
    let finishOld!: (result: ReturnType<typeof empty>) => void;
    let finishNew!: (result: ReturnType<typeof empty>) => void;
    f.poll.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    f.poll.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    );
    f.client.schedulePoll();
    await vi.advanceTimersByTimeAsync(100);
    await f.eufy.disconnect();
    expect(f.diagnostics().inFlight).toBe(false);
    f.client.schedulePoll();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.diagnostics().inFlight).toBe(true);
    finishOld(empty());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.diagnostics()).toMatchObject({ inFlight: true, scheduledAtMs: null, nextDueAtMs: null });
    expect(vi.getTimerCount()).toBe(0);
    finishNew(empty());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.diagnostics()).toMatchObject({ inFlight: false, scheduledAtMs: 1_200, nextDueAtMs: 1_300 });
    await f.eufy.disconnect();
  });

  it("records failed poll completion and preserves the original finally rearm", async () => {
    const f = fixture();
    const report = vi.spyOn(f.client, "reportError").mockImplementation(() => {});
    const error = new Error("synthetic-private-error");
    f.poll.mockRejectedValueOnce(error);
    f.client.schedulePoll();
    await vi.advanceTimersByTimeAsync(100);
    expect(report).toHaveBeenCalledExactlyOnceWith(error, "cloud_poll");
    expect(f.diagnostics()).toMatchObject({ inFlight: false, nextDueAtMs: 1_200 });
    await f.eufy.disconnect();
  });

  it("leaves invalid intervals and invalid due clocks unknown without changing the timer decision", async () => {
    const f = fixture(NaN);
    expect(f.diagnostics()).toMatchObject({ enabled: false, intervalMs: null, nextDueAtMs: null });
    f.client.opts.pollMs = 100;
    vi.spyOn(Date, "now").mockReturnValue(NaN);
    f.client.schedulePoll();
    expect(f.diagnostics()).toMatchObject({ enabled: true, intervalMs: 100, scheduledAtMs: null, nextDueAtMs: null });
    expect(vi.getTimerCount()).toBe(1);
    await f.eufy.disconnect();
  });
});
