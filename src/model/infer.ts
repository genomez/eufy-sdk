/**
 * Naming inference.
 *
 * Capability *detection* (evidence params, model/category hints, vendor device-type tables) lives
 * per-capability in `src/model/capabilities/*` (each module's `detection` spec) and is dispatched by
 * the barrel's `detectCapabilities`. What lives here is the one piece that is about *naming*, not
 * capabilities: {@link inferName}.
 *
 * @module model/infer
 */

import type { CloudRecord } from "./types.js";

/**
 * Best-effort display name from a cloud record. Prefers a clean uppercase model T-code
 * (e.g. `"T8423"`); falls back to `undefined`. Never throws.
 *
 * A "clean model code" is the eufy product-code shape: a leading letter (usually `T`) plus
 * digits, optionally with a short alphanumeric suffix. We normalise case and trim noise; if
 * the model doesn't look like a code at all we return `undefined` rather than echoing junk.
 *
 * @param rec The cloud device record.
 * @returns The normalised model code, or `undefined` when none is usable.
 */
export function inferName(rec: CloudRecord): string | undefined {
  const model = rec?.model;
  if (typeof model !== "string") return undefined;

  const trimmed = model.trim();
  if (trimmed.length === 0) return undefined;

  // Pull a product-code token out of the (possibly noisy) model string:
  // a letter, 3-5 digits, then an optional short alphanumeric tail (e.g. T8423, T8170P, T81A0).
  const match = trimmed.match(/\b([A-Za-z]\d{3,5}[A-Za-z0-9]{0,3})\b/);
  if (match) return match[1].toUpperCase();

  return undefined;
}
