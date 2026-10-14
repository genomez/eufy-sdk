/**
 * Persistence for FCM credentials + seen persistent-ids, so we register the FCM
 * token ONCE and just reconnect (and don't re-receive old pushes) across runs.
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { FcmCredentials } from "./types.js";

export interface PersistedPush {
  creds: FcmCredentials;
  persistentIds: string[];
}

export interface FcmStore {
  load(): PersistedPush | null;
  save(p: PersistedPush): void;
  clear(): void;
}

export class MemoryFcmStore implements FcmStore {
  private p: PersistedPush | null = null;
  load(): PersistedPush | null {
    return this.p;
  }
  save(p: PersistedPush): void {
    this.p = p;
  }
  clear(): void {
    this.p = null;
  }
}

export class FileFcmStore implements FcmStore {
  constructor(private readonly path: string) {}
  load(): PersistedPush | null {
    try {
      return JSON.parse(readFileSync(this.path, "utf-8")) as PersistedPush;
    } catch {
      return null;
    }
  }
  save(p: PersistedPush): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* exists */
    }
    writeFileSync(this.path, JSON.stringify(p, null, 2), { mode: 0o600 });
  }
  clear(): void {
    try {
      rmSync(this.path);
    } catch {
      /* gone */
    }
  }
}
