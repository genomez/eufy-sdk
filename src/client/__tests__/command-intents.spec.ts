import { describe, expect, it } from "vitest";
import { CommandIntentRegistry } from "../command-intents.js";

describe("validated command intent ownership", () => {
  it("rejects older preparation even when it finishes after a newer accepted invocation", () => {
    const registry = new CommandIntentRegistry();
    const old = registry.allocate();
    const next = registry.allocate();
    const current = registry.acceptValidated("station", "target", next, "state")!;
    expect(registry.acceptValidated("station", "target", old, "state")).toBeUndefined();
    expect(registry.isCurrent(current)).toBe(true);
  });

  it("invalidates target recovery for other properties and actions without coalescing those writes", () => {
    const registry = new CommandIntentRegistry();
    const state = registry.acceptValidated("station", "target", registry.allocate(), "state")!;
    const brightness = registry.acceptValidated("station", "target", registry.allocate(), "brightness")!;
    expect(registry.isCurrent(state)).toBe(false);
    expect(registry.isPropertyCurrent(state)).toBe(true);
    const action = registry.acceptValidated("station", "target", registry.allocate())!;
    expect(registry.isCurrent(brightness)).toBe(false);
    expect(registry.isPropertyCurrent(brightness)).toBe(true);
    expect(registry.isPropertyCurrent(action)).toBe(true);
    registry.acceptValidated("station", "target", registry.allocate(), "state");
    expect(registry.isPropertyCurrent(state)).toBe(false);
  });

  it("preserves distinct properties and actions when their preparation finishes out of order", () => {
    const registry = new CommandIntentRegistry();
    const stateOrdinal = registry.allocate();
    const actionOrdinal = registry.allocate();
    const level = registry.acceptValidated("station", "target", registry.allocate(), "brightness")!;
    const state = registry.acceptValidated("station", "target", stateOrdinal, "state")!;
    const action = registry.acceptValidated("station", "target", actionOrdinal)!;
    expect(state).toBeDefined();
    expect(action).toBeDefined();
    expect(registry.isPropertyCurrent(state)).toBe(true);
    expect(registry.isPropertyCurrent(action)).toBe(true);
    expect(registry.isCurrent(level)).toBe(true);
    expect(registry.isCurrent(state)).toBe(false);
  });

  it("preserves legacy FIFO but a profile barrier supersedes older unsent legacy intent", () => {
    const registry = new CommandIntentRegistry();
    const one = registry.acceptValidated("station", "target", registry.allocate(), "state", false)!;
    const two = registry.acceptValidated("station", "target", registry.allocate(), "state", false)!;
    expect(registry.isPropertyCurrent(one)).toBe(true);
    expect(registry.isPropertyCurrent(two)).toBe(true);
    const bounded = registry.acceptValidated("station", "target", registry.allocate(), "state", true)!;
    expect(registry.isPropertyCurrent(one)).toBe(false);
    expect(registry.isPropertyCurrent(two)).toBe(false);
    expect(registry.isPropertyCurrent(bounded)).toBe(true);
    registry.acceptValidated("station", "target", registry.allocate(), "state", false);
    expect(registry.isPropertyCurrent(bounded)).toBe(false);
  });

  it("does not let allocated but unvalidated or invalid ordinals supersede ownership", () => {
    const registry = new CommandIntentRegistry();
    const current = registry.acceptValidated("station", "target", registry.allocate(), "state")!;
    registry.allocate();
    for (const ordinal of [0, -1, 1.5, Infinity, NaN, 999])
      expect(registry.acceptValidated("station", "target", ordinal, "state")).toBeUndefined();
    expect(registry.isCurrent(current)).toBe(true);
    expect(registry.isPropertyCurrent(current)).toBe(true);
  });

  it.each(["station", "all"])("retires pending preparations and all accepted token kinds on %s close", (mode) => {
    const registry = new CommandIntentRegistry();
    const old = registry.acceptValidated("station", "target", registry.allocate())!;
    const preparing = registry.allocate();
    if (mode === "station") registry.invalidateStation("station");
    else registry.close();
    expect(registry.isCurrent(old)).toBe(false);
    expect(registry.isPropertyCurrent(old)).toBe(false);
    expect(registry.acceptValidated("station", "target", preparing)).toBeUndefined();
    expect(registry.acceptValidated("station", "target", registry.allocate())).toBeDefined();
  });

  it("bounds target and property ownership without evicting a live token", () => {
    const registry = new CommandIntentRegistry(1);
    const old = registry.acceptValidated("station", "one", registry.allocate(), "state")!;
    expect(registry.acceptValidated("station", "two", registry.allocate(), "state")).toBeUndefined();
    expect(registry.acceptValidated("station", "one", registry.allocate(), "brightness")).toBeUndefined();
    expect(registry.isCurrent(old)).toBe(true);
    expect(registry.isPropertyCurrent(old)).toBe(true);
  });
});
