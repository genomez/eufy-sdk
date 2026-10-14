import { describe, expect, it } from "vitest";

import { randomPhoneModel, randomUserAgent } from "../phone-model.js";

describe("randomPhoneModel", () => {
  it("is deterministic for a given seed (stable across runs / calls)", () => {
    expect(randomPhoneModel("udid-abc")).toBe(randomPhoneModel("udid-abc"));
    expect(randomUserAgent("udid-abc")).toBe(randomUserAgent("udid-abc"));
  });

  it("varies by seed", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((x) => randomPhoneModel(`seed-${x}`));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("returns a non-empty realistic model string", () => {
    for (const seed of ["1", "2", "3", "4", "5"]) {
      const m = randomPhoneModel(seed);
      expect(m.length).toBeGreaterThan(2);
      expect(m).not.toMatch(/undefined|NaN/);
    }
  });

  it("without a seed still returns a valid model (non-deterministic)", () => {
    expect(randomPhoneModel().length).toBeGreaterThan(2);
  });

  it("randomUserAgent is a Dalvik UA that embeds the given model", () => {
    const ua = randomUserAgent("udid-abc", "SM-G998B");
    expect(ua).toMatch(/^Dalvik\/2\.1\.0 \(Linux; U; Android \d+; SM-G998B Build\/[A-Z0-9.]+\)$/);
  });
});
