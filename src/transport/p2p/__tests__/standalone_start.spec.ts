import { randomBytes } from "node:crypto";
import {
  buildCommandHeader,
  buildRawCommandPayload,
  encryptP2PData,
  paddingP2PData,
  decryptP2PData,
  parseDataFrameHeader,
  p2pCommandEncryptionKey,
  MAGIC_WORD,
} from "../codec.js";

/**
 * Wire-shape guard for the STANDALONE camera live-start: a level-1
 * (signCode 1) CMD_CONTROL_PAYLOAD (1700) frame, frame-header `type` (streamId byte) = 11, whose
 * AES-128-ECB body is the `{commandType:1000, data:{…encryptkey…}}` START_LIVE wrapper. Mirrors the
 * exact construction in P2PSession.sendStartLiveLevel1; the functional proof is the live on-device
 * test (T8410/T8442/T8400 went from 0 frames to streaming).
 */
describe("standalone live-start (1700 / cmd 1000, level-1)", () => {
  // synthetic serial + p2p_did (right shape for p2pCommandEncryptionKey; never a real device)
  const key = Buffer.from(p2pCommandEncryptionKey("T8000P0000000000", "XXXXXXX-000000-XXXXX"));
  const encryptkey = randomBytes(128).toString("hex"); // stand-in for rsaModulus() (128-byte hex)
  const channel = 0;
  const accountId = "0000000000000000000000000000000000000000"; // synthetic — never a real account id

  function buildStartFrame(): Buffer {
    const value = JSON.stringify({
      commandType: 1000,
      data: { cmd: 1000, account_id: accountId, mChannel: channel, streamtype: 2, video_type: 12, encryptkey },
    });
    const body = encryptP2PData(paddingP2PData(Buffer.from(value, "utf-8")), key);
    return Buffer.concat([buildCommandHeader(1, 1700), buildRawCommandPayload(body, channel, 1, [0x01, 0x00], 11)]);
  }

  it("frames as XZYH cmd 1700, signCode 1, type 11 on the camera channel", () => {
    const frame = buildStartFrame();
    const xz = frame.indexOf(Buffer.from(MAGIC_WORD));
    expect(xz).toBeGreaterThanOrEqual(0);
    const h = parseDataFrameHeader(frame.subarray(xz));
    expect(h.commandId).toBe(1700);
    expect(h.signCode).toBe(1);
    expect(h.type).toBe(11);
    expect(h.channel).toBe(channel);
  });

  it("body decrypts to the START_LIVE (cmd 1000) wrapper carrying the RSA encryptkey", () => {
    const frame = buildStartFrame();
    const xz = frame.indexOf(Buffer.from(MAGIC_WORD));
    const h = parseDataFrameHeader(frame.subarray(xz));
    const body = frame.subarray(xz + 16, xz + 16 + h.bytesToRead);
    const json = JSON.parse(decryptP2PData(body, key).toString("utf-8").replace(/\0+$/, ""));
    expect(json.commandType).toBe(1000);
    expect(json.data.cmd).toBe(1000);
    expect(json.data.encryptkey).toBe(encryptkey);
    expect(json.data.streamtype).toBe(2);
    expect(json.data.video_type).toBe(12);
  });
});
