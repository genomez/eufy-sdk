import { describe, expect, it } from "vitest";
import { PushClient } from "../push-client.js";
import { mcsRoot } from "../proto.js";
import { MessageTag } from "../message-tags.js";
import type { McsParser } from "../parser.js";
import type { PushEvent, RawPushMessage } from "../types.js";

const time = 1_790_741_400_000;
const body = {
  device_sn: "SYNTHETIC_CAMERA",
  station_sn: "SYNTHETIC_STATION",
  event_type: 3102,
  pic_url: "https://example.test/thumbnail.jpg",
  create_time: time - 7000,
  trigger_time: time - 7000,
};
const encoded = (value: unknown) =>
  Buffer.concat([Buffer.from(JSON.stringify(value)), Buffer.from([0])]).toString("base64");

/** Exercise the actual protobuf stream parser and PushClient dispatch without opening a socket. */
function receive(appData: Array<{ key: string; value: string }>) {
  const client = new PushClient({
    fid: "synthetic",
    androidId: "1",
    securityToken: "2",
    fcmToken: "synthetic",
    createdAt: 0,
  });
  let raw!: RawPushMessage;
  let push!: PushEvent;
  client.on("message", (value: RawPushMessage) => {
    raw = value;
  });
  client.on("push", (value: PushEvent) => {
    push = value;
  });
  const type = mcsRoot().lookupType("mcs_proto.DataMessageStanza");
  const frame = Buffer.concat([
    Buffer.from([41, MessageTag.DataMessageStanza]),
    type
      .encodeDelimited({ from: "synthetic", category: "synthetic", appData, persistentId: "synthetic-persistent" })
      .finish(),
  ]);
  const parser = (client as unknown as { parser: McsParser }).parser;
  parser.handleData(frame.subarray(0, 6));
  parser.handleData(frame.subarray(6));
  expect(client.getPersistentIds()).toEqual(["synthetic-persistent"]);
  client.close();
  return { raw, push };
}

const split = (value: unknown = body, clock = String(time), extra: Array<{ key: string; value: string }> = []) =>
  receive([
    { key: "payload", value: encoded(value) },
    { key: "event_time", value: clock },
    { key: "push_time", value: String(time + 2000) },
    { key: "station_sn", value: "SYNTHETIC_STATION" },
    ...extra,
  ]);

describe("MCS envelope preservation", () => {
  it("retains the supplied envelope and device body together", () => {
    const { raw, push } = split();
    expect(raw.payload.event_time).toBe(String(time));
    expect(raw.payload.payload).toEqual(body);
    expect(push.payload).toEqual(body);
    expect(push.stationSn).toBe("SYNTHETIC_STATION");
    expect(push.eventType).toBe(3102);
  });

  it("forwards a sibling millisecond event time to the exact thumbnail candidate", () => {
    expect(split().push.thumbnailCandidate).toEqual({
      url: body.pic_url,
      eventTime: time,
      attribution: { kind: "device", deviceSn: body.device_sn },
    });
  });

  it("normalizes sibling seconds without using the later push time", () => {
    expect(split(body, String(time / 1000)).push.thumbnailCandidate?.eventTime).toBe(time);
  });

  it("does not substitute nested creation or trigger clocks when envelope time is absent", () => {
    const { push } = receive([
      { key: "payload", value: encoded(body) },
      { key: "station_sn", value: body.station_sn },
    ]);
    expect(push.thumbnailCandidate?.eventTime).toBeUndefined();
    expect(push.payload.create_time).toBe(time - 7000);
  });

  it.each(["0", "invalid", "2026-09-30T00:00:00Z", String(time + 0.5)])(
    "keeps malformed envelope time %s unknown",
    (clock) => {
      expect(split(body, clock).push.thumbnailCandidate?.eventTime).toBeUndefined();
    },
  );

  it("preserves envelope precedence over a different nested event clock", () => {
    expect(split({ ...body, event_time: time - 10000 }).push.thumbnailCandidate?.eventTime).toBe(time);
  });

  it("keeps the body-only payload shape and its existing time behavior", () => {
    const payload = { ...body, event_time: time };
    const { raw, push } = receive([{ key: "payload", value: encoded(payload) }]);
    expect(raw.payload).toEqual(payload);
    expect(push.thumbnailCandidate?.eventTime).toBe(time);
  });

  it("keeps an already packed envelope authoritative despite outer presentation metadata", () => {
    const envelope = {
      device_sn: body.device_sn,
      station_sn: body.station_sn,
      event_time: String(time),
      payload: body,
    };
    const { raw, push } = receive([
      { key: "payload", value: encoded(envelope) },
      { key: "content", value: "synthetic text" },
      { key: "event_time", value: String(time + 10000) },
    ]);
    expect(raw.payload).toEqual(envelope);
    expect(push.thumbnailCandidate?.eventTime).toBe(time);
  });

  it("retains the previously supported packed JSON-string body", () => {
    const envelope = { event_time: String(time), payload: JSON.stringify(body) };
    expect(receive([{ key: "payload", value: encoded(envelope) }]).push.thumbnailCandidate?.eventTime).toBe(time);
  });

  it("does not discard a conflicting outer camera claim", () => {
    expect(
      split(body, String(time), [{ key: "device_sn", value: "OTHER_SYNTHETIC_CAMERA" }]).push.thumbnailCandidate
        ?.attribution,
    ).toEqual({ kind: "ambiguous" });
  });

  it("retains station-only attribution supplied beside a body without a camera claim", () => {
    const { device_sn: _device, station_sn: _station, ...unclaimed } = body;
    expect(split(unclaimed).push.thumbnailCandidate?.attribution).toEqual({
      kind: "station",
      stationSn: body.station_sn,
    });
  });

  it("preserves explicit person identity fields without parsing presentation text", () => {
    const named = { ...body, person_name: "Synthetic Person", person_id: 42 };
    const { push } = split(named, String(time), [{ key: "content", value: "Different Synthetic Person detected" }]);
    expect(push.payload.person_name).toBe("Synthetic Person");
    expect(push.payload.person_id).toBe(42);
    expect(push.payload.content).toBeUndefined();
  });

  it("does not invent a name from a named notification title or content", () => {
    const { push } = split(body, String(time), [{ key: "content", value: "Synthetic Person detected" }]);
    expect(push.payload.person_name).toBeUndefined();
    expect(push.payload.nick_name).toBeUndefined();
  });

  it("keeps malformed decoded body text unusable without losing the safe envelope", () => {
    const malformed = Buffer.from("not json\0").toString("base64");
    const { raw, push } = receive([
      { key: "payload", value: malformed },
      { key: "event_time", value: String(time) },
    ]);
    expect(raw.payload.event_time).toBe(String(time));
    expect(push.thumbnailCandidate).toBeUndefined();
    expect(push.eventType).toBeUndefined();
  });

  it("retains the existing no-payload envelope path", () => {
    const { raw } = receive([{ key: "event_time", value: String(time) }]);
    expect(raw.payload.event_time).toBe(String(time));
  });

  it("does not give sibling prototype keys authority over the envelope", () => {
    const { raw, push } = split(body, String(time), [{ key: "__proto__", value: "synthetic" }]);
    expect(Object.getPrototypeOf(raw.payload)).toBeNull();
    expect(push.thumbnailCandidate?.eventTime).toBe(time);
    expect(Object.prototype.hasOwnProperty.call(raw.payload, "__proto__")).toBe(true);
  });
});
