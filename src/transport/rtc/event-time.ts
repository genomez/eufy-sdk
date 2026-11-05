/** Strict station wall-clock interpretation, independent of the process timezone. */
export type RecordingTimeStatus = "valid" | "unknown_format" | "ambiguous" | "invalid";

/** Validated local syntax and its uniquely identified Chicago instant, when available. */
export interface RecordingTime {
  timeStatus: RecordingTimeStatus;
  sourceLocal: string | null;
  atMs: number | null;
  utc: string | null;
  local: string | null;
}

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Calendar round trips reject invalid dates; multiple offset matches retain an ambiguous local time. */
export function parseRecordingTime(value: unknown, timezone: "America/Chicago" = "America/Chicago"): RecordingTime {
  const empty = (timeStatus: RecordingTimeStatus, sourceLocal: string | null = null): RecordingTime => ({
    timeStatus,
    sourceLocal,
    atMs: null,
    utc: null,
    local: null,
  });
  if (timezone !== "America/Chicago" || typeof value !== "string" || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value))
    return empty("unknown_format");
  const [y, m, d, h, minute, s] = value.split(/[- :]/).map(Number) as [number, number, number, number, number, number];
  if (y < 2000 || y > 2099) return empty("invalid");
  const nominal = Date.UTC(y, m - 1, d, h, minute, s);
  if (new Date(nominal).toISOString().slice(0, 19).replace("T", " ") !== value) return empty("invalid");
  const matches: number[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = nominal + offset * 60_000;
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((p) => [p.type, p.value]));
    if (`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` === value)
      matches.push(candidate);
  }
  if (matches.length !== 1) return empty(matches.length ? "ambiguous" : "invalid", value);
  const atMs = matches[0]!;
  const offset = (nominal - atMs) / 60_000;
  const offsetText = `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  return {
    timeStatus: "valid",
    sourceLocal: value,
    atMs,
    utc: new Date(atMs).toISOString(),
    local: value.replace(" ", "T") + offsetText,
  };
}

/** Playback uses whole seconds and admits only a unique strict Chicago timestamp. */
export function chicagoInstant(value: unknown): number | undefined {
  const result = parseRecordingTime(value);
  return result.atMs === null ? undefined : result.atMs / 1000;
}
