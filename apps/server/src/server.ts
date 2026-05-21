import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./index";
import { applyRuntimeConfigOverrides, loadConfig } from "./lib/config";
import { validateEnrichmentDestinations } from "./lib/enrichment_destinations";
import { MemoryRateLimiter } from "./lib/rate_limit";
import { loadRuntimeEnv } from "./runtime";
import { createSessionStore } from "./storage";

declare const Bun: {
  env: Record<string, string | undefined>;
  serve(options: {
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): { port: number };
};

const env = loadRuntimeEnv(Bun.env);
const config = applyRuntimeConfigOverrides(loadConfig(), env);
validateEnrichmentDestinations(config, env);
const store = await createSessionStore();
const app = createApp({
  config,
  env,
  store,
  rateLimiter: new MemoryRateLimiter(),
  publicDir: join(dirname(fileURLToPath(import.meta.url)), "../public"),
});

const port = parsePort(Bun.env.PORT);
const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`greenware: listening on :${server.port}`);

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 8787;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return parsed;
}
