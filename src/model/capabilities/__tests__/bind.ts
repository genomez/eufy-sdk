import { buildActions } from "../index.js";
import { camelCase } from "../access.js";
import type { Capability } from "../../types.js";
import type { CommandContext } from "../types.js";
import type { MemberDeps } from "../members.js";
import type { Command } from "../../../core/contracts.js";

/**
 * The bound `dev.<cap>()` object plus the commands it sent — what a caller actually holds.
 *
 * A module's `actions()` is no longer the whole surface: a control's setter is derived in the barrel
 * from the same entry that declares its getter, so a spec that calls `MODULE.actions()` directly sees
 * only the hand-written half. Binding through `buildActions` is what a device does, and it is the only
 * view where the derived setters and the evidence-gated getters both exist.
 */
export function bind<T>(
  capability: Capability,
  ctx: CommandContext,
  deps: Partial<Omit<MemberDeps, "ctx" | "sink" | "read">> & {
    /** Loosened for specs: a fixture reader may answer a narrower value type than the real reader. */
    read?: (name: string) => { value: unknown } | undefined;
  } = {},
): { acts: T; sent: Command[] } {
  const sent: Command[] = [];
  const actions = buildActions([capability], {
    ctx,
    sink: { dispatch: async (c) => void sent.push(c) },
    ...(deps as Omit<MemberDeps, "ctx" | "sink">),
    read: (deps.read ?? (() => undefined)) as MemberDeps["read"],
  });
  return { acts: (actions as Record<string, unknown>)[camelCase(capability)] as T, sent };
}
