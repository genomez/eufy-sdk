import { VIDEO } from "../video.js";

describe("video capability module", () => {
  it("declares the capability + empty schema", () => {
    expect(VIDEO.capability).toBe("video");
    expect(Array.isArray(VIDEO.properties)).toBe(true);
    expect(VIDEO.properties).toEqual([]);
  });

  it("detects via the live-view enable param + camera codec", () => {
    expect(VIDEO.detection?.evidenceParams).toEqual([1056]);
    expect(VIDEO.detection?.codecs).toEqual(["camera"]);
  });
});
