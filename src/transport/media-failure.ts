/** Modified for genomez S1 experimental source preview, 2026-10-14. */
/**
 * Why acquiring a push thumbnail produced no bytes.
 *
 * Transport vocabulary, and it stays inside `transport/`: the modules that raise it and the cache that
 * reads it are both here, and neither the device model nor the client names it. Nothing crosses the
 * capability boundary, so nothing belongs in the shared floor.
 *
 * @module transport/media-failure
 */

/**
 * The terms an acquisition failure is reported in — a CLOSED vocabulary, and that is the point.
 *
 * `download-failed` says a candidate did not become an image; it does not say whether the URL was
 * refused before a packet moved, the host answered 404, the transfer timed out, or the bytes arrived
 * and would not decode. Those need entirely different fixes, so the distinction has to survive to
 * whatever is reading the log.
 *
 * It is a fixed vocabulary rather than an error message because the thing that fails holds a signed
 * media URL and a response body, and neither may reach a log line. Every member here is a term this
 * file defines; a downloader's own wording never is.
 *
 * - `url-not-allowed` — the candidate URL failed the media allowlist (scheme, credentials, port, a
 *   literal address, or a host the SDK does not download from). Nothing was requested.
 * - `address-not-public` — the host resolved to nothing, or to an address that is not public.
 * - `redirect-not-allowed` — the media host redirected somewhere the object-store allowlist refuses,
 *   redirected without a target, or redirected twice.
 * - `http-status` — the host answered, with a status other than 200. Carried alongside as `status`.
 * - `too-large` — the body exceeded the download bound, declared or observed.
 * - `timeout` — the whole attempt, DNS included, outlived its window.
 * - `network` — the request itself failed: connect, TLS, a reset mid-body.
 * - `decode-failed` — the bytes arrived and the push-image decoder refused them. A property of the
 *   image, not of the network.
 */
export type MediaFailureReason =
  | "url-not-allowed"
  | "address-not-public"
  | "redirect-not-allowed"
  | "http-status"
  | "too-large"
  | "timeout"
  | "network"
  | "decode-failed";

/** Every {@link MediaFailureReason}, so a tag that crossed an injected boundary can be checked against it. */
export const MEDIA_FAILURE_REASONS: readonly MediaFailureReason[] = [
  "url-not-allowed",
  "address-not-public",
  "redirect-not-allowed",
  "http-status",
  "too-large",
  "timeout",
  "network",
  "decode-failed",
];

/**
 * The tag a media-acquisition failure carries for diagnostics.
 *
 * A property rather than a base class: the cache that logs it takes its downloader by injection and
 * must not import the transport that throws — so it reads this shape off an unknown error and checks
 * the term against {@link MEDIA_FAILURE_REASONS} before it goes anywhere near a log.
 */
export interface MediaFailure {
  readonly mediaFailure: MediaFailureReason;
  /** The HTTP status, when {@link mediaFailure} is `http-status`. */
  readonly status?: number;
}

/**
 * The closed-vocabulary failure tag an error carries, if it carries one this file recognises.
 *
 * Read off an unknown error and checked against {@link MEDIA_FAILURE_REASONS} rather than trusted: the
 * downloader is injected, so its errors are whatever the caller's implementation throws, and the one
 * thing that must never reach a log line here is a message someone else wrote — a media URL is signed,
 * and a failure often quotes the response. A term this SDK defines is safe by construction; anything
 * else is dropped, leaving the log exactly as uninformative as it was before.
 */
export function mediaFailureTag(error: unknown): { cause?: MediaFailureReason; status?: number } {
  if (typeof error !== "object" || error === null) return {};
  const { mediaFailure, status } = error as { mediaFailure?: unknown; status?: unknown };
  if (typeof mediaFailure !== "string") return {};
  const cause = MEDIA_FAILURE_REASONS.find((reason) => reason === mediaFailure);
  if (!cause) return {};
  return Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599
    ? { cause, status: status as number }
    : { cause };
}
