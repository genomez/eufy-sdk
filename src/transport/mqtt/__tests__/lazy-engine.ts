import { vi } from "vitest";

/**
 * The mqtt client the code under test just created — awaited, because it no longer exists
 * synchronously.
 *
 * `mqtt` is imported lazily (see `../engine.ts`: it is +19 MB of RSS that an account with no appliance
 * never needs), so `connect()` awaits a module load before calling `mqtt.connect`. The client therefore
 * appears a few microtasks after the call rather than during it. That is the ONLY thing the specs using
 * this had to change — the promise each method returns, and everything it settles with, is unchanged.
 *
 * Takes the array rather than owning it: `vi.mock` is hoisted per file, so each spec keeps its own
 * factory and its own clients, and only this waiting is shared.
 */
export async function nextClient<T>(clients: readonly T[], index = 0): Promise<T> {
  return await vi.waitFor(() => {
    const client = clients[index];
    if (!client) throw new Error(`no mqtt client #${index} yet`);
    return client;
  });
}
