import { describe, expect, it } from "vitest";
import { loadRuntimeEnv } from "../src/runtime";

describe("loadRuntimeEnv", () => {
  it("loads configured Railway environment variables and defaults GREENWARE_ENV", () => {
    const env = loadRuntimeEnv({
      GREENWARE_SIGNING_KEY: "signing",
      GREENWARE_READ_KEY: "read",
      GREENWARE_SETUP_TOKEN: "setup",
    });

    expect(env).toEqual({
      GREENWARE_SIGNING_KEY: "signing",
      GREENWARE_READ_KEY: "read",
      GREENWARE_SETUP_TOKEN: "setup",
      GREENWARE_ENV: "production",
    });
  });

  it("uses ephemeral runtime secrets when template secrets are absent", () => {
    const env = loadRuntimeEnv({});

    expect(env.GREENWARE_SIGNING_KEY).toMatch(/^ephemeral-/);
    expect(env.GREENWARE_READ_KEY).toMatch(/^ephemeral-/);
    expect(env.GREENWARE_SETUP_TOKEN).toBeUndefined();
    expect(env.GREENWARE_ENV).toBe("production");
  });

  it("loads optional deployment overrides", () => {
    const env = loadRuntimeEnv({
      GREENWARE_SIGNING_KEY: "signing",
      GREENWARE_READ_KEY: "read",
      GREENWARE_SETUP_TOKEN: "setup",
      GREENWARE_ALLOWED_ORIGINS: "https://greenware-test.ngrok-free.app",
      GREENWARE_DESTINATIONS: '{"default":{"webhook_url":"https://hooks.example.com/default"}}',
      GREENWARE_PUBLIC_URL: "https://greenware.example.com/",
    });

    expect(env.GREENWARE_ALLOWED_ORIGINS).toBe("https://greenware-test.ngrok-free.app");
    expect(env.GREENWARE_DESTINATIONS).toBe(
      '{"default":{"webhook_url":"https://hooks.example.com/default"}}',
    );
    expect(env.GREENWARE_PUBLIC_URL).toBe("https://greenware.example.com/");
  });
});
