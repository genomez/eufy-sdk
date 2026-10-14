import { describe, expect, it } from "vitest";
import { normalizePushEvent, PushClient } from "../push-client.js";
import { mcsRoot } from "../proto.js";
import { MessageTag } from "../message-tags.js";
import type { McsParser } from "../parser.js";
import type { PushEvent } from "../types.js";

const when = 1790000000000;
const body = {
  device_sn: "synthetic-camera",
  event_type: 3102,
  pic_url: "https://example.invalid/image",
  create_time: when,
  trigger_time: when,
  session_id: "synthetic-event",
};
const normalize = (payload: Record<string, unknown> = body, envelope: Record<string, unknown> = {}) =>
  normalizePushEvent({ payload: { ...envelope, payload } }).thumbnailCandidate;

function receive(payload: unknown, siblings: Record<string, string> = {}) {
  const client = new PushClient({
    fid: "synthetic",
    androidId: "1",
    securityToken: "2",
    fcmToken: "synthetic",
    createdAt: 0,
  });
  let event!: PushEvent;
  client.on("push", (value: PushEvent) => {
    event = value;
  });
  const data = mcsRoot().lookupType("mcs_proto.DataMessageStanza");
  const encoded = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([0])]).toString("base64");
  const frame = Buffer.concat([
    Buffer.from([41, MessageTag.DataMessageStanza]),
    data
      .encodeDelimited({
        from: "synthetic",
        category: "synthetic",
        appData: [
          { key: "payload", value: encoded },
          ...Object.entries(siblings).map(([key, value]) => ({ key, value })),
        ],
      })
      .finish(),
  ]);
  try {
    const parser = (client as unknown as { parser: McsParser }).parser;
    parser.handleData(frame.subarray(0, 5));
    parser.handleData(frame.subarray(5));
    return event;
  } finally {
    client.close();
  }
}

describe("thumbnail source clock consensus", () => {
  it("uses matching clocks belonging to the identified thumbnail payload", () => {
    expect(normalize()?.eventTime).toBe(when);
  });
  it("accepts equal source seconds and milliseconds", () => {
    expect(normalize({ ...body, create_time: when / 1000 })?.eventTime).toBe(when);
  });
  it("uses unique_id when session_id is absent", () => {
    expect(normalize({ ...body, session_id: undefined, unique_id: "synthetic-event" })?.eventTime).toBe(when);
  });
  it.each([null, "", "0", "1790000000junk", " 1790000000", when + 0.5])(
    "does not hide supplied malformed envelope time %s behind valid nested clocks",
    (event_time) => {
      expect(normalize(body, { event_time })?.eventTime).toBeUndefined();
    },
  );
  it("preserves valid envelope precedence even when nested clocks differ", () => {
    expect(normalize({ ...body, trigger_time: when - 1000 }, { event_time: String(when + 5000) })?.eventTime).toBe(
      when + 5000,
    );
  });
  it.each([{}, { session_id: "" }, { session_id: " " }, { session_id: 42 }])(
    "keeps unidentified events undated: %s",
    (identity) => {
      expect(normalize({ ...body, session_id: undefined, ...identity })?.eventTime).toBeUndefined();
    },
  );
  it.each([
    { create_time: undefined },
    { trigger_time: undefined },
    { create_time: when - 1000 },
    { trigger_time: "invalid" },
    { create_time: null },
    { trigger_time: 0 },
  ])("rejects missing, malformed or conflicting source pairs: %s", (clocks) => {
    expect(normalize({ ...body, ...clocks })?.eventTime).toBeUndefined();
  });
  it("accepts an optional nested event clock only when it agrees", () => {
    expect(normalize({ ...body, event_time: when / 1000 })?.eventTime).toBe(when);
  });
  it.each([when - 1000, null, "invalid"])(
    "rejects conflicting or malformed optional nested event clock %s",
    (event_time) => {
      expect(normalize({ ...body, event_time })?.eventTime).toBeUndefined();
    },
  );
  it("does not use presentation, push or download clock hints", () => {
    expect(
      normalize({ ...body, create_time: undefined, trigger_time: undefined, push_time: when, sent: when })?.eventTime,
    ).toBeUndefined();
  });
  it("keeps conflicting camera attribution ambiguous", () => {
    expect(normalize(body, { device_sn: "other-synthetic-camera" })?.attribution).toEqual({ kind: "ambiguous" });
  });
  it("does not build a dated candidate without a thumbnail", () => {
    expect(normalize({ ...body, pic_url: undefined })).toBeUndefined();
  });
});

describe("consensus through actual MCS parsing", () => {
  it("keeps body-only identified source clocks", () => {
    expect(receive(body).thumbnailCandidate?.eventTime).toBe(when);
  });
  it("uses source clocks in a split body only when the outer clock is absent", () => {
    expect(receive(body, { station_sn: "synthetic-station" }).thumbnailCandidate?.eventTime).toBe(when);
  });
  it("preserves a valid sibling outer clock instead of relabeling it", () => {
    expect(receive(body, { event_time: String(when + 5000) }).thumbnailCandidate?.eventTime).toBe(when + 5000);
  });
  it("does not lose a malformed supplied sibling clock and then fall back", () => {
    expect(receive(body, { event_time: "invalid" }).thumbnailCandidate?.eventTime).toBeUndefined();
  });
  it("keeps packed object and JSON-string bodies authoritative", () => {
    for (const payload of [body, JSON.stringify(body)]) {
      expect(receive({ payload }, { event_time: String(when + 5000) }).thumbnailCandidate?.eventTime).toBe(when);
    }
  });
  it("keeps packed malformed envelope clocks unknown", () => {
    expect(receive({ event_time: null, payload: body }).thumbnailCandidate?.eventTime).toBeUndefined();
  });
  it("retains conflicting sibling camera claims", () => {
    expect(receive(body, { device_sn: "other-synthetic-camera" }).thumbnailCandidate?.attribution).toEqual({
      kind: "ambiguous",
    });
  });
});
