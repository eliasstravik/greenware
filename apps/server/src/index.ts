/**
 * Greenware server — Hono app factory.
 *
 * The app is platform-neutral: Railway/Bun startup code constructs the runtime
 * dependencies once and passes them in here; tests do the same with in-memory
 * fakes.
 */

import { Hono } from "hono";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative, sep } from "node:path";
import type { AppBindings, RuntimeEnv } from "./types";
import type { GreenwareConfig } from "./lib/config";
import type { RateLimiter } from "./lib/rate_limit";
import type { SessionStore } from "./lib/sessions";
import { submitRoute, type WebhookDispatcher } from "./routes/submit";
import { startRoute } from "./routes/start";
import { ingestRoute } from "./routes/ingest";
import { callbackRoute } from "./routes/callback";
import { sessionRoute } from "./routes/session";
import { waitRoute } from "./routes/wait";
import { setupRoute } from "./routes/setup";
import { checkOrigin, corsHeadersFor, type CorsEndpoint } from "./lib/origin";
import { checkReadiness } from "./lib/readiness";

export type AppDeps = {
  config: GreenwareConfig;
  env: RuntimeEnv;
  store: SessionStore;
  rateLimiter: RateLimiter;
  dispatchWebhook?: WebhookDispatcher;
  publicDir?: string;
};

export function createApp(deps: AppDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.options("/api/submit", (c) => preflight(c, deps.config.security.allowed_origins, "submit"));
  app.options("/api/session/start", (c) =>
    preflight(c, deps.config.security.allowed_origins, "submit"),
  );
  app.options("/api/session/:sessionId", (c) =>
    preflight(c, deps.config.security.allowed_origins, "session"),
  );

  app.route(
    "/",
    submitRoute({
      config: deps.config,
      env: deps.env,
      store: deps.store,
      rateLimiter: deps.rateLimiter,
      dispatchWebhook: deps.dispatchWebhook,
    }),
  );
  app.route(
    "/",
    startRoute({
      config: deps.config,
      env: deps.env,
      store: deps.store,
      rateLimiter: deps.rateLimiter,
    }),
  );
  app.route(
    "/",
    ingestRoute({
      config: deps.config,
      env: deps.env,
      store: deps.store,
      rateLimiter: deps.rateLimiter,
      dispatchWebhook: deps.dispatchWebhook,
    }),
  );
  app.route(
    "/",
    callbackRoute({
      config: deps.config,
      env: deps.env,
      store: deps.store,
      rateLimiter: deps.rateLimiter,
    }),
  );
  app.route("/", sessionRoute({ config: deps.config, env: deps.env, store: deps.store }));
  app.route("/", waitRoute());
  app.route("/", setupRoute({ env: deps.env, store: deps.store }));

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/ready", (c) => {
    const readiness = checkReadiness(deps.config, deps.env);
    if (!readiness.ok) {
      return c.json({
        status: "not_ready",
        problem: readiness.problem,
        fix: readiness.fix,
        storage: readiness.storage,
      }, 503);
    }
    return c.json({
      status: "ok",
      destination: readiness.destination,
      storage: readiness.storage,
    });
  });
  app.get("/", (c) =>
    c.json({
      name: "greenware",
      status: "ok",
      kind: "backend",
      endpoints: {
        submit: "/api/submit",
        session_start: "/api/session/start",
        provider_ingest: "/api/ingest/:provider",
        callback: "/api/callback/:sessionId",
        session: "/api/session/:sessionId",
        health: "/health",
      },
    }),
  );

  if (deps.publicDir !== undefined) {
    app.get("*", async (c) => {
      const res = await servePublicFile(deps.publicDir!, c.req.path);
      if (res !== null) return res;
      return c.notFound();
    });
  }

  app.notFound((c) => {
    return c.json(
      {
        error: "NOT_FOUND",
        problem: `No route matched ${c.req.method} ${c.req.path}.`,
        fix: "Check the API path or refer to greenware.dev/docs.",
      },
      404,
    );
  });

  return app;
}

async function servePublicFile(publicDir: string, requestPath: string): Promise<Response | null> {
  const normalizedPath = normalizeRequestPath(requestPath);
  if (normalizedPath === null) return null;

  const filePath = join(publicDir, normalizedPath);
  const rel = relative(publicDir, filePath);
  if (rel.startsWith("..") || rel === "" || rel.split(sep).includes("..")) return null;

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const body = await readFile(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentTypeFor(filePath),
        "Cache-Control": cacheControlFor(filePath),
      },
    });
  } catch {
    return null;
  }
}

function normalizeRequestPath(requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const stripped = decoded.replace(/^\/+/, "");
  const normalized = normalize(stripped);
  if (normalized === "." || normalized.startsWith("..")) return null;
  return normalized;
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function cacheControlFor(filePath: string): string {
  return filePath.includes(`${sep}embed${sep}`) ? "public, max-age=300" : "no-store";
}

function preflight(
  c: { req: { header: (name: string) => string | undefined } },
  allowedOrigins: readonly string[],
  endpoint: CorsEndpoint,
): Response {
  const origin = c.req.header("origin");
  const allowedOrigin = checkOrigin(origin, allowedOrigins);
  if (allowedOrigin === null) {
    return new Response(null, { status: 204 });
  }
  const headers = corsHeadersFor(allowedOrigin, endpoint);
  headers["Access-Control-Max-Age"] = "86400";
  return new Response(null, { status: 204, headers });
}
