import type { Context } from "hono";
import type { AppBindings, RuntimeEnv } from "../types";

export function publicBaseUrl(c: Context<AppBindings>, env: RuntimeEnv): string {
  const configured = configuredPublicBaseUrl(env);
  if (configured !== undefined) return configured;
  return `${publicScheme(c)}://${publicHost(c)}`;
}

export function configuredPublicBaseUrl(env: RuntimeEnv): string | undefined {
  const explicit = normalizeUrl(env.GREENWARE_PUBLIC_URL);
  if (explicit !== undefined) return explicit;

  const railwayDomain = normalizeRailwayDomain(env.RAILWAY_PUBLIC_DOMAIN);
  if (railwayDomain !== undefined) return railwayDomain;

  return undefined;
}

function normalizeUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("GREENWARE_PUBLIC_URL must be a valid URL.");
  }
  if (parsed.protocol !== "https:" && !isLocalHttp(parsed)) {
    throw new Error("GREENWARE_PUBLIC_URL must use https://, except localhost http:// for development.");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeRailwayDomain(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const withoutScheme = trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return withoutScheme.length > 0 ? `https://${withoutScheme}` : undefined;
}

function isLocalHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

function publicHost(c: Context<AppBindings>): string {
  return c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "greenware.local";
}

function publicScheme(c: Context<AppBindings>): "http" | "https" {
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "http" || forwarded === "https") return forwarded;
  return new URL(c.req.url).protocol === "http:" ? "http" : "https";
}
