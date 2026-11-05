/** Internal proof attached to the exact failed read only after its session has retired. */
const retiredReads = new WeakSet<Error>();

/** Exact errors superseded by a verified local renewal adoption. */
const renewalReads = new WeakSet<Error>();

/** Mark only a read whose original session was locally retired by adoption. */
export function markRenewalInformationRead(error: Error): void {
  renewalReads.add(error);
}

/** Passive classification preserves the marker for the automatic sweep's single retry. */
export function isRenewalInformationRead(error: unknown): boolean {
  return error instanceof Error && renewalReads.has(error);
}

/** One failed operation grants at most one renewal retry. */
export function consumeRenewalInformationRead(error: unknown): boolean {
  return error instanceof Error && renewalReads.delete(error);
}

/** Preserve the original error and its classification without retaining the session. */
export function markRetiredInformationRead(error: Error): void {
  retiredReads.add(error);
}

/** Consume once so one failed read cannot grant multiple accelerated retries. */
export function consumeRetiredInformationRead(error: unknown): boolean {
  return error instanceof Error && retiredReads.delete(error);
}
