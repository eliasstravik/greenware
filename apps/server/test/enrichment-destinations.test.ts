import { describe, expect, it } from "vitest";
import type { GreenwareConfig } from "../src/lib/config";
import { resolveEnrichmentDestination } from "../src/lib/enrichment_destinations";
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

const baseEnv: RuntimeEnv = {
  GREENWARE_SIGNING_KEY: "signing",
  GREENWARE_READ_KEY: "read",
  GREENWARE_SETUP_TOKEN: "setup",
  GREENWARE_ENV: "test",
};

describe("resolveEnrichmentDestination", () => {
  it("selects a form-specific destination from GREENWARE_DESTINATIONS", () => {
    const destination = resolveEnrichmentDestination(config, {
      ...baseEnv,
      GREENWARE_DESTINATIONS: JSON.stringify({
        default: {
          webhook_url: "https://api.clay.com/v3/sources/webhook/default",
          headers: { "x-clay-webhook-auth": "default-token" },
        },
        "enterprise-demo": {
          webhook_url: "https://api.clay.com/v3/sources/webhook/enterprise",
          headers: { "x-clay-webhook-auth": "enterprise-token" },
          timeout_ms: 15_000,
        },
      }),
    }, "enterprise-demo");

    expect(destination).toEqual({
      id: "enterprise-demo",
      webhookUrl: "https://api.clay.com/v3/sources/webhook/enterprise",
      timeoutMs: 15_000,
      headers: {
        "Content-Type": "application/json",
        "x-clay-webhook-auth": "enterprise-token",
      },
    });
  });

  it("falls back to the default destination when form_id has no exact match", () => {
    const destination = resolveEnrichmentDestination(config, {
      ...baseEnv,
      GREENWARE_DESTINATIONS: JSON.stringify({
        default: {
          webhook_url: "https://api.clay.com/v3/sources/webhook/default",
          headers: { "x-clay-webhook-auth": "default-token" },
        },
      }),
    }, "unknown-form");

    expect(destination).toMatchObject({
      id: "default",
      webhookUrl: "https://api.clay.com/v3/sources/webhook/default",
      headers: {
        "Content-Type": "application/json",
        "x-clay-webhook-auth": "default-token",
      },
    });
  });

  it("throws when there is no exact form match and no default destination", () => {
    expect(() =>
      resolveEnrichmentDestination(config, {
        ...baseEnv,
        GREENWARE_DESTINATIONS: JSON.stringify({
          "enterprise-demo": {
            webhook_url: "https://api.clay.com/v3/sources/webhook/enterprise",
          },
        }),
      }, "contact-us"),
    ).toThrow(/No GREENWARE_DESTINATIONS entry matched form_id 'contact-us'/);
  });
});
