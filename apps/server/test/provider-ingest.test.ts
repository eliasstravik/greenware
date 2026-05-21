import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { MemoryRateLimiter } from "../src/lib/rate_limit";
import { MemorySessionStore } from "../src/lib/sessions";
import type { GreenwareConfig } from "../src/lib/config";
import type { RuntimeEnv } from "../src/types";

const PRIMARY_KEY = "test-primary-key-32-bytes-minimum-length-for-hs256";
const READ_KEY = "test-read-key-32-bytes-minimum-length-for-hs256";
const ALLOWED_ORIGIN = "https://example.com";
const SERVER_HOST = "greenware.test";

const config: GreenwareConfig = {
  version: "1",
  enrichment: {
    timeout_ms: 10_000,
  },
  security: {
    allowed_origins: [ALLOWED_ORIGIN],
    session_ttl_seconds: 600,
    rate_limit_per_ip_per_minute: 10,
    iframe_allowlist: [],
  },
};

const env: RuntimeEnv = {
  GREENWARE_SIGNING_KEY: PRIMARY_KEY,
  GREENWARE_READ_KEY: READ_KEY,
  GREENWARE_ENV: "test",
  GREENWARE_DESTINATIONS: JSON.stringify({
    default: { webhook_url: "https://hooks.example.com/clay" },
  }),
};

type WebhookCall = { url: string; body: unknown };

function makeHarness(envOverride?: Partial<RuntimeEnv>, configOverride?: Partial<GreenwareConfig>) {
  const store = new MemorySessionStore();
  const webhookCalls: WebhookCall[] = [];
  const appConfig: GreenwareConfig = {
    ...config,
    ...(configOverride ?? {}),
    security: {
      ...config.security,
      ...(configOverride?.security ?? {}),
    },
  };
  const app = createApp({
    config: appConfig,
    env: { ...env, ...envOverride },
    store,
    rateLimiter: new MemoryRateLimiter(),
    dispatchWebhook: async (url, body) => {
      webhookCalls.push({ url, body });
    },
  });

  const request = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(`https://${SERVER_HOST}${path}`, init));

  return { request, store, webhookCalls };
}

async function startProviderSession(h: {
  request: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const res = await h.request("/api/session/start", {
    method: "POST",
    headers: {
      "Origin": ALLOWED_ORIGIN,
      "Content-Type": "application/json",
      "Host": SERVER_HOST,
    },
    body: JSON.stringify({ provider: "typeform", form_id: "enterprise-demo" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    session_id: string;
    read_token: string;
    expires_at: number;
    hidden_fields: { greenware_session_id: string; greenware_read_token: string };
    wait_url: string;
  };
}

function typeformPayload(sessionId: string, readToken: string) {
  return {
    event_id: "01HXTYPEFORMEVENT",
    form_response: {
      token: "response-token-123",
      hidden: {
        greenware_session_id: sessionId,
        greenware_read_token: readToken,
      },
      answers: [
        {
          type: "email",
          email: "taylor@bigcorp.com",
          field: { ref: "email", title: "Work email" },
        },
        {
          type: "text",
          text: "Taylor Chen",
          field: { ref: "name", title: "Name" },
        },
        {
          type: "text",
          text: "BigCorp",
          field: { ref: "company", title: "Company" },
        },
        {
          type: "number",
          number: 3200,
          field: { ref: "employees", title: "Employees" },
        },
      ],
    },
  };
}

function tallyPayloadWithHiddenFieldsAsFieldRows(sessionId: string, readToken: string) {
  return {
    eventId: "01HXTALLYEVENT",
    data: {
      responseId: "response-tally-123",
      fields: [
        { key: "question_session", label: "greenware_session_id", value: sessionId },
        { key: "question_read", label: "greenware_read_token", value: readToken },
        { key: "question_form", label: "greenware_form_id", value: "enterprise-demo" },
        { key: "question_email", label: "Email", value: "taylor@bigcorp.com" },
        { key: "question_company", label: "Company", value: "BigCorp" },
      ],
    },
  };
}

function tallyPayloadWithNestedAnswerValues(sessionId: string, readToken: string) {
  return {
    eventId: "01HXTALLYEVENT-NESTED",
    data: {
      responseId: "response-tally-nested-123",
      fields: [
        {
          key: "question_session",
          label: "greenware_session_id",
          type: "HIDDEN_FIELDS",
          answer: { value: sessionId, raw: sessionId },
        },
        {
          key: "question_read",
          label: "greenware_read_token",
          type: "HIDDEN_FIELDS",
          answer: { value: readToken, raw: readToken },
        },
        {
          key: "question_form",
          label: "greenware_form_id",
          type: "HIDDEN_FIELDS",
          answer: { value: "enterprise-demo", raw: "enterprise-demo" },
        },
        {
          key: "question_email",
          label: "Email",
          type: "INPUT_EMAIL",
          answer: { value: "taylor@bigcorp.com", raw: "taylor@bigcorp.com" },
        },
      ],
    },
  };
}

async function callbackFromClay(
  h: { request: (path: string, init?: RequestInit) => Promise<Response> },
  callbackUrl: string,
  sessionId: string,
) {
  const url = new URL(callbackUrl);
  return h.request(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Host": SERVER_HOST,
    },
    body: JSON.stringify({
      session_id: sessionId,
      status: "ok",
      action: {
        type: "embed",
        provider: "calendly",
        url: "https://calendly.com/acme/demo",
        mobile_behavior: "iframe",
      },
    }),
  });
}

async function poll(
  h: { request: (path: string, init?: RequestInit) => Promise<Response> },
  sessionId: string,
  readToken: string,
) {
  return h.request(`/api/session/${sessionId}`, {
    method: "GET",
    headers: {
      "Origin": ALLOWED_ORIGIN,
      "Authorization": `Bearer ${readToken}`,
      "Host": SERVER_HOST,
    },
  });
}

describe("provider-backed routing", () => {
  it("returns setup instructions for GET checks on provider ingest URLs", async () => {
    const h = makeHarness();

    const res = await h.request("/api/ingest/tally", {
      method: "GET",
      headers: { "Host": SERVER_HOST },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      provider: "tally",
      expected_method: "POST",
      content_type: "application/json",
      webhook_url: `https://${SERVER_HOST}/api/ingest/tally`,
      auth: {
        hidden_fields: ["greenware_session_id", "greenware_read_token", "greenware_form_id"],
      },
      note: "This GET response is only a setup check. Form-provider submissions must POST JSON with Greenware hidden fields to this URL.",
    });
    expect(h.webhookCalls).toEqual([]);
  });

  it("starts a browser session without dispatching Clay yet", async () => {
    const h = makeHarness();

    const start = await startProviderSession(h);

    expect(start.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(start.hidden_fields).toEqual({
      greenware_session_id: start.session_id,
      greenware_read_token: start.read_token,
      greenware_form_id: "enterprise-demo",
    });
    expect(start.wait_url).toBe(`/wait/${start.session_id}#read_token=${encodeURIComponent(start.read_token)}`);
    expect(h.webhookCalls).toEqual([]);

    const pending = await poll(h, start.session_id, start.read_token);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ status: "pending" });
  });

  it("ingests a Typeform webhook, dispatches Clay, then callback makes the browser session ready", async () => {
    const h = makeHarness();
    const start = await startProviderSession(h);

    const ingest = await h.request("/api/ingest/typeform", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": SERVER_HOST,
      },
      body: JSON.stringify(typeformPayload(start.session_id, start.read_token)),
    });

    expect(ingest.status).toBe(202);
    expect(await ingest.json()).toEqual({ status: "accepted", session_id: start.session_id });
    expect(h.webhookCalls).toHaveLength(1);

    const clayBody = h.webhookCalls[0]!.body as {
      session_id: string;
      callback_url: string;
      lead: Record<string, unknown>;
      form_id?: string;
      source: { provider: string; provider_submission_id?: string };
    };
    expect(clayBody.session_id).toBe(start.session_id);
    expect(clayBody.callback_url).toContain(`/api/callback/${start.session_id}`);
    expect(clayBody.lead).toEqual({
      email: "taylor@bigcorp.com",
      name: "Taylor Chen",
      company: "BigCorp",
      employees: 3200,
    });
    expect(clayBody.form_id).toBe("enterprise-demo");
    expect(clayBody.source).toEqual({
      provider: "typeform",
      provider_submission_id: "response-token-123",
    });

    const cb = await callbackFromClay(h, clayBody.callback_url, start.session_id);
    expect(cb.status).toBe(200);

    const ready = await poll(h, start.session_id, start.read_token);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "ready",
      action: {
        type: "embed",
        provider: "calendly",
        url: "https://calendly.com/acme/demo",
        mobile_behavior: "iframe",
      },
    });
  });

  it("uses configured public URL for provider callback URLs", async () => {
    const h = makeHarness({
      GREENWARE_PUBLIC_URL: "https://greenware.example.com/",
      RAILWAY_PUBLIC_DOMAIN: "railway-generated.example.com",
    } as Partial<RuntimeEnv>);
    const start = await startProviderSession(h);

    const ingest = await h.request("/api/ingest/typeform", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": SERVER_HOST,
      },
      body: JSON.stringify(typeformPayload(start.session_id, start.read_token)),
    });

    expect(ingest.status).toBe(202);
    const clayBody = h.webhookCalls[0]!.body as { callback_url: string };
    expect(clayBody.callback_url).toMatch(/^https:\/\/greenware\.example\.com\/api\/callback\//);
    expect(clayBody.callback_url).not.toContain(SERVER_HOST);
  });

  it("rejects provider submissions when greenware_read_token does not match the session", async () => {
    const h = makeHarness();
    const start = await startProviderSession(h);

    const res = await h.request("/api/ingest/typeform", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": SERVER_HOST,
      },
      body: JSON.stringify(typeformPayload(start.session_id, "wrong-read-token")),
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "INVALID_AUTH" });
    expect(h.webhookCalls).toEqual([]);
  });

  it("ingests a Tally webhook when hidden fields arrive as normal field rows", async () => {
    const h = makeHarness();
    const start = await startProviderSession(h);

    const ingest = await h.request("/api/ingest/tally", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": SERVER_HOST,
      },
      body: JSON.stringify(tallyPayloadWithHiddenFieldsAsFieldRows(start.session_id, start.read_token)),
    });

    expect(ingest.status).toBe(202);
    expect(await ingest.json()).toEqual({ status: "accepted", session_id: start.session_id });
    expect(h.webhookCalls).toHaveLength(1);

    const clayBody = h.webhookCalls[0]!.body as {
      session_id: string;
      lead: Record<string, unknown>;
      form_id?: string;
      source: { provider: string; provider_submission_id?: string };
    };
    expect(clayBody.session_id).toBe(start.session_id);
    expect(clayBody.lead).toEqual({
      email: "taylor@bigcorp.com",
      company: "BigCorp",
    });
    expect(clayBody.form_id).toBe("enterprise-demo");
    expect(clayBody.source).toEqual({
      provider: "tally",
      provider_submission_id: "response-tally-123",
    });
  });

  it("ingests a Tally webhook when field values arrive under answer.value", async () => {
    const h = makeHarness();
    const start = await startProviderSession(h);

    const ingest = await h.request("/api/ingest/tally", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": SERVER_HOST,
      },
      body: JSON.stringify(tallyPayloadWithNestedAnswerValues(start.session_id, start.read_token)),
    });

    expect(ingest.status).toBe(202);
    expect(await ingest.json()).toEqual({ status: "accepted", session_id: start.session_id });
    expect(h.webhookCalls).toHaveLength(1);

    const clayBody = h.webhookCalls[0]!.body as {
      session_id: string;
      lead: Record<string, unknown>;
      form_id?: string;
      source: { provider: string; provider_submission_id?: string };
    };
    expect(clayBody.session_id).toBe(start.session_id);
    expect(clayBody.lead).toEqual({
      email: "taylor@bigcorp.com",
    });
    expect(clayBody.form_id).toBe("enterprise-demo");
    expect(clayBody.source).toEqual({
      provider: "tally",
      provider_submission_id: "response-tally-nested-123",
    });
  });

  it("dispatches provider submissions to the destination matching form_id", async () => {
    const h = makeHarness({
      GREENWARE_DESTINATIONS: JSON.stringify({
        default: {
          webhook_url: "https://hooks.example.com/default",
        },
        "enterprise-demo": {
          webhook_url: "https://hooks.example.com/enterprise",
          headers: { "x-clay-webhook-auth": "enterprise-token" },
        },
      }),
    });
    const start = await startProviderSession(h);

    const ingest = await h.request("/api/ingest/tally", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": SERVER_HOST,
      },
      body: JSON.stringify(tallyPayloadWithHiddenFieldsAsFieldRows(start.session_id, start.read_token)),
    });

    expect(ingest.status).toBe(202);
    expect(h.webhookCalls).toHaveLength(1);
    expect(h.webhookCalls[0]!.url).toBe("https://hooks.example.com/enterprise");
  });

  it("accepts provider ingest without the optional setup token when the read token matches", async () => {
    const h = makeHarness();
    const start = await startProviderSession(h);

    const res = await h.request("/api/ingest/typeform", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": SERVER_HOST,
      },
      body: JSON.stringify(typeformPayload(start.session_id, start.read_token)),
    });

    expect(res.status).toBe(202);
    expect(h.webhookCalls).toHaveLength(1);
  });

  it("rate limits provider ingest attempts", async () => {
    const h = makeHarness(undefined, {
      security: { ...config.security, rate_limit_per_ip_per_minute: 2 },
    });
    const start = await startProviderSession(h);
    const body = JSON.stringify(typeformPayload(start.session_id, start.read_token));

    const first = await h.request("/api/ingest/typeform", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Host": SERVER_HOST },
      body,
    });
    expect(first.status).toBe(202);

    const second = await h.request("/api/ingest/typeform", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Host": SERVER_HOST },
      body,
    });
    expect(second.status).toBe(429);
  });

  it("does not dispatch Clay twice for duplicate provider webhooks", async () => {
    const h = makeHarness();
    const start = await startProviderSession(h);
    const body = JSON.stringify(typeformPayload(start.session_id, start.read_token));

    const first = await h.request("/api/ingest/typeform", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Host": SERVER_HOST },
      body,
    });
    expect(first.status).toBe(202);

    const second = await h.request("/api/ingest/typeform", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Host": SERVER_HOST },
      body,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "duplicate", session_id: start.session_id });
    expect(h.webhookCalls).toHaveLength(1);
  });
});
