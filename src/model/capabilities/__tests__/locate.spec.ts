import type { CommandContext } from "../types.js";
import { LOCATE, type LocateActions } from "../locate.js";
import { bind } from "./bind.js";

function locateCtx(paramIds: ReadonlySet<number> = new Set()): CommandContext {
  return { channel: 0, codec: "vacuum", paramIds };
}

describe("locate capability module", () => {
  it("declares the capability + schema", () => {
    expect(LOCATE.capability).toBe("locate");
    expect(LOCATE.properties.map((p) => p.name)).toEqual(["locating"]);
  });

  it("is a vacuum-codec baseline", () => {
    expect(LOCATE.detection?.codecs).toEqual(["vacuum"]);
  });
});

describe("locate — platform routing", () => {
  it("is present on an AIoT device that has reported no DPs at all", () => {
    const { acts } = bind<LocateActions>("locate", locateCtx(new Set()));
    expect(acts.locate).toBeDefined();
  });

  it("is present on an AIoT device regardless of whether DP 160 was reported", () => {
    // DP 160 is a momentary write trigger. A device never reports it in its param set, so gating the
    // verb on its presence would make locate() vanish on every real AIoT vacuum.
    expect(bind<LocateActions>("locate", locateCtx(new Set([160]))).acts.locate).toBeDefined();
    expect(bind<LocateActions>("locate", locateCtx(new Set())).acts.locate).toBeDefined();
  });

  it("is absent on a Tuya device — the DP 103 write is unconfirmed, so none is offered", () => {
    // Dispatching DP 103 would route through the Tuya command router, which refuses unverified
    // writes by default. A verb that is advertised and then throws is worse than an absent one.
    const reported = { ...locateCtx(new Set([103])), category: "eufy_home_tuya" };
    const silent = { ...locateCtx(new Set()), category: "eufy_home_tuya" };
    expect(bind<LocateActions>("locate", reported).acts.locate).toBeUndefined();
    expect(bind<LocateActions>("locate", silent).acts.locate).toBeUndefined();
  });

  it("dispatches DP 160 = true", async () => {
    const { acts, sent } = bind<LocateActions>("locate", locateCtx(new Set([160])));
    await acts.locate!();
    expect(sent).toEqual([{ kind: "aiot-dp", dp: 160, value: true }]);
  });

  it("dispatches DP 160 = false to cancel a beep in progress", async () => {
    const { acts, sent } = bind<LocateActions>("locate", locateCtx(new Set([160])));
    await acts.locate!(false);
    expect(sent).toEqual([{ kind: "aiot-dp", dp: 160, value: false }]);
  });

  it("never dispatches the legacy Tuya DP 103, even when the device reported it", async () => {
    const { acts, sent } = bind<LocateActions>("locate", locateCtx(new Set([103, 160])));
    await acts.locate!();
    expect(sent).toEqual([{ kind: "aiot-dp", dp: 160, value: true }]);
  });
});
