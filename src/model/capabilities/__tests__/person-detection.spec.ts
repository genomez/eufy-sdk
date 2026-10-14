/** Modified for genomez S1 experimental source preview, 2026-10-14. */
import { PERSON_DETECTION } from "../person-detection.js";
import { decodeEvent, detectCapabilities } from "../index.js";

describe("person_detection capability module", () => {
  it("declares the capability + schema", () => {
    expect(PERSON_DETECTION.capability).toBe("person_detection");
    // Push events are the whole read surface; no owned camera reports a detection state param.
    expect(PERSON_DETECTION.properties).toEqual([]);
  });

  it("advertises semantic person events on the camera baseline without inventing sensor support", () => {
    expect(detectCapabilities({ params: {} }, "camera")).toContain("person_detection");
    expect(detectCapabilities({ params: {} }, "sensor")).not.toContain("person_detection");
    expect(PERSON_DETECTION.events?.map(({ emit }) => emit)).toEqual([
      "personDetected",
      "personDetected",
      "strangerDetected",
    ]);
  });
});

describe("person names on validated person events", () => {
  it.each([3102, 3111])("normalizes an explicit name before a nickname for %i", (eventType) => {
    const [event] = decodeEvent({
      source: "push",
      eventType,
      payload: { person_name: " Synthetic Person ", nick_name: "Other Person" },
    });
    expect(event?.payload.person_name).toBe("Synthetic Person");
  });
  it("uses the person-event nickname, never generic name fields", () => {
    const [named] = decodeEvent({ source: "push", eventType: 3111, payload: { nick_name: "Synthetic Person" } });
    expect(named?.payload.person_name).toBe("Synthetic Person");
    const [unnamed] = decodeEvent({
      source: "push",
      eventType: 3111,
      payload: { name: "Camera Label", n: "Camera Label", person_id: 7 },
    });
    expect(unnamed?.payload.person_name).toBeUndefined();
    expect(unnamed?.payload.person_id).toBe(7);
  });
  it.each([null, false, 12, {}, "", "  "])("does not invent a name from %j", (value) => {
    const [event] = decodeEvent({ source: "push", eventType: 3111, payload: { person_name: value, nick_name: value } });
    expect(event?.payload.person_name).toBeUndefined();
  });
  it("keeps explicit strangers distinct from named-person events", () => {
    const [event] = decodeEvent({ source: "push", eventType: 3112, payload: { nick_name: "Camera Label" } });
    expect(event?.event).toBe("strangerDetected");
    expect(event?.payload.person_name).toBeUndefined();
  });
});
