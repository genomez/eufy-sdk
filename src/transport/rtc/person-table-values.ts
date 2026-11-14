/** Decimal integer strings and safe integers are the only accepted numeric representations. */
export function personTableInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^-?\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) ? parsed : null;
}

/** Update times accept safe integers, decimal integer strings and bounded datetime strings. */
export function personTableUpdateTime(value: unknown): number | string | null {
  return (
    personTableInteger(value) ??
    (typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)
      ? value
      : null)
  );
}
