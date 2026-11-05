import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSessionStore, type PersistedSession } from "../../../core/store.js";
import { MegaHttpClient } from "../mega-client.js";

const fault = vi.hoisted(() => ({ mode: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      if (fault.mode === "rename-eio") throw Object.assign(new Error("synthetic rename EIO"), { code: "EIO" });
      if (fault.mode === "fallback-partial")
        throw Object.assign(new Error("synthetic rename EACCES"), { code: "EACCES" });
      return real.renameSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      const partial =
        (fault.mode === "temp-partial" && String(args[0]).endsWith(".tmp")) ||
        (fault.mode === "fallback-partial" && !String(args[0]).endsWith(".tmp"));
      if (partial) {
        real.writeFileSync(args[0], String(args[1]).slice(0, 5), args[2]);
        throw Object.assign(new Error("synthetic partial ENOSPC"), { code: "ENOSPC" });
      }
      return real.writeFileSync(...args);
    },
  };
});

afterEach(() => {
  fault.mode = "";
});

describe("accepted key persistence through the physical FileSessionStore", () => {
  it.each(["temp-partial", "rename-eio", "fallback-partial"])("preserves RAM and retries after %s", async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "key-qualification-"));
    const path = join(dir, "synthetic-session.json");
    const disk = new FileSessionStore<PersistedSession>(path);
    const initial: PersistedSession = {
      userId: "synthetic-user",
      accountUserId: "synthetic-account",
      authToken: "synthetic-token",
      region: "us-pr",
      openudid: "synthetic-install",
      shareKey: "00".repeat(16),
      keyIdent: "synthetic-old",
      tokenExpiresAt: 0,
      savedAt: Date.now(),
    };
    disk.save(initial);
    const originalBytes = readFileSync(path);
    const client = new MegaHttpClient({ email: "synthetic@example.invalid", password: "", store: disk });
    const internals = client as any;
    internals.sessionKey = { ...internals.sessionKey, shareKey: "11".repeat(16), keyIdent: "synthetic-new" };
    internals.mainKeyPersistencePending = true;
    const clear = vi.spyOn(disk, "clear");
    internals.httpPost = vi.fn(async () => ({ status: 200, data: { code: 0, data: { ok: true } } }));
    fault.mode = mode;
    await expect(client.postSigned("app-house-us-pr.eufy.com", "/synthetic")).resolves.toEqual({ ok: true });
    expect(internals.auth_.authToken).toBe(initial.authToken);
    expect(internals.sessionKey.keyIdent).toBe("synthetic-new");
    expect(internals.mainKeyPersistencePending).toBe(true);
    expect(clear).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(["synthetic-session.json"]);
    if (mode === "fallback-partial") {
      expect(disk.load()).toBeNull();
      expect(readFileSync(path).equals(originalBytes)).toBe(false);
    } else expect(readFileSync(path)).toEqual(originalBytes);
    fault.mode = "";
    await client.postSigned("app-house-us-pr.eufy.com", "/synthetic");
    expect(disk.load()?.keyIdent).toBe("synthetic-new");
    expect(internals.mainKeyPersistencePending).toBe(false);
    expect(internals.httpPost).toHaveBeenCalledTimes(2);
  });
});
