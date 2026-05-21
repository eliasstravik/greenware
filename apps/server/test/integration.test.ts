/**
 * Greenware server — integration tests.
 *
 * Drives the full Hono app via `app.request(...)` with in-memory runtime
 * dependencies. Covers:
 *   - Happy path (submit → callback → poll returns ready with action)
 *   - Duplicate callback (same action hash → 200 duplicate)
 *   - Conflict callback (different hash → 409, state unchanged)
 *   - Submit from disallowed origin → 403
 *   - Submit with oversized body → 413
 *   - Submit with wrong Content-Type → 415
 *   - Poll without read_token → 401
 *   - Poll with wrong read_token → 403
 *   - Callback with bad signature → 403, no state change
 *   - Callback with malformed payload → session marked failed
 *   - Poll for failed session returns correct error_code
 *   - Poll for expired/not-found session returns 404
 *   - Callback missing sig/exp/nonce/kid → 400
 *
 * Design choices:
 *   - No platform emulator. The app closes over a memory session store,
 *     memory rate limiter, and webhook dispatch stub.
 *   - Webhook dispatch promises are captured so tests can observe the
 *     fire-and-forget submit behavior without calling the network.
 */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { MemoryRateLimiter } from "../src/lib/rate_limit";
import { MemorySessionStore, type SessionStore } from "../src/lib/sessions";
import { signCallback, generateNonce } from "../src/lib/signing";
import { hashReadToken } from "../src/lib/read_token";
import type { RuntimeEnv } from "../src/types";
import type { GreenwareConfig } from "../src/lib/config";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const PRIMARY_KEY = "test-primary-key-32-bytes-minimum-length-for-hs256";
const READ_KEY = "test-read-key-32-bytes-minimum-length-for-hs256";
const ALLOWED_ORIGIN = "https://example.com";
const DISALLOWED_ORIGIN = "https://evil.example.com";
const SERVER_HOST = "greenware.test";

const TEST_CONFIG: GreenwareConfig = {
  version: "1",
  enrichment: {
    timeout_ms: 10_000,
  },
  security: {
    allowed_origins: [ALLOWED_ORIGIN],
    session_ttl_seconds: 600,
    rate_limit_per_ip_per_minute: 10,
    iframe_allowlist: [],
  },
};

// ---------------------------------------------------------------------------
// Test harness.
// ---------------------------------------------------------------------------

type WebhookCall = {
  url: string;
  body: unknown;
  options?: unknown;
};
type DispatchStub = (
  url: string,
  body: unknown,
  options?: unknown,
) => Promise<void>;

interface Harness {
  env: RuntimeEnv;
  store: SessionStore;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  webhookCalls: WebhookCall[];
  webhookPromises: Promise<void>[];
}

function makeHarness(
  configOverride?: Partial<GreenwareConfig>,
  envOverride?: Partial<RuntimeEnv>,
  dispatchOverride?: DispatchStub,
): Harness {
  const env: RuntimeEnv = {
    GREENWARE_SIGNING_KEY: PRIMARY_KEY,
    GREENWARE_READ_KEY: READ_KEY,
    GREENWARE_SETUP_TOKEN: "setup-token-unused-in-these-tests",
    GREENWARE_ENV: "test",
    GREENWARE_DESTINATIONS: JSON.stringify({
      default: { webhook_url: "https://hooks.example.com/test" },
    }),
    ...(envOverride ?? {}),
  };
  const config: GreenwareConfig = {
    ...TEST_CONFIG,
    ...(configOverride ?? {}),
    security: {
      ...TEST_CONFIG.security,
      ...(configOverride?.security ?? {}),
    },
  };

  const store = new MemorySessionStore();
  const webhookCalls: WebhookCall[] = [];
  const webhookPromises: Promise<void>[] = [];
  const app = createApp({
    config,
    env,
    store,
    rateLimiter: new MemoryRateLimiter(),
    dispatchWebhook: (url, body, options) => {
      webhookCalls.push({ url, body, options });
      const promise = dispatchOverride === undefined
        ? Promise.resolve()
        : dispatchOverride(url, body, options);
      webhookPromises.push(promise);
      return promise;
    },
  });

  const request = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(`https://${SERVER_HOST}${path}`, init));

  return { env, store, request, webhookCalls, webhookPromises };
}

// ---------------------------------------------------------------------------
// Helpers — build submit request, parse submit response, build callback.
// ---------------------------------------------------------------------------

async function submit(
  harness: Harness,
  overrides?: { origin?: string; contentType?: string; body?: string },
): Promise<Response> {
  return harness.request("/api/submit", {
    method: "POST",
    headers: {
      "Origin": overrides?.origin ?? ALLOWED_ORIGIN,
      "Content-Type": overrides?.contentType ?? "application/json",
      "Host": SERVER_HOST,
      "X-Forwarded-For": "203.0.113.7",
    },
    body: overrides?.body ?? JSON.stringify({ lead: { email: "alice@example.com" } }),
  });
}

interface SubmitResponse {
  session_id: string;
  read_token: string;
  expires_at: number;
}

async function submitHappy(harness: Harness): Promise<SubmitResponse> {
  const res = await submit(harness);
  expect(res.status).toBe(200);
  return (await res.json()) as SubmitResponse;
}

/** Build a signed callback URL for the given session id. */
async function signedCallbackUrl(params: {
  sessionId: string;
  expiresAt?: number;
  signingKey?: string;
  nonce?: string;
  kid?: string;
}): Promise<{ url: string; sig: string; nonce: string; kid: string; exp: number }> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const expiresAt = params.expiresAt ?? nowUnix + 600;
  const nonce = params.nonce ?? generateNonce();
  const kid = params.kid ?? "primary";
  const signed = await signCallback({
    sessionId: params.sessionId,
    expiresAt,
    nonce,
    kid,
    signingKey: params.signingKey ?? PRIMARY_KEY,
  });
  const url =
    `/api/callback/${params.sessionId}` +
    `?exp=${signed.expires_at}` +
    `&sig=${encodeURIComponent(signed.sig)}` +
    `&nonce=${encodeURIComponent(signed.nonce)}` +
    `&kid=${encodeURIComponent(signed.kid)}`;
  return { url, sig: signed.sig, nonce: signed.nonce, kid: signed.kid, exp: signed.expires_at };
}

async function callback(
  harness: Harness,
  sessionId: string,
  body: unknown,
  options?: { urlOverride?: string },
): Promise<Response> {
  let url: string;
  if (options?.urlOverride !== undefined) {
    url = options.urlOverride;
  } else {
    const signed = await signedCallbackUrl({ sessionId });
    url = signed.url;
  }
  return harness.request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Host": SERVER_HOST,
    },
    body: JSON.stringify(body),
  });
}

async function poll(
  harness: Harness,
  sessionId: string,
  readToken: string | null,
  origin: string = ALLOWED_ORIGIN,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Origin": origin,
    "Host": SERVER_HOST,
  };
  if (readToken !== null) {
    headers["Authorization"] = `Bearer ${readToken}`;
  }
  return harness.request(`/api/session/${sessionId}`, {
    method: "GET",
    headers,
  });
}

// ---------------------------------------------------------------------------
// Happy path.
// ---------------------------------------------------------------------------

describe("happy path", () => {
  it("submit → callback → poll returns ready with action", async () => {
    const h = makeHarness();

    const submitRes = await submitHappy(h);
    expect(submitRes.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(submitRes.read_token.length).toBeGreaterThan(10);
    expect(submitRes.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Poll before callback — still pending.
    const pendingRes = await poll(h, submitRes.session_id, submitRes.read_token);
    expect(pendingRes.status).toBe(200);
    expect(await pendingRes.json()).toEqual({ status: "pending" });

    // Fire the callback.
    const cbRes = await callback(h, submitRes.session_id, {
      session_id: submitRes.session_id,
      status: "ok",
      action: { type: "redirect", url: "https://cal.com/acme" },
    });
    expect(cbRes.status).toBe(200);
    expect(await cbRes.json()).toEqual({ status: "ok" });

    // Poll again — should now be ready with the action.
    const readyRes = await poll(h, submitRes.session_id, submitRes.read_token);
    expect(readyRes.status).toBe(200);
    expect(readyRes.headers.get("Cache-Control")).toBe("no-store");
    expect(readyRes.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(await readyRes.json()).toEqual({
      status: "ready",
      action: { type: "redirect", url: "https://cal.com/acme" },
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency + conflict.
// ---------------------------------------------------------------------------

describe("callback idempotency", () => {
  it("duplicate callback with same action → 200 duplicate, no state change", async () => {
    const h = makeHarness();
    const { session_id } = await submitHappy(h);

    const payload = {
      session_id,
      status: "ok" as const,
      action: { type: "redirect" as const, url: "https://cal.com/acme" },
    };
    const first = await callback(h, session_id, payload);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "ok" });

    const stateBefore = await h.store.read(session_id);

    const second = await callback(h, session_id, payload);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "duplicate" });

    // State preserved.
    expect(await h.store.read(session_id)).toEqual(stateBefore);
  });

  it("conflict callback with different action → 409, state unchanged", async () => {
    const h = makeHarness();
    const { session_id } = await submitHappy(h);

    const first = await callback(h, session_id, {
      session_id,
      status: "ok",
      action: { type: "redirect", url: "https://cal.com/first" },
    });
    expect(first.status).toBe(200);

    const stateBefore = await h.store.read(session_id);

    const conflict = await callback(h, session_id, {
      session_id,
      status: "ok",
      action: { type: "redirect", url: "https://cal.com/second-different" },
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: string };
    expect(body.error).toBe("CALLBACK_CONFLICT");

    expect(await h.store.read(session_id)).toEqual(stateBefore);
  });
});

// ---------------------------------------------------------------------------
// Submit error paths.
// ---------------------------------------------------------------------------

describe("submit validation", () => {
  it("disallowed origin → 403", async () => {
    const h = makeHarness();
    const res = await submit(h, { origin: DISALLOWED_ORIGIN });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("missing origin → 403", async () => {
    const h = makeHarness();
    const res = await h.request("/api/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": SERVER_HOST,
        "X-Forwarded-For": "203.0.113.7",
      },
      body: JSON.stringify({ lead: { email: "a@b.com" } }),
    });
    expect(res.status).toBe(403);
  });

  it("wrong Content-Type → 415", async () => {
    const h = makeHarness();
    const res = await submit(h, { contentType: "text/plain" });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("CONTENT_TYPE_INVALID");
  });

  it("oversized body → 413", async () => {
    const h = makeHarness();
    const big = JSON.stringify({ lead: { blob: "a".repeat(17 * 1024) } });
    const res = await submit(h, { body: big });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("malformed JSON body → 400", async () => {
    const h = makeHarness();
    const res = await submit(h, { body: "{not json" });
    expect(res.status).toBe(400);
  });

  it("body missing `lead` wrapper → 400 INVALID_SUBMIT_SHAPE", async () => {
    // Regression guard: the embed posts `{ lead: { ...fields }, form_id? }`.
    // A flat `{ email: "..." }` body (old contract / hand-rolled clients)
    // must now be rejected with a clear shape-hint error, not silently
    // double-wrapped into `body.lead.lead`.
    const h = makeHarness();
    const res = await submit(h, { body: JSON.stringify({ email: "alice@example.com" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; problem: string; fix?: string };
    expect(body.error).toBe("INVALID_SUBMIT_SHAPE");
    expect(body.problem).toMatch(/lead/);
    expect(body.fix).toMatch(/lead/);
  });

  it("webhook dispatch body surfaces lead fields at lead.* (not lead.lead.*)", async () => {
    // Contract test for the embed ↔ server ↔ downstream-enrichment wire
    // shape. The embed sends `{ lead: {...}, form_id }`; the server must
    // unwrap `lead` and pass `form_id` as a sibling key so that a real
    // Clay / Zapier / custom webhook sees `body.lead.email` — not the
    // previously-broken `body.lead.lead.email`.
    const h = makeHarness();

    const res = await submit(h, {
      body: JSON.stringify({
        lead: { email: "alice@example.com", name: "Alice" },
        form_id: "contact-us",
      }),
    });
    expect(res.status).toBe(200);

    // Wait for the fire-and-forget webhook dispatch to run.
    await Promise.all(h.webhookPromises);

    const webhookCall = h.webhookCalls.find((call) => call.url === "https://hooks.example.com/test");
    expect(webhookCall).toBeDefined();

    const capturedBody = webhookCall!.body as {
      session_id: string;
      callback_url: string;
      lead: { email: string; name: string };
      form_id?: string;
      meta: { submitted_at: string };
    };

    // Core contract: the lead fields must be at `body.lead.email`,
    // not `body.lead.lead.email`.
    expect(capturedBody.lead.email).toBe("alice@example.com");
    expect(capturedBody.lead.name).toBe("Alice");
    expect((capturedBody.lead as Record<string, unknown>).lead).toBeUndefined();

    // form_id rides alongside lead as a sibling, not nested inside it.
    expect(capturedBody.form_id).toBe("contact-us");
    expect((capturedBody.lead as Record<string, unknown>).form_id).toBeUndefined();

    // session_id + callback_url + meta still wrap the body.
    expect(capturedBody.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(capturedBody.callback_url).toContain("/api/callback/");
    expect(capturedBody.meta.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("uses configured public URL for callback URLs instead of forwarded request host", async () => {
    const h = makeHarness(undefined, {
      GREENWARE_PUBLIC_URL: "https://greenware.example.com/",
      RAILWAY_PUBLIC_DOMAIN: "railway-generated.example.com",
    } as Partial<RuntimeEnv>);

    const res = await submit(h, {
      body: JSON.stringify({
        lead: { email: "alice@example.com" },
        form_id: "contact-us",
      }),
    });
    expect(res.status).toBe(200);
    await Promise.all(h.webhookPromises);

    const capturedBody = h.webhookCalls[0]!.body as { callback_url: string };
    expect(capturedBody.callback_url).toMatch(/^https:\/\/greenware\.example\.com\/api\/callback\//);
    expect(capturedBody.callback_url).not.toContain(SERVER_HOST);
  });

  it("marks the session failed when enrichment dispatch fails after submit", async () => {
    const h = makeHarness(undefined, undefined, async () => {
      const err = new Error("Clay returned 401");
      (err as Error & { errorCode?: string }).errorCode = "WEBHOOK_NON_2XX";
      throw err;
    });

    const submitRes = await submitHappy(h);
    await Promise.allSettled(h.webhookPromises);

    const pollRes = await poll(h, submitRes.session_id, submitRes.read_token);
    expect(pollRes.status).toBe(200);
    expect(await pollRes.json()).toEqual({
      status: "failed",
      error_code: "WEBHOOK_NON_2XX",
    });
  });

  it("webhook dispatch uses the destination matching form_id", async () => {
    const h = makeHarness(undefined, {
      GREENWARE_DESTINATIONS: JSON.stringify({
        default: {
          webhook_url: "https://hooks.example.com/default",
        },
        "contact-us": {
          webhook_url: "https://hooks.example.com/contact",
          headers: { "x-clay-webhook-auth": "contact-token" },
        },
      }),
    });

    const res = await submit(h, {
      body: JSON.stringify({
        lead: { email: "alice@example.com" },
        form_id: "contact-us",
      }),
    });
    expect(res.status).toBe(200);
    await Promise.all(h.webhookPromises);

    expect(h.webhookCalls).toHaveLength(1);
    expect(h.webhookCalls[0]!.url).toBe("https://hooks.example.com/contact");
    expect(h.webhookCalls[0]!.options).toMatchObject({
      destinationId: "contact-us",
      headers: {
        "Content-Type": "application/json",
        "x-clay-webhook-auth": "contact-token",
      },
    });
  });

  it("rate limit exhausted → 429", async () => {
    const h = makeHarness({ security: { ...TEST_CONFIG.security, rate_limit_per_ip_per_minute: 2 } });
    expect((await submit(h)).status).toBe(200);
    expect((await submit(h)).status).toBe(200);
    const limited = await submit(h);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: string };
    expect(body.error).toBe("RATE_LIMITED");
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
  });
});

// ---------------------------------------------------------------------------
// Poll error paths.
// ---------------------------------------------------------------------------

describe("poll auth + state", () => {
  it("poll without read_token → 401", async () => {
    const h = makeHarness();
    const { session_id } = await submitHappy(h);
    const res = await poll(h, session_id, null);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_AUTH");
  });

  it("poll with wrong read_token → 403", async () => {
    const h = makeHarness();
    const { session_id } = await submitHappy(h);
    const res = await poll(h, session_id, "totally-wrong-token");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("INVALID_AUTH");
  });

  it("poll with disallowed origin → 403", async () => {
    const h = makeHarness();
    const { session_id, read_token } = await submitHappy(h);
    const res = await poll(h, session_id, read_token, DISALLOWED_ORIGIN);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("poll for nonexistent session → 404", async () => {
    const h = makeHarness();
    // Need to submit once to get a valid read_token format, then swap
    // in a different (unknown) session id.
    const { read_token } = await submitHappy(h);
    const res = await poll(h, "00000000-0000-4000-8000-000000000000", read_token);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("SESSION_NOT_FOUND");
  });

  it("poll for failed session returns status=failed with error_code", async () => {
    const h = makeHarness();
    const { session_id, read_token } = await submitHappy(h);

    // Send a malformed callback so the session transitions to failed.
    const res = await callback(h, session_id, { wrong: "shape" });
    expect(res.status).toBe(400);

    const pollRes = await poll(h, session_id, read_token);
    expect(pollRes.status).toBe(200);
    const body = (await pollRes.json()) as { status: string; error_code: string };
    expect(body.status).toBe("failed");
    expect(body.error_code).toBe("INVALID_CALLBACK_PAYLOAD");
  });

  it("poll for an expired session returns status=expired", async () => {
    const h = makeHarness();
    const { session_id, read_token } = await submitHappy(h);

    await h.store.transitionToTerminal({
      sessionId: session_id,
      status: "expired",
    });

    const res = await poll(h, session_id, read_token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "expired" });
  });

  it("long-poll with ?wait=1 returns terminal state when callback lands mid-wait", async () => {
    const h = makeHarness();
    const { session_id, read_token } = await submitHappy(h);

    // Kick off the wait poll, then transition the shared store while it waits.
    const pollPromise = h.request(`/api/session/${session_id}?wait=1`, {
      method: "GET",
      headers: {
        "Origin": ALLOWED_ORIGIN,
        "Host": SERVER_HOST,
        "Authorization": `Bearer ${read_token}`,
      },
    });

    // Give the long-poll loop one tick to start, then transition to ready.
    await new Promise((r) => setTimeout(r, 50));
    await h.store.transitionToTerminal({
      sessionId: session_id,
      status: "ready",
      actionHash: "test-hash",
      actionPayload: { type: "message", title: "Hi", body: "Long-poll works." },
    });

    const res = await pollPromise;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; action: { type: string; title: string } };
    expect(body.status).toBe("ready");
    expect(body.action.type).toBe("message");
    expect(body.action.title).toBe("Hi");
  });
});

// ---------------------------------------------------------------------------
// Callback auth + payload.
// ---------------------------------------------------------------------------

describe("callback auth + payload", () => {
  it("bad signature → 403, state unchanged", async () => {
    const h = makeHarness();
    const { session_id } = await submitHappy(h);

    const stateBefore = await h.store.read(session_id);

    // Hand-build a URL with a deliberately bogus sig.
    const nowUnix = Math.floor(Date.now() / 1000);
    const url =
      `/api/callback/${session_id}` +
      `?exp=${nowUnix + 600}` +
      `&sig=${encodeURIComponent("ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")}` +
      `&nonce=${encodeURIComponent("deadbeef")}` +
      `&kid=primary`;
    const res = await callback(
      h,
      session_id,
      {
        session_id,
        status: "ok",
        action: { type: "redirect", url: "https://cal.com/x" },
      },
      { urlOverride: url },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("SIGNATURE_INVALID");

    // State unchanged (still pending).
    expect(await h.store.read(session_id)).toEqual(stateBefore);
  });

  it("expired signature → 403 SIGNATURE_EXPIRED", async () => {
    const h = makeHarness();
    const { session_id } = await submitHappy(h);

    // Sign with exp in the past.
    const expiredExp = Math.floor(Date.now() / 1000) - 10;
    const signed = await signCallback({
      sessionId: session_id,
      expiresAt: expiredExp,
      nonce: "deadbeefcafef00d",
      signingKey: PRIMARY_KEY,
    });
    const url =
      `/api/callback/${session_id}` +
      `?exp=${signed.expires_at}` +
      `&sig=${encodeURIComponent(signed.sig)}` +
      `&nonce=${encodeURIComponent(signed.nonce)}` +
      `&kid=${encodeURIComponent(signed.kid)}`;

    const res = await callback(
      h,
      session_id,
      {
        session_id,
        status: "ok",
        action: { type: "redirect", url: "https://cal.com/x" },
      },
      { urlOverride: url },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("SIGNATURE_EXPIRED");
  });

  it("missing sig/exp/nonce/kid → 400", async () => {
    const h = makeHarness();
    const { session_id } = await submitHappy(h);

    const res = await callback(
      h,
      session_id,
      {
        session_id,
        status: "ok",
        action: { type: "redirect", url: "https://cal.com/x" },
      },
      { urlOverride: `/api/callback/${session_id}` }, // no query string
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MISSING_SIG_PARAMS");
  });

  it("rate limits callback attempts", async () => {
    const h = makeHarness({
      security: { ...TEST_CONFIG.security, rate_limit_per_ip_per_minute: 1 },
    });
    const { session_id } = await submitHappy(h);

    const first = await callback(h, session_id, {
      session_id,
      status: "ok",
      action: { type: "redirect", url: "https://cal.com/x" },
    });
    expect(first.status).toBe(200);

    const second = await callback(h, session_id, {
      session_id,
      status: "ok",
      action: { type: "redirect", url: "https://cal.com/x" },
    });
    expect(second.status).toBe(429);
  });

  it("malformed payload (bad schema) → 400 + session marked failed", async () => {
    const h = makeHarness();
    const { session_id, read_token } = await submitHappy(h);

    // Missing required `action` field.
    const res = await callback(h, session_id, { session_id, status: "ok" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("INVALID_CALLBACK_PAYLOAD");

    // Session should now be failed with INVALID_CALLBACK_PAYLOAD.
    const pollRes = await poll(h, session_id, read_token);
    const pollBody = (await pollRes.json()) as { status: string; error_code: string };
    expect(pollBody.status).toBe("failed");
    expect(pollBody.error_code).toBe("INVALID_CALLBACK_PAYLOAD");
  });

  it("accepts protocol error callbacks and marks the session failed with the posted code", async () => {
    const h = makeHarness();
    const { session_id, read_token } = await submitHappy(h);

    const res = await callback(h, session_id, {
      session_id,
      status: "error",
      error_code: "WEBHOOK_TIMEOUT",
      problem: "Clay timed out.",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });

    const pollRes = await poll(h, session_id, read_token);
    expect(pollRes.status).toBe(200);
    expect(await pollRes.json()).toEqual({
      status: "failed",
      error_code: "WEBHOOK_TIMEOUT",
    });
  });

  it("rejects embed callback URLs outside the configured iframe allowlist", async () => {
    const h = makeHarness({
      security: {
        ...TEST_CONFIG.security,
        iframe_allowlist: ["calendly.com"],
      },
    });
    const { session_id, read_token } = await submitHappy(h);

    const res = await callback(h, session_id, {
      session_id,
      status: "ok",
      action: {
        type: "embed",
        provider: "iframe",
        url: "https://untrusted.example.com/scheduler",
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; problem: string };
    expect(body.error).toBe("INVALID_CALLBACK_PAYLOAD");
    expect(body.problem).toMatch(/iframe/i);

    const pollRes = await poll(h, session_id, read_token);
    expect(await pollRes.json()).toEqual({
      status: "failed",
      error_code: "INVALID_CALLBACK_PAYLOAD",
    });
  });

  it("non-JSON body → 400 + session marked failed", async () => {
    const h = makeHarness();
    const { session_id, read_token } = await submitHappy(h);

    const signed = await signedCallbackUrl({ sessionId: session_id });
    const res = await h.request(signed.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Host": SERVER_HOST },
      body: "{not json",
    });
    expect(res.status).toBe(400);

    const pollRes = await poll(h, session_id, read_token);
    const pollBody = (await pollRes.json()) as { status: string; error_code: string };
    expect(pollBody.status).toBe("failed");
  });

  it("payload session_id mismatch → 400 + failed", async () => {
    const h = makeHarness();
    const { session_id, read_token } = await submitHappy(h);

    const other = "11111111-1111-4111-8111-111111111111";
    const res = await callback(h, session_id, {
      session_id: other,
      status: "ok",
      action: { type: "redirect", url: "https://cal.com/x" },
    });
    expect(res.status).toBe(400);

    const pollRes = await poll(h, session_id, read_token);
    const pollBody = (await pollRes.json()) as { status: string };
    expect(pollBody.status).toBe("failed");
  });

  it("oversized callback body → 413", async () => {
    const h = makeHarness();
    const { session_id } = await submitHappy(h);
    const signed = await signedCallbackUrl({ sessionId: session_id });
    const huge = JSON.stringify({ blob: "a".repeat(65 * 1024) });
    const res = await h.request(signed.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Host": SERVER_HOST },
      body: huge,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("callback for unknown session → 404", async () => {
    const h = makeHarness();
    const unknown = "22222222-2222-4222-8222-222222222222";
    const res = await callback(h, unknown, {
      session_id: unknown,
      status: "ok",
      action: { type: "redirect", url: "https://cal.com/x" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("SESSION_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Smoke tests — CORS + healthz + unknown route.
// ---------------------------------------------------------------------------

describe("smoke", () => {
  it("healthz responds ok", async () => {
    const h = makeHarness();
    const res = await h.request("/healthz", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("ready reports missing production destination separately from process health", async () => {
    const h = makeHarness(undefined, { GREENWARE_DESTINATIONS: undefined });

    const res = await h.request("/ready", { method: "GET" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      problem: expect.stringMatching(/destination/i),
    });
  });

  it("ready reports not_ready when only local/Railway origins are configured", async () => {
    const h = makeHarness({
      security: {
        ...TEST_CONFIG.security,
        allowed_origins: [
          "http://localhost:8787",
          "http://127.0.0.1:8787",
          "https://greenware-production.up.railway.app",
        ],
      },
    }, {
      GREENWARE_DESTINATIONS: JSON.stringify({
        default: {
          webhook_url: "https://hooks.example.com/default",
        },
      }),
      RAILWAY_PUBLIC_DOMAIN: "greenware-production.up.railway.app",
      GREENWARE_ENV: "production",
    });

    const res = await h.request("/ready", { method: "GET" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      problem: expect.stringMatching(/allowed browser origin/i),
    });
  });

  it("ready reports ok when a real enrichment destination is configured", async () => {
    const h = makeHarness(undefined, {
      GREENWARE_DESTINATIONS: JSON.stringify({
        default: {
          webhook_url: "https://hooks.example.com/default",
        },
      }),
    });

    const res = await h.request("/ready", { method: "GET" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      destination: "default",
      storage: "memory",
    });
  });

  it("setup session log endpoint is token protected and returns redacted records", async () => {
    const h = makeHarness();
    const { session_id } = await submitHappy(h);
    await callback(h, session_id, {
      session_id,
      status: "ok",
      action: { type: "redirect", url: "https://cal.com/acme" },
    });

    const denied = await h.request("/setup/sessions", { method: "GET" });
    expect(denied.status).toBe(401);

    const queryTokenDenied = await h.request(
      `/setup/sessions?token=${encodeURIComponent(h.env.GREENWARE_SETUP_TOKEN!)}`,
      { method: "GET" },
    );
    expect(queryTokenDenied.status).toBe(401);

    const allowed = await h.request("/setup/sessions", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${h.env.GREENWARE_SETUP_TOKEN!}`,
      },
    });
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { sessions: Array<Record<string, unknown>> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      session_id,
      status: "ready",
      action_type: "redirect",
    });
    expect(body.sessions[0]).not.toHaveProperty("action_payload");
    expect(body.sessions[0]).not.toHaveProperty("read_token_hash");
  });

  it("keeps setup session log disabled when no setup token is configured", async () => {
    const h = makeHarness(undefined, { GREENWARE_SETUP_TOKEN: undefined });

    const res = await h.request("/setup/sessions", { method: "GET" });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "INVALID_AUTH",
      problem: "Setup endpoints are disabled because GREENWARE_SETUP_TOKEN is not configured.",
    });
  });

  it("unknown route → 404 with unified error shape", async () => {
    const h = makeHarness();
    const res = await h.request("/nope", { method: "GET" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("submit response includes Access-Control-Allow-Origin", async () => {
    const h = makeHarness();
    const res = await submit(h);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("read_token_hash stored is hash of read_token returned", async () => {
    // Defense against the token ever being stored raw.
    const h = makeHarness();
    const { session_id, read_token } = await submitHappy(h);

    const rec = await h.store.read(session_id);
    const expected = await hashReadToken(read_token);
    expect(rec?.read_token_hash).toBe(expected);
    expect(rec?.read_token_hash).not.toBe(read_token);
  });
});

// ---------------------------------------------------------------------------
// CORS preflight (OPTIONS).
// ---------------------------------------------------------------------------

describe("CORS preflight", () => {
  it("OPTIONS /api/submit from allowed origin → 204 + CORS headers with POST method", async () => {
    const h = makeHarness();
    const res = await h.request("/api/submit", {
      method: "OPTIONS",
      headers: {
        "Origin": ALLOWED_ORIGIN,
        "Host": SERVER_HOST,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("OPTIONS /api/session/:id from allowed origin → 204 + CORS headers with GET method", async () => {
    const h = makeHarness();
    const res = await h.request("/api/session/00000000-0000-4000-8000-000000000000", {
      method: "OPTIONS",
      headers: {
        "Origin": ALLOWED_ORIGIN,
        "Host": SERVER_HOST,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Authorization");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("OPTIONS /api/submit from disallowed origin → 204 but NO ACA-Origin header", async () => {
    const h = makeHarness();
    const res = await h.request("/api/submit", {
      method: "OPTIONS",
      headers: {
        "Origin": DISALLOWED_ORIGIN,
        "Host": SERVER_HOST,
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
  });

  it("OPTIONS /api/session/:id from disallowed origin → 204 but NO ACA-Origin header", async () => {
    const h = makeHarness();
    const res = await h.request("/api/session/00000000-0000-4000-8000-000000000000", {
      method: "OPTIONS",
      headers: {
        "Origin": DISALLOWED_ORIGIN,
        "Host": SERVER_HOST,
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Production error sanitization (Fix 3 / D3).
// ---------------------------------------------------------------------------

describe("production error sanitization", () => {
  it("GREENWARE_ENV=production strips `cause` from error bodies", async () => {
    const h = makeHarness(undefined, { GREENWARE_ENV: "production" });
    const res = await submit(h, { origin: DISALLOWED_ORIGIN });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("ORIGIN_NOT_ALLOWED");
    expect(body.problem).toBeDefined();
    expect(body.fix).toBeDefined();
    expect(body).not.toHaveProperty("cause");
  });

  it("GREENWARE_ENV=test keeps `cause` field (fail-open dev visibility)", async () => {
    const h = makeHarness();
    const res = await submit(h, { origin: DISALLOWED_ORIGIN });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("ORIGIN_NOT_ALLOWED");
    // `cause` should be present in non-production environments.
    expect(body.cause).toBeDefined();
  });
});
