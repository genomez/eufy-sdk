/** Exact errors created by the local connection deadline, without retaining a session. */
const deadlines = new WeakSet<Error>();

/** Preserve the existing deadline wording while recording its local origin. */
export function connectionDeadline(station: string, timeoutMs: number): Error {
  const error = new Error(`rtc: ${station} did not come up within ${timeoutMs}ms`);
  deadlines.add(error);
  return error;
}

/** A failed read can consume its exact deadline once; matching text is insufficient. */
export function consumeConnectionDeadline(error: unknown): boolean {
  return error instanceof Error && deadlines.delete(error);
}
