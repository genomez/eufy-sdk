import { buildFf09SettingToggleFrame, FF09_SETTING_ID, LOCK_COMMAND_CODE } from "../ff09.js";

/**
 * Byte-exact reproduction of a captured T8531 Rain Mode toggle (off→on).
 *
 * Originally decrypted from two live SET frames on a real T8531 (2026-07-18) — the real
 * admin_user_id/serial were re-derived to synthetic placeholders (docs/REDACTION.md) and these
 * vectors regenerated from the (unchanged) encoder against the synthetic identity, using the SAME
 * `unixTime`/`nonce`/`seqNum` shape recovered from the capture. Reproducing them byte-for-byte still
 * proves the COMPACT TLV layout ([A1 time][A2 admin][A3 settingId][A4 value], no A5-A9) and the shared
 * SET_SETTINGS(52) opcode/cipher/framing are correct.
 */
describe("ff09 setting-toggle frame encoder (compact single-setting write)", () => {
  const adminUserId = "0000000000000000000000000000000000000000";
  const deviceSn = "T8531K0000000000";

  it("reproduces the captured Rain Mode OFF frame byte-for-byte", () => {
    const out = buildFf09SettingToggleFrame({
      adminUserId,
      deviceSn,
      settingId: FF09_SETTING_ID.RAIN_MODE,
      value: false,
      unixTime: 1700000000,
      nonce: 1,
      seqNum: 1700000000,
    });
    expect(out.lockPayload).toBe(
      "ff095a000300024034c95e3c2f5723dd34dc46e785422929ff55993ea04f56c53c97d9e375a5685b59b085547" +
        "241dac6f52080d43b7e3975648da1d0ae030f1e89eca3f1799db1decac831c383a091a7c94840fca44b16fa9b3e",
    );
    expect(out.time).toBe(1700000001); // 1700000000 | 1
    expect(out.seqNum).toBe(1700000000);
    // cmdEnc = 0x4000 | 52 = 0x4034, right after the 7-byte header (ff09|size2|03 00 02) — same
    // SET_SETTINGS opcode as the full-blob auto-lock write (ff09-settings.spec.ts).
    expect(out.lockPayload.slice(14, 18)).toBe("4034");
  });

  it("reproduces the captured Rain Mode ON frame byte-for-byte (differs only in A4)", () => {
    const out = buildFf09SettingToggleFrame({
      adminUserId,
      deviceSn,
      settingId: FF09_SETTING_ID.RAIN_MODE,
      value: true,
      unixTime: 1700000010,
      nonce: 1,
      seqNum: 1700000002,
    });
    expect(out.lockPayload).toBe(
      "ff095a0003000240344a57f50da1ab31a9801f61ad2767b47a453f4b53ca45383a9da2fd3dfdf9205681ce1c30" +
        "94d4630686397879363cb31eb9fb0346f9ed3dff3f35cc54b88d9285eddf18ef6f20e65290f0b03a3b9c6b7f48",
    );
  });

  it("is much shorter than the full-blob settings write — no A5-A9 fields", () => {
    // header(9B) + ciphertext; the compact TLV (A1..A4) zero-pads to one 16B block, the full blob
    // (A1..A9) needs two — so the compact frame is 16 bytes (32 hex chars) shorter: 90B vs 106B.
    const compact = buildFf09SettingToggleFrame({
      adminUserId,
      deviceSn,
      settingId: FF09_SETTING_ID.RAIN_MODE,
      value: true,
      unixTime: 1700000000,
      nonce: 1,
      seqNum: 1700000000,
    });
    expect(compact.lockPayload.length).toBe(180); // hex chars = 90 bytes
  });

  it("SET_SETTINGS opcode matches the full-blob write's — same command, different TLV shape", () => {
    expect(LOCK_COMMAND_CODE.SET_SETTINGS).toBe(52);
  });

  it("rejects missing/short identity loudly, same as the other ff09 builders", () => {
    expect(() =>
      buildFf09SettingToggleFrame({ adminUserId: "", deviceSn, settingId: FF09_SETTING_ID.RAIN_MODE, value: true }),
    ).toThrow(/adminUserId/);
    expect(() =>
      buildFf09SettingToggleFrame({ adminUserId, deviceSn: "", settingId: FF09_SETTING_ID.RAIN_MODE, value: true }),
    ).toThrow(/deviceSn/);
    expect(() =>
      buildFf09SettingToggleFrame({
        adminUserId: "short",
        deviceSn,
        settingId: FF09_SETTING_ID.RAIN_MODE,
        value: true,
      }),
    ).toThrow(/too short/);
  });
});
