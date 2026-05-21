const DEFAULT_TIMEOUT_MS = 10_000;

export class EnrichmentWebhookError extends Error {
  constructor(
    public readonly errorCode: "WEBHOOK_TIMEOUT" | "WEBHOOK_NON_2XX",
    message: string,
  ) {
    super(message);
    this.name = "EnrichmentWebhookError";
  }
}

export async function dispatchEnrichmentWebhook(
  url: string,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  explicitHeaders?: Record<string, string>,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers:
        explicitHeaders === undefined
          ? new Headers({ "Content-Type": "application/json" })
          : new Headers(explicitHeaders),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EnrichmentWebhookError(
        "WEBHOOK_NON_2XX",
        `Enrichment webhook returned HTTP ${res.status}${body.length > 0 ? `: ${body.slice(0, 200)}` : ""}`,
      );
    }
  } catch (err) {
    if (err instanceof EnrichmentWebhookError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new EnrichmentWebhookError("WEBHOOK_TIMEOUT", `Enrichment webhook timed out after ${timeoutMs}ms`);
    }
    throw new EnrichmentWebhookError(
      "WEBHOOK_NON_2XX",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}
