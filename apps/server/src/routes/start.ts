/**
 * Greenware server — POST /api/session/start.
 *
 * Browser-facing endpoint for third-party form embeds. It mints a pending
 * session before the provider form is submitted so the session id/read token
 * can be passed as hidden fields into Typeform, Tally, or a locked-down form.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings, RuntimeEnv } from "../types";
import type { GreenwareConfig } from "../lib/config";
import type { RateLimiter } from "../lib/rate_limit";
import type { SessionStore } from "../lib/sessions";
import { checkOrigin, corsHeadersFor } from "../lib/origin";
import { mintReadToken, hashReadToken } from "../lib/read_token";
import {
  errorResponse,
  ERR_CONTENT_TYPE_INVALID,
  ERR_INVALID_CALLBACK_PAYLOAD,
  ERR_ORIGIN_NOT_ALLOWED,
  ERR_PAYLOAD_TOO_LARGE,
  ERR_RATE_LIMITED,
} from "../lib/errors";

const MAX_BODY_BYTES = 4096;

export function startRoute(deps: {
  config: GreenwareConfig;
  env: RuntimeEnv;
  store: SessionStore;
  rateLimiter: RateLimiter;
}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post("/api/session/start", async (c) => {
    return handleStart(c, deps.config, deps.env, deps.store, deps.rateLimiter);
  });

  return app;
}

async function handleStart(
  c: Context<AppBindings>,
  config: GreenwareConfig,
  env: RuntimeEnv,
  store: SessionStore,
  rateLimiter: RateLimiter,
): Promise<Response> {
  const origin = c.req.header("origin");
  const allowedOrigin = checkOrigin(origin, config.security.allowed_origins);
  if (allowedOrigin === null) {
    return errorResponse(
      403,
      {
        error: ERR_ORIGIN_NOT_ALLOWED,
        problem: "Origin header is missing or not in the allowed list.",
        fix: "Add the requesting origin to GREENWARE_ALLOWED_ORIGINS or the server config allowed_origins.",
      },
      env.GREENWARE_ENV,
    );
  }
  const corsHeaders = corsHeadersFor(allowedOrigin, "submit");

  const rl = await rateLimiter.checkAndIncrement({
    ip: clientIp(c),
    limit: config.security.rate_limit_per_ip_per_minute,
  });
  if (!rl.allowed) {
    const res = errorResponse(
      429,
      {
        error: ERR_RATE_LIMITED,
        problem: "Too many session starts from this IP.",
        fix: `Retry after ${rl.retryAfter} seconds.`,
      },
      env.GREENWARE_ENV,
    );
    res.headers.set("Retry-After", String(rl.retryAfter));
    return withHeaders(res, corsHeaders);
  }

  const contentType = c.req.header("content-type") ?? "";
  if (contentType.length > 0 && !contentType.toLowerCase().startsWith("application/json")) {
    return withHeaders(
      errorResponse(
        415,
        {
          error: ERR_CONTENT_TYPE_INVALID,
          problem: "Content-Type must be application/json.",
          fix: "Send JSON or omit the request body.",
        },
        env.GREENWARE_ENV,
      ),
      corsHeaders,
    );
  }

  const bodyText = await c.req.text();
  if (bodyText.length > MAX_BODY_BYTES) {
    return withHeaders(
      errorResponse(
        413,
        {
          error: ERR_PAYLOAD_TOO_LARGE,
          problem: `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
          fix: "Send only provider/form metadata when starting a session.",
        },
        env.GREENWARE_ENV,
      ),
      corsHeaders,
    );
  }

  let provider: string | undefined;
  let formId: string | undefined;
  if (bodyText.trim().length > 0) {
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("body must be an object");
      }
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.provider === "string" && obj.provider.length > 0) provider = obj.provider;
      if (typeof obj.form_id === "string" && obj.form_id.length > 0) formId = obj.form_id;
    } catch (err) {
      return withHeaders(
        errorResponse(
          400,
          {
            error: ERR_INVALID_CALLBACK_PAYLOAD,
            problem: "Request body is not valid JSON.",
            cause: err instanceof Error ? err.message : "unknown parse error",
            fix: "Send { provider?: string, form_id?: string }.",
          },
          env.GREENWARE_ENV,
        ),
        corsHeaders,
      );
    }
  }

  const sessionId = crypto.randomUUID();
  const readToken = await mintReadToken(sessionId, env.GREENWARE_READ_KEY);
  const nowUnix = Math.floor(Date.now() / 1000);
  const expiresAt = nowUnix + config.security.session_ttl_seconds;

  await store.writePending({
    sessionId,
    readTokenHash: await hashReadToken(readToken),
    origin: allowedOrigin,
    provider,
    formId,
    expiresAtUnix: expiresAt,
    ttlSeconds: config.security.session_ttl_seconds,
  });

  return withHeaders(
    new Response(
      JSON.stringify({
        session_id: sessionId,
        read_token: readToken,
        expires_at: expiresAt,
        hidden_fields: {
          greenware_session_id: sessionId,
          greenware_read_token: readToken,
          ...(formId !== undefined ? { greenware_form_id: formId } : {}),
        },
        wait_url: `/wait/${sessionId}#read_token=${encodeURIComponent(readToken)}`,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    ),
    corsHeaders,
  );
}

function clientIp(c: Context<AppBindings>): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}
