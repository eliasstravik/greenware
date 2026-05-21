/**
 * Greenware server — origin check + CORS header helper.
 *
 * `/api/submit` and `/api/session/*` are browser-facing and enforce
 * an `Origin` header allow-list. The callback endpoint does not — it's
 * server-to-server and authenticated by HMAC.
 *
 * Scope: pure helper — takes a raw `Origin` header string and the
 * allowed list, returns a decision. Callers build responses.
 */

/**
 * Test `origin` against `allowed`. Returns the matched origin string on
 * allow (so callers can echo it back in `Access-Control-Allow-Origin`),
 * or `null` on deny. A missing or empty `Origin` is always denied —
 * we require browsers to send one.
 */
export function checkOrigin(origin: string | null | undefined, allowed: readonly string[]): string | null {
  if (typeof origin !== "string" || origin.length === 0) return null;
  // Case-sensitive: RFC 6454 origins are case-sensitive on scheme+host+port.
  return allowed.includes(origin) ? origin : null;
}

/**
 * Same-origin fallback via Referer.
 *
 * Browsers do NOT send an `Origin` header on same-origin GET requests
 * (even when the request carries an `Authorization` header). That means
 * a page served by the same server that calls `/api/session/*` will
 * legitimately arrive without an `Origin`.
 *
 * We accept the request if a `Referer` header is present AND its origin
 * component (scheme + host + optional port) is on the allow-list. This
 * preserves the defense-in-depth story: a CSRF-ish same-site attacker
 * still needs the page they're attacking to be on the allow-list.
 *
 * Returns the derived origin string on allow (for `Access-Control-Allow-Origin`
 * echo), or `null` on deny. Malformed Referer → deny.
 */
export function checkOriginOrReferer(
  origin: string | null | undefined,
  referer: string | null | undefined,
  allowed: readonly string[],
): string | null {
  // Prefer Origin when present — it's the stronger signal.
  const byOrigin = checkOrigin(origin, allowed);
  if (byOrigin !== null) return byOrigin;

  // Fallback: parse Referer and use its origin.
  if (typeof referer !== "string" || referer.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(referer);
  } catch {
    return null;
  }
  // Reconstruct origin (scheme://host[:port]). URL.origin handles default ports.
  const refererOrigin = parsed.origin;
  return allowed.includes(refererOrigin) ? refererOrigin : null;
}

/**
 * Which browser-facing endpoint the CORS headers are for. The submit
 * endpoint takes POST + `Content-Type`; the session poll endpoint takes
 * GET + `Authorization`. Keeping the two sets distinct means preflight
 * responses only advertise the minimum surface each path actually
 * accepts — no wildcard `*` and no cross-endpoint surprises.
 */
export type CorsEndpoint = "submit" | "session";

/**
 * Build the CORS header set for an allowed-origin response. Called by
 * route handlers after a successful origin check to echo the origin
 * back with the right `Vary` + credentials policy.
 *
 * We do NOT set `Access-Control-Allow-Credentials: true`. Browsers
 * sending `fetch(..., { credentials: "omit" })` (our documented
 * default) won't send cookies anyway; keeping credentials off
 * eliminates a whole class of CSRF-via-allow-list-bypass bugs.
 *
 * When `endpoint` is provided, the response also carries
 * `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers`
 * tailored to that path. These are primarily for preflight (OPTIONS)
 * responses but are harmless on the real request too — browsers only
 * read them on preflight.
 */
export function corsHeadersFor(origin: string, endpoint?: CorsEndpoint): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
  };
  if (endpoint === "submit") {
    headers["Access-Control-Allow-Methods"] = "POST";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  } else if (endpoint === "session") {
    headers["Access-Control-Allow-Methods"] = "GET";
    headers["Access-Control-Allow-Headers"] = "Authorization";
  }
  return headers;
}
