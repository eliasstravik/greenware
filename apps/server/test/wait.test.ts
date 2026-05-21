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

describe("customer-owned wait page", () => {
  it("serves a polling wait page for redirect-only form providers", async () => {
    const app = createApp({
      config,
      env,
      store: new MemorySessionStore(),
      rateLimiter: new MemoryRateLimiter(),
    });

    const sessionId = "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c";
    const res = await app.request(`https://greenware.test/wait/${sessionId}?read_token=abc123`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain("Greenware");
    expect(html).toContain(sessionId);
    expect(html).toContain("abc123");
    expect(html).toContain(`/api/session/${sessionId}`);
  });

  it("HTML-escapes script-context values in the polling wait page", async () => {
    const app = createApp({
      config,
      env,
      store: new MemorySessionStore(),
      rateLimiter: new MemoryRateLimiter(),
    });

    const token = `</script><script>globalThis.__greenwareXss = true</script>`;
    const res = await app.request(
      `https://greenware.test/wait/session-safe?read_token=${encodeURIComponent(token)}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'nonce-");
    const html = await res.text();
    expect(html.match(/<script/g)?.length).toBe(1);
    expect(html).not.toContain(token);
    expect(html).toContain("\\u003C/script\\u003E");
  });
});
