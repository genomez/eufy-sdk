import { P2PSession } from "../p2p-session.js";

/**
 * A station volunteers an attached device's state as a `params` array whose ids are the cloud
 * record's own, so the session unwraps it as framing rather than leaving each capability to parse it.
 * Driven through the private frame handler: the unwrap is what is under test, not the socket.
 */
const handle = (json: unknown) => {
  const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX" });
  const frames: { params?: Record<number, string> }[] = [];
  session.on("data", (f) => frames.push(f));
  const body = Buffer.concat([Buffer.from(JSON.stringify(json), "utf8"), Buffer.from([0])]);
  (session as unknown as { handleFrame(h: unknown, p: Buffer, d: number): void }).handleFrame(
    { commandId: 1351, channel: 16, signCode: 0, bytesToRead: body.length },
    body,
    0,
  );
  return frames[0];
};

describe("P2P frame — station param report", () => {
  it("lifts a params array into the cloud's param_type → value shape", () => {
    const f = handle({
      cmd: 1829,
      payload: {
        params: [
          { dev_type: 16, param_type: 1550, param_value: "1" },
          { dev_type: 16, param_type: 1101, param_value: "30" },
        ],
      },
    });
    expect(f?.params).toEqual({ 1550: "1", 1101: "30" });
  });

  it("stringifies a numeric value, so a caller sees one type", () => {
    const f = handle({ cmd: 1829, payload: { params: [{ param_type: 1141, param_value: -64 }] } });
    expect(f?.params).toEqual({ 1141: "-64" });
  });

  it("skips an entry with no id or no value instead of storing a placeholder", () => {
    const f = handle({
      cmd: 1829,
      payload: { params: [{ param_type: 1550 }, { param_value: "1" }, { param_type: 1101, param_value: "30" }] },
    });
    expect(f?.params).toEqual({ 1101: "30" });
  });

  it("reports nothing for a notify that carries no params array", () => {
    expect(handle({ cmd: 6246, payload: { num: 0 } })?.params).toBeUndefined();
  });

  it("reports nothing when every entry was unusable", () => {
    expect(handle({ cmd: 1829, payload: { params: [{ dev_type: 16 }] } })?.params).toBeUndefined();
  });
});

describe("P2P frame — the param report is scoped to a notify", () => {
  /** Drive one frame through the private handler under an arbitrary outer command id. */
  const withCommandId = (commandId: number, json: unknown) => {
    const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX" });
    const frames: { params?: Record<number, string> }[] = [];
    session.on("data", (f) => frames.push(f));
    const body = Buffer.concat([Buffer.from(JSON.stringify(json), "utf8"), Buffer.from([0])]);
    (session as unknown as { handleFrame(h: unknown, p: Buffer, d: number): void }).handleFrame(
      { commandId, channel: 16, signCode: 0, bytesToRead: body.length },
      body,
      0,
    );
    return frames[0];
  };
  const report = { cmd: 1829, payload: { params: [{ param_type: 1550, param_value: "1" }] } };

  it("reads a notify frame's params", () => {
    expect(withCommandId(1351, report)?.params).toEqual({ 1550: "1" });
  });

  it("ignores the same array under any other command", () => {
    expect(withCommandId(1350, report)?.params).toBeUndefined();
    expect(withCommandId(1103, report)?.params).toBeUndefined();
  });

  /**
   * A camera reports its OWN state under `CMD_CAMERA_INFO`, and puts the array at the ROOT rather than under
   * `payload` — measured on two own-session cameras, each reporting the enablement param with its new value
   * within seconds of a write, on a session that was already open. Reading it is what lets a write be
   * confirmed by the device instead of by polling the account device list.
   *
   * The two shapes are what keep this honest: the notify's array is nested, this one is not, so a reply that
   * merely happens to nest an array under `payload` is still refused under this command id.
   */
  const cameraInfo = { params: [{ dev_type: 1000, param_type: 1035, param_value: "0" }] };

  it("reads a camera-info frame's own params, which sit at the root", () => {
    expect(withCommandId(1103, cameraInfo)?.params).toEqual({ 1035: "0" });
  });

  it("still refuses a nested array under camera-info, which is a reply and not a report", () => {
    expect(withCommandId(1103, report)?.params).toBeUndefined();
  });

  it("does not read a root-level array under an unrelated command", () => {
    expect(withCommandId(1350, cameraInfo)?.params).toBeUndefined();
    expect(withCommandId(1351, cameraInfo)?.params).toBeUndefined();
  });
});
