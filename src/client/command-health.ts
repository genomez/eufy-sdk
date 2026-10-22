import { performance } from "node:perf_hooks";
import type { CommandReceipt, PropertyCommandHealth } from "../core/contracts.js";

export const COMMAND_FAST_REFUSAL_MAX_MS = 1_000;
export const COMMAND_FAST_REFUSAL_WINDOW_MS = 60_000;
export const COMMAND_FAST_REFUSAL_THRESHOLD = 2;
export const COMMAND_DEGRADED_COOLDOWN_MS = 600_000;
const CAPACITY = 1_024;

/** Property-scoped command permission; it makes no claim about observed device state. */
export interface CommandHealthEvent extends PropertyCommandHealth {
  device: string;
  property: string;
}

/** Descendants retain explicit lineage even when property invocation ownership changes. */
export interface CommandHealthToken {
  readonly key: string;
  readonly lineage: number;
  readonly automatic: boolean;
  readonly controller: AbortController;
  sent: boolean;
  suppressed: boolean;
  responseObserved: boolean;
}

interface Entry {
  device: string;
  property: string;
  lineage: number;
  revision: number;
  firstFastAt?: number;
  fastCount: number;
  degradedUntil: number;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  pending: Set<CommandHealthToken>;
}

/** One bounded gate covers all automatic descendants of the latest explicit property intent. */
export class CommandHealthGate {
  private readonly entries = new Map<string, Entry>();
  private revision = 0;
  private readonly stats = { activations: 0, suppressedSends: 0, fastRefusals: 0, cooldownExpiries: 0 };

  constructor(
    private readonly event: (event: CommandHealthEvent) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Explicit commands replace evidence lineage without shortening an active cooldown. */
  bind(device: string, property: string, ordinal: number, automatic: boolean): CommandHealthToken | undefined {
    this.prune();
    const key = JSON.stringify([device, property]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= CAPACITY) return undefined;
      entry = {
        device,
        property,
        lineage: ordinal,
        revision: this.revision,
        fastCount: 0,
        degradedUntil: 0,
        expiresAt: this.now() + COMMAND_DEGRADED_COOLDOWN_MS,
        pending: new Set(),
      };
      this.entries.set(key, entry);
    }
    if (entry.pending.size >= CAPACITY) return undefined;
    if (!automatic) {
      entry.lineage = ordinal;
      entry.firstFastAt = undefined;
      entry.fastCount = 0;
    }
    entry.expiresAt = Math.max(entry.expiresAt, this.now() + COMMAND_DEGRADED_COOLDOWN_MS);
    const token: CommandHealthToken = {
      key,
      lineage: entry.lineage,
      automatic,
      controller: new AbortController(),
      sent: false,
      suppressed: false,
      responseObserved: false,
    };
    entry.pending.add(token);
    if (automatic && this.health(entry).status === "command_degraded") this.suppress(token);
    return token;
  }

  /** Retry children reuse their original explicit lineage without replacing property authority. */
  child(parent: CommandHealthToken): CommandHealthToken | undefined {
    const entry = this.entries.get(parent.key);
    if (!entry || entry.lineage !== parent.lineage || entry.pending.size >= CAPACITY) return undefined;
    const token: CommandHealthToken = {
      ...parent,
      automatic: true,
      controller: new AbortController(),
      sent: false,
      suppressed: false,
      responseObserved: false,
    };
    entry.pending.add(token);
    if (this.health(entry).status === "command_degraded") this.suppress(token);
    return token;
  }

  release(token: CommandHealthToken | undefined): void {
    if (token) this.entries.get(token.key)?.pending.delete(token);
  }

  /** Only correlated on-wire responses enter the gate, before station admission resumes. */
  response(token: CommandHealthToken | undefined, receipt: CommandReceipt): void {
    if (
      !token ||
      token.responseObserved ||
      !receipt.sendAttempted ||
      !["acknowledged", "rejected"].includes(receipt.status) ||
      !Number.isFinite(receipt.responseLatencyMs)
    )
      return;
    token.responseObserved = true;
    if (
      receipt.status !== "rejected" ||
      receipt.rejectionCode !== -108 ||
      !receipt.sendAttempted ||
      !Number.isFinite(receipt.responseLatencyMs) ||
      receipt.responseLatencyMs! < 0 ||
      receipt.responseLatencyMs! > COMMAND_FAST_REFUSAL_MAX_MS
    )
      return;
    const entry = this.entries.get(token.key);
    if (!entry || entry.lineage !== token.lineage) return;
    this.stats.fastRefusals++;
    const now = this.now();
    if (this.health(entry).status === "command_degraded") return;
    if (entry.firstFastAt === undefined || now - entry.firstFastAt > COMMAND_FAST_REFUSAL_WINDOW_MS) {
      entry.firstFastAt = now;
      entry.fastCount = 0;
    }
    if (++entry.fastCount < COMMAND_FAST_REFUSAL_THRESHOLD) return;
    entry.degradedUntil = now + COMMAND_DEGRADED_COOLDOWN_MS;
    entry.revision = ++this.revision;
    entry.expiresAt = Math.max(entry.expiresAt, entry.degradedUntil);
    this.stats.activations++;
    for (const pending of entry.pending) if (pending.automatic && !pending.sent) this.suppress(pending);
    entry.timer = setTimeout(() => this.health(entry!), COMMAND_DEGRADED_COOLDOWN_MS);
    entry.timer.unref?.();
    this.event({ device: entry.device, property: entry.property, ...this.health(entry) });
  }

  /** Suppression is counted once per unsent automatic invocation. */
  private suppress(token: CommandHealthToken): void {
    if (token.sent || token.suppressed) return;
    token.suppressed = true;
    this.stats.suppressedSends++;
    token.controller.abort(new Error("automatic command suppressed: command_degraded"));
  }

  status(device: string, property: string): PropertyCommandHealth {
    const entry = this.entries.get(JSON.stringify([device, property]));
    return entry ? this.health(entry) : { status: "healthy", cooldownRemainingMs: 0, revision: this.revision };
  }

  private health(entry: Entry): PropertyCommandHealth {
    const remaining = Math.max(0, entry.degradedUntil - this.now());
    if (entry.degradedUntil > 0 && remaining === 0) {
      entry.degradedUntil = 0;
      entry.revision = ++this.revision;
      entry.firstFastAt = undefined;
      entry.fastCount = 0;
      clearTimeout(entry.timer);
      entry.timer = undefined;
      this.stats.cooldownExpiries++;
      this.event({
        device: entry.device,
        property: entry.property,
        status: "healthy",
        cooldownRemainingMs: 0,
        revision: entry.revision,
      });
    }
    return {
      status: remaining > 0 ? "command_degraded" : "healthy",
      cooldownRemainingMs: remaining,
      revision: entry.revision,
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      this.health(entry);
      if (entry.pending.size === 0 && entry.degradedUntil === 0 && now >= entry.expiresAt) this.entries.delete(key);
    }
  }

  diagnostics() {
    this.prune();
    return {
      ...this.stats,
      entries: this.entries.size,
      activeDegraded: [...this.entries.values()].filter((entry) => entry.degradedUntil > this.now()).length,
      capacity: CAPACITY,
    };
  }

  close(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      for (const token of entry.pending) if (token.automatic && !token.sent) token.controller.abort();
    }
    this.entries.clear();
  }
}
