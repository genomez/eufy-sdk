/** Recognize the bounded information envelope without interpreting entries or their ownership. */
export function informationPayload(value: unknown): Record<string, unknown> | undefined {
  const candidates: unknown[] = [value];
  if (value && typeof value === "object" && !Array.isArray(value))
    candidates.push((value as Record<string, unknown>).payload);
  for (let candidate of candidates) {
    if (typeof candidate === "string") {
      try {
        candidate = JSON.parse(candidate);
      } catch {
        continue;
      }
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const lists = ["params", "db_bypass_str"].filter((key) => Object.hasOwn(record, key)).map((key) => record[key]);
    if (
      lists.length > 0 &&
      lists.every(
        (entries) =>
          Array.isArray(entries) &&
          entries.length <= 4096 &&
          entries.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)),
      )
    )
      return record;
  }
  return undefined;
}
