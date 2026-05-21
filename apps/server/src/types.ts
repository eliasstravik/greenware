/**
 * Greenware server runtime types.
 *
 * Railway provides runtime values through process environment variables.
 * Route handlers receive these values through app-factory closures, not Hono
 * platform bindings, so the same code runs in tests and in Bun.serve.
 */

export type RuntimeEnv = {
  GREENWARE_SIGNING_KEY: string;
  GREENWARE_SIGNING_KEY_PREVIOUS?: string;
  GREENWARE_READ_KEY: string;
  GREENWARE_SETUP_TOKEN?: string;
  GREENWARE_ALLOWED_ORIGINS?: string;
  GREENWARE_PUBLIC_URL?: string;
  GREENWARE_DESTINATIONS?: string;
  GREENWARE_ENV: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
};

export type AppBindings = Record<string, never>;
