import { createECDH } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EUFY_MEGA_LOCAL_KEY_HEX,
  EUFYLIFE_LOCAL_KEY_HEX,
  decryptBody,
  encryptBody,
  gtoken,
} from "../../../core/crypto.js";
import { MemorySessionStore, type PersistedSession } from "../../../core/store.js";
import { EufyCloudErrorCode, LoginStatus, MegaHttpClient, SessionExpiredError } from "../mega-client.js";

const HOST = "app-house-us-pr.eufy.com";
const PATH = "/app/house/get_devs_list";
const saved = (): PersistedSession => ({
  userId: "synthetic-cloud-user",
  accountUserId: "synthetic-account-user",
  authToken: "synthetic-token",
  region: "us-pr",
  openudid: "synthetic-install",
  shareKey: "00".repeat(16),
  keyIdent: "synthetic-old-key",
  tokenExpiresAt: 0,
  savedAt: Date.now(),
});
type Reply = { status: number; data: { code: number; data?: unknown; msg?: string } };

/** Actual client and crypto with only the physical HTTP boundary replaced by synthetic envelopes. */
function fixture(initial: PersistedSession | null = saved()) {
  const store = new MemorySessionStore();
  if (initial) store.save(initial);
  const save = vi.spyOn(store, "save");
  const clear = vi.spyOn(store, "clear");
  const client = new MegaHttpClient({ email: "synthetic@example.invalid", password: "", countryCode: "GB", store });
  const internals = client as any;
  const keys = new Map<string, string>([["main", initial?.shareKey ?? ""]]);
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  let reply: (url: string, body: any, headers: Record<string, string>) => Reply = () => ({
    status: 200,
    data: { code: 0, data: { devices: [] } },
  });
  internals.httpPost = vi.fn(async (url: string, body: any, headers: Record<string, string>) => {
    if (url.endsWith("/passport/estimate_domain")) {
      calls.push({ url, body, headers });
      return { status: 200, data: { code: 0, data: { domain: "app-openapi-us-pr.eufy.com" } } };
    }
    const keyHost = url.includes(".eufylife.com") ? new URL(url).host : "main";
    if (url.endsWith("/openapi/oauth/key/exchange")) {
      const local = keyHost === "main" ? EUFY_MEGA_LOCAL_KEY_HEX : EUFYLIFE_LOCAL_KEY_HEX;
      const publicKey = decryptBody(body.client_public_key, local).toString("utf8");
      const server = createECDH("prime256v1");
      server.generateKeys();
      keys.set(keyHost, server.computeSecret(Buffer.from(publicKey, "hex")).toString("hex").slice(0, 32));
      calls.push({ url, body, headers });
      return {
        status: 200,
        data: { code: 0, data: { server_public_key: encryptBody(server.getPublicKey("hex", "uncompressed"), local) } },
      };
    }
    const decoded = JSON.parse(decryptBody(body, keys.get(keyHost)!).toString("utf8"));
    calls.push({ url, body: decoded, headers });
    return reply(url, decoded, headers);
  });
  return {
    client,
    internals,
    store,
    save,
    clear,
    calls,
    keys,
    answer: (next: typeof reply) => {
      reply = next;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("accepted main-key persistence qualification", () => {
  it("traverses captcha, limited 2FA, identity renewal during verify-code dispatch, and completed login without saving a limited token", async () => {
    const f = fixture(null);
    let login = 0,
      sends = 0;
    f.answer((url, body, headers) => {
      if (url.endsWith("/passport/generate/captcha"))
        return { status: 200, data: { code: 0, data: { captcha_id: "synthetic-captcha", item: "synthetic-image" } } };
      if (url.endsWith("/passport/login")) {
        login++;
        if (login === 1)
          return { status: 403, data: { code: EufyCloudErrorCode.CAPTCHA_REQUIRED, msg: "synthetic captcha" } };
        if (login === 2) {
          expect(body.captcha_id).toBe("synthetic-captcha");
          expect(body.answer).toBe("synthetic-answer");
          return {
            status: 200,
            data: {
              code: 0,
              data: {
                ap_cloud_user_id: "synthetic-cloud-user",
                user_id: "synthetic-account-user",
                auth_token: "synthetic-limited-token",
                fa_info: { info: "synthetic-2fa" },
              },
            },
          };
        }
        expect(body.verify_code).toBe("000000");
        expect(headers["x-auth-token"]).toBe("synthetic-limited-token");
        expect(f.save).not.toHaveBeenCalled();
        return {
          status: 200,
          data: {
            code: 0,
            data: {
              ap_cloud_user_id: "synthetic-cloud-user",
              user_id: "synthetic-account-user",
              auth_token: "synthetic-final-token",
              token_expires_at: 0,
            },
          },
        };
      }
      if (url.endsWith("/app/sendmsg/verify_code")) {
        expect(f.save).not.toHaveBeenCalled();
        expect(headers["x-auth-token"]).toBe("synthetic-limited-token");
        expect(headers.gtoken).toBe(gtoken("synthetic-account-user"));
        if (++sends === 1) return { status: 463, data: { code: EufyCloudErrorCode.IDENTITY_KEY_STALE } };
      }
      return { status: 200, data: { code: 0, data: {} } };
    });
    expect((await f.client.login()).status).toBe(LoginStatus.Captcha);
    expect(f.store.load()).toBeNull();
    expect((await f.client.solveCaptcha("synthetic-answer")).status).toBe(LoginStatus.TwoFactor);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.store.load()).toBeNull();
    expect((await f.client.submitVerifyCode("000000")).status).toBe(LoginStatus.Ok);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.store.load()?.authToken).toBe("synthetic-final-token");
    expect(f.store.load()?.shareKey).toBe(f.keys.get("main"));
    expect(f.internals.mainKeyPersistencePending).toBe(false);
    expect(f.clear).not.toHaveBeenCalled();
  });

  it("does not flush a pending main key on eufylife success or identity recovery", async () => {
    const f = fixture();
    f.internals.sessionKey.createdAt -= 12 * 3600_000 + 1;
    await f.client.ensureSessionKey();
    let failures = 0;
    f.answer((url) =>
      url.includes(".eufylife.com") && failures++ === 0
        ? { status: 463, data: { code: EufyCloudErrorCode.IDENTITY_KEY_STALE } }
        : { status: 200, data: { code: 0, data: {} } },
    );
    await f.client.postSigned("security-app.eufylife.com", "/v3/synthetic", {}, true);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.internals.mainKeyPersistencePending).toBe(true);
    await f.client.postSigned(HOST, PATH, {}, true);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.store.load()?.shareKey).toBe(f.keys.get("main"));
  });

  it("retains pending state on ordinary rejection and persists on a later accepted call", async () => {
    const f = fixture();
    f.internals.sessionKey.createdAt -= 12 * 3600_000 + 1;
    f.answer(() => ({ status: 429, data: { code: 429, msg: "synthetic throttle" } }));
    await expect(f.client.postSigned(HOST, PATH)).rejects.toThrow();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.internals.mainKeyPersistencePending).toBe(true);
    f.answer(() => ({ status: 200, data: { code: 0, data: {} } }));
    await f.client.postSigned(HOST, PATH);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.clear).not.toHaveBeenCalled();
  });

  it("does not save an anonymous exchange or anonymous accepted request", async () => {
    const f = fixture(null);
    await f.client.postSigned(HOST, PATH, {}, false);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.internals.mainKeyPersistencePending).toBe(false);
  });

  it("preserves token-rejection clearing even after a main-key rotation", async () => {
    const f = fixture();
    f.internals.sessionKey.createdAt -= 12 * 3600_000 + 1;
    f.answer(() => ({ status: 401, data: { code: EufyCloudErrorCode.SESSION_KICKED, msg: "synthetic rejection" } }));
    await expect(f.client.postSigned(HOST, PATH)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(f.clear).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.store.load()).toBeNull();
    expect(f.internals.mainKeyPersistencePending).toBe(false);
  });

  it("contains a throwing diagnostic sink and retries only persistence on the next normal call", async () => {
    const f = fixture();
    f.internals.sessionKey.createdAt -= 12 * 3600_000 + 1;
    f.save.mockImplementationOnce(() => {
      throw new Error("synthetic cache failure");
    });
    f.internals.logger = {
      debug() {},
      info() {},
      error() {},
      warn() {
        throw new Error("synthetic warning failure");
      },
    };
    await expect(f.client.postSigned(HOST, PATH)).resolves.toEqual({ devices: [] });
    expect(f.internals.auth_.authToken).toBe("synthetic-token");
    expect(f.internals.mainKeyPersistencePending).toBe(true);
    const count = f.calls.length;
    await f.client.postSigned(HOST, PATH);
    expect(f.calls.length).toBe(count + 1);
    expect(f.save).toHaveBeenCalledTimes(2);
    expect(f.internals.mainKeyPersistencePending).toBe(false);
    expect(f.clear).not.toHaveBeenCalled();
  });
});
