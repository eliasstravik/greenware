/**
 * Greenware Protocol v1 — HMAC-SHA256 callback URL signing.
 *
 * The server hands a signed callback URL to the enrichment service and
 * later verifies the signature before accepting the callback POST. Without
 * this layer, any stranger could POST to `/api/callback/:id` and hijack
 * a live browser session.
 *
 * Signing input (defined by Greenware Protocol v1):
 *     <session_id>:<exp>:<nonce>:<kid>
 *
 * URL shape the server produces:
 *     https://<host>/api/callback/<session_id>?exp=<ts>&sig=<b64url>&nonce=<hex>&kid=<id>
 *
 * Scope of this module: sign + verify + nonce generation. No session
 * storage, no HTTP, no protocol parsing — those live elsewhere. Web Crypto
 * only; zero runtime dependencies.
 */
// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export interface SignCallbackParams {
  sessionId: string;
  /** Unix timestamp (seconds) after which the signed URL is no longer valid. */
  expiresAt: number;
  /** Hex-encoded random value; use {@link generateNonce} unless you have a reason not to. */
  nonce: string;
  /** Key identifier. Defaults to `"primary"`. */
  kid?: string;
  /** Raw HMAC signing key (UTF-8 string). Must be at least 16 bytes long in practice. */
  signingKey: string;
}

export interface SignedUrl {
  /** base64url-encoded HMAC-SHA256 signature — URL-safe, no padding. */
  sig: string;
  /** Echoes the `expiresAt` input so callers can build the URL from one object. */
  expires_at: number;
  nonce: string;
  kid: string;
}

export interface VerifyCallbackParams {
  sessionId: string;
  sig: string;
  expiresAt: number;
  nonce: string;
  kid: string;
  primaryKey: string;
  /** Present during a rotation's grace period; consulted only when `kid === "previous"`. */
  previousKey?: string;
  /** Override current time (seconds). Primarily for tests. Defaults to `Date.now() / 1000`. */
  now?: number;
}

export type VerifyResult =
  | { valid: true; usedPrimary: boolean }
  | { valid: false; reason: "expired" | "bad_signature" | "unknown_kid" };

// ---------------------------------------------------------------------------
// Input validation.
// ---------------------------------------------------------------------------

/**
 * Minimum signing key length in bytes (UTF-8 characters for our purposes;
 * callers use ASCII keys). 16 bytes = 128 bits — the floor at which HMAC-SHA256
 * security assumptions still hold. Anything shorter almost certainly indicates
 * a misconfigured environment (e.g. `GREENWARE_SIGNING_KEY=""`) and we'd
 * rather fail loudly than produce forgeable signatures.
 */
const MIN_KEY_LENGTH = 16;

/**
 * Ensure a signing key is present and at least `MIN_KEY_LENGTH` bytes long.
 * Throws with a descriptive error so the surface that caught a misconfigured
 * deploy gets a useful log line.
 */
function validateSigningKey(key: string | undefined, paramName: string): void {
  if (!key || key.length < MIN_KEY_LENGTH) {
    throw new Error(
      `${paramName} must be at least ${MIN_KEY_LENGTH} bytes (got ${key?.length ?? 0})`,
    );
  }
}

/**
 * Ensure a string field is non-empty and does not contain `:` — the signing
 * input uses `:` as a delimiter (`<session_id>:<exp>:<nonce>:<kid>`), and a
 * field that contains `:` could let an attacker-influenced value collide
 * with a different canonical tuple, producing signature ambiguity.
 */
function validateField(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  if (value.includes(":")) {
    throw new Error(`${name} must not contain ':' (would collide with signing input delimiter)`);
  }
}

/**
 * Ensure `expiresAt` is a non-negative integer. A caller that accidentally
 * passes `Date.now() / 1000` (float) or a `parseInt`-gone-wrong NaN would
 * otherwise silently produce a malformed signing input.
 */
function validateExpiresAt(expiresAt: number): void {
  if (!Number.isInteger(expiresAt) || expiresAt < 0) {
    throw new Error(`expiresAt must be a non-negative integer (got ${expiresAt})`);
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers.
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/**
 * Encode a byte sequence as base64url (RFC 4648 §5): no padding, `-` and `_`
 * instead of `+` and `/`. Using `btoa` on a binary string keeps this runtime-
 * agnostic (works under Node >= 20, browsers).
 */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const b64 = btoa(binary);
  // URL-safe and strip `=` padding in one pass.
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a base64url string back to bytes. Rehydrates padding before handing
 * off to `atob`. Returns `null` on malformed input so callers can map that to
 * a `bad_signature` result instead of throwing.
 */
function base64urlDecode(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0) return null;
  // Reject anything outside the base64url alphabet. We accept an optional
  // trailing `=` pad purely for robustness (our own encoder never emits it).
  if (!/^[A-Za-z0-9_-]+=*$/.test(s)) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  let binary: string;
  try {
    binary = atob(b64 + pad);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Hex-encode bytes (lowercase, no separators). Used only for nonce output,
 * so performance doesn't matter.
 */
function hexEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

// ---------------------------------------------------------------------------
// Core HMAC primitive.
// ---------------------------------------------------------------------------

/**
 * Build the signing input from the four bound-together fields. The colon
 * separators match the Greenware Protocol v1 spec and are unambiguous because
 * none of the fields contain `:` by construction (session_id is a UUID, exp
 * is a number, nonce is hex, kid is a short ASCII identifier).
 */
function buildSigningInput(sessionId: string, expiresAt: number, nonce: string, kid: string): string {
  return `${sessionId}:${expiresAt}:${nonce}:${kid}`;
}

/** Import a raw UTF-8 key string as an HMAC-SHA256 `CryptoKey`. */
async function importKey(keyMaterial: string, usages: ReadonlyArray<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages as KeyUsage[],
  );
}

/** HMAC-SHA256 a string and return the raw 32-byte digest. */
async function hmacBytes(keyMaterial: string, message: string): Promise<Uint8Array> {
  const key = await importKey(keyMaterial, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return new Uint8Array(sigBuf);
}

// ---------------------------------------------------------------------------
// Constant-time comparison.
// ---------------------------------------------------------------------------

/**
 * Compare two byte sequences in constant time w.r.t. their common prefix.
 *
 * If the lengths differ we bail out early — a length mismatch is already
 * observable to the attacker (they control the sig they send) and doesn't
 * leak key material. Within matched lengths we OR-accumulate the XOR of
 * each byte pair and only check the result at the end, so the loop's
 * branching does not depend on the data.
 *
 * Exported because tests exercise it directly and because callers that
 * verify manually (e.g. when they already have a pre-computed digest)
 * may want it instead of going through {@link verifyCallback}.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Nonce generation.
// ---------------------------------------------------------------------------

/**
 * Generate a random nonce using the CSPRNG backing `crypto.getRandomValues`.
 * The default of 16 bytes yields 128 bits of entropy — well above the
 * protocol's ≥64-bit floor. Returned as lowercase hex.
 */
export function generateNonce(bytes = 16): string {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error("generateNonce: bytes must be a positive integer");
  }
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return hexEncode(buf);
}

// ---------------------------------------------------------------------------
// Sign.
// ---------------------------------------------------------------------------

/**
 * Sign the four fields that identify a callback (`session_id`, `exp`,
 * `nonce`, `kid`) with HMAC-SHA256 and return the query-param set needed
 * to build the final URL.
 *
 * The `kid` defaults to `"primary"`. Callers that want to pre-sign under a
 * rotating key (e.g. during a key-rollover test) can override.
 */
export async function signCallback(params: SignCallbackParams): Promise<SignedUrl> {
  const { sessionId, expiresAt, nonce, signingKey } = params;
  const kid = params.kid ?? "primary";

  // Trust-boundary validation — better to throw here than to emit a
  // forgeable signature or a signing input with delimiter collisions.
  validateSigningKey(signingKey, "signingKey");
  validateField(sessionId, "sessionId");
  validateField(nonce, "nonce");
  validateField(kid, "kid");
  validateExpiresAt(expiresAt);

  const input = buildSigningInput(sessionId, expiresAt, nonce, kid);
  const digest = await hmacBytes(signingKey, input);

  return {
    sig: base64urlEncode(digest),
    expires_at: expiresAt,
    nonce,
    kid,
  };
}

// ---------------------------------------------------------------------------
// Verify.
// ---------------------------------------------------------------------------

/**
 * Verify a presented signature against the four identifying fields.
 *
 * Checks, in order:
 *   1. `exp` is not in the past.
 *   2. `kid` resolves to a known key — exactly `"primary"` or `"previous"`.
 *   3. HMAC over the canonical input matches `sig` in constant time.
 *
 * No cross-kid fallback: a `kid === "primary"` signature is verified ONLY
 * against `primaryKey` — rotations are explicit via the `kid` query param.
 * This keeps the security-critical decision ("which key?") out of the
 * signature-matching path.
 */
export async function verifyCallback(params: VerifyCallbackParams): Promise<VerifyResult> {
  const { sessionId, sig, expiresAt, nonce, kid, primaryKey, previousKey } = params;
  const now = params.now ?? Math.floor(Date.now() / 1000);

  // Trust-boundary validation — we throw rather than return a VerifyResult
  // here because a misconfigured key or a field that contains the signing
  // delimiter is a caller bug, not a bad signature. Masking it as
  // `bad_signature` would make such bugs invisible.
  validateSigningKey(primaryKey, "primaryKey");
  if (previousKey !== undefined) {
    validateSigningKey(previousKey, "previousKey");
  }
  validateField(sessionId, "sessionId");
  validateField(nonce, "nonce");
  validateField(kid, "kid");
  validateExpiresAt(expiresAt);

  // 1. Expiry — cheapest check, do it first.
  if (expiresAt < now) {
    return { valid: false, reason: "expired" };
  }

  // 2. kid routing — explicit, no fallback.
  let keyMaterial: string;
  let isPrimary: boolean;
  if (kid === "primary") {
    keyMaterial = primaryKey;
    isPrimary = true;
  } else if (kid === "previous" && typeof previousKey === "string" && previousKey.length > 0) {
    keyMaterial = previousKey;
    isPrimary = false;
  } else {
    return { valid: false, reason: "unknown_kid" };
  }

  // 3. HMAC compare in constant time. A malformed base64url sig or any
  //    throw from the crypto layer maps to bad_signature — never expose
  //    a separate code, since attackers would otherwise learn whether
  //    the URL was well-formed independent of the key.
  const presented = base64urlDecode(sig);
  if (presented === null) {
    return { valid: false, reason: "bad_signature" };
  }

  let expected: Uint8Array;
  try {
    expected = await hmacBytes(keyMaterial, buildSigningInput(sessionId, expiresAt, nonce, kid));
  } catch {
    return { valid: false, reason: "bad_signature" };
  }

  if (!timingSafeEqual(presented, expected)) {
    return { valid: false, reason: "bad_signature" };
  }

  return { valid: true, usedPrimary: isPrimary };
}
