import type { RuntimeEnv } from "../types";
import type { GreenwareConfig } from "./config";
import { resolveEnrichmentDestination } from "./enrichment_destinations";

export type ReadinessResult =
  | { ok: true; destination: string; storage: "memory" }
  | { ok: false; problem: string; fix: string; storage: "memory" };

export function checkReadiness(config: GreenwareConfig, env: RuntimeEnv): ReadinessResult {
  if (env.GREENWARE_DESTINATIONS === undefined || env.GREENWARE_DESTINATIONS.trim().length === 0) {
    return {
      ok: false,
      storage: "memory",
      problem: "No production enrichment destination is configured.",
      fix: "Set GREENWARE_DESTINATIONS to a JSON map of Clay webhook destinations.",
    };
  }

  if (
    env.GREENWARE_ENV === "production" &&
    !hasDeployableBrowserOrigin(config.security.allowed_origins, env.RAILWAY_PUBLIC_DOMAIN)
  ) {
    return {
      ok: false,
      storage: "memory",
      problem: "No production allowed browser origin is configured.",
      fix: "Set GREENWARE_ALLOWED_ORIGINS to the exact website origin(s) that will host your form, for example https://www.yourcompany.com.",
    };
  }

  const destination = resolveEnrichmentDestination(config, env);
  return { ok: true, destination: destination.id, storage: "memory" };
}

function hasDeployableBrowserOrigin(
  allowedOrigins: readonly string[],
  railwayPublicDomain: string | undefined,
): boolean {
  const railwayOrigin = railwayPublicOrigin(railwayPublicDomain);
  return allowedOrigins.some((origin) => {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:") return false;
      if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return false;
      if (railwayOrigin !== undefined && parsed.origin === railwayOrigin) return false;
      return true;
    } catch {
      return false;
    }
  });
}

function railwayPublicOrigin(domain: string | undefined): string | undefined {
  const clean = domain?.trim();
  if (!clean) return undefined;
  const withoutScheme = clean.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return withoutScheme.length > 0 ? `https://${withoutScheme}` : undefined;
}
