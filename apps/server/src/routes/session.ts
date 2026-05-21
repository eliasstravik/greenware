/**
 * Greenware server — GET /api/session/:sessionId.
 *
 * Browser polling endpoint. Auth uses the per-session read token returned by
 * `/api/submit`; status responses are never cached.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings, RuntimeEnv } from "../types";
import type { GreenwareConfig } from "../lib/config";
import type { SessionStore } from "../lib/sessions";
import { checkOriginOrReferer, corsHeadersFor } from "../lib/origin";
import { hashReadToken } from "../lib/read_token";
import { timingSafeEqual } from "../lib/signing";
import {
  errorResponse,
  ERR_ORIGIN_NOT_ALLOWED,
  ERR_MISSING_AUTH,
  ERR_INVALID_AUTH,
  ERR_SESSION_NOT_FOUND,
} from "../lib/errors";

const textEncoder = new TextEncoder();
const BEARER_PATTERN = /^Bearer\s+(\S+)\s*$/i;

export function sessionRoute(deps: {
  config: GreenwareConfig;
  env: RuntimeEnv;
  store: SessionStore;
}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/api/session/:sessionId", async (c) => {
    return handleGetSession(c, deps.config, deps.env, deps.store);
  });

  return app;
}

async function handleGetSession(
  c: Context<AppBindings>,
  config: GreenwareConfig,
  env: RuntimeEnv,
  store: SessionStore,
): Promise<Response> {
  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  let allowedOrigin = checkOriginOrReferer(origin, referer, config.security.allowed_origins);
  if (allowedOrigin === null) {
    allowedOrigin = sameServerRefererOrigin(referer, c.req.url);
  }
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
  const corsHeaders = corsHeadersFor(allowedOrigin, "session");

  const authHeader = c.req.header("authorization") ?? "";
  const match = BEARER_PATTERN.exec(authHeader);
  if (match === null) {
    return withHeaders(
      errorResponse(
        401,
        {
          error: ERR_MISSING_AUTH,
          problem: "Missing or malformed Authorization header.",
          fix: "Send 'Authorization: Bearer <read_token>' using the token from /api/submit.",
        },
        env.GREENWARE_ENV,
      ),
      corsHeaders,
    );
  }

  const sessionId = c.req.param("sessionId") ?? "";
  if (sessionId.length === 0) {
    return withHeaders(
      errorResponse(
        404,
        {
          error: ERR_SESSION_NOT_FOUND,
          problem: "Missing session_id in URL.",
        },
        env.GREENWARE_ENV,
      ),
      corsHeaders,
    );
  }

  const record = await store.read(sessionId);
  if (record === null) {
    return withHeaders(
      errorResponse(
        404,
        {
          error: ERR_SESSION_NOT_FOUND,
          problem: "No session with this id exists.",
          cause: "Either the id is wrong or the session has expired and been garbage-collected.",
          fix: "Re-submit the form to obtain a fresh session.",
        },
        env.GREENWARE_ENV,
      ),
      corsHeaders,
    );
  }

  const presentedHash = await hashReadToken(match[1]!);
  const presentedBytes = textEncoder.encode(presentedHash);
  const storedBytes = textEncoder.encode(record.read_token_hash);
  if (!timingSafeEqual(presentedBytes, storedBytes)) {
    return withHeaders(
      errorResponse(
        403,
        {
          error: ERR_INVALID_AUTH,
          problem: "The presented read_token does not match this session.",
          fix: "Ensure you are polling with the token returned for this specific session.",
        },
        env.GREENWARE_ENV,
      ),
      corsHeaders,
    );
  }

  let liveRecord = record;
  const wantWait = parseWaitParam(c.req.query("wait"));
  if (wantWait && liveRecord.status === "pending") {
    const deadlineMs = Date.now() + LONG_POLL_MAX_MS;
    while (Date.now() < deadlineMs) {
      await sleep(LONG_POLL_INTERVAL_MS);
      const next = await store.read(sessionId);
      if (next === null) {
        return withHeaders(
          errorResponse(
            404,
            {
              error: ERR_SESSION_NOT_FOUND,
              problem: "Session disappeared during wait.",
              cause: "TTL elapsed mid-poll, or session was administratively cleared.",
              fix: "Re-submit the form to obtain a fresh session.",
            },
            env.GREENWARE_ENV,
          ),
          corsHeaders,
        );
      }
      if (next.status !== "pending") {
        liveRecord = next;
        break;
      }
    }
  }

  let body: Record<string, unknown>;
  switch (liveRecord.status) {
    case "pending":
      body = wantWait ? { status: "pending", wait_timed_out: true } : { status: "pending" };
      break;
    case "ready":
      body = { status: "ready", action: liveRecord.action_payload ?? null };
      break;
    case "failed":
      body = { status: "failed", error_code: liveRecord.error_code ?? "UNKNOWN" };
      break;
    case "expired":
      body = { status: "expired" };
      break;
  }

  return withHeaders(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }),
    corsHeaders,
  );
}

function sameServerRefererOrigin(
  referer: string | null | undefined,
  requestUrl: string,
): string | null {
  if (typeof referer !== "string" || referer.length === 0) return null;
  try {
    const ref = new URL(referer);
    const req = new URL(requestUrl);
    return ref.origin === req.origin ? ref.origin : null;
  } catch {
    return null;
  }
}

const LONG_POLL_MAX_MS = 25_000;
const LONG_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWaitParam(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.toLowerCase();
  return v === "" || v === "1" || v === "true" || v === "yes";
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}
