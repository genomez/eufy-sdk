import { buildSignPreimage, swapMd5, SIGN_ALLOWLIST, StubSigner, HmacSigner } from "../sign.js";

describe("Tuya sign preimage", () => {
  // The exact params of a real `smartlife.p.time.get` request (bizData/sdkVersion present on the
  // wire but NOT in the sign). This is the load-bearing golden vector from the live capture.
  const params = {
    a: "smartlife.p.time.get",
    v: "1.0",
    et: "3",
    time: "1783934864",
    requestId: "5b5e39e5-4bfa-475c-ab6d-63170ac6f22f",
    lang: "en_GB",
    sid: "eu17712350978973Mm5DV9a39459fdcdcb2ee61bbec8b7dda373c18c",
    deviceId: "7932c5202387dffd14f2e2d75e0fbb8efa1cf7f28be5",
    chKey: "7cbfe6d8",
    os: "Android",
    ttid: "android",
    appVersion: "6.0.51_26722",
    clientId: "w8x4ppqkdxvqnd73ahj9",
    // Present on the wire, MUST be excluded from the sign:
    bizData: JSON.stringify({ customDomainSupport: "1" }),
    sdkVersion: "7.5.0",
    platform: "google",
  };

  const EXPECTED_PREIMAGE =
    "a=smartlife.p.time.get||appVersion=6.0.51_26722||chKey=7cbfe6d8||clientId=w8x4ppqkdxvqnd73ahj9||" +
    "deviceId=7932c5202387dffd14f2e2d75e0fbb8efa1cf7f28be5||et=3||lang=en_GB||os=Android||" +
    "requestId=5b5e39e5-4bfa-475c-ab6d-63170ac6f22f||" +
    "sid=eu17712350978973Mm5DV9a39459fdcdcb2ee61bbec8b7dda373c18c||time=1783934864||ttid=android||v=1.0";

  it("reproduces the known live preimage exactly", () => {
    expect(buildSignPreimage(params)).toBe(EXPECTED_PREIMAGE);
  });

  it("excludes bizData / sdkVersion / non-allowlisted keys", () => {
    const pre = buildSignPreimage(params);
    expect(pre).not.toContain("bizData");
    expect(pre).not.toContain("sdkVersion");
    expect(pre).not.toContain("platform");
  });

  it("sorts keys ascending and joins with ||", () => {
    const pre = buildSignPreimage({ v: "1.0", a: "x", os: "Android" });
    expect(pre).toBe("a=x||os=Android||v=1.0");
  });

  it("drops undefined and empty-string values", () => {
    const pre = buildSignPreimage({ a: "x", sid: "", lang: undefined });
    expect(pre).toBe("a=x");
  });

  it("SIGN_ALLOWLIST omits bizData and sdkVersion but includes postData", () => {
    expect(SIGN_ALLOWLIST.has("bizData")).toBe(false);
    expect(SIGN_ALLOWLIST.has("sdkVersion")).toBe(false);
    expect(SIGN_ALLOWLIST.has("postData")).toBe(true);
  });

  it("folds postData through the md5-then-swap transform in the preimage", () => {
    const postData = JSON.stringify({ devId: "abc", dpCacheType: 1 });
    const pre = buildSignPreimage({ a: "x", postData });
    // postData is NOT included verbatim; it appears as its swapMd5 fold.
    expect(pre).toBe(`a=x||postData=${swapMd5(postData)}`);
    expect(pre).not.toContain(postData);
  });
});

describe("swapMd5", () => {
  it("md5s then rotates the four 8-char blocks [b0 b1 b2 b3] -> [b1 b0 b3 b2]", () => {
    // golden vector computed from the documented transform
    const postData = JSON.stringify({ devId: "abc", dpCacheType: 1 });
    expect(swapMd5(postData)).toBe("e2687218fe93932680db50766dfbb3a9");
    expect(swapMd5(postData)).toHaveLength(32);
  });
});

describe("HmacSigner (recovered native digest)", () => {
  // The live-captured (preimage -> sign) pair; sign = HMAC-SHA256(TUYA_SIGN_K, preimage).
  // This is the load-bearing test that proves TUYA_SIGN_K is the correct app key.
  const PREIMAGE =
    "a=smartlife.p.time.get||appVersion=6.0.51_26722||chKey=7cbfe6d8||clientId=w8x4ppqkdxvqnd73ahj9||" +
    "deviceId=7932c5202387dffd14f2e2d75e0fbb8efa1cf7f28be5||et=3||lang=en_GB||os=Android||" +
    "requestId=5b5e39e5-4bfa-475c-ab6d-63170ac6f22f||" +
    "sid=eu17712350978973Mm5DV9a39459fdcdcb2ee61bbec8b7dda373c18c||time=1783934864||ttid=android||v=1.0";
  const KNOWN_SIGN = "97a78b35ce00fcd7cf90f428a3ff2150acc45a8b6ce3f6de4126a0514a7f8c84";

  it("reproduces the live-captured sign from its preimage (HMAC-SHA256 with the built-in key)", () => {
    expect(new HmacSigner().sign(PREIMAGE)).toBe(KNOWN_SIGN);
  });

  it("env var TUYA_SIGN_KEY overrides the built-in key when set", () => {
    const saved = process.env.TUYA_SIGN_KEY;
    process.env.TUYA_SIGN_KEY = "custom-key";
    try {
      // wrong key → wrong sign
      expect(new HmacSigner().sign(PREIMAGE)).not.toBe(KNOWN_SIGN);
    } finally {
      if (saved !== undefined) process.env.TUYA_SIGN_KEY = saved;
      else delete process.env.TUYA_SIGN_KEY;
    }
  });
});

describe("StubSigner", () => {
  it("throws (native digest not implemented)", () => {
    expect(() => new StubSigner().sign("anything")).toThrow(/native sign not yet implemented/);
  });
});
