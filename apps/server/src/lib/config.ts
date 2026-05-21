/**
 * Greenware server: config loader and validator.
 *
 * Greenware bundles `greenware.config.example.json` as a TypeScript import. The
 * Railway/Bun server reads the inlined object at startup, so no filesystem read
 * happens per request and schema drift fails fast.
 *
 * `loadConfig()` accepts an optional `raw` argument so tests can inject
 * a synthetic config without touching the filesystem. In production the
 * caller passes no argument and the bundled import is used.
 *
 * Scope: schema + loader only. No HTTP, no routes — route handlers call
 * `loadConfig()` once (or receive the result via closure) and treat the
 * returned object as immutable.
 */

import { z } from "zod";
import { isSafeUrl } from "./protocol";

// ---------------------------------------------------------------------------
// Zod schema. Mirrors `greenware.config.example.json`. Each field is
// validated at import time; invalid configs throw and (in production)
// fail the server deploy.
//
// As of v1's events-only embed split, the server config is server-only:
// no form fields, no submit label, no spinner messages, no error copy.
// All UI concerns (rendering, copy, motion) belong to the host page or
// the optional default-UI script — not the server config.
// ---------------------------------------------------------------------------

const Enrichment = z
  .object({
    /** Default upper bound on how long we wait for a Clay webhook POST
     *  before abandoning the dispatch. Individual GREENWARE_DESTINATIONS
     *  entries may override this with their own timeout_ms value. */
    timeout_ms: z.number().int().min(1000).max(30_000).default(10_000),
  })
  .strict();

/**
 * Validator for Clay destination webhook URLs. Accepts `https://<anything>`
 * unconditionally; accepts `http://` only when the host is `localhost`
 * or `127.0.0.1` (loopback dev convenience).
 *
 * Exported so tests can exercise the boundary directly.
 */
export function isSafeWebhookUrl(u: string): boolean {
  if (isSafeUrl(u, ["https:"])) return true;
  if (!isSafeUrl(u, ["http:"])) return false;
  try {
    const parsed = new URL(u);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

const Security = z
  .object({
    /** Allowed browser origins for `/api/submit` and `/api/session/*`.
     *  Matched case-sensitively against the `Origin` header. */
    allowed_origins: z.array(z.string().min(1)).min(1),
    /** Session lifetime in seconds. Also used as the signed-callback
     *  `exp` window: `exp = now + session_ttl_seconds`. */
    session_ttl_seconds: z.number().int().min(60).max(3600).default(600),
    /** Max `/api/submit` requests per IP per minute. Enforced by the runtime
     *  rate limiter. */
    rate_limit_per_ip_per_minute: z.number().int().min(1).max(1000).default(10),
    /** Hosts allowed for embed iframes — future use, passed through to
     *  the embed.js runtime. */
    iframe_allowlist: z.array(z.string().min(1)).default([]),
  })
  .strict();

/**
 * The full Greenware config schema. `version: "1"` is a literal so a
 * future v2 config gets rejected by v0.1 servers rather than silently
 * accepted with default values.
 */
export const GreenwareConfig = z
  .object({
    version: z.literal("1"),
    enrichment: Enrichment,
    security: Security,
  })
  .strict();

export type GreenwareConfig = z.infer<typeof GreenwareConfig>;

export type RuntimeConfigOverrides = {
  GREENWARE_ALLOWED_ORIGINS?: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
};

// ---------------------------------------------------------------------------
// Bundled default config. Production deploys normally keep this file unchanged
// and use environment variables for destinations and browser origins.
// ---------------------------------------------------------------------------

import bundledConfig from "../../../../greenware.config.example.json";

// ---------------------------------------------------------------------------
// Loader. Validates on call. Throws `ConfigError` on failure with a
// summary suitable for server deploy logs — the intent is "fail the
// deploy loud and early" rather than "start the server in a bad state".
// ---------------------------------------------------------------------------

/**
 * Thrown by `loadConfig` when the raw config fails schema validation.
 * Carries a compact per-issue summary; callers can inspect `.issues`
 * for structured error reporting.
 */
export class ConfigError extends Error {
  public readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(message: string, issues: ReadonlyArray<{ path: string; message: string }>) {
    super(message);
    this.issues = issues;
    this.name = "ConfigError";
  }
}

/**
 * Load + validate a Greenware config. Pass `raw` to override the
 * bundled import (tests use this). Throws `ConfigError` on invalid
 * input with a human-readable summary.
 */
export function loadConfig(raw?: unknown): GreenwareConfig {
  const input = raw === undefined ? bundledConfig : raw;
  const result = GreenwareConfig.safeParse(input);
  if (result.success) return result.data;

  const issues = result.error.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
  const summary = issues
    .slice(0, 5)
    .map((i) => `${i.path}: ${i.message}`)
    .join("; ");
  throw new ConfigError(`Invalid Greenware config: ${summary}`, issues);
}

/**
 * Apply deploy-time overrides from environment variables. This keeps the
 * tracked example config generic while still making Railway and local tunnel
 * tests configurable without editing source files.
 */
export function applyRuntimeConfigOverrides(
  config: GreenwareConfig,
  overrides: RuntimeConfigOverrides,
): GreenwareConfig {
  const raw = {
    version: config.version,
    enrichment: { ...config.enrichment },
    security: { ...config.security },
  };

  const allowedOrigins = parseCommaSeparated(overrides.GREENWARE_ALLOWED_ORIGINS);
  if (allowedOrigins.length > 0) {
    raw.security.allowed_origins = allowedOrigins;
  }

  const railwayOrigin = railwayPublicOrigin(overrides.RAILWAY_PUBLIC_DOMAIN);
  if (railwayOrigin !== undefined && !raw.security.allowed_origins.includes(railwayOrigin)) {
    raw.security.allowed_origins = [...raw.security.allowed_origins, railwayOrigin];
  }

  return loadConfig(raw);
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parseCommaSeparated(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function railwayPublicOrigin(domain: string | undefined): string | undefined {
  const clean = cleanOptional(domain);
  if (clean === undefined) return undefined;
  const withoutScheme = clean.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return withoutScheme.length > 0 ? `https://${withoutScheme}` : undefined;
}

// ---------------------------------------------------------------------------
// Startup validation — importing this module in the server runs the
// validator against the bundled config and throws synchronously on
// bad input. That surfaces a bad config during the server's first
// cold-start request rather than once per request.
// ---------------------------------------------------------------------------

/**
 * Validate the bundled config at module load. Called once. If the
 * bundled file is invalid, the server module throws during import —
 * the process fails fast instead of serving a bad configuration.
 */
loadConfig();
