import type { RuntimeEnv } from "../types";
import type { GreenwareConfig } from "./config";
import { isSafeWebhookUrl } from "./config";

export type EnrichmentDestination = {
  id: string;
  webhookUrl: string;
  timeoutMs: number;
  headers: Record<string, string>;
};

type RawDestination = {
  webhook_url?: unknown;
  timeout_ms?: unknown;
  headers?: unknown;
};

export function resolveEnrichmentDestination(
  config: GreenwareConfig,
  env: RuntimeEnv,
  formId?: string,
): EnrichmentDestination {
  const configured = destinationsFromEnv(env.GREENWARE_DESTINATIONS, config.enrichment.timeout_ms);
  const exact = formId !== undefined ? configured[formId] : undefined;
  if (exact !== undefined) return exact;
  if (configured.default !== undefined) return configured.default;
  throw new Error(
    formId === undefined
      ? "GREENWARE_DESTINATIONS must include a default destination."
      : `No GREENWARE_DESTINATIONS entry matched form_id '${formId}', and no default destination is configured.`,
  );
}

export function validateEnrichmentDestinations(config: GreenwareConfig, env: RuntimeEnv): void {
  if (env.GREENWARE_DESTINATIONS === undefined || env.GREENWARE_DESTINATIONS.trim().length === 0) {
    return;
  }
  resolveEnrichmentDestination(config, env);
}

function destinationsFromEnv(
  rawJson: string | undefined,
  defaultTimeoutMs: number,
): Record<string, EnrichmentDestination> {
  if (rawJson === undefined || rawJson.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(
      `Invalid GREENWARE_DESTINATIONS JSON: ${err instanceof Error ? err.message : "parse failed"}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("GREENWARE_DESTINATIONS must be a JSON object.");
  }

  const out: Record<string, EnrichmentDestination> = {};
  for (const [id, raw] of Object.entries(parsed)) {
    out[id] = destinationFromRaw(id, raw, defaultTimeoutMs);
  }
  return out;
}

function destinationFromRaw(
  id: string,
  raw: unknown,
  defaultTimeoutMs: number,
): EnrichmentDestination {
  if (!isRecord(raw)) {
    throw new Error(`GREENWARE_DESTINATIONS.${id} must be an object.`);
  }
  const input = raw as RawDestination;
  const webhookUrl = stringValue(input.webhook_url);
  if (webhookUrl === undefined) {
    throw new Error(`GREENWARE_DESTINATIONS.${id}.webhook_url is required.`);
  }
  if (!isSafeWebhookUrl(webhookUrl)) {
    throw new Error(`GREENWARE_DESTINATIONS.${id}.webhook_url must be an https URL.`);
  }

  return {
    id,
    webhookUrl,
    timeoutMs: timeoutValue(input.timeout_ms, defaultTimeoutMs),
    headers: destinationHeaders(input),
  };
}

function destinationHeaders(input: RawDestination): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isRecord(input.headers)) {
    for (const [key, value] of Object.entries(input.headers)) {
      if (typeof value === "string" && value.trim().length > 0) {
        headers[key] = value;
      }
    }
  }
  return headers;
}

function timeoutValue(value: unknown, fallback: number): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isInteger(value) || value < 1000 || value > 30_000) {
    throw new Error("Destination timeout_ms must be an integer between 1000 and 30000.");
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
