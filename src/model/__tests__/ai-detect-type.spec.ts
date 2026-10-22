import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Device, type RawParams } from "../device.js";
import { SECURITY_PARAMS } from "../param-dictionary.js";
import { buildCommand } from "../capabilities/index.js";
import type { MotionActions } from "../capabilities/motion.js";
import type { Command } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";

const serial = "T8000P0000000000";
const context = { codec: "camera" as const, channel: 3, paramIds: new Set([1298]) };

function camera(params: RawParams = {}) {
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sent: Command[] = [];
  const device = Device.fromRecord(serial, { deviceType: 9, model: "T8114" }, logger);
  device.applyParams(params);
  device.bindActions(context, { dispatch: async (command) => void sent.push(command) });
  return { device, motion: device.motion?.()!, logger, sent };
}

describe("AI setting 1298 scalar readback", () => {
  it("keeps the getter and setter numeric at the typed surface", () => {
    expectTypeOf<MotionActions["aiDetectType"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<MotionActions["setAiDetectType"]>().toEqualTypeOf<(value: number) => Promise<void>>();
  });

  it.each([
    ["P2P integer", 0x3000f, 0x3000f, 0x3000f],
    ["decimal cloud string", "196623", 0x3000f, 0x3000f],
    ["explicit plus", "+8", 8, 8],
    ["leading zero", "08", 8, 8],
    ["hexadecimal string", "0x8", 8, 8],
    ["binary string", "0b1000", 8, 8],
    ["octal string", "0o10", 8, 8],
    ["exponent string", "8e1", 80, 80],
    ["fractional number", 1.5, 1.5, 1.5],
    ["fractional decimal string", "1.5", 1.5, 1.5],
    ["negative fractional string", "-1.5", -1.5, -1.5],
    ["leading decimal point", ".5", 0.5, 0.5],
    ["trailing decimal point", "8.", 8, 8],
    ["bare zero", 0, 0, 0],
    ["string zero", "0", 0, 0],
    ["negative zero", -0, -0, -0],
    ["negative zero string", "-0", -0, -0],
    ["negative integer", -1, -1, -1],
    ["negative integer string", "-1", -1, -1],
    ["empty string", "", 0, 0],
    ["whitespace string", " \t\n", 0, 0],
    ["padded number", " \t+8\n", 8, 8],
    ["unicode whitespace", "\u00a0\ufeff8\u2029", 8, 8],
    ["boolean true", true, 1, 1],
    ["boolean false", false, 0, 0],
    ["maximum finite number", Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    ["minimum positive number", Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE],
    ["rounded integer string", "9007199254740993", 9007199254740992, 9007199254740992],
    ["underflow string", "1e-999", 0, 0],
    ["NaN number", Number.NaN, "NaN", undefined],
    ["positive infinite number", Number.POSITIVE_INFINITY, "Infinity", undefined],
    ["negative infinite number", Number.NEGATIVE_INFINITY, "-Infinity", undefined],
    ["NaN string", "NaN", "NaN", undefined],
    ["infinite string", "Infinity", "Infinity", undefined],
    ["overflow string", "1e309", "1e309", undefined],
    ["JSON true string", "true", "true", undefined],
    ["JSON false string", "false", "false", undefined],
    ["JSON null string", "null", "null", undefined],
    ["JSON quoted scalar", '"196623"', '"196623"', undefined],
    ["JSON quoted empty string", '""', '""', undefined],
    ["arbitrary text", "invalid", "invalid", undefined],
  ])("preserves base primitive storage, getters and announcements for %s", (_label, wire, stored, expected) => {
    const { device, motion } = camera({ 1298: wire });
    const announcement =
      expected === undefined ? { property: "aiDetectType" } : { property: "aiDetectType", value: expected };
    expect(device.getProperty("aiDetectType")?.value).toBe(stored);
    expect(motion.aiDetectType).toBe(expected);
    expect(device.getPropertyValue("aiDetectType")).toBe(expected);
    expect(device.getPropertyValues().aiDetectType).toBe(expected);
    expect(device.announcements(["aiDetectType"])).toEqual([announcement]);
    expect(device.observedProperties({ 1298: wire })).toEqual([announcement]);
    expect(device.applyParams({ 1298: wire })).toEqual([]);
    device.applyParams({ 1298: 42 });
    expect(device.announcements(device.applyParams({ 1298: wire }))).toEqual([announcement]);
    expect(device.getProperty("aiDetectType")?.value).toBe(stored);
    expect(motion.aiDetectType).toBe(expected);
  });

  it.each([
    ["JSON object", '{"ai_detect_type":196619,"ai_switch":1,"channel":2}', 0x3000b],
    ["object zero", '{"ai_detect_type":0}', 0],
    ["object negative integer", '{"ai_detect_type":-1}', -1],
    ["padded object", ' \n{"ai_detect_type":8}\t', 8],
  ])("reads a %s without numeric mismatch warnings", (_label, wire, expected) => {
    const { device, motion, logger } = camera({ 1298: wire });
    expect(motion.aiDetectType).toBe(expected);
    expect(device.getPropertyValue("aiDetectType")).toBe(expected);
    expect(device.getPropertyValues().aiDetectType).toBe(expected);
    expect(device.announcements(["aiDetectType"])).toEqual([{ property: "aiDetectType", value: expected }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["empty object", "{}"],
    ["other setting", '{"hbAiDetectType":3}'],
    ["null field", '{"ai_detect_type":null}'],
    ["string field", '{"ai_detect_type":"196623"}'],
    ["boolean field", '{"ai_detect_type":true}'],
    ["fractional field", '{"ai_detect_type":1.5}'],
    ["infinite field", '{"ai_detect_type":1e309}'],
    ["nested object field", '{"ai_detect_type":{"value":3}}'],
    ["array field", '{"ai_detect_type":[3]}'],
    ["empty array", "[]"],
    ["number array", "[196623]"],
    ["object array", '[{"ai_detect_type":196623}]'],
    ["quoted object", JSON.stringify('{"ai_detect_type":8}')],
    ["malformed JSON", '{"ai_detect_type":'],
  ])("withholds a scalar for %s", (_label, wire) => {
    const { device, motion, logger } = camera({ 1298: wire });
    expect(device.getProperty("aiDetectType")?.value).toBe(wire);
    expect(motion.aiDetectType).toBeUndefined();
    expect(device.getPropertyValue("aiDetectType")).toBeUndefined();
    expect(device.getPropertyValues().aiDetectType).toBeUndefined();
    expect(device.announcements(["aiDetectType"])).toEqual([{ property: "aiDetectType" }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps a numeric bitfield schema and the original object envelope string in parameter storage", () => {
    const wire = '{"ai_detect_type":196619,"ai_switch":1,"ai_notification":0,"ai_use_global":0,"channel":2}';
    const { device } = camera({ 1298: wire });
    expect(device.getProperty("aiDetectType")?.value).toBe(wire);
    expect(device.getPropertySpecs().find((spec) => spec.name === "aiDetectType")).toMatchObject({
      paramType: 1298,
      type: "number",
      kind: "bitfield",
      writable: true,
      raw: undefined,
      decode: undefined,
    });
    expect(SECURITY_PARAMS[1298]).toEqual({ name: "aiDetectType", type: "number", provenance: "apk" });
    expect(SECURITY_PARAMS[1299]).toEqual({ name: "hbAiDetectType", type: "number", provenance: "apk" });
  });

  it("deduplicates numerically equivalent primitive reports and preserves primitive invalidation", () => {
    const { device, motion } = camera({ 1298: 8 });
    const apply = (wire: string | number | boolean) => device.announcements(device.applyParams({ 1298: wire }));
    for (const wire of ["8", "+8", "08", "0x8", "0b1000", "0o10", " 8 "]) {
      expect(apply(wire)).toEqual([]);
      expect(motion.aiDetectType).toBe(8);
    }
    expect(apply(1.5)).toEqual([{ property: "aiDetectType", value: 1.5 }]);
    expect(apply("1.5")).toEqual([]);
    expect(apply(true)).toEqual([{ property: "aiDetectType", value: 1 }]);
    expect(apply("true")).toEqual([{ property: "aiDetectType" }]);
    expect(motion.aiDetectType).toBeUndefined();
    expect(apply(false)).toEqual([{ property: "aiDetectType", value: 0 }]);
    expect(apply("")).toEqual([]);
    expect(apply(" \t\n")).toEqual([]);
    expect(apply("false")).toEqual([{ property: "aiDetectType" }]);
    expect(motion.aiDetectType).toBeUndefined();
    expect(apply(-0)).toEqual([{ property: "aiDetectType", value: -0 }]);
    expect(apply("-0")).toEqual([]);
    expect(apply(0)).toEqual([{ property: "aiDetectType", value: 0 }]);
  });

  it("updates an already bound getter through object, scalar, invalid and recovered reports", () => {
    const { device, motion, sent } = camera({ 1298: "196623", 1299: "1" });
    const apply = (wire: string | number) => device.announcements(device.applyParams({ 1298: wire }));
    expect(apply('{"ai_detect_type":196619,"channel":2}')).toEqual([{ property: "aiDetectType", value: 0x3000b }]);
    expect(motion.aiDetectType).toBe(0x3000b);
    expect(apply(8)).toEqual([{ property: "aiDetectType", value: 8 }]);
    expect(motion.aiDetectType).toBe(8);
    expect(apply('{"ai_detect_type":"8"}')).toEqual([{ property: "aiDetectType" }]);
    expect(motion.aiDetectType).toBeUndefined();
    expect(apply('{"ai_detect_type":0}')).toEqual([{ property: "aiDetectType", value: 0 }]);
    expect(motion.aiDetectType).toBe(0);
    expect(apply('{"ai_detect_type":0}')).toEqual([]);
    expect(device.getProperty("hbAiDetectType")?.value).toBe(1);
    expect(device.motion?.()).toBe(motion);
    expect(sent).toEqual([]);
  });

  it("evidence-gates the getter until 1298 is reported without changing setter availability", () => {
    const device = Device.fromRecord(serial, { deviceType: 9, model: "T8114" });
    const bind = () => device.bindActions({ ...context, paramIds: new Set<number>() }, { dispatch: async () => {} });
    bind();
    expect(device.motion?.()).not.toHaveProperty("aiDetectType");
    expect(device.motion?.()?.setAiDetectType).toBeTypeOf("function");
    device.applyParams({ 1298: '{"ai_detect_type":8}' });
    bind();
    expect(device.motion?.()?.aiDetectType).toBe(8);
  });

  it("projects announcements without freshness work or fluent getter execution", () => {
    const { device, motion } = camera({ 1298: "196623" });
    const refresh = vi.fn(async () => {});
    device.setFreshnessPolicy({ staleAfterMs: -1, refresh });
    const getter = vi.spyOn(motion, "aiDetectType", "get");
    const changed = device.applyParams({ 1298: '{"ai_detect_type":8}' });
    expect(device.announcements(changed)).toEqual([{ property: "aiDetectType", value: 8 }]);
    expect(device.getPropertyValue("aiDetectType")).toBe(8);
    expect(getter).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("preserves the exact setter envelope and leaves state unchanged until a report arrives", async () => {
    const { device, motion, sent } = camera({ 1298: '{"ai_detect_type":196619,"channel":2,"ai_switch":0}' });
    const expected: Command = {
      kind: "set-payload",
      cmd: 1298,
      payload: { ai_detect_type: 8, channel: 3 },
      channel: 0,
      mValue3: 0,
      form: "auto",
    };
    await motion.setAiDetectType(8);
    expect(sent).toEqual([expected]);
    expect(buildCommand("aiDetectType", 8, { ...context, capabilities: new Set(["motion"]) })).toEqual(expected);
    expect(motion.aiDetectType).toBe(0x3000b);
    expect(device.getPropertyValue("aiDetectType")).toBe(0x3000b);
    await motion.setAiDetectType(0);
    expect(sent[1]).toEqual({ ...expected, payload: { ai_detect_type: 0, channel: 3 } });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid setter value %s", async (value) => {
    const { motion, sent } = camera({ 1298: '{"ai_detect_type":8}' });
    await expect(motion.setAiDetectType(value)).rejects.toThrow(/aiDetectType/);
    expect(() => buildCommand("aiDetectType", value, { ...context, capabilities: new Set(["motion"]) })).toThrow(
      /aiDetectType/,
    );
    expect(sent).toEqual([]);
  });

  it("preserves the camera-only write gate", async () => {
    const device = Device.fromRecord(serial, { model: "T8910", deviceType: 10, params: { 1298: "8" } });
    const dispatch = vi.fn(async () => {});
    const sensorContext = { ...context, codec: "sensor" as const };
    device.bindActions(sensorContext, { dispatch });
    await expect(device.motion?.()!.setAiDetectType(8)).rejects.toThrow(/aiDetectType/);
    expect(() => buildCommand("aiDetectType", 8, { ...sensorContext, capabilities: new Set(["motion"]) })).toThrow(
      /aiDetectType/,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});
