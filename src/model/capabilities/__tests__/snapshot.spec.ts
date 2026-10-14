import { SNAPSHOT } from "../snapshot.js";

describe("snapshot capability module", () => {
  it("declares the capability + empty schema", () => {
    expect(SNAPSHOT.capability).toBe("snapshot");
    expect(Array.isArray(SNAPSHOT.properties)).toBe(true);
    expect(SNAPSHOT.properties).toEqual([]);
  });

  it("detects via the cover-image param + camera codec", () => {
    expect(SNAPSHOT.detection?.evidenceParams).toEqual([1004]);
    expect(SNAPSHOT.detection?.codecs).toEqual(["camera"]);
  });
});
