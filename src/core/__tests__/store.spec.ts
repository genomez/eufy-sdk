import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSessionStore } from "../store.js";
import { FileFcmStore } from "../../transport/push/store.js";

/** A write that dies part-way, as a full disk or a killed process leaves it. */
const partialWrite = vi.hoisted(() => ({
  armed: false,
  createCode: "",
  renameCode: "",
  writes: [] as Array<{ path: string; mode?: number; flag?: string }>,
  links: new Map<string, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    realpathSync: (path: string) => {
      if (partialWrite.links.has(path)) throw Object.assign(new Error("synthetic dangling link"), { code: "ENOENT" });
      return real.realpathSync(path);
    },
    lstatSync: (path: string) => (partialWrite.links.has(path) ? { isSymbolicLink: () => true } : real.lstatSync(path)),
    readlinkSync: (path: string) => partialWrite.links.get(path) ?? real.readlinkSync(path),
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      if (partialWrite.renameCode)
        throw Object.assign(new Error("synthetic rename failure"), { code: partialWrite.renameCode });
      return real.renameSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      const [path, , options] = args;
      const opts = typeof options === "object" ? options : undefined;
      partialWrite.writes.push({ path: String(path), mode: opts?.mode as number, flag: opts?.flag });
      if (partialWrite.createCode && String(path).endsWith(".tmp"))
        throw Object.assign(new Error("synthetic temp creation failure"), { code: partialWrite.createCode });
      if (!partialWrite.armed) return real.writeFileSync(...args);
      const [file, data, writeOptions] = args;
      real.writeFileSync(file, String(data).slice(0, 5), writeOptions);
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    },
  };
});

/**
 * Both file stores keep a complete, owner-only record on disk: a write that fails part-way leaves the
 * previous record readable, and every atomic save leaves the file at `0o600`, including one that existed first.
 */
describe.each([
  ["FileSessionStore", (p: string) => new FileSessionStore<unknown>(p)],
  ["FileFcmStore", (p: string) => new FileFcmStore(p) as FileSessionStore<unknown>],
])("%s", (_name, make) => {
  afterEach(() => {
    partialWrite.armed = false;
    partialWrite.createCode = "";
    partialWrite.renameCode = "";
    partialWrite.writes = [];
    partialWrite.links.clear();
  });

  const fresh = () => join(mkdtempSync(join(tmpdir(), "store-spec-")), "s.json");

  it("resolves relative dangling-link chains and creates missing target directories", () => {
    const link = fresh();
    const next = resolve(dirname(link), "nested", "next-link.json");
    const target = resolve(dirname(link), "target", "record.json");
    partialWrite.links.set(link, join("nested", "next-link.json"));
    partialWrite.links.set(next, join("..", "target", "record.json"));

    make(link).save({ token: "synthetic" });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ token: "synthetic" });
    expect(partialWrite.links.size).toBe(2);
    expect(readdirSync(dirname(target))).toEqual(["record.json"]);
    expect(partialWrite.writes).toHaveLength(1);
    expect(partialWrite.writes[0]!.path.startsWith(target + ".")).toBe(true);
  });

  it("creates nested directories and replaces complete records using exclusive owner-only temp files", () => {
    const path = join(fresh(), "nested", "record.json");
    const store = make(path);
    store.save({ token: "first" });
    store.save({ token: "second" });
    expect(store.load()).toEqual({ token: "second" });
    const writes = partialWrite.writes;
    expect(writes).toHaveLength(2);
    expect(writes.every((write) => write.path.startsWith(path + ".") && write.path.endsWith(".tmp"))).toBe(true);
    expect(new Set(writes.map((write) => write.path)).size).toBe(2);
    expect(writes.every((write) => write.mode === 0o600 && write.flag === "wx")).toBe(true);
    expect(readdirSync(join(path, ".."))).toEqual(["record.json"]);
  });

  it.each(["EACCES", "EPERM", "EBUSY", "EXDEV", "EROFS"])(
    "falls back in place on %s from temp creation or rename and keeps an existing mode",
    (code) => {
      const path = fresh();
      writeFileSync(path, "{}", { mode: 0o644 });
      const mode = statSync(path).mode;
      for (const stage of ["createCode", "renameCode"] as const) {
        partialWrite[stage] = code;
        make(path).save({ stage });
        partialWrite[stage] = "";
        expect(make(path).load()).toEqual({ stage });
        expect(statSync(path).mode).toBe(mode);
        expect(readdirSync(join(path, ".."))).toEqual(["s.json"]);
      }
    },
  );

  it("keeps the previous record and cleans the temp file on an unexpected rename failure", () => {
    const path = fresh();
    const store = make(path);
    store.save({ token: "old" });
    partialWrite.renameCode = "EIO";
    expect(() => store.save({ token: "new" })).toThrow("synthetic rename failure");
    expect(store.load()).toEqual({ token: "old" });
    expect(readdirSync(join(path, ".."))).toEqual(["s.json"]);
  });

  it("keeps the previous record when a write fails part-way", () => {
    const path = fresh();
    const store = make(path);
    store.save({ token: "old-token" });

    partialWrite.armed = true;
    expect(() => store.save({ token: "new-token" })).toThrow(/ENOSPC/);
    partialWrite.armed = false;

    expect(store.load()).toEqual({ token: "old-token" });
    expect(readdirSync(join(path, ".."))).toEqual(["s.json"]);
  });

  it.skipIf(process.platform === "win32")("leaves an existing file owner-only after a save", () => {
    const path = fresh();
    writeFileSync(path, "{}", { mode: 0o644 });
    chmodSync(path, 0o644);

    make(path).save({ token: "t" });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ token: "t" });
  });

  it.skipIf(process.platform === "win32")("writes through a symlink and keeps the link", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-spec-"));
    mkdirSync(join(dir, "real"));
    const real = join(dir, "real", "target.json");
    writeFileSync(real, "{}");
    const link = join(dir, "link.json");
    symlinkSync(real, link);

    make(link).save({ token: "t" });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual({ token: "t" });
    expect(readdirSync(join(dir, "real"))).toEqual(["target.json"]);
  });

  it.skipIf(process.platform === "win32")("creates the missing target of a dangling symlink and keeps the link", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-spec-"));
    mkdirSync(join(dir, "real"));
    const link = join(dir, "link.json");
    symlinkSync(join("real", "target.json"), link);

    make(link).save({ token: "t" });

    const real = join(dir, "real", "target.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual({ token: "t" });
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "real"))).toEqual(["target.json"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "saves in place to a writable file inside a read-only directory",
    () => {
      const path = fresh();
      writeFileSync(path, "{}", { mode: 0o644 });
      const dir = join(path, "..");
      chmodSync(dir, 0o555);
      try {
        make(path).save({ token: "t" });
      } finally {
        chmodSync(dir, 0o755);
      }

      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ token: "t" });
      expect(readdirSync(dir)).toEqual(["s.json"]);
    },
  );
});
