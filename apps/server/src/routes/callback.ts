/**
 * Greenware server — POST /api/callback/:sessionId.
 *
 * Server-to-server endpoint called by the enrichment service with a signed URL
 * and a Protocol v1 callback payload. Valid callbacks transition the session
 * to ready; malformed callback bodies transition the session to failed so the
 * browser does not wait until TTL expiry.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings, RuntimeEnv } from "../types";
import type { GreenwareConfig } from "../lib/config";
import type { RateLimiter } from "../lib/rate_limit";
import type { SessionStore } from "../lib/sessions";
import { verifyCallback } from "../lib/signing";
import { ErrorPayload, parseCallback, ProtocolParseError, type Action } from "../lib/protocol";
import {
  errorResponse,
  ERR_PAYLOAD_TOO_LARGE,
  ERR_INVALID_CALLBACK_PAYLOAD,
  ERR_CALLBACK_CONFLICT,
  ERR_SESSION_NOT_FOUND,
  ERR_SESSION_NOT_PENDING,
  ERR_SIGNATURE_INVALID,
  ERR_SIGNATURE_EXPIRED,
  ERR_UNKNOWN_KID,
  ERR_MISSING_SIG_PARAMS,
  ERR_RATE_LIMITED,
} from "../lib/errors";

const MAX_BODY_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();

export function callbackRoute(deps: {
  config: GreenwareConfig;
  env: RuntimeEnv;
  store: SessionStore;
  rateLimiter: RateLimiter;
}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post("/api/callback/:sessionId", async (c) => {
    return handleCallback(c, deps.config, deps.env, deps.store, deps.rateLimiter);
  });

  return app;
}

async function handleCallback(
  c: Context<AppBindings>,
  config: GreenwareConfig,
  env: RuntimeEnv,
  store: SessionStore,
  rateLimiter: RateLimiter,
): Promise<Response> {
  const sessionId = c.req.param("sessionId") ?? "";
  if (sessionId.length === 0) {
    return errorResponse(
      400,
      {
        error: ERR_MISSING_SIG_PARAMS,
        problem: "Callback URL is missing the session_id path segment.",
        fix: "Use the signed callback_url returned by /api/submit.",
      },
      env.GREENWARE_ENV,
    );
  }

  const rl = await rateLimiter.checkAndIncrement({
    ip: clientIp(c),
    limit: config.security.rate_limit_per_ip_per_minute,
  });
  if (!rl.allowed) {
    const res = errorResponse(
      429,
      {
        error: ERR_RATE_LIMITED,
        problem: "Too many callback attempts from this IP.",
        fix: `Retry after ${rl.retryAfter} seconds.`,
      },
      env.GREENWARE_ENV,
    );
    res.headers.set("Retry-After", String(rl.retryAfter));
    return res;
  }

  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return errorResponse(
        413,
        {
          error: ERR_PAYLOAD_TOO_LARGE,
          problem: `Callback body exceeds ${MAX_BODY_BYTES} bytes.`,
          cause: `Declared Content-Length: ${declared}.`,
          fix: "Shrink the action payload.",
        },
        env.GREENWARE_ENV,
      );
    }
  }

  const bodyText = await c.req.text();
  if (bodyText.length > MAX_BODY_BYTES) {
    return errorResponse(
      413,
      {
        error: ERR_PAYLOAD_TOO_LARGE,
        problem: `Callback body exceeds ${MAX_BODY_BYTES} bytes.`,
        cause: `Actual body length: ${bodyText.length}.`,
        fix: "Shrink the action payload.",
      },
      env.GREENWARE_ENV,
    );
  }

  const sig = c.req.query("sig");
  const expRaw = c.req.query("exp");
  const nonce = c.req.query("nonce");
  const kid = c.req.query("kid");

  if (!sig || !expRaw || !nonce || !kid) {
    return errorResponse(
      400,
      {
        error: ERR_MISSING_SIG_PARAMS,
        problem: "Callback URL is missing one or more signature query params.",
        cause: "Required: sig, exp, nonce, kid.",
        fix: "Use the signed callback_url returned by /api/submit; do not construct your own.",
      },
      env.GREENWARE_ENV,
    );
  }

  const expiresAt = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt < 0) {
    return errorResponse(
      400,
      {
        error: ERR_MISSING_SIG_PARAMS,
        problem: "Callback `exp` query param is not a valid unix timestamp.",
        cause: `Got: '${expRaw}'.`,
        fix: "Use the signed callback_url returned by /api/submit.",
      },
      env.GREENWARE_ENV,
    );
  }

  const verify = await verifyCallback({
    sessionId,
    sig,
    expiresAt,
    nonce,
    kid,
    primaryKey: env.GREENWARE_SIGNING_KEY,
    previousKey: env.GREENWARE_SIGNING_KEY_PREVIOUS,
  });
  if (!verify.valid) {
    const { code, message } = mapVerifyReason(verify.reason);
    return errorResponse(
      403,
      {
        error: code,
        problem: message,
        cause: `kid=${kid} reason=${verify.reason}`,
        fix: "Check that the signing key matches between Greenware and the caller.",
      },
      env.GREENWARE_ENV,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText) as unknown;
  } catch (err) {
    await store
      .transitionToTerminal({
        sessionId,
        status: "failed",
        errorCode: "INVALID_CALLBACK_PAYLOAD",
      })
      .catch(() => undefined);

    return errorResponse(
      400,
      {
        error: ERR_INVALID_CALLBACK_PAYLOAD,
        problem: "Callback body did not match Protocol v1 schema.",
        cause: err instanceof Error ? err.message : "unknown parse error",
        fix: "Send { session_id, status: \"ok\", action: { type, ... } } per greenware.dev/docs/protocol-v1.",
      },
      env.GREENWARE_ENV,
    );
  }

  const parsedError = ErrorPayload.safeParse(raw);
  if (parsedError.success) {
    if (parsedError.data.session_id !== sessionId) {
      await failSession(store, sessionId, "INVALID_CALLBACK_PAYLOAD");
      return sessionMismatchResponse(env, sessionId, parsedError.data.session_id);
    }

    const result = await store.transitionToTerminal({
      sessionId,
      status: "failed",
      errorCode: parsedError.data.error_code,
    });
    switch (result.kind) {
      case "transitioned":
        return jsonOk({ status: "ok" });
      case "not_pending":
        return jsonOk({ status: "duplicate" });
      case "not_found":
        return sessionNotFoundResponse(env, sessionId);
      case "idempotent_duplicate":
        return jsonOk({ status: "duplicate" });
      case "conflict":
        return callbackConflictResponse(env, result.previousActionHash, "error");
    }
  }

  let parsed;
  try {
    parsed = parseCallback(raw);
    assertIframeAllowed(parsed.action, config.security.iframe_allowlist);
  } catch (err) {
    const isProtocolErr = err instanceof ProtocolParseError;
    const cause = err instanceof Error ? err.message : "unknown parse error";

    await store
      .transitionToTerminal({
        sessionId,
        status: "failed",
        errorCode: isProtocolErr ? err.code : "INVALID_CALLBACK_PAYLOAD",
      })
      .catch(() => undefined);

    return errorResponse(
      400,
      {
        error: ERR_INVALID_CALLBACK_PAYLOAD,
        problem:
          isProtocolErr && cause.toLowerCase().includes("iframe")
            ? "Callback embed iframe destination is not allowed."
            : "Callback body did not match Protocol v1 schema.",
        cause,
        fix: "Send { session_id, status: \"ok\", action: { type, ... } } per greenware.dev/docs/protocol-v1.",
      },
      env.GREENWARE_ENV,
    );
  }

  if (parsed.session_id !== sessionId) {
    await failSession(store, sessionId, "INVALID_CALLBACK_PAYLOAD");
    return sessionMismatchResponse(env, sessionId, parsed.session_id);
  }

  const actionHash = await sha256Hex(JSON.stringify(parsed.action));
  const result = await store.transitionToTerminal({
    sessionId,
    status: "ready",
    actionHash,
    actionPayload: parsed.action,
  });

  switch (result.kind) {
    case "transitioned":
      return jsonOk({ status: "ok" });
    case "idempotent_duplicate":
      return jsonOk({ status: "duplicate" });
    case "conflict":
      return callbackConflictResponse(env, result.previousActionHash, actionHash);
    case "not_found":
      return sessionNotFoundResponse(env, sessionId);
    case "not_pending":
      return errorResponse(
        409,
        {
          error: ERR_SESSION_NOT_PENDING,
          problem: `Session is already in terminal state '${result.currentStatus}'.`,
          fix: "Each session can be completed only once.",
        },
        env.GREENWARE_ENV,
      );
  }
}

function assertIframeAllowed(action: Action, allowlist: readonly string[]): void {
  if (action.type !== "embed" || allowlist.length === 0) return;
  let host: string;
  try {
    host = new URL(action.url).hostname.toLowerCase();
  } catch {
    throw new ProtocolParseError("INVALID_CALLBACK_PAYLOAD", "action.url: invalid embed URL");
  }
  const allowed = allowlist.some((item) => {
    const allowedHost = item.trim().toLowerCase();
    return host === allowedHost || host.endsWith(`.${allowedHost}`);
  });
  if (!allowed) {
    throw new ProtocolParseError(
      "INVALID_CALLBACK_PAYLOAD",
      "action.url: iframe destination is not in security.iframe_allowlist",
    );
  }
}

async function failSession(store: SessionStore, sessionId: string, errorCode: string): Promise<void> {
  await store
    .transitionToTerminal({
      sessionId,
      status: "failed",
      errorCode,
    })
    .catch(() => undefined);
}

function sessionMismatchResponse(env: RuntimeEnv, sessionId: string, payloadSessionId: string): Response {
  return errorResponse(
    400,
    {
      error: ERR_INVALID_CALLBACK_PAYLOAD,
      problem: "Payload session_id does not match URL path session_id.",
      cause: `URL: ${sessionId}, payload: ${payloadSessionId}.`,
      fix: "Echo the session_id from the signed callback URL in the body.",
    },
    env.GREENWARE_ENV,
  );
}

function callbackConflictResponse(
  env: RuntimeEnv,
  previousActionHash: string,
  incomingActionHash: string,
): Response {
  return errorResponse(
    409,
    {
      error: ERR_CALLBACK_CONFLICT,
      problem: "A different callback already completed this session.",
      cause: `previous_action_hash=${previousActionHash}, incoming_action_hash=${incomingActionHash}`,
      fix: "Each session must be completed exactly once. Check for duplicate or racing workflows.",
    },
    env.GREENWARE_ENV,
  );
}

function sessionNotFoundResponse(env: RuntimeEnv, sessionId: string): Response {
  return errorResponse(
    404,
    {
      error: ERR_SESSION_NOT_FOUND,
      problem: "No session with this id exists.",
      cause: `session_id=${sessionId}`,
      fix: "Verify the callback URL has not expired and belongs to a session minted by this server.",
    },
    env.GREENWARE_ENV,
  );
}

function mapVerifyReason(reason: "expired" | "bad_signature" | "unknown_kid"): {
  code: string;
  message: string;
} {
  switch (reason) {
    case "expired":
      return {
        code: ERR_SIGNATURE_EXPIRED,
        message: "Callback URL has expired.",
      };
    case "bad_signature":
      return {
        code: ERR_SIGNATURE_INVALID,
        message: "Callback URL signature did not verify.",
      };
    case "unknown_kid":
      return {
        code: ERR_UNKNOWN_KID,
        message: "Callback URL references an unknown signing key.",
      };
  }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  const bytes = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function clientIp(c: Context<AppBindings>): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip") ?? "unknown";
}
