import type { RuntimeEnv } from "./types";

type RawEnv = Record<string, string | undefined>;

export function loadRuntimeEnv(input: RawEnv): RuntimeEnv {
  const env: RuntimeEnv = {
    GREENWARE_SIGNING_KEY: secretOrEphemeral(input.GREENWARE_SIGNING_KEY, "GREENWARE_SIGNING_KEY"),
    GREENWARE_READ_KEY: secretOrEphemeral(input.GREENWARE_READ_KEY, "GREENWARE_READ_KEY"),
    GREENWARE_ENV: input.GREENWARE_ENV || "production",
  };

  copyOptional(env, input, "GREENWARE_SETUP_TOKEN");
  copyOptional(env, input, "GREENWARE_SIGNING_KEY_PREVIOUS");
  copyOptional(env, input, "GREENWARE_ALLOWED_ORIGINS");
  copyOptional(env, input, "GREENWARE_PUBLIC_URL");
  copyOptional(env, input, "GREENWARE_DESTINATIONS");
  copyOptional(env, input, "RAILWAY_PUBLIC_DOMAIN");

  return env;
}

function secretOrEphemeral(value: string | undefined, key: string): string {
  if (value !== undefined && value.length > 0) return value;
  console.warn(`greenware: ${key} is not set; using an ephemeral runtime secret.`);
  return `ephemeral-${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

function copyOptional<K extends keyof RuntimeEnv>(
  env: RuntimeEnv,
  input: RawEnv,
  key: K,
): void {
  const value = input[key];
  if (value !== undefined && value.length > 0) {
    env[key] = value as RuntimeEnv[K];
  }
}
