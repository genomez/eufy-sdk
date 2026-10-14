import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { Device } from "../../model/device.js";

/**
 * A `Device` the caller asked for and then dropped.
 *
 * `propertyChanged` carries the new VALUE, and that value is read out of a `Device`'s own live state —
 * so the announcement needs the object the caller was handed. The SDK holds those WEAKLY on purpose
 * (`liveDevices`: "this map must never be what keeps one alive"), which was harmless before anything was
 * announced against them: a collected `Device` meant nobody was told anything, and the caller who let it
 * go plainly did not care.
 *
 * Announcing against it makes that weakness load-bearing, and the resulting failure has the worst shape
 * there is — non-deterministic (it depends on when the collector runs, so it passes in development and
 * stops under memory pressure), silent (no error, the events simply cease), and non-local (the obligation
 * is on `getDevice`, the symptom shows on `propertyChanged`).
 *
 * It cannot be designed away without either re-deriving the value outside live state — two answers for
 * one reading, which is the disagreement the announcement exists to remove — or making this map keep
 * every device alive for the session, reversing a documented invariant. So it is made LOUD instead: the
 * one case that is certainly a mistake, a serial the caller DID ask for whose object is now gone, is
 * reported once and then forgotten, so a host learns why its events stopped instead of investigating a
 * silence.
 *
 * A collected `WeakRef` cannot be produced on demand in a spec — the collector is not ours to run — so
 * these stand one in, which is exactly what `deref()` answers afterwards.
 */
const SN = "T8000P0000000000";

function withDroppedDevice() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const eufy = new EufyMega({ email: "t@example.com", password: "x", logger: logger as never });
  vi.spyOn((eufy as any).registry, "applyRealtimeParams").mockImplementation(() => {});
  const announced: unknown[] = [];
  eufy.on("propertyChanged", (e) => announced.push(e));
  /** What `liveDevices` holds once the collector has taken the device the caller let go. */
  const collected = () => (eufy as any).liveDevices.set(SN, { deref: () => undefined });
  const poll = () =>
    (eufy as any).applyPolledParams([{ deviceSn: SN, paramType: 1550, from: "0", to: "1", params: { 1550: "1" } }]);
  const report = () => (eufy as any).applyRealtimeState(SN, { 1550: "1" });
  const warnings = () => logger.warn.mock.calls.map(([m]) => String(m));
  return { eufy, logger, announced, collected, poll, report, warnings };
}

describe("a Device the caller asked for and dropped", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("says so on the poll path, naming what the caller has to do", () => {
    const { collected, poll, warnings, announced } = withDroppedDevice();
    collected();

    poll();

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(SN);
    expect(warnings()[0]).toMatch(/getDevice/);
    expect(announced).toEqual([]);
  });

  it("says so on the realtime path too", () => {
    const { collected, report, warnings } = withDroppedDevice();
    collected();

    report();

    expect(warnings()).toHaveLength(1);
  });

  /** Once. A device dropped on purpose must not narrate every pass for the rest of the session. */
  it("reports it once, not on every inbound signal", () => {
    const { collected, poll, report, warnings } = withDroppedDevice();
    collected();

    poll();
    poll();
    report();

    expect(warnings()).toHaveLength(1);
  });

  /**
   * A serial the caller never asked for has no object by definition, and no announcement was ever owed
   * for it — reporting that would name most of the account on every pass.
   */
  it("stays silent for a serial no caller ever asked for", () => {
    const { poll, report, warnings } = withDroppedDevice();

    poll();
    report();

    expect(warnings()).toEqual([]);
  });

  it("announces again once the caller fetches the device back", () => {
    const { eufy, collected, poll, announced, warnings } = withDroppedDevice();
    collected();
    poll();
    expect(announced).toEqual([]);

    const dev = Device.fromRecord(SN, { model: "T8900", category: "eufy_security", params: { 1550: "0" } });
    (eufy as any).liveDevices.set(SN, new WeakRef(dev));
    poll();

    expect(announced).toEqual([{ deviceSn: SN, property: "contact", value: true }]);
    expect(warnings()).toHaveLength(1); // still just the one, from before
  });
});
