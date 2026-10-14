/** Internal proof attached to the exact failed read only after its session has retired. */
const retiredReads = new WeakSet<Error>();

/** Preserve the original error and its classification without retaining the session. */
export function markRetiredInformationRead(error: Error): void {
  retiredReads.add(error);
}

/** Consume once so one failed read cannot grant multiple accelerated retries. */
export function consumeRetiredInformationRead(error: unknown): boolean {
  return error instanceof Error && retiredReads.delete(error);
}
