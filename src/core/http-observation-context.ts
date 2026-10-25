import { AsyncLocalStorage } from "node:async_hooks";

/** HTTP attempts started in one asynchronous scope; durations cover completed attempts only. */
export interface HttpObservationCounts {
  requests: number;
  completed: number;
  totalMs: number;
  maxMs: number;
}

const scopes = new AsyncLocalStorage<HttpObservationScope>();

/**
 * Invocation-local HTTP attribution without global counter subtraction. Work started outside the
 * scope, including an existing shared promise, is not attributed to its waiters. Closing the scope
 * excludes later completions and detached follow-up work; requests minus completed is unfinished work.
 */
export class HttpObservationScope {
  private active = true;
  private readonly counts: HttpObservationCounts = { requests: 0, completed: 0, totalMs: 0, maxMs: 0 };

  run<T>(operation: () => T): T {
    return scopes.run(this, operation);
  }

  start(): ((elapsedMs: number) => void) | undefined {
    if (!this.active) return undefined;
    this.counts.requests++;
    return (elapsedMs) => {
      if (!this.active) return;
      this.counts.completed++;
      this.counts.totalMs += elapsedMs;
      this.counts.maxMs = Math.max(this.counts.maxMs, elapsedMs);
    };
  }

  finish(): HttpObservationCounts {
    this.active = false;
    return { ...this.counts };
  }
}

/** Capture the initiating scope before fetch yields; no request data enters the context. */
export function startHttpObservation(): ((elapsedMs: number) => void) | undefined {
  return scopes.getStore()?.start();
}
