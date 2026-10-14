import { describe, expect, it } from "vitest";
import { buildPortalHeader, parsePortalPacket, PortalLinkType, type PortalResponse } from "../portal-packet.js";
import { inspectRtcPushPayload } from "../push-notification.js";

const rtcPushPayload = (...args: Parameters<typeof inspectRtcPushPayload>) => inspectRtcPushPayload(...args).payload;

const HUB = "T8000P0000000000";
const body = { device_sn: "T8000P0000000001", event_type: 3111, nick_name: "Synthetic Person" };
function frame(cmd: number, payload: unknown): PortalResponse {
  const bytes = Buffer.from(JSON.stringify({ cmd, payload }));
  return parsePortalPacket(
    Buffer.concat([buildPortalHeader(1351, bytes.length, 255, 1), bytes]),
    PortalLinkType.NOTIFY,
  )!;
}

describe("RTC push envelopes", () => {
  it.each([1317, 1318])("decodes station envelope %i through the packet parser", (cmd) => {
    expect(
      rtcPushPayload(
        HUB,
        frame(cmd, { station_sn: HUB, payload: Buffer.from(JSON.stringify(body)).toString("base64") }),
      ),
    ).toEqual(body);
  });
  it.each([body, JSON.stringify(body)])("decodes object and JSON camera notifications", (payload) => {
    expect(rtcPushPayload(HUB, frame(2037, payload))).toEqual(body);
  });
  it.each([
    "!!!!",
    "/w==",
    "e30=garbage",
    Buffer.from("[]").toString("base64"),
    Buffer.from("null").toString("base64"),
    Buffer.from("{").toString("base64"),
  ])("rejects malformed encoded bodies %s", (payload) => {
    expect(rtcPushPayload(HUB, frame(1317, { payload }))).toBeUndefined();
  });
  it("rejects conflicting station identity at every envelope level", () => {
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
    for (const candidate of [
      frame(1317, { station_sn: "OTHER", payload: encoded(body) }),
      frame(1317, { payload: encoded({ ...body, station_sn: "OTHER" }) }),
      frame(2037, { ...body, station_sn: "OTHER" }),
      { ...frame(2037, body), data: { cmd: 2037, station_sn: "OTHER", payload: body } },
    ])
      expect(rtcPushPayload(HUB, candidate)).toBeUndefined();
  });
  it("ignores response, command-channel, conflicting and unrelated frames", () => {
    const candidate = frame(2037, body);
    for (const other of [
      { ...candidate, isResponse: 1 },
      { ...candidate, linkType: 1 },
      { ...candidate, cmd: 1317 },
      frame(1103, body),
      frame(2037, "invalid"),
    ])
      expect(rtcPushPayload(HUB, other)).toBeUndefined();
  });
});
