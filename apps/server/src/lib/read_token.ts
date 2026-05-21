/**
 * Greenware server — browser read_token mint + hash.
 *
 * The submit route mints a `read_token` the browser uses to poll
 * `/api/session/:id`. Design choices:
 *   - `read_token = base64url( HMAC-SHA256(session_id, GREENWARE_READ_KEY) )`
 *     so it's deterministic and we never store the raw token server-side.
 *   - We store `sha256(read_token)` (hex) on the session record; poll
 *     path hashes the presented token and compares in constant time.
 *
 * The HMAC key is separate from the callback-signing key — an attacker
 * who somehow exfiltrates `GREENWARE_READ_KEY` can mint read tokens for
 * sessions whose IDs they already know, but cannot forge signed
 * callbacks; the converse also holds. Compromise of one key does not
 * compromise the other.
 *
 * Scope: token mint + hash only. No session storage.
 */

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Encoding helpers (duplicated from signing.ts — kept local so this
// module has no cross-lib import; the two helpers are ~15 LOC).
// ---------------------------------------------------------------------------

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Mint a fresh read token bound to `sessionId`. The browser receives the
 * base64url string; the server stores `hashReadToken(rawToken)`.
 */
export async function mintReadToken(sessionId: string, readKey: string): Promise<string> {
  if (!readKey || readKey.length < 16) {
    throw new Error("readKey must be at least 16 bytes");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(readKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, textEncoder.encode(sessionId));
  return base64urlEncode(new Uint8Array(sigBuf));
}

/**
 * SHA-256 hex of a raw read token — what we store server-side. The
 * browser's token is never written to session storage.
 */
export async function hashReadToken(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(rawToken));
  return hexEncode(new Uint8Array(digest));
}
