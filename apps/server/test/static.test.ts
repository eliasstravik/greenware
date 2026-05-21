import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { MemoryRateLimiter } from "../src/lib/rate_limit";
import { MemorySessionStore } from "../src/lib/sessions";
import type { GreenwareConfig } from "../src/lib/config";
import type { RuntimeEnv } from "../src/types";

const config: GreenwareConfig = {
  version: "1",
  enrichment: {
    timeout_ms: 10_000,
  },
  security: {
    allowed_origins: ["https://example.com"],
    session_ttl_seconds: 600,
    rate_limit_per_ip_per_minute: 10,
    iframe_allowlist: [],
  },
};

const env: RuntimeEnv = {
  GREENWARE_SIGNING_KEY: "test-primary-key-32-bytes-minimum-length-for-hs256",
  GREENWARE_READ_KEY: "test-read-key-32-bytes-minimum-length-for-hs256",
  GREENWARE_SETUP_TOKEN: "setup-token",
  GREENWARE_ENV: "test",
};

function app() {
  return createApp({
    config,
    env,
    store: new MemorySessionStore(),
    rateLimiter: new MemoryRateLimiter(),
    publicDir: new URL("../public", import.meta.url).pathname,
  });
}

describe("static assets", () => {
  it("serves embed scripts from the public directory", async () => {
    const res = await app().request("http://localhost:8787/embed/v1.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(await res.text()).toContain("greenware:submit");
  });

  it("does not ship hosted HTML preview or test pages", async () => {
    for (const path of ["/demo", "/demo.html", "/site", "/site.html", "/provider.html", "/live.html"]) {
      const res = await app().request(`http://localhost:8787${path}`);
      expect(res.status).toBe(404);
    }
  });

  it("serves backend metadata from the root", async () => {
    const res = await app().request("http://localhost:8787/");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "greenware",
      status: "ok",
      kind: "backend",
      endpoints: {
        submit: "/api/submit",
        health: "/health",
      },
    });
  });
});
