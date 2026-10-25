import { describe, expect, it } from "vitest";
import { checkinRoot, mcsRoot } from "../proto.js";
import { McsParser } from "../parser.js";
import { MessageTag } from "../message-tags.js";
import type { McsMessage } from "../types.js";

const invalidLengths = [
  [0x80, 0x80, 0x80, 0x80, 0x08],
  [0x80, 0x80, 0x80, 0x80, 0x10],
  [0xff, 0xff, 0xff, 0xff, 0x7f],
  [0x80, 0x80, 0x80, 0x80, 0x80, 0x00],
];

describe("push protobuf parsing", () => {
  it.each(invalidLengths)("rejects an overflowing MCS string length (%j)", (...length) => {
    const body = Buffer.from([0x0a, ...length]);
    const parser = new McsParser();
    const messages: McsMessage[] = [];
    parser.on("message", (message) => messages.push(message));
    expect(() =>
      parser.handleData(Buffer.concat([Buffer.from([41, MessageTag.LoginResponse, body.length]), body])),
    ).toThrow("invalid length encoding");
    expect(messages).toEqual([]);
  });

  it.each(invalidLengths)("rejects an overflowing check-in string length (%j)", (...length) => {
    const response = checkinRoot().lookupType("CheckinResponse");
    expect(() => response.decode(Buffer.from([0x22, ...length]))).toThrow("invalid length encoding");
  });

  it("rejects truncated fields rather than admitting an incomplete message", () => {
    const response = checkinRoot().lookupType("CheckinResponse");
    const login = mcsRoot().lookupType("mcs_proto.LoginResponse");
    expect(() => response.decode(Buffer.from([0x22, 0x80]))).toThrow(RangeError);
    expect(() => login.decode(Buffer.from([0x0a, 0x04, 0x61]))).toThrow(RangeError);
  });

  it("preserves check-in fixed64 and int64 fields beyond the safe integer range", () => {
    const response = checkinRoot().lookupType("CheckinResponse");
    const values = {
      statsOk: true,
      androidId: "18446744073709551615",
      securityToken: "9007199254740993",
      timeMs: "9223372036854775807",
    };
    const bytes = response.encode(response.fromObject(values)).finish();
    expect(response.toObject(response.decode(bytes), { longs: String })).toEqual(values);
    const request = checkinRoot().lookupType("CheckinRequest");
    const input = {
      androidId: "9223372036854775807",
      securityToken: "18446744073709551615",
      checkin: { build: { fingerprint: "synthetic" } },
      fragment: 0,
    };
    const encoded = request.encode(request.fromObject(input)).finish();
    expect(request.toObject(request.decode(encoded), { longs: String })).toEqual(input);
  });

  it("reassembles every split across login, heartbeats and a multibyte-length data frame", () => {
    const root = mcsRoot();
    const frame = (tag: MessageTag, object: Record<string, unknown>) =>
      Buffer.concat([
        Buffer.from([tag]),
        root.lookupType(`mcs_proto.${MessageTag[tag]}`).encodeDelimited(object).finish(),
      ]);
    const payload = JSON.stringify({ content: "synthetic ".repeat(25), event_type: 3102 });
    const appData = [{ key: "payload", value: Buffer.from(payload).toString("base64") }];
    const wire = Buffer.concat([
      Buffer.from([41]),
      frame(MessageTag.LoginResponse, { id: "synthetic" }),
      frame(MessageTag.HeartbeatPing, { lastStreamIdReceived: 7 }),
      frame(MessageTag.HeartbeatAck, {}),
      frame(
        MessageTag.DataMessageStanza,
        root.lookupType("mcs_proto.DataMessageStanza").fromObject({
          from: "synthetic",
          category: "synthetic",
          persistentId: "synthetic-id",
          sent: "9223372036854775807",
          appData,
        }),
      ),
    ]);
    for (let split = 1; split < wire.length; split++) {
      const parser = new McsParser();
      const messages: McsMessage[] = [];
      parser.on("message", (message) => messages.push(message));
      parser.handleData(wire.subarray(0, split));
      parser.handleData(wire.subarray(split));
      expect(messages.map(({ tag }) => tag)).toEqual([
        MessageTag.LoginResponse,
        MessageTag.HeartbeatPing,
        MessageTag.HeartbeatAck,
        MessageTag.DataMessageStanza,
      ]);
      expect(messages[1].object.lastStreamIdReceived).toBe(7);
      expect(messages[3].object).toMatchObject({ sent: "9223372036854775807", persistentId: "synthetic-id", appData });
    }
  });
});
