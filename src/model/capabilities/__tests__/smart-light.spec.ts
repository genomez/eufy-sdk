import { SMART_LIGHT, type RgbColor, type SmartLightActions } from "../smart-light.js";
import { bind } from "./bind.js";
import type { InboundSignal, CommandContext } from "../types.js";
import type { Command, DpInboundFrame } from "../../../core/contracts.js";

/**
 * Frames here are the real shapes captured off a T8L02 on 2026-07-28, with only the account id and
 * serial replaced by synthetic placeholders (neither appears inside the DP frame itself).
 *
 * The status report is `[ff 09][u16LE len][03][flag][02][u16BE cmd][TLV…][xor]`. Note the header
 * differs from the WRITE frame in two bytes — flag and cmdHi/cmdLo — and that the read leg's tags mean
 * different things from the write leg's: inbound `a1` is power, outbound `a1` is a timestamp.
 */
function reportFrame(fields: ReadonlyArray<[tag: number, value: readonly number[]]>, cmd = 0x0204): Buffer {
  const tlv = Buffer.concat(fields.map(([tag, v]) => Buffer.concat([Buffer.from([tag, v.length]), Buffer.from(v)])));
  const head = Buffer.from([0xff, 0x09, 0, 0, 0x03, 0x01, 0x02, cmd >> 8, cmd & 0xff]);
  const body = Buffer.concat([head, tlv]);
  body.writeUInt16LE(body.length + 1, 2);
  let xor = 0;
  for (const b of body) xor ^= b;
  return Buffer.concat([body, Buffer.from([xor])]);
}

const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

/** The exact field set a live T8L02 reported after `setBrightness(40)` while effect 10474 was running. */
const LIVE_REPORT = reportFrame([
  [0xa1, [1]],
  [0xa2, [40]],
  [0xa3, [10]],
  [0xa4, u32(10474)],
  [0xa5, [0]],
  [0xa6, u32(10474)],
  [0xa7, [2]],
]);

/**
 * Build the signal the facade hands a capability: the transport has already unwrapped the envelope and
 * validated the framing, so what arrives here is the decoded frame.
 *
 * Deliberately does NOT import the transport's parser — this layer may not, and the point of the split
 * is that a capability is testable from the contract alone. The framing itself (double-nested payload,
 * hex inner, the status byte, malformed input) is covered where it lives, in the dp-codec spec.
 */
function signalOf(frame: DpInboundFrame | undefined, topic?: string): InboundSignal {
  return {
    source: "mqtt",
    deviceSn: "T8000P0000000000",
    topic: topic ?? "cmd/eufy_life/T8L02/T8000P0000000000/app/res",
    raw: {},
    frame,
  };
}

/** Split a raw TLV run into the fields the transport would hand over. */
function fieldsOf(buf: Buffer): Array<{ tag: number; value: Buffer }> {
  const out: Array<{ tag: number; value: Buffer }> = [];
  for (let i = 0; i + 1 < buf.length;) {
    const len = buf[i + 1];
    if (i + 2 + len > buf.length) break;
    out.push({ tag: buf[i], value: buf.subarray(i + 2, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

function mqttSignal(frame: Buffer, opts: { topic?: string; cmd?: number } = {}): InboundSignal {
  const hasStatus = frame.readUInt16BE(7) >> 8 === 0x0a;
  const tlv = frame.subarray(9 + (hasStatus ? 1 : 0), frame.length - 1);
  return signalOf(
    {
      envelopeCmd: opts.cmd ?? 16,
      cmd: frame.readUInt16BE(7),
      status: hasStatus ? frame[9] : undefined,
      fields: fieldsOf(tlv),
    },
    opts.topic,
  );
}

const ctx: CommandContext = { channel: 0, codec: "light", paramIds: new Set<number>() };

describe("smart_light capability module", () => {
  it("declares the capability, the light-codec baseline, and typed reads over the report tags", () => {
    expect(SMART_LIGHT.capability).toBe("smart_light");
    expect(SMART_LIGHT.detection?.codecs).toEqual(["light"]);
    const { acts } = bind<SmartLightActions>("smart_light", ctx);
    expect(Object.keys(Object.getOwnPropertyDescriptors(acts)).filter((k) => !k.startsWith("set"))).toEqual([
      "on",
      "off",
      "power",
      "brightness",
      "lightLength",
      "effectId",
      "colorGradient",
      "cloudEffectId",
      "refreshState",
    ]);
  });

  it("exposes no typed getter for a tag whose value space isn't evidenced", () => {
    // 0xa7 (lightEffectMode) is decoded and readable via getProperty, but must not be a typed read.
    expect(SMART_LIGHT.properties.some((p) => p.name === "lightEffectMode")).toBe(true);
    expect(bind<SmartLightActions>("smart_light", ctx).acts).not.toHaveProperty("lightEffectMode");
  });

  it("decodes every evidenced field of a live status report into namespaced params", () => {
    expect(SMART_LIGHT.decodeState?.(mqttSignal(LIVE_REPORT))).toEqual({
      params: { 161: "1", 162: "40", 163: "10", 164: "10474", 165: "0", 166: "10474", 167: "2" },
    });
  });

  it("reads power from tag 0xa1 — NOT 0xa3, which is the strip length on this leg", () => {
    const off = reportFrame([
      [0xa1, [0]],
      [0xa3, [10]],
    ]);
    expect(SMART_LIGHT.decodeEvent?.(mqttSignal(off))?.payload).toMatchObject({ power: false });
    expect(SMART_LIGHT.decodeState?.(mqttSignal(off))?.params).toEqual({ 161: "0", 163: "10" });
  });

  it("surfaces the report as one smartLightState event", () => {
    expect(SMART_LIGHT.decodeEvent?.(mqttSignal(LIVE_REPORT))).toEqual({
      event: "smartLightState",
      payload: {
        power: true,
        brightness: 40,
        lightLength: 10,
        effectId: 10474,
        colorGradient: false,
        cloudEffectId: 10474,
      },
    });
  });

  it("decodes the 0x0A00 get-reply, whose widths and mode tag differ from the notify", () => {
    // Real reply captured from a T8L02: status byte before the TLVs, a3/a4 two bytes wide, a7 a
    // 16-byte LED bit array, and the effect mode moved to a8 (the app's isEvent=false branch).
    const reply = Buffer.from(
      "ff093a000300020a0000a10100a20155a3020a00a402ea28a50100a60400000000" +
        "a71000000000000000000000000000000000a80100a90100ee",
      "hex",
    );
    expect(SMART_LIGHT.decodeState?.(mqttSignal(reply))?.params).toEqual({
      161: "0",
      162: "85",
      163: "10",
      164: "10474",
      165: "0",
      166: "0",
      167: "0",
    });
  });

  it("does not read the get-reply's LED bit array as an effect mode", () => {
    // a7 is 16 bytes here; decoding it with the notify's table would report a bitmap as the mode.
    const reply = Buffer.from(
      "ff093a000300020a0000a10100a20155a3020a00a402ea28a50100a60400000000" +
        "a710ff000000000000000000000000000000a80107a90100ee",
      "hex",
    );
    // 167 comes from a8 (7), never from the 16-byte a7.
    expect(SMART_LIGHT.decodeState?.(mqttSignal(reply))?.params[167]).toBe("7");
  });

  it("ignores the ack frame (0x0A01) — a bare status byte where TLVs would be", () => {
    const ack = Buffer.from([0xff, 0x09, 0x0b, 0x00, 0x03, 0x00, 0x02, 0x0a, 0x01, 0x00, 0xf7]);
    expect(SMART_LIGHT.decodeEvent?.(mqttSignal(ack))).toBeNull();
    expect(SMART_LIGHT.decodeState?.(mqttSignal(ack))).toBeNull();
  });

  it("ignores the OUTBOUND dispatch id — inbound reports carry a different head.cmd", () => {
    expect(SMART_LIGHT.decodeEvent?.(mqttSignal(LIVE_REPORT, { cmd: 17 }))).toBeNull();
  });

  it("ignores non-mqtt signals", () => {
    expect(SMART_LIGHT.decodeEvent?.({ source: "poll", deviceSn: "x", paramType: 1, params: {} })).toBeNull();
  });

  it("decodes on frame evidence, not on the topic it arrived from", () => {
    // The topic a line reports on is transport's business, so the decode must not depend on it: a valid
    // frame decodes wherever it arrives, and another line's payload is rejected by the frame checks
    // rather than by a hard-coded topic prefix.
    const odd = mqttSignal(LIVE_REPORT, { topic: "cmd/eufy_home/T2351/T8000P0000000000/res" });
    expect(SMART_LIGHT.decodeState?.(odd)?.params[161]).toBe("1");

    const foreign: InboundSignal = {
      source: "mqtt",
      deviceSn: "T8000P0000000000",
      topic: "cmd/eufy_life/T8L02/T8000P0000000000/app/res",
      raw: { head: { cmd: 65537 }, payload: JSON.stringify({ data: {} }) },
    };
    expect(SMART_LIGHT.decodeState?.(foreign)).toBeNull();
    expect(SMART_LIGHT.decodeEvent?.(foreign)).toBeNull();
  });

  it("skips a known tag too wide to be the numeric it should be, keeping the rest", () => {
    // Widths legitimately vary per frame (a4 is 4 bytes on the notify, 2 on the reply), so anything up
    // to 4 is read as a little-endian number; wider is a shape that isn't reversed and must be skipped
    // rather than truncated to a plausible value.
    const odd = reportFrame([
      [0xa1, [1]],
      [0xa4, [1, 2, 3, 4, 5, 6, 7, 8]],
      [0xa2, [70]],
    ]);
    expect(SMART_LIGHT.decodeState?.(mqttSignal(odd))?.params).toEqual({ 161: "1", 162: "70" });
  });

  it("skips a zero-length field rather than reading it as 0", () => {
    const odd = reportFrame([
      [0xa1, [1]],
      [0xa2, []],
    ]);
    expect(SMART_LIGHT.decodeState?.(mqttSignal(odd))?.params).toEqual({ 161: "1" });
  });

  it("passes over an unknown tag without dropping the fields around it", () => {
    const withA9 = reportFrame([
      [0xa1, [1]],
      [0xa9, [2, 0, 0, 0, 0xea, 0x28, 0, 0, 0x73, 0x05, 0, 0]],
      [0xa2, [90]],
    ]);
    expect(SMART_LIGHT.decodeState?.(mqttSignal(withA9))?.params).toEqual({ 161: "1", 162: "90" });
  });

  it("returns null when the transport did not recognise the message as a DP frame", () => {
    // Malformed framing is the transport's to reject (covered in the dp-codec spec); the capability's
    // job is simply to do nothing when no frame arrived.
    expect(SMART_LIGHT.decodeState?.(signalOf(undefined))).toBeNull();
    expect(SMART_LIGHT.decodeEvent?.(signalOf(undefined))).toBeNull();
  });

  it("returns null for a frame command it has no tag table for", () => {
    expect(SMART_LIGHT.decodeState?.(signalOf({ envelopeCmd: 16, cmd: 0x0a01, fields: [] }))).toBeNull();
  });
});

describe("smart_light write path", () => {
  /** The bound object: a member's setter is derived in the barrel, not returned by `actions()`. */
  const spy = (over: Partial<CommandContext> = {}) => bind<SmartLightActions>("smart_light", { ...ctx, ...over });
  const colorSpy = (model: string | undefined, lightLength?: unknown) =>
    bind<SmartLightActions>(
      "smart_light",
      { ...ctx, model },
      {
        read: (name) => (name === "lightLength" && lightLength !== undefined ? { value: lightLength } : undefined),
      },
    );

  it("on()/off() emit setDeviceInfoPayloadData (cmd 0x0201) with tag 0xa3 = isOn", async () => {
    const { acts, sent } = spy();
    await acts.on!();
    await acts.off!();
    expect(sent[0]).toEqual({
      kind: "mqtt-dp",
      mqttCmdCode: 17,
      cmdCode: 0x0201,
      fields: [{ tag: 0xa3, value: Buffer.from([1]) }],
    });
    expect(sent[1]).toEqual({
      kind: "mqtt-dp",
      mqttCmdCode: 17,
      cmdCode: 0x0201,
      fields: [{ tag: 0xa3, value: Buffer.from([0]) }],
    });
  });

  it("set() emits the same frame as on()/off(), taking the state as a value", async () => {
    const { acts, sent } = spy();
    await acts.set!(true);
    await acts.set!(false);
    expect((sent[0] as Extract<Command, { kind: "mqtt-dp" }>).fields).toEqual([{ tag: 0xa3, value: Buffer.from([1]) }]);
    expect((sent[1] as Extract<Command, { kind: "mqtt-dp" }>).fields).toEqual([{ tag: 0xa3, value: Buffer.from([0]) }]);
  });

  it("setBrightness() emits tag 0xa4, rejecting anything outside 0-100 rather than clamping it", async () => {
    const { acts, sent } = spy();
    await acts.setBrightness!(50);
    await expect(acts.setBrightness!(150)).rejects.toThrow(
      /brightness: 150 is not a valid value \(must be in 0\.\.100\)/,
    );
    expect((sent[0] as Extract<Command, { kind: "mqtt-dp" }>).fields).toEqual([
      { tag: 0xa4, value: Buffer.from([50]) },
    ]);
    expect(sent).toHaveLength(1);
  });

  it("refreshState() and realtimeInit() both ask for every field (cmd 0x0200, a3 = 0x1FFF)", async () => {
    const { acts, sent } = spy();
    await acts.refreshState!();
    const expected = {
      kind: "mqtt-dp",
      mqttCmdCode: 17,
      cmdCode: 0x0200,
      fields: [{ tag: 0xa3, value: Buffer.from([0xff, 0x1f, 0x00, 0x00]) }],
    };
    expect(sent[0]).toEqual(expected);
    expect(SMART_LIGHT.realtimeInit?.(ctx)).toEqual([expected]);
  });

  it("setEffect emits the transport-neutral preset intent, carrying both feature ids", async () => {
    const { acts, sent } = spy({ model: "T8L02" });
    await acts.setEffect!(10474);
    expect(sent[0]).toEqual({
      kind: "mqtt-dp-preset",
      mqttCmdCode: 17,
      cmdCode: 0x020d,
      companionCmdCode: 0x0201,
      presetId: 10474,
    });
  });

  it("setEffect rejects (never sends) on a family member whose effect encoding isn't captured", async () => {
    const { acts, sent } = spy({ model: "T8L20" });
    await expect(acts.setEffect!(10474)).rejects.toThrow(/verified only on/i);
    expect(sent).toHaveLength(0); // nothing dispatched to the wire
  });

  it("setColor emits one color-only intent from RGB and reported segment evidence", async () => {
    const state = { value: 10 };
    const { acts, sent } = bind<SmartLightActions>(
      "smart_light",
      { ...ctx, model: " t8l02 " },
      {
        read: (name) => (name === "lightLength" ? state : undefined),
      },
    );

    await acts.setColor!({ red: 255, green: 128, blue: 0 });

    expect(sent).toEqual([
      {
        kind: "mqtt-dp-color",
        mqttCmdCode: 17,
        cmdCode: 0x0206,
        red: 255,
        green: 128,
        blue: 0,
        segmentCount: 10,
      },
    ]);
    expect(state.value).toBe(10);
    expect(acts).not.toHaveProperty("color");
  });

  it.each(["T8L01", "T8L02X", "T8L20", undefined])(
    "setColor is absent without dispatch on unsupported model %s",
    (model) => {
      const { acts, sent } = colorSpy(model, 10);
      expect(acts.setColor).toBeUndefined();
      expect(sent).toHaveLength(0);
    },
  );

  it.each([undefined, 0, -1, 1.5, 255])(
    "setColor rejects without dispatch when segment evidence is %s",
    async (lightLength) => {
      const { acts, sent } = colorSpy("T8L02", lightLength);
      await expect(acts.setColor!({ red: 1, green: 2, blue: 3 })).rejects.toThrow(/segment count/i);
      expect(sent).toHaveLength(0);
    },
  );

  it.each([
    { red: -1, green: 0, blue: 0 },
    { red: 256, green: 0, blue: 0 },
    { red: 1.5, green: 0, blue: 0 },
    { red: Number.NaN, green: 0, blue: 0 },
    { red: 0, green: Number.POSITIVE_INFINITY, blue: 0 },
  ])("setColor rejects malformed channels without dispatch: $red/$green/$blue", async (color) => {
    const { acts, sent } = colorSpy("T8L02", 10);
    await expect(acts.setColor!(color)).rejects.toThrow(/RGB channels/i);
    expect(sent).toHaveLength(0);
  });

  it("on/off/brightness still work on an unconfirmed family member (not gated)", async () => {
    const { acts, sent } = spy({ model: "T8L20" });
    await acts.on!();
    await acts.setBrightness!(40);
    expect(sent).toHaveLength(2);
  });
});

/**
 * The derived surface, pinned at COMPILE time — these assertions have no runtime half, which is the
 * point: what a developer sees in the editor is the same table the runtime installs from, and the two
 * cannot drift. Checked by `npm run typecheck`; a widened type fails the build here.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
declare const light: SmartLightActions;

// A getter is optional (nothing is reported before the first status frame) and narrowed to its type.
const _power: Exact<typeof light.power, boolean | undefined> = true;
const _brightness: Exact<typeof light.brightness, number | undefined> = true;
const _effectId: Exact<typeof light.effectId, number | undefined> = true;

// The setter a member names for itself, and the one derived from the key.
const _set: Exact<Parameters<typeof light.set>[0], boolean> = true;
const _setBrightness: Exact<Parameters<typeof light.setBrightness>[0], number> = true;

// A momentary action takes nothing and answers nothing.
const _refresh: Exact<typeof light.refreshState, () => Promise<void>> = true;

// The model-gated write is a method, so it keeps its own signature rather than a value setter's.
const _setEffect: Exact<typeof light.setEffect, (lightId: number) => Promise<void>> = true;
const _setColor: Exact<typeof light.setColor, ((color: RgbColor) => Promise<void>) | undefined> = true;
const _rgb: Exact<RgbColor, { red: number; green: number; blue: number }> = true;

// Reported but unexposed: no getter, and no setter either, since it declares no write.
const _noModeGetter: Exact<"lightEffectMode" extends keyof SmartLightActions ? true : false, false> = true;
const _noModeSetter: Exact<"setLightEffectMode" extends keyof SmartLightActions ? true : false, false> = true;

// A read-only member gets no setter.
const _noEffectIdSetter: Exact<"setEffectId" extends keyof SmartLightActions ? true : false, false> = true;

export const _surfaceAssertions = [
  _power,
  _brightness,
  _effectId,
  _set,
  _setBrightness,
  _refresh,
  _setEffect,
  _setColor,
  _rgb,
  _noModeGetter,
  _noModeSetter,
  _noEffectIdSetter,
];
