/**
 * Greenware server — POST /api/submit.
 *
 * Validates the browser form submission, mints a session + read token, signs
 * a callback URL, persists the pending session, and dispatches the enrichment
 * webhook in the background. The browser receives `{ session_id, read_token,
 * expires_at }` immediately and starts polling.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings, RuntimeEnv } from "../types";
import type { GreenwareConfig } from "../lib/config";
import type { RateLimiter } from "../lib/rate_limit";
import type { SessionStore } from "../lib/sessions";
import { checkOrigin, corsHeadersFor } from "../lib/origin";
import { signCallback, generateNonce } from "../lib/signing";
import { mintReadToken, hashReadToken } from "../lib/read_token";
import { dispatchEnrichmentWebhook } from "../lib/enrichment_webhook";
import { resolveEnrichmentDestination } from "../lib/enrichment_destinations";
import { publicBaseUrl } from "../lib/public_url";
import {
  errorResponse,
  ERR_ORIGIN_NOT_ALLOWED,
  ERR_CONTENT_TYPE_INVALID,
  ERR_PAYLOAD_TOO_LARGE,
  ERR_RATE_LIMITED,
  ERR_INVALID_CALLBACK_PAYLOAD,
  ERR_INVALID_SUBMIT_SHAPE,
} from "../lib/errors";

const MAX_BODY_BYTES = 16 * 1024;

export type WebhookDispatcher = (
  url: string,
  body: unknown,
  options?: {
    destinationId: string;
    headers: Record<string, string>;
    timeoutMs: number;
  },
) => Promise<void>;

export function submitRoute(deps: {
  config: GreenwareConfig;
  env: RuntimeEnv;
  store: SessionStore;
  rateLimiter: RateLimiter;
  dispatchWebhook?: WebhookDispatcher;
}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const dispatch =
    deps.dispatchWebhook ??
    ((url, body, options) =>
      dispatchEnrichmentWebhook(
        url,
        body,
        options?.timeoutMs ?? deps.config.enrichment.timeout_ms,
        options?.headers,
      ));

  app.post("/api/submit", async (c) => {
    return handleSubmit(c, deps.config, deps.env, deps.store, deps.rateLimiter, dispatch);
  });

  return app;
}

async function handleSubmit(
  c: Context<AppBindings>,
  config: GreenwareConfig,
  env: RuntimeEnv,
  store: SessionStore,
  rateLimiter: RateLimiter,
  dispatch: WebhookDispatcher,
): Promise<Response> {
  const origin = c.req.header("origin");
  const allowedOrigin = checkOrigin(origin, config.security.allowed_origins);
  if (allowedOrigin === null) {
    return errorResponse(
      403,
      {
        error: ERR_ORIGIN_NOT_ALLOWED,
        problem: "Origin header is missing or not in the allowed list.",
        cause: origin
          ? `Origin '${origin}' is not permitted.`
          : "No Origin header was sent by the browser.",
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
        problem: "Too many submissions from this IP.",
        cause: `Limit: ${config.security.rate_limit_per_ip_per_minute} per minute.`,
        fix: `Retry after ${rl.retryAfter} seconds.`,
      },
      env.GREENWARE_ENV,
    );
    res.headers.set("Retry-After", String(rl.retryAfter));
    return withHeaders(res, corsHeaders);
  }

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return withHeaders(
      errorResponse(
        415,
        {
          error: ERR_CONTENT_TYPE_INVALID,
          problem: "Content-Type must be application/json.",
          cause: `Received '${contentType || "(none)"}'.`,
          fix: "Set Content-Type: application/json on the submit request.",
        },
        env.GREENWARE_ENV,
      ),
      corsHeaders,
    );
  }

  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return withHeaders(
        errorResponse(
          413,
          {
            error: ERR_PAYLOAD_TOO_LARGE,
            problem: `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
            cause: `Declared Content-Length: ${declared}.`,
            fix: "Reduce the form payload; Greenware expects a small set of fields.",
          },
          env.GREENWARE_ENV,
        ),
        corsHeaders,
      );
    }
  }

  const bodyText = await c.req.text();
  if (bodyText.length > MAX_BODY_BYTES) {
    return withHeaders(
      errorResponse(
        413,
        {
          error: ERR_PAYLOAD_TOO_LARGE,
          problem: `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
          cause: `Actual body length: ${bodyText.length}.`,
          fix: "Reduce the form payload.",
        },
        env.GREENWARE_ENV,
      ),
      corsHeaders,
    );
  }

  let lead: Record<string, unknown>;
  let formId: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }

    const parsedObj = parsed as Record<string, unknown>;
    const leadField = parsedObj.lead;
    if (
      leadField === undefined ||
      leadField === null ||
      typeof leadField !== "object" ||
      Array.isArray(leadField)
    ) {
      return withHeaders(
        errorResponse(
          400,
          {
            error: ERR_INVALID_SUBMIT_SHAPE,
            problem: "Request body is missing the `lead` object.",
            cause:
              leadField === undefined
                ? "`lead` key was not present on the request body."
                : `\`lead\` was of type ${leadField === null ? "null" : Array.isArray(leadField) ? "array" : typeof leadField}.`,
            fix: "Send a JSON object shaped as { lead: { ...fields }, form_id?: string }. The embed always sends this shape; hand-rolled clients must match it.",
          },
          env.GREENWARE_ENV,
        ),
        corsHeaders,
      );
    }

    lead = leadField as Record<string, unknown>;
    if (typeof parsedObj.form_id === "string") {
      formId = parsedObj.form_id;
    }
  } catch (err) {
    return withHeaders(
      errorResponse(
        400,
        {
          error: ERR_INVALID_CALLBACK_PAYLOAD,
          problem: "Request body is not a valid JSON object.",
          cause: err instanceof Error ? err.message : "unknown parse error",
          fix: "Send a JSON object shaped as { lead: { ...fields }, form_id?: string }.",
        },
        env.GREENWARE_ENV,
      ),
      corsHeaders,
    );
  }

  const sessionId = crypto.randomUUID();
  const readToken = await mintReadToken(sessionId, env.GREENWARE_READ_KEY);
  const readTokenHash = await hashReadToken(readToken);

  const nowUnix = Math.floor(Date.now() / 1000);
  const expiresAt = nowUnix + config.security.session_ttl_seconds;
  const signed = await signCallback({
    sessionId,
    expiresAt,
    nonce: generateNonce(),
    signingKey: env.GREENWARE_SIGNING_KEY,
    kid: "primary",
  });

  const callbackUrl =
    `${publicBaseUrl(c, env)}/api/callback/${sessionId}` +
    `?exp=${signed.expires_at}` +
    `&sig=${encodeURIComponent(signed.sig)}` +
    `&nonce=${encodeURIComponent(signed.nonce)}` +
    `&kid=${encodeURIComponent(signed.kid)}`;

  await store.writePending({
    sessionId,
    readTokenHash,
    origin: allowedOrigin,
    expiresAtUnix: expiresAt,
    ttlSeconds: config.security.session_ttl_seconds,
    formId,
  });

  const webhookBody: {
    session_id: string;
    callback_url: string;
    lead: Record<string, unknown>;
    form_id?: string;
    meta: { submitted_at: string };
  } = {
    session_id: sessionId,
    callback_url: callbackUrl,
    lead,
    meta: {
      submitted_at: new Date(nowUnix * 1000).toISOString(),
    },
  };
  if (formId !== undefined) {
    webhookBody.form_id = formId;
  }

  const destination = resolveEnrichmentDestination(config, env, formId);
  void dispatch(destination.webhookUrl, webhookBody, {
    destinationId: destination.id,
    headers: destination.headers,
    timeoutMs: destination.timeoutMs,
  }).catch((err) => {
    console.warn(
      `greenware: webhook dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    void store
      .transitionToTerminal({
        sessionId,
        status: "failed",
        errorCode: webhookErrorCode(err),
      })
      .catch(() => undefined);
  });

  return withHeaders(
    new Response(
      JSON.stringify({
        session_id: sessionId,
        read_token: readToken,
        expires_at: expiresAt,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
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

function webhookErrorCode(err: unknown): "WEBHOOK_TIMEOUT" | "WEBHOOK_NON_2XX" {
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  return code === "WEBHOOK_TIMEOUT" ? "WEBHOOK_TIMEOUT" : "WEBHOOK_NON_2XX";
}
