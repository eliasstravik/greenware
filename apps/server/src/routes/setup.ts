import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings, RuntimeEnv } from "../types";
import type { SessionStore } from "../lib/sessions";
import { errorResponse, ERR_INVALID_AUTH } from "../lib/errors";
import { timingSafeEqual } from "../lib/signing";

const textEncoder = new TextEncoder();

export function setupRoute(deps: {
  env: RuntimeEnv;
  store: SessionStore;
}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/setup/sessions", async (c) => {
    return handleSessions(c, deps.env, deps.store);
  });

  return app;
}

async function handleSessions(
  c: Context<AppBindings>,
  env: RuntimeEnv,
  store: SessionStore,
): Promise<Response> {
  if (env.GREENWARE_SETUP_TOKEN === undefined) {
    return errorResponse(
      404,
      {
        error: ERR_INVALID_AUTH,
        problem: "Setup endpoints are disabled because GREENWARE_SETUP_TOKEN is not configured.",
        fix: "Set GREENWARE_SETUP_TOKEN to enable protected setup endpoints.",
      },
      env.GREENWARE_ENV,
    );
  }

  if (!isAuthorized(c, env.GREENWARE_SETUP_TOKEN)) {
    return errorResponse(
      401,
      {
        error: ERR_INVALID_AUTH,
        problem: "Setup endpoints require the setup token.",
        fix: "Send Authorization: Bearer <GREENWARE_SETUP_TOKEN>.",
      },
      env.GREENWARE_ENV,
    );
  }

  const limit = clampLimit(c.req.query("limit"));
  const sessions = await store.listRecent(limit);
  return new Response(JSON.stringify({ sessions }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isAuthorized(c: Context<AppBindings>, setupToken: string): boolean {
  const auth = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  if (match === null) return false;
  const presented = textEncoder.encode(match[1]!);
  const expected = textEncoder.encode(setupToken);
  return timingSafeEqual(presented, expected);
}

function clampLimit(raw: string | undefined): number {
  const parsed = raw === undefined ? 20 : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(1, Math.min(100, parsed));
}
