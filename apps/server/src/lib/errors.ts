/**
 * Greenware server — unified error-response helper.
 *
 * Every non-2xx JSON response from the server uses this shape:
 *   { error, problem, cause?, fix?, docs? }
 *
 * The shape comes from the DX review (D7): error bodies must surface a
 * short machine code plus human-readable problem/cause/fix strings. This
 * gives operators immediate repair guidance without grepping logs.
 *
 * Scope: response construction only. Doesn't import Hono, doesn't touch
 * sessions or signing — route handlers call `errorResponse(...)` and
 * return its `Response`.
 */

// ---------------------------------------------------------------------------
// Shared error codes. Keep in sync with the test suite and protocol docs.
// ---------------------------------------------------------------------------

export const ERR_ORIGIN_NOT_ALLOWED = "ORIGIN_NOT_ALLOWED";
export const ERR_CONTENT_TYPE_INVALID = "CONTENT_TYPE_INVALID";
export const ERR_PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE";
export const ERR_RATE_LIMITED = "RATE_LIMITED";
export const ERR_MISSING_AUTH = "MISSING_AUTH";
export const ERR_INVALID_AUTH = "INVALID_AUTH";
export const ERR_INVALID_CALLBACK_PAYLOAD = "INVALID_CALLBACK_PAYLOAD";
export const ERR_INVALID_SUBMIT_SHAPE = "INVALID_SUBMIT_SHAPE";
export const ERR_CALLBACK_CONFLICT = "CALLBACK_CONFLICT";
export const ERR_SESSION_NOT_FOUND = "SESSION_NOT_FOUND";
export const ERR_SESSION_NOT_PENDING = "SESSION_NOT_PENDING";
export const ERR_SIGNATURE_INVALID = "SIGNATURE_INVALID";
export const ERR_SIGNATURE_EXPIRED = "SIGNATURE_EXPIRED";
export const ERR_UNKNOWN_KID = "UNKNOWN_KID";
export const ERR_MISSING_SIG_PARAMS = "MISSING_SIG_PARAMS";
export const ERR_INTERNAL = "INTERNAL_ERROR";

// ---------------------------------------------------------------------------
// Response shape + helper.
// ---------------------------------------------------------------------------

/**
 * Canonical error body. `error` is the machine-readable code; the rest
 * are optional human-facing fields that route handlers fill to whatever
 * depth they can.
 */
export interface ErrorBody {
  error: string;
  problem: string;
  cause?: string;
  fix?: string;
  docs?: string;
}

/**
 * Strip fields that should not leak into production error bodies.
 *
 * Per design doc D3: `cause` carries diagnostic detail that's valuable
 * for developers but risks surfacing internal state (path segments,
 * parse errors, exact byte counts, etc.) to end users and, worse, to
 * attackers probing the endpoint. In production we drop it; elsewhere
 * (dev/test/staging) we keep it so operators have full visibility.
 *
 * `env` is the raw `GREENWARE_ENV` binding. Only the exact string
 * `"production"` triggers sanitization — anything else (`"test"`,
 * `"staging"`, empty, undefined-as-string) keeps the full body. This
 * mirrors the fail-open posture used elsewhere: if the env binding is
 * mis-set, we'd rather leak `cause` than silently hide it.
 */
export function sanitizeForEnv(body: ErrorBody, env: string): ErrorBody {
  if (env !== "production") return body;
  const { cause: _cause, ...rest } = body;
  void _cause;
  return rest;
}

/**
 * Build a JSON `Response` with the given status and error body. Sets
 * `Content-Type: application/json; charset=utf-8`. Any CORS header
 * decisions are left to the caller's middleware — this helper is
 * transport-level only.
 *
 * When `env` is provided, the body is run through `sanitizeForEnv`
 * before serialization. Route handlers pass `c.env.GREENWARE_ENV` so
 * production responses drop the `cause` field.
 */
export function errorResponse(status: number, body: ErrorBody, env?: string): Response {
  const finalBody = env !== undefined ? sanitizeForEnv(body, env) : body;
  return new Response(JSON.stringify(finalBody), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
