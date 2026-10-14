import { KEYPAD } from "../keypad.js";

describe("keypad capability module", () => {
  it("declares the capability + schema", () => {
    expect(KEYPAD.capability).toBe("keypad");
    expect(KEYPAD.properties.map((p) => p.name)).toEqual(["batteryLow", "charging", "rssi"]);
  });

  it("is the keypad-codec baseline", () => {
    expect(KEYPAD.detection?.codecs).toEqual(["keypad"]);
  });
});
