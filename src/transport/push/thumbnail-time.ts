/**
 * Normalize the event envelope's Unix timestamp. The established envelope uses decimal
 * seconds or milliseconds. Missing, malformed, zero and unsupported forms remain unknown.
 * No delivery clock, nested trigger field, URL or recording identifier is substituted.
 */
export function thumbnailEventTime(value: unknown): { eventTime?: number } {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  if (!/^(?:[1-9]\d{9}|[1-9]\d{12})$/.test(text)) return {};
  const eventTime = Number(text) * (text.length === 10 ? 1000 : 1);
  return { eventTime };
}

/**
 * Keep the authoritative envelope clock. With no envelope clock, accept only matching
 * create/trigger clocks beside the thumbnail and a supplied event identity. This is
 * source event-associated time, not proof of the JPEG's exposure or a receipt clock.
 */
export function thumbnailSourceTime(envelopeTime: unknown, payload: Record<string, unknown>): { eventTime?: number } {
  if (envelopeTime !== undefined) return thumbnailEventTime(envelopeTime);
  const identified = [payload.session_id, payload.unique_id].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (!identified) return {};
  const created = thumbnailEventTime(payload.create_time).eventTime;
  const triggered = thumbnailEventTime(payload.trigger_time).eventTime;
  if (created === undefined || created !== triggered) return {};
  if (payload.event_time !== undefined && thumbnailEventTime(payload.event_time).eventTime !== triggered) return {};
  return { eventTime: triggered };
}
