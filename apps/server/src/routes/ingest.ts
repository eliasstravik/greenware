/**
 * Greenware server — POST /api/ingest/:provider.
 *
 * Server-to-server form-provider webhook endpoint. It accepts Typeform, Tally,
 * or generic JSON webhooks containing a Greenware session id hidden field,
 * normalizes the submission, and dispatches the Clay/enrichment webhook.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings, RuntimeEnv } from "../types";
import type { GreenwareConfig } from "../lib/config";
import type { RateLimiter } from "../lib/rate_limit";
import type { SessionStore } from "../lib/sessions";
import { signCallback, generateNonce } from "../lib/signing";
import { timingSafeEqual } from "../lib/signing";
import { hashReadToken } from "../lib/read_token";
import { dispatchEnrichmentWebhook } from "../lib/enrichment_webhook";
import { resolveEnrichmentDestination } from "../lib/enrichment_destinations";
import { publicBaseUrl } from "../lib/public_url";
import {
  extractProviderSubmission,
  parseProviderName,
  ProviderPayloadError,
} from "../lib/provider_payload";
import type { WebhookDispatcher } from "./submit";
import {
  errorResponse,
  ERR_CONTENT_TYPE_INVALID,
  ERR_INVALID_AUTH,
  ERR_INVALID_CALLBACK_PAYLOAD,
  ERR_PAYLOAD_TOO_LARGE,
  ERR_RATE_LIMITED,
  ERR_SESSION_NOT_FOUND,
  ERR_SESSION_NOT_PENDING,
} from "../lib/errors";

const MAX_BODY_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();

export function ingestRoute(deps: {
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

  app.post("/api/ingest/:provider", async (c) => {
    return handleIngest(c, deps.config, deps.env, deps.store, deps.rateLimiter, dispatch);
  });
  app.get("/api/ingest/:provider", (c) => {
    const provider = parseProviderName(c.req.param("provider") ?? "generic");
    const baseUrl = `${publicBaseUrl(c, deps.env)}/api/ingest/${provider}`;
    return json(
      {
        status: "ok",
        provider,
        expected_method: "POST",
        content_type: "application/json",
        webhook_url: baseUrl,
        auth: {
          hidden_fields: ["greenware_session_id", "greenware_read_token", "greenware_form_id"],
        },
        note: "This GET response is only a setup check. Form-provider submissions must POST JSON with Greenware hidden fields to this URL.",
      },
      200,
    );
  });

  return app;
}

async function handleIngest(
  c: Context<AppBindings>,
  config: GreenwareConfig,
  env: RuntimeEnv,
  store: SessionStore,
  rateLimiter: RateLimiter,
  dispatch: WebhookDispatcher,
): Promise<Response> {
  const rl = await rateLimiter.checkAndIncrement({
    ip: clientIp(c),
    limit: config.security.rate_limit_per_ip_per_minute,
  });
  if (!rl.allowed) {
    const res = errorResponse(
      429,
      {
        error: ERR_RATE_LIMITED,
        problem: "Too many provider webhook submissions from this IP.",
        fix: `Retry after ${rl.retryAfter} seconds.`,
      },
      env.GREENWARE_ENV,
    );
    res.headers.set("Retry-After", String(rl.retryAfter));
    return res;
  }

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return errorResponse(
      415,
      {
        error: ERR_CONTENT_TYPE_INVALID,
        problem: "Content-Type must be application/json.",
        fix: "Configure the form provider webhook to send JSON.",
      },
      env.GREENWARE_ENV,
    );
  }

  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return errorResponse(
        413,
        {
          error: ERR_PAYLOAD_TOO_LARGE,
          problem: `Provider webhook body exceeds ${MAX_BODY_BYTES} bytes.`,
          fix: "Reduce the form payload or remove large text/file fields.",
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
        problem: `Provider webhook body exceeds ${MAX_BODY_BYTES} bytes.`,
        fix: "Reduce the form payload or remove large text/file fields.",
      },
      env.GREENWARE_ENV,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch (err) {
    return errorResponse(
      400,
      {
        error: ERR_INVALID_CALLBACK_PAYLOAD,
        problem: "Provider webhook body is not valid JSON.",
        cause: err instanceof Error ? err.message : "unknown parse error",
        fix: "Configure the provider webhook to send a JSON object.",
      },
      env.GREENWARE_ENV,
    );
  }

  const provider = parseProviderName(c.req.param("provider") ?? "generic");
  let submission;
  try {
    submission = extractProviderSubmission(raw, provider);
  } catch (err) {
    return errorResponse(
      400,
      {
        error: ERR_INVALID_CALLBACK_PAYLOAD,
        problem: err instanceof ProviderPayloadError ? err.message : "Provider payload could not be parsed.",
        fix: "Pass greenware_session_id as a hidden field and ensure the webhook sends answers as JSON.",
      },
      env.GREENWARE_ENV,
    );
  }

  const record = await store.read(submission.sessionId);
  if (record === null) {
    return errorResponse(
      404,
      {
        error: ERR_SESSION_NOT_FOUND,
        problem: "No Greenware session exists for the provider submission.",
        cause: `session_id=${submission.sessionId}`,
        fix: "Create a session with /api/session/start and pass greenware_session_id into the form as a hidden field.",
      },
      env.GREENWARE_ENV,
    );
  }

  if (!(await providerReadTokenMatches(submission.readToken, record.read_token_hash))) {
    return errorResponse(
      403,
      {
        error: ERR_INVALID_AUTH,
        problem: "Provider submission read token does not match the Greenware session.",
        fix: "Pass the exact greenware_read_token hidden field returned by /api/session/start.",
      },
      env.GREENWARE_ENV,
    );
  }

  const attach = await store.attachSubmission({
    sessionId: submission.sessionId,
    provider,
    providerSubmissionId: submission.providerSubmissionId,
    formId: submission.formId ?? record.form_id,
  });
  if (attach.kind === "duplicate") {
    return json({ status: "duplicate", session_id: submission.sessionId }, 200);
  }
  if (attach.kind === "not_found") {
    return errorResponse(
      404,
      {
        error: ERR_SESSION_NOT_FOUND,
        problem: "No Greenware session exists for the provider submission.",
        fix: "Create a session with /api/session/start before the provider form is submitted.",
      },
      env.GREENWARE_ENV,
    );
  }
  if (attach.kind === "not_pending") {
    return errorResponse(
      409,
      {
        error: ERR_SESSION_NOT_PENDING,
        problem: `Session is already in terminal state '${attach.currentStatus}'.`,
        fix: "Provider webhooks should only be delivered once per pending session.",
      },
      env.GREENWARE_ENV,
    );
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  const signed = await signCallback({
    sessionId: submission.sessionId,
    expiresAt: record.expires_at_unix,
    nonce: generateNonce(),
    signingKey: env.GREENWARE_SIGNING_KEY,
    kid: "primary",
  });
  const callbackUrl =
    `${publicBaseUrl(c, env)}/api/callback/${submission.sessionId}` +
    `?exp=${signed.expires_at}` +
    `&sig=${encodeURIComponent(signed.sig)}` +
    `&nonce=${encodeURIComponent(signed.nonce)}` +
    `&kid=${encodeURIComponent(signed.kid)}`;

  const formId = submission.formId ?? record.form_id;
  const destination = resolveEnrichmentDestination(config, env, formId);
  try {
    await dispatch(destination.webhookUrl, {
      session_id: submission.sessionId,
      callback_url: callbackUrl,
      lead: submission.lead,
      ...(formId
        ? { form_id: formId }
        : {}),
      source: {
        provider,
        ...(submission.providerSubmissionId !== undefined
          ? { provider_submission_id: submission.providerSubmissionId }
          : {}),
      },
      meta: {
        submitted_at: new Date(nowUnix * 1000).toISOString(),
      },
    }, {
      destinationId: destination.id,
      headers: destination.headers,
      timeoutMs: destination.timeoutMs,
    });
  } catch (err) {
    const errorCode = webhookErrorCode(err);
    await store
      .transitionToTerminal({
        sessionId: submission.sessionId,
        status: "failed",
        errorCode,
      })
      .catch(() => undefined);
    return errorResponse(
      502,
      {
        error: errorCode,
        problem: "Greenware could not dispatch the provider submission to the enrichment destination.",
        cause: err instanceof Error ? err.message : String(err),
        fix: "Check the Clay webhook URL, auth header, and destination availability.",
      },
      env.GREENWARE_ENV,
    );
  }

  return json({ status: "accepted", session_id: submission.sessionId }, 202);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function providerReadTokenMatches(
  presentedReadToken: string | undefined,
  storedReadTokenHash: string,
): Promise<boolean> {
  if (presentedReadToken === undefined || presentedReadToken.length === 0) return false;
  const presentedHash = await hashReadToken(presentedReadToken);
  return timingSafeEqual(textEncoder.encode(presentedHash), textEncoder.encode(storedReadTokenHash));
}

function clientIp(c: Context<AppBindings>): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

function webhookErrorCode(err: unknown): "WEBHOOK_TIMEOUT" | "WEBHOOK_NON_2XX" {
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  return code === "WEBHOOK_TIMEOUT" ? "WEBHOOK_TIMEOUT" : "WEBHOOK_NON_2XX";
}
