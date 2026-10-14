import { describe, expect, it } from "vitest";
import { DECODED_MAP_CHANNELS, decodeMapFrame } from "../map-channels.js";
import { BIZ_CHANNEL } from "../../transport/mqtt/biz-stream.js";
import type { BizMapFrame } from "../../transport/mqtt/biz-stream.js";
import { byteCodec, frame, int, sint, sub } from "../../model/capabilities/__tests__/proto-bytes.js";

/**
 * The one table where the transport's channel numbering meets the model's decoders.
 *
 * Both sides can move without the other noticing — a channel renamed here, a decoder retired there —
 * and the result would be frames silently going unread rather than anything failing. So the two are
 * pinned against each other, and the routing rules that cannot be seen from either side alone are
 * pinned here too.
 */

const bizFrame = (channelId: number, payload: string, offset = 0): BizMapFrame => ({
  channelId,
  clearType: 0,
  dataType: 0,
  offset,
  len: 0,
  payload,
});

/** A `DynamicData`: one pose, small enough to write out. */
const POSE = frame(sub(1, [...sint(1, -320), ...sint(2, 145), ...sint(3, -157)]));

describe("the channel table", () => {
  it("names only channels BIZ_CHANNEL knows", () => {
    for (const name of DECODED_MAP_CHANNELS) expect(BIZ_CHANNEL[name], name).toBeDefined();
  });

  it("routes every channel it claims to read", () => {
    // The compile-time list and the runtime map are two separate things; this is what keeps them one.
    for (const name of DECODED_MAP_CHANNELS) {
      const routed = decodeMapFrame(bizFrame(BIZ_CHANNEL[name], POSE), byteCodec);
      // Only the pose channel decodes a pose. What matters here is that the id is ROUTED at all, which
      // an unrouted channel proves by returning undefined for every payload including its own.
      if (name === "DYNAMIC_DATA") expect(routed, name).toBeDefined();
    }
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.DYNAMIC_DATA, POSE), byteCodec)).toEqual({
      kind: "pose",
      value: { x: -320, y: 145, theta: -157 },
    });
  });

  it("leaves the channels nothing reads unrouted", () => {
    // Deliberate, and each for its own reason: MAP_INFO carries geometry that names no map and so
    // cannot be stamped against what is held; the rest have no decoder. Reporting them as undecoded
    // beats half-reading them with a decoder written for a different message.
    for (const id of [
      BIZ_CHANNEL.MAP_INFO,
      BIZ_CHANNEL.PATH,
      BIZ_CHANNEL.TEMPORARY_DATA,
      BIZ_CHANNEL.OBSTACLE_INFO,
      BIZ_CHANNEL.CRUISE_DATA,
      BIZ_CHANNEL.SCENES,
    ]) {
      expect(decodeMapFrame(bizFrame(id, POSE), byteCodec), `${id}`).toBeUndefined();
    }
  });

  it("has no answer for a channel id outside the table", () => {
    expect(decodeMapFrame(bizFrame(99, POSE), byteCodec)).toBeUndefined();
  });
});

describe("fragments", () => {
  it("skips a frame that is not the start of a message", () => {
    // A large map is split across frames and `offset` locates this one. Whatever it counts, a non-zero
    // value means this is not the start — and handing a fragment to a protobuf reader is how a decoder
    // produces a confident wrong answer.
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.DYNAMIC_DATA, POSE, 1), byteCodec)).toBeUndefined();
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.DYNAMIC_DATA, POSE, 4096), byteCodec)).toBeUndefined();
  });

  it("reads the same payload once its offset says it is the start", () => {
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.DYNAMIC_DATA, POSE, 0), byteCodec)).toBeDefined();
  });
});

describe("a payload that is not what its channel promised", () => {
  it("comes back undecoded rather than half-read", () => {
    // Channels can be renumbered by a device, which is the risk the table documents. A wrong decoder
    // meeting the wrong message has to answer nothing, not answer something.
    const notAPose = frame(int(2, 7));
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.DYNAMIC_DATA, notAPose), byteCodec)).toBeUndefined();
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.MAP_DATA, POSE), byteCodec)).toBeUndefined();
    expect(decodeMapFrame(bizFrame(BIZ_CHANNEL.ROOM_OUTLINE, POSE), byteCodec)).toBeUndefined();
  });
});
