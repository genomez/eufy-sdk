import { EufyMega } from "../client/eufy-mega.js";
import { STATE_EVENT_FIELDS } from "../model/capabilities/index.js";

/**
 * Edge-triggering for state-carrying semantic events.
 *
 * A contact change reaches the SDK on up to three transports — the station notify, the same value as
 * an FCM push ~2 s later, then the next cloud poll — so a host would hear one door movement several
 * times. These drive the private emitter directly: the point under test is the suppression rule, not
 * the transports feeding it.
 */
const emitOn = (eufy: EufyMega, event: string, payload: Record<string, unknown>, edge: boolean) =>
  (
    eufy as unknown as { emitSemantic(e: string, p: Record<string, unknown>, o?: { edge?: boolean }): void }
  ).emitSemantic(event, payload, { edge });

const client = () =>
  new EufyMega({ email: "user@example.test", password: "x", countryCode: "GB", autoRealtime: false });
const SN = "T8000P0000000000";

describe("state-event edge triggering", () => {
  it("declares contactState as state-carrying, keyed on its value field", () => {
    expect(STATE_EVENT_FIELDS["contactState"]).toBe("open");
  });

  it("treats motion as a pulse, never a state", () => {
    expect(STATE_EVENT_FIELDS["motion"]).toBeUndefined();
  });

  it("announces one change once, however many transports report it", () => {
    const eufy = client();
    const seen: unknown[] = [];
    eufy.on("contactState", (e) => seen.push(e.open));
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, true);
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, true);
    expect(seen).toEqual([true]);
  });

  it("passes a genuine open→close→open burst intact", () => {
    const eufy = client();
    const seen: unknown[] = [];
    eufy.on("contactState", (e) => seen.push(e.open));
    for (const open of [true, false, true]) emitOn(eufy, "contactState", { deviceSn: SN, open }, true);
    expect(seen).toEqual([true, false, true]);
  });

  it("keeps devices independent — one sensor's state never masks another's", () => {
    const eufy = client();
    const seen: unknown[] = [];
    eufy.on("contactState", (e) => seen.push([e.deviceSn, e.open]));
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, true);
    emitOn(eufy, "contactState", { deviceSn: "T8000P0000000001", open: true }, true);
    expect(seen).toEqual([
      [SN, true],
      ["T8000P0000000001", true],
    ]);
  });

  it("never suppresses a pulse, even an identical consecutive one", () => {
    const eufy = client();
    let n = 0;
    eufy.on("motion", () => n++);
    emitOn(eufy, "motion", { deviceSn: SN }, true);
    emitOn(eufy, "motion", { deviceSn: SN }, true);
    expect(n).toBe(2);
  });

  it("re-announces an unchanged state on the poll path, so a host can re-synchronise", () => {
    const eufy = client();
    const seen: unknown[] = [];
    eufy.on("contactState", (e) => seen.push(e.open));
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, true);
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, false);
    expect(seen).toEqual([true, true]);
  });

  it("lets the poll's re-assertion update what is known, so a later realtime repeat stays suppressed", () => {
    const eufy = client();
    const seen: unknown[] = [];
    eufy.on("contactState", (e) => seen.push(e.open));
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, false);
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, true);
    expect(seen).toEqual([true]);
  });

  it("emits a signal that says nothing about the state — it can't duplicate what it doesn't carry", () => {
    const eufy = client();
    let n = 0;
    eufy.on("contactState", () => n++);
    emitOn(eufy, "contactState", { deviceSn: SN }, true);
    emitOn(eufy, "contactState", { deviceSn: SN }, true);
    expect(n).toBe(2);
  });

  it("emits an unattributable signal rather than risk masking another device", () => {
    const eufy = client();
    let n = 0;
    eufy.on("contactState", () => n++);
    emitOn(eufy, "contactState", { stationSn: SN, open: true }, true);
    emitOn(eufy, "contactState", { stationSn: SN, open: true }, true);
    expect(n).toBe(2);
  });

  it("forgets what it announced once the connection is torn down", async () => {
    const eufy = client();
    const seen: unknown[] = [];
    eufy.on("contactState", (e) => seen.push(e.open));
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, true);
    await eufy.disconnect();
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, true);
    expect(seen).toEqual([true, true]);
  });

  it("suppresses the catch-all `event` alongside the named one", () => {
    const eufy = client();
    let n = 0;
    eufy.on("event", (e) => e.eventName === "contactState" && n++);
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, true);
    emitOn(eufy, "contactState", { deviceSn: SN, open: true }, true);
    expect(n).toBe(1);
  });
});
