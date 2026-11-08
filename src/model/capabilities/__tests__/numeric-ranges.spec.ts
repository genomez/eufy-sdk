import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { BATTERY, BATTERY_MEMBERS } from "../battery.js";
import { CAMERA_MEMBERS } from "../camera.js";
import { PTZ_MEMBERS } from "../ptz.js";
import { propertiesOf, memberWrite, bindMembers, numericRange, type ValueMember } from "../members.js";
import { CAPABILITY_MODULES, buildActions, describeCapabilities } from "../index.js";
import type { CommandContext } from "../types.js";
import type { Capability } from "../../types.js";
import { Device } from "../../device.js";

const context = (model?: string): CommandContext => ({
  codec: "camera",
  channel: 0,
  model,
  capabilities: new Set<Capability>(["battery"]),
  paramIds: new Set(BATTERY.properties.map((p) => p.paramType)),
});
const sink = { dispatch: async () => undefined };
const bounds = (model: string, name: string) => {
  const spec = propertiesOf(BATTERY_MEMBERS, context(model)).find((p) => p.name === name)!;
  return { min: spec.min, max: spec.max, step: spec.step };
};
const cases = [
  ["T8170", 10, 120, 5, 60],
  ["T8171", 5, 120, 5, 60],
  ["T8134", 5, 120, 5, 60],
  ["T8214", 5, 120, 2, 60],
] as const;

describe("numeric property domains", () => {
  it.each(cases)(
    "resolves %s ranges consistently for properties, reads and actions",
    (model, clipMin, clipMax, gapMin, gapMax) => {
      const ctx = context(model);
      const bound = buildActions(["battery"], { ctx, sink, read: () => undefined });
      const manifest = describeCapabilities(bound, ctx).find((p) => p.capability === "battery")!;
      for (const [name, min, max] of [
        ["recordDuration", clipMin, clipMax],
        ["recordInterval", gapMin, gapMax],
      ] as const) {
        expect(bounds(model, name)).toEqual({ min, max, step: 1 });
        expect(manifest.reads.find((p) => p.property === name)).toMatchObject({ min, max, step: 1 });
        expect(manifest.actions.find((p) => p.reflects === name)?.args?.[0]).toMatchObject({ min, max, step: 1 });
      }
    },
  );

  it.each([undefined, "T8425", "T8426", "T8416", "T9999"])(
    "does not borrow another model's recording limits for %s",
    (model) => {
      const spec = propertiesOf(BATTERY_MEMBERS, context(model)).find((p) => p.name === "recordDuration")!;
      expect(spec.min).toBe(0);
      expect(spec.max).toBeUndefined();
      expect(spec.step).toBeUndefined();
    },
  );

  it.each(cases)(
    "refuses invalid %s writes on intent and fluent paths before dispatch",
    async (model, min, max, gapMin, gapMax) => {
      const ctx = context(model);
      let sent = 0;
      const bound = bindMembers(BATTERY_MEMBERS, {
        ctx,
        sink: {
          dispatch: async () => {
            sent++;
          },
        },
        read: () => undefined,
      });
      for (const [name, low, high] of [
        ["recordDuration", min, max],
        ["recordInterval", gapMin, gapMax],
      ] as const) {
        const m = BATTERY_MEMBERS[name];
        for (const invalid of [low - 1, high + 1, low + 0.5, NaN, Infinity]) {
          expect(() => memberWrite(name, m, invalid, ctx)).toThrow();
          const setter = name === "recordDuration" ? bound.setRecordDuration : bound.setRecordInterval;
          await expect(setter!(invalid)).rejects.toThrow();
        }
        expect(() => memberWrite(name, m, low, ctx)).not.toThrow();
        expect(() => memberWrite(name, m, high, ctx)).not.toThrow();
      }
      expect(sent).toBe(0);
    },
  );

  it("publishes the existing property-specific validation domains", () => {
    for (const member of [CAMERA_MEMBERS.soundDetectionSensitivity, PTZ_MEMBERS.rotationSpeed]) {
      expect(numericRange(member)).toEqual({ min: 1, max: 5, step: 1 });
      expect(() => memberWrite("level", member, 6, context("T8416"))).toThrow();
    }
  });

  it("keeps fractional steps and never widens static bounds", () => {
    const member: ValueMember = {
      param: 999999,
      type: "number",
      kind: "scalar",
      min: 0.25,
      max: 2,
      step: 0.25,
      description: "Synthetic fractional domain.",
      numericRangeFor: () => ({ min: -10, max: 10 }),
      write: () => ({ kind: "set-json", param: 999999, data: { value: 1 }, channel: 0 }),
    };
    expect(propertiesOf({ fractional: member }, context())[0]).toMatchObject({ min: 0.25, max: 2, step: 0.25 });
    expect(() => memberWrite("fractional", member, 0.5, context())).not.toThrow();
    expect(() => memberWrite("fractional", member, 0.6, context())).toThrow();
    expect(() => memberWrite("fractional", member, -1, context())).toThrow();
  });

  it("inventories synthetic owner-model number properties without runtime reads", () => {
    const params = Object.fromEntries(
      Object.values(CAPABILITY_MODULES).flatMap((m) => m.properties.map((p) => [p.paramType, "1"])),
    );
    const rows = ["T8425", "T8426", "T8170", "T8171", "T8134", "T8214", "T8416", "T9000"].map((model) => {
      const dev = Device.fromRecord("synthetic-device", { model, params });
      return {
        model,
        properties: dev.properties
          .filter(
            (p) =>
              p.writable &&
              p.type === "number" &&
              p.kind &&
              p.kind !== "bitfield" &&
              !p.raw &&
              !p.unexposed &&
              !p.enumValues,
          )
          .map(({ name, kind, min, max, step }) => ({ name, kind, min, max, step })),
      };
    });
    expect(rows.length).toBe(8);
    if (process.env.I34_INVENTORY_OUTPUT)
      writeFileSync(process.env.I34_INVENTORY_OUTPUT, JSON.stringify(rows, null, 2) + "\n");
  });
});
