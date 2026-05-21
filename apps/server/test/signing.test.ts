/**
 * Greenware Protocol v1 — HMAC signing tests.
 *
 * Exercises the sign/verify round trip, the kid-based key-rotation rules,
 * forgery and expiry rejection paths, nonce uniqueness, base64url encoding,
 * signing determinism, and the constant-time comparator.
 */

import { describe, it, expect } from "vitest";
import {
  generateNonce,
  signCallback,
  timingSafeEqual,
  verifyCallback,
} from "../src/lib/signing";

const SESSION = "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c";
const PRIMARY_KEY = "test-primary-key-32-bytes-minimum-length-for-hs256";
const PREVIOUS_KEY = "test-previous-key-32-bytes-minimum-length-for-hs256";
const NOW = 1_780_000_000; // Fixed clock so `now` math is reproducible.
const FUTURE = NOW + 600; // 10 min ahead of NOW.

// ---------------------------------------------------------------------------
// Sign → verify round trip.
// ---------------------------------------------------------------------------

describe("signCallback + verifyCallback — round trip", () => {
  it("verifies a freshly signed callback with kid=primary", async () => {
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "deadbeefcafef00d",
      signingKey: PRIMARY_KEY,
    });

    expect(signed.kid).toBe("primary");
    expect(signed.expires_at).toBe(FUTURE);
    expect(signed.nonce).toBe("deadbeefcafef00d");
    expect(signed.sig).toMatch(/^[A-Za-z0-9_-]+$/);

    const result = await verifyCallback({
      sessionId: SESSION,
      sig: signed.sig,
      expiresAt: signed.expires_at,
      nonce: signed.nonce,
      kid: signed.kid,
      primaryKey: PRIMARY_KEY,
      now: NOW,
    });

    expect(result).toEqual({ valid: true, usedPrimary: true });
  });

  it("verifies a callback signed under kid=previous against previousKey", async () => {
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "0011223344556677",
      kid: "previous",
      signingKey: PREVIOUS_KEY,
    });

    expect(signed.kid).toBe("previous");

    const result = await verifyCallback({
      sessionId: SESSION,
      sig: signed.sig,
      expiresAt: signed.expires_at,
      nonce: signed.nonce,
      kid: signed.kid,
      primaryKey: PRIMARY_KEY,
      previousKey: PREVIOUS_KEY,
      now: NOW,
    });

    expect(result).toEqual({ valid: true, usedPrimary: false });
  });
});

// ---------------------------------------------------------------------------
// Forgery / tamper rejection.
// ---------------------------------------------------------------------------

describe("verifyCallback — rejects tampered input", () => {
  it("rejects a flipped byte in the signature as bad_signature", async () => {
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      signingKey: PRIMARY_KEY,
    });

    // Flip the first character deterministically to something different.
    const first = signed.sig[0]!;
    const replacement = first === "A" ? "B" : "A";
    const tampered = replacement + signed.sig.slice(1);
    expect(tampered).not.toBe(signed.sig);

    const result = await verifyCallback({
      sessionId: SESSION,
      sig: tampered,
      expiresAt: signed.expires_at,
      nonce: signed.nonce,
      kid: signed.kid,
      primaryKey: PRIMARY_KEY,
      now: NOW,
    });

    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects a malformed base64url signature as bad_signature", async () => {
    const result = await verifyCallback({
      sessionId: SESSION,
      sig: "not valid base64url!!!",
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      kid: "primary",
      primaryKey: PRIMARY_KEY,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects a signature where session_id was substituted", async () => {
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      signingKey: PRIMARY_KEY,
    });

    const result = await verifyCallback({
      sessionId: "00000000-0000-4000-8000-000000000000",
      sig: signed.sig,
      expiresAt: signed.expires_at,
      nonce: signed.nonce,
      kid: signed.kid,
      primaryKey: PRIMARY_KEY,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects a signature where exp was substituted (different exp changes signing input)", async () => {
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      signingKey: PRIMARY_KEY,
    });

    const result = await verifyCallback({
      sessionId: SESSION,
      sig: signed.sig,
      expiresAt: FUTURE + 1, // Still in the future, so not expired — but signed input changes.
      nonce: signed.nonce,
      kid: signed.kid,
      primaryKey: PRIMARY_KEY,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });
});

// ---------------------------------------------------------------------------
// Expiry.
// ---------------------------------------------------------------------------

describe("verifyCallback — expiry", () => {
  it("rejects a callback whose expiresAt is strictly before now", async () => {
    const past = NOW - 1;
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: past,
      nonce: "aabbccddeeff0011",
      signingKey: PRIMARY_KEY,
    });
    const result = await verifyCallback({
      sessionId: SESSION,
      sig: signed.sig,
      expiresAt: past,
      nonce: signed.nonce,
      kid: signed.kid,
      primaryKey: PRIMARY_KEY,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("accepts a callback whose expiresAt equals now (boundary is inclusive)", async () => {
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: NOW,
      nonce: "aabbccddeeff0011",
      signingKey: PRIMARY_KEY,
    });
    const result = await verifyCallback({
      sessionId: SESSION,
      sig: signed.sig,
      expiresAt: NOW,
      nonce: signed.nonce,
      kid: signed.kid,
      primaryKey: PRIMARY_KEY,
      now: NOW,
    });
    expect(result).toEqual({ valid: true, usedPrimary: true });
  });
});

// ---------------------------------------------------------------------------
// kid routing.
// ---------------------------------------------------------------------------

describe("verifyCallback — kid routing", () => {
  it("returns unknown_kid for a kid that isn't primary or previous", async () => {
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      kid: "spare",
      signingKey: PRIMARY_KEY,
    });
    const result = await verifyCallback({
      sessionId: SESSION,
      sig: signed.sig,
      expiresAt: signed.expires_at,
      nonce: signed.nonce,
      kid: "spare",
      primaryKey: PRIMARY_KEY,
      previousKey: PREVIOUS_KEY,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: "unknown_kid" });
  });

  it("returns unknown_kid for kid=previous when previousKey is not provided", async () => {
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      kid: "previous",
      signingKey: PREVIOUS_KEY,
    });
    const result = await verifyCallback({
      sessionId: SESSION,
      sig: signed.sig,
      expiresAt: signed.expires_at,
      nonce: signed.nonce,
      kid: "previous",
      primaryKey: PRIMARY_KEY,
      // previousKey intentionally omitted.
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: "unknown_kid" });
  });

  it("does NOT fall back to previousKey when kid=primary and primaryKey is wrong", async () => {
    // Sign under the PREVIOUS key but label the kid as "primary".
    // A buggy verifier that fell back to previousKey would accept this.
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      kid: "primary",
      signingKey: PREVIOUS_KEY,
    });
    const result = await verifyCallback({
      sessionId: SESSION,
      sig: signed.sig,
      expiresAt: signed.expires_at,
      nonce: signed.nonce,
      kid: "primary",
      primaryKey: PRIMARY_KEY,
      previousKey: PREVIOUS_KEY,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });
});

// ---------------------------------------------------------------------------
// Nonce generator.
// ---------------------------------------------------------------------------

describe("generateNonce", () => {
  it("produces 1000 unique values with default 16 bytes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateNonce());
    }
    expect(seen.size).toBe(1000);
  });

  it("emits lowercase hex of the requested byte length", () => {
    const n = generateNonce(24);
    expect(n).toHaveLength(48);
    expect(n).toMatch(/^[0-9a-f]+$/);
  });

  it("throws on non-positive or non-integer byte counts", () => {
    expect(() => generateNonce(0)).toThrow();
    expect(() => generateNonce(-1)).toThrow();
    expect(() => generateNonce(1.5)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// base64url encoding contract.
// ---------------------------------------------------------------------------

describe("signCallback — base64url encoding", () => {
  it("never produces `+`, `/`, or `=` in the signature", async () => {
    // Loop over varied inputs so at least some signatures hit the high-bit
    // byte positions that would have yielded `+` or `/` under standard
    // base64.
    for (let i = 0; i < 32; i++) {
      const signed = await signCallback({
        sessionId: SESSION,
        expiresAt: FUTURE + i,
        nonce: `nonce-${i.toString(16).padStart(16, "0")}`,
        signingKey: PRIMARY_KEY,
      });
      expect(signed.sig).not.toMatch(/[+/=]/);
      expect(signed.sig).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

describe("signCallback — determinism", () => {
  it("produces identical output for identical inputs", async () => {
    const input = {
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      kid: "primary",
      signingKey: PRIMARY_KEY,
    };
    const a = await signCallback(input);
    const b = await signCallback(input);
    expect(a).toEqual(b);
  });

  it("produces different output when any field changes", async () => {
    const base = {
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      kid: "primary",
      signingKey: PRIMARY_KEY,
    };
    const a = await signCallback(base);
    const b = await signCallback({ ...base, nonce: "aabbccddeeff0012" });
    const c = await signCallback({ ...base, expiresAt: FUTURE + 1 });
    const d = await signCallback({ ...base, kid: "previous" });
    expect(a.sig).not.toBe(b.sig);
    expect(a.sig).not.toBe(c.sig);
    expect(a.sig).not.toBe(d.sig);
  });
});

// ---------------------------------------------------------------------------
// Constant-time comparison correctness.
// ---------------------------------------------------------------------------

describe("timingSafeEqual", () => {
  it("returns true for equal byte arrays", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  it("returns true for empty byte arrays", () => {
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it("returns false when one byte differs at the start", () => {
    const a = new Uint8Array([9, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it("returns false when one byte differs at the end", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 9]);
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it("returns false when lengths differ (even if prefix matches)", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 0]);
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it("returns false when every byte differs", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([9, 8, 7, 6]);
    expect(timingSafeEqual(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input validation — key length.
//
// Keys shorter than 16 bytes undercut HMAC-SHA256's security assumptions and
// almost always indicate a misconfigured deploy (e.g. an empty env var). We
// want the system to fail loudly rather than silently emit forgeable sigs.
// ---------------------------------------------------------------------------

describe("signCallback — signing key validation", () => {
  it("throws when signingKey is the empty string", async () => {
    await expect(
      signCallback({
        sessionId: SESSION,
        expiresAt: FUTURE,
        nonce: "aabbccddeeff0011",
        signingKey: "",
      }),
    ).rejects.toThrow(/signingKey/);
  });

  it("throws when signingKey is 15 chars (one below the boundary)", async () => {
    await expect(
      signCallback({
        sessionId: SESSION,
        expiresAt: FUTURE,
        nonce: "aabbccddeeff0011",
        signingKey: "x".repeat(15),
      }),
    ).rejects.toThrow(/signingKey/);
  });

  it("succeeds when signingKey is exactly 16 chars (boundary is inclusive)", async () => {
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      signingKey: "x".repeat(16),
    });
    expect(signed.sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("verifyCallback — signing key validation", () => {
  it("throws when primaryKey is empty", async () => {
    await expect(
      verifyCallback({
        sessionId: SESSION,
        sig: "AAAA",
        expiresAt: FUTURE,
        nonce: "aabbccddeeff0011",
        kid: "primary",
        primaryKey: "",
        now: NOW,
      }),
    ).rejects.toThrow(/primaryKey/);
  });

  it("throws when previousKey is provided but too short", async () => {
    await expect(
      verifyCallback({
        sessionId: SESSION,
        sig: "AAAA",
        expiresAt: FUTURE,
        nonce: "aabbccddeeff0011",
        kid: "previous",
        primaryKey: PRIMARY_KEY,
        previousKey: "short",
        now: NOW,
      }),
    ).rejects.toThrow(/previousKey/);
  });

  it("does not throw when previousKey is undefined (optional)", async () => {
    // Rely on normal kid routing — a kid=primary call with no previousKey
    // is the bread-and-butter path. It should verify (or not) without the
    // optional-key validator going off.
    const signed = await signCallback({
      sessionId: SESSION,
      expiresAt: FUTURE,
      nonce: "aabbccddeeff0011",
      signingKey: PRIMARY_KEY,
    });
    const result = await verifyCallback({
      sessionId: SESSION,
      sig: signed.sig,
      expiresAt: signed.expires_at,
      nonce: signed.nonce,
      kid: signed.kid,
      primaryKey: PRIMARY_KEY,
      // previousKey intentionally omitted.
      now: NOW,
    });
    expect(result).toEqual({ valid: true, usedPrimary: true });
  });
});

// ---------------------------------------------------------------------------
// Input validation — field boundary / delimiter safety.
//
// The signing input packs four fields with `:` as the delimiter. A field that
// itself contains `:` could collide with a different canonical tuple and let
// an attacker forge a signature by rearranging where the boundary lands.
// ---------------------------------------------------------------------------

describe("signCallback — field boundary validation", () => {
  it("throws when sessionId contains ':'", async () => {
    await expect(
      signCallback({
        sessionId: "aa:bb",
        expiresAt: FUTURE,
        nonce: "aabbccddeeff0011",
        signingKey: PRIMARY_KEY,
      }),
    ).rejects.toThrow(/sessionId/);
  });

  it("throws when sessionId is empty", async () => {
    await expect(
      signCallback({
        sessionId: "",
        expiresAt: FUTURE,
        nonce: "aabbccddeeff0011",
        signingKey: PRIMARY_KEY,
      }),
    ).rejects.toThrow(/sessionId/);
  });

  it("throws when nonce contains ':'", async () => {
    await expect(
      signCallback({
        sessionId: SESSION,
        expiresAt: FUTURE,
        nonce: "aa:bb",
        signingKey: PRIMARY_KEY,
      }),
    ).rejects.toThrow(/nonce/);
  });

  it("throws when nonce is empty", async () => {
    await expect(
      signCallback({
        sessionId: SESSION,
        expiresAt: FUTURE,
        nonce: "",
        signingKey: PRIMARY_KEY,
      }),
    ).rejects.toThrow(/nonce/);
  });

  it("throws when kid contains ':'", async () => {
    await expect(
      signCallback({
        sessionId: SESSION,
        expiresAt: FUTURE,
        nonce: "aabbccddeeff0011",
        kid: "pri:mary",
        signingKey: PRIMARY_KEY,
      }),
    ).rejects.toThrow(/kid/);
  });
});

describe("verifyCallback — field boundary validation", () => {
  it("throws when sessionId contains ':'", async () => {
    await expect(
      verifyCallback({
        sessionId: "aa:bb",
        sig: "AAAA",
        expiresAt: FUTURE,
        nonce: "aabbccddeeff0011",
        kid: "primary",
        primaryKey: PRIMARY_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/sessionId/);
  });

  it("throws when nonce contains ':'", async () => {
    await expect(
      verifyCallback({
        sessionId: SESSION,
        sig: "AAAA",
        expiresAt: FUTURE,
        nonce: "aa:bb",
        kid: "primary",
        primaryKey: PRIMARY_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/nonce/);
  });

  it("throws when nonce is empty", async () => {
    await expect(
      verifyCallback({
        sessionId: SESSION,
        sig: "AAAA",
        expiresAt: FUTURE,
        nonce: "",
        kid: "primary",
        primaryKey: PRIMARY_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/nonce/);
  });

  it("throws when kid contains ':'", async () => {
    await expect(
      verifyCallback({
        sessionId: SESSION,
        sig: "AAAA",
        expiresAt: FUTURE,
        nonce: "aabbccddeeff0011",
        kid: "pri:mary",
        primaryKey: PRIMARY_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/kid/);
  });

  it("throws when kid is empty", async () => {
    await expect(
      verifyCallback({
        sessionId: SESSION,
        sig: "AAAA",
        expiresAt: FUTURE,
        nonce: "aabbccddeeff0011",
        kid: "",
        primaryKey: PRIMARY_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/kid/);
  });
});

// ---------------------------------------------------------------------------
// Input validation — expiresAt integer check.
//
// `expiresAt` is typed `number`; a caller that accidentally passes
// `Date.now() / 1000` (float) or a NaN from a bad parse would silently
// produce a malformed signing input. Fail fast instead.
// ---------------------------------------------------------------------------

describe("signCallback — expiresAt validation", () => {
  it("throws on a non-integer (float) expiresAt", async () => {
    await expect(
      signCallback({
        sessionId: SESSION,
        expiresAt: 1_780_000_000.5,
        nonce: "aabbccddeeff0011",
        signingKey: PRIMARY_KEY,
      }),
    ).rejects.toThrow(/expiresAt/);
  });

  it("throws on a negative expiresAt", async () => {
    await expect(
      signCallback({
        sessionId: SESSION,
        expiresAt: -1,
        nonce: "aabbccddeeff0011",
        signingKey: PRIMARY_KEY,
      }),
    ).rejects.toThrow(/expiresAt/);
  });

  it("throws on NaN expiresAt", async () => {
    await expect(
      signCallback({
        sessionId: SESSION,
        expiresAt: Number.NaN,
        nonce: "aabbccddeeff0011",
        signingKey: PRIMARY_KEY,
      }),
    ).rejects.toThrow(/expiresAt/);
  });

  it("throws when expiresAt is a string (via type assertion)", async () => {
    await expect(
      signCallback({
        sessionId: SESSION,
        expiresAt: "1780000000" as unknown as number,
        nonce: "aabbccddeeff0011",
        signingKey: PRIMARY_KEY,
      }),
    ).rejects.toThrow(/expiresAt/);
  });
});

describe("verifyCallback — expiresAt validation", () => {
  it("throws on a non-integer (float) expiresAt", async () => {
    await expect(
      verifyCallback({
        sessionId: SESSION,
        sig: "AAAA",
        expiresAt: 1_780_000_000.5,
        nonce: "aabbccddeeff0011",
        kid: "primary",
        primaryKey: PRIMARY_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/expiresAt/);
  });

  it("throws on a negative expiresAt", async () => {
    await expect(
      verifyCallback({
        sessionId: SESSION,
        sig: "AAAA",
        expiresAt: -1,
        nonce: "aabbccddeeff0011",
        kid: "primary",
        primaryKey: PRIMARY_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/expiresAt/);
  });

  it("throws on NaN expiresAt", async () => {
    await expect(
      verifyCallback({
        sessionId: SESSION,
        sig: "AAAA",
        expiresAt: Number.NaN,
        nonce: "aabbccddeeff0011",
        kid: "primary",
        primaryKey: PRIMARY_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/expiresAt/);
  });

  it("throws when expiresAt is a string (via type assertion)", async () => {
    await expect(
      verifyCallback({
        sessionId: SESSION,
        sig: "AAAA",
        expiresAt: "1780000000" as unknown as number,
        nonce: "aabbccddeeff0011",
        kid: "primary",
        primaryKey: PRIMARY_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/expiresAt/);
  });
});
