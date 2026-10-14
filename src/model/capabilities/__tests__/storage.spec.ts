import { STORAGE } from "../storage.js";

describe("storage capability module", () => {
  it("declares the capability + schema", () => {
    expect(STORAGE.capability).toBe("storage");
    // No owned station reports a capacity param, and 1131 — the only candidate id — is `deviceStatus`
    // in the dictionary, reported by ten devices with an unrelated meaning.
    expect(STORAGE.properties).toEqual([]);
  });

  it("is a station-codec baseline", () => {
    expect(STORAGE.detection?.codecs).toEqual(["station"]);
  });
});
