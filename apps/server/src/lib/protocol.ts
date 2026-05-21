/**
 * Greenware Protocol v1 — zod schemas.
 *
 * Source of truth for field-level validation. The spec document
 * (`docs/protocol-v1.md`) is the source of truth for intent and
 * renderer contract. Keep the two in sync.
 *
 * Scope of this module: parse + validate payloads. No signing,
 * no session storage, no HTTP. A single responsibility.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// XSS guard applied to every text field and URL at the zod boundary.
// Belt-and-suspenders: renderers still use textContent + HTTPS-only checks.
// ---------------------------------------------------------------------------

const XSS_PATTERNS = ["<script", "javascript:", "data:", "vbscript:"] as const;

/**
 * Returns true iff the string contains no known XSS substrings.
 * Case-insensitive to catch `JavaScript:`, `<SCRIPT`, etc.
 */
function isXssSafe(s: string): boolean {
  const lower = s.toLowerCase();
  for (const p of XSS_PATTERNS) {
    if (lower.includes(p)) return false;
  }
  return true;
}

/**
 * Helper: build a string schema that enforces `min=1`, a maximum length,
 * and the XSS substring guard. We build it per-use because zod's
 * The inferred schema type differs between zod majors, so callers rely
 * on inference instead of naming a concrete zod wrapper type.
 */
function safeString(max: number, label = "field") {
  return z
    .string()
    .min(1, `${label} must not be empty`)
    .max(max, `${label} too long`)
    .refine(isXssSafe, {
      message: `${label} contains disallowed pattern (XSS guard)`,
    });
}

/**
 * HTTPS URL validator — scheme must be `https:`, not `http:`, `javascript:`,
 * `data:`, `vbscript:`, `file:`, or anything else. Also rejects URLs
 * containing any XSS substring.
 */
export function isSafeUrl(url: string, allowedSchemes: string[]): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  if (!isXssSafe(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // URL.protocol includes the trailing colon, e.g. "https:".
  return allowedSchemes.includes(parsed.protocol);
}

const HttpsUrl = z
  .string()
  .min(1, "url must not be empty")
  .refine((u) => isSafeUrl(u, ["https:"]), {
    message: "url must be a valid https:// URL (no javascript:/data:/vbscript:/http:)",
  });

/**
 * Reusable `{ label, url }` shape for CTAs and rejection off-ramps.
 * `.strict()` rejects extra unknown keys.
 */
const LabeledUrl = z
  .object({
    label: safeString(200, "label"),
    url: HttpsUrl,
  })
  .strict();

// ---------------------------------------------------------------------------
// Individual action schemas. Each uses `.strict()` to forbid unknown fields,
// which forces integrations to track the spec instead of piling on bespoke
// extensions that later collide with v2 additions.
// ---------------------------------------------------------------------------

export const ActionRedirect = z
  .object({
    type: z.literal("redirect"),
    url: HttpsUrl,
  })
  .strict();

export const ActionEmbed = z
  .object({
    type: z.literal("embed"),
    provider: z.enum(["cal", "calendly", "iframe"]),
    url: HttpsUrl,
    mobile_behavior: z.enum(["redirect", "iframe"]).default("redirect"),
  })
  .strict();

export const ActionMessage = z
  .object({
    type: z.literal("message"),
    title: safeString(200, "title"),
    body: safeString(2000, "body"),
    cta: LabeledUrl.optional(),
  })
  .strict();

export const ActionReject = z
  .object({
    type: z.literal("reject"),
    reason: safeString(280, "reason"),
    alternative: LabeledUrl.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Discriminated union over `type`. Unknown discriminant values throw —
// the server maps that to `UNKNOWN_ACTION_TYPE` in the error payload,
// and embed.js forward-compat logic renders a generic error message.
// ---------------------------------------------------------------------------

export const Action = z.discriminatedUnion("type", [
  ActionRedirect,
  ActionEmbed,
  ActionMessage,
  ActionReject,
]);

// ---------------------------------------------------------------------------
// Top-level callback payload.
// ---------------------------------------------------------------------------

const Meta = z
  .object({
    enriched_at: z.string().datetime({ offset: true }).optional(),
    source: safeString(200, "source").optional(),
  })
  .strict();

/**
 * A UUID session_id is required. Non-UUID strings are rejected at parse
 * time — the server also double-checks that this value matches the
 * `<session_id>` path segment of the signed callback URL.
 */
const SessionId = z.string().uuid("session_id must be a UUID");

export const CallbackPayload = z
  .object({
    session_id: SessionId,
    status: z.literal("ok"),
    action: Action,
    meta: Meta.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Error payload shape. Used in two places:
//   (a) Enrichment posts `status: "error"` to the callback URL.
//   (b) Tests/docs can validate the error variant independently. The
//       browser-polled session endpoint exposes the stored terminal failure as
//       `{ status: "failed", error_code }`, not this full callback payload.
// ---------------------------------------------------------------------------

const ErrorCode = z.enum([
  "INVALID_CALLBACK_PAYLOAD",
  "UNKNOWN_ACTION_TYPE",
  "INVALID_SIGNATURE",
  "EXPIRED_CALLBACK",
  "SESSION_NOT_FOUND",
  "SESSION_ALREADY_COMPLETED",
  "WEBHOOK_TIMEOUT",
  "WEBHOOK_NON_2XX",
  "PAYLOAD_TOO_LARGE",
]);

export const ErrorPayload = z
  .object({
    session_id: SessionId,
    status: z.literal("error"),
    error_code: ErrorCode,
    problem: safeString(500, "problem").optional(),
    cause: safeString(500, "cause").optional(),
    fix: safeString(500, "fix").optional(),
    docs: HttpsUrl.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred TypeScript types.
// ---------------------------------------------------------------------------

export type ActionRedirect = z.infer<typeof ActionRedirect>;
export type ActionEmbed = z.infer<typeof ActionEmbed>;
export type ActionMessage = z.infer<typeof ActionMessage>;
export type ActionReject = z.infer<typeof ActionReject>;
export type Action = z.infer<typeof Action>;
export type CallbackPayload = z.infer<typeof CallbackPayload>;
export type ErrorPayload = z.infer<typeof ErrorPayload>;

// ---------------------------------------------------------------------------
// Public parse entry point. Throws on invalid with a descriptive,
// non-PII-leaking summary suitable for the server's error-code path.
// ---------------------------------------------------------------------------

/**
 * Parse an unknown callback payload as a Greenware Protocol v1
 * `CallbackPayload` (status: "ok" with an action).
 *
 * Throws a `ProtocolParseError` with `.code` set to `INVALID_CALLBACK_PAYLOAD`
 * or `UNKNOWN_ACTION_TYPE` on failure.
 *
 * Note: this does NOT parse `ErrorPayload` shapes; use `ErrorPayload.parse`
 * directly if you need to accept the error variant at the same endpoint.
 */
export function parseCallback(raw: unknown): CallbackPayload {
  if (hasUnknownActionType(raw)) {
    throw new ProtocolParseError(
      "UNKNOWN_ACTION_TYPE",
      "action.type: Unknown Greenware action type",
    );
  }

  const result = CallbackPayload.safeParse(raw);
  if (result.success) return result.data;

  const issues = result.error.issues;

  // Detect the discriminator-mismatch case and surface as UNKNOWN_ACTION_TYPE.
  const hasUnknownType = issues.some(
    (i) => {
      const issueCode = String(i.code);
      return issueCode === "invalid_union_discriminator" ||
      (i.path.length >= 2 &&
        i.path[0] === "action" &&
        i.path[1] === "type" &&
        (issueCode === "invalid_literal" || issueCode === "invalid_enum_value"));
    },
  );

  const code: "INVALID_CALLBACK_PAYLOAD" | "UNKNOWN_ACTION_TYPE" = hasUnknownType
    ? "UNKNOWN_ACTION_TYPE"
    : "INVALID_CALLBACK_PAYLOAD";

  // Build a single-sentence summary without leaking raw input values.
  // zod issue messages are field-level descriptions; we prepend the path.
  const summary = issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");

  throw new ProtocolParseError(code, summary);
}

function hasUnknownActionType(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const action = (raw as { action?: unknown }).action;
  if (action === null || typeof action !== "object" || Array.isArray(action)) return false;
  const type = (action as { type?: unknown }).type;
  return (
    typeof type === "string" &&
    type !== "redirect" &&
    type !== "embed" &&
    type !== "message" &&
    type !== "reject"
  );
}

/**
 * Thrown by `parseCallback` on invalid input.
 *
 * `.code` is stable and matches the Greenware Protocol v1 error codes,
 * so callers can forward it straight into an `ErrorPayload.error_code`.
 */
export class ProtocolParseError extends Error {
  public readonly code: "INVALID_CALLBACK_PAYLOAD" | "UNKNOWN_ACTION_TYPE";

  constructor(
    code: "INVALID_CALLBACK_PAYLOAD" | "UNKNOWN_ACTION_TYPE",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ProtocolParseError";
  }
}
