import { describe, expect, it } from "vitest";
import { applyRuntimeConfigOverrides, loadConfig } from "../src/lib/config";

const BASE_CONFIG = {
  version: "1",
  enrichment: {
    timeout_ms: 10000,
  },
  security: {
    allowed_origins: ["https://example.com"],
    session_ttl_seconds: 600,
    rate_limit_per_ip_per_minute: 10,
    iframe_allowlist: ["cal.com"],
  },
};

describe("applyRuntimeConfigOverrides", () => {
  it("overrides allowed origins from a comma-separated environment value", () => {
    const config = applyRuntimeConfigOverrides(loadConfig(BASE_CONFIG), {
      GREENWARE_ALLOWED_ORIGINS:
        "https://greenware-test.ngrok-free.app, http://localhost:8787",
    });

    expect(config.security.allowed_origins).toEqual([
      "https://greenware-test.ngrok-free.app",
      "http://localhost:8787",
    ]);
  });

  it("adds the Railway public domain as an allowed origin when Railway provides one", () => {
    const config = applyRuntimeConfigOverrides(loadConfig(BASE_CONFIG), {
      RAILWAY_PUBLIC_DOMAIN: "greenware-production.up.railway.app",
    });

    expect(config.security.allowed_origins).toContain(
      "https://greenware-production.up.railway.app",
    );
  });

  it("keeps bundled defaults local-only until deployers set real browser origins", () => {
    const config = loadConfig();

    expect(config.security.allowed_origins).toEqual([
      "http://localhost:8787",
      "http://127.0.0.1:8787",
    ]);
    expect(config.security.allowed_origins.join(",")).not.toContain("yourcompany.com");
  });
});
