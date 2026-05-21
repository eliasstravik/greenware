<p align="center">
  <img src="assets/greenware-logo.png" width="90" alt="Greenware logo" />
</p>

<h1 align="center">Greenware</h1>

<p align="center">
  Website form lead routing for Clay-powered backend
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
</p>

---

## What it does

Greenware lets companies keep their existing forms while routing each submission through Clay before deciding what the visitor sees next.

```
Website form / Tally / Typeform
  -> Greenware backend on Railway
    -> Clay webhook
      -> Clay runs enrichment and routing logic
        -> Clay POSTs a signed callback back to Greenware
          -> Browser receives an embed, redirect, message, or rejection
```

Greenware is not a form builder and does not ship a hosted marketing site. It is a backend service plus two optional JavaScript embed files:

- `/api/*` routes for submission, provider ingest, session polling, and signed callbacks
- `/embed/v1.js` for browser/session orchestration
- `/embed/v1-default-ui.js` for the default spinner and action renderer

The deployable backend intentionally includes no HTML preview pages, demo pages, or hosted example website.

## Getting started

### Step 1: Deploy Greenware

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/PqFdW4?utm_medium=integration&utm_source=button&utm_campaign=greenware)

<details>
<summary><b>Railway step-by-step</b></summary>

1. Click the **Deploy on Railway** button above
2. Sign in to Railway or create an account
3. If asked to name the project, pick anything you like, such as `greenware`
4. Leave the variables as-is. Greenware can boot without any required deploy-time secrets
5. Deploy the template
6. Wait for the build to finish
7. Open the `greenware` service. If it is unexposed, go to Settings -> Networking -> Public Networking and click **Generate Domain**. Copy the public Railway URL, such as:

   ```text
   https://greenware-production-xxxx.up.railway.app
   ```

8. Open `/health` on the public URL. It should return `{"status":"ok"}`
9. If the Variables tab says **No Environment Variables**, that is expected. Greenware is online, but not ready to route leads yet.
10. Continue to Step 2 and add the production variables for Clay and your website origins.

The Railway template creates one Greenware backend service. It intentionally does not create a database. See [docs/railway-template.md](docs/railway-template.md) for the exact template settings.

</details>

<details>
<summary><b>Local / VPS / other</b></summary>

```bash
git clone https://github.com/eliasstravik/greenware.git
cd greenware
bun install
cp apps/server/.env.example apps/server/.env
bun run build
bun run start
```

For live routing outside Railway, set:

```bash
GREENWARE_DESTINATIONS='{"default":{"webhook_url":"INSERT_WEBHOOK_URL_HERE","headers":{"x-clay-webhook-auth":"INSERT_AUTH_TOKEN_HERE"}}}'
GREENWARE_ALLOWED_ORIGINS=https://yourcompany.com,https://www.yourcompany.com
GREENWARE_ENV=production
GREENWARE_PUBLIC_URL=https://greenware.yourcompany.com
PORT=8080

# Optional stable keys.
GREENWARE_SIGNING_KEY=long-random-secret
GREENWARE_READ_KEY=long-random-secret

# Optional protected setup endpoint.
GREENWARE_SETUP_TOKEN=long-random-secret
```

Your server URL is whatever domain or IP points to this process.

</details>

### Step 2: Make the deployment ready

A fresh deploy needs no variables to boot. To start routing real form submissions, open the Railway `greenware` service, go to **Variables**, and add the variables below. You can use **Raw Editor** to paste them in.

#### Required for Clay

`GREENWARE_DESTINATIONS` tells Greenware which Clay webhook to call.

```text
GREENWARE_DESTINATIONS={"default":{"webhook_url":"INSERT_WEBHOOK_URL_HERE","headers":{"x-clay-webhook-auth":"INSERT_AUTH_TOKEN_HERE"}}}
```

Replace:

- `INSERT_WEBHOOK_URL_HERE` with your Clay webhook source URL
- `INSERT_AUTH_TOKEN_HERE` with your Clay webhook auth token

#### Required for browser forms and embeds

`GREENWARE_ALLOWED_ORIGINS` tells Greenware which websites may call the browser APIs. Use exact origins only: scheme, hostname, and port if needed. Do not include paths.

```text
GREENWARE_ALLOWED_ORIGINS=https://yourcompany.com,https://www.yourcompany.com
```

This is needed for custom-coded forms, Webflow/Squarespace/WordPress pages, and Tally or Typeform embeds that use Greenware's JavaScript. It is not needed for the provider's server-to-server webhook POST.

Origin checks protect browser integrations from accidental cross-site use. They are not server-to-server authentication, because non-browser clients can forge an `Origin` header. Keep provider webhook URLs unguessable through per-session hidden fields, and use Railway or service-level protections if you expose Greenware to high-volume public traffic.

After adding variables, redeploy the service and check:

```bash
curl https://your-greenware-url/health
curl https://your-greenware-url/ready
```

Expected `/health`:

```json
{ "status": "ok" }
```

Expected `/ready`:

```json
{ "status": "ok", "destination": "default", "storage": "memory" }
```

If `/ready` returns `not_ready`, `GREENWARE_DESTINATIONS` is missing or invalid, or your only allowed origins are local development origins / the Railway service domain. Add the real website origin that hosts the form.

#### Multiple Clay destinations

Greenware can route different forms to different Clay webhook tables. In Railway, open the Greenware service variables and set `GREENWARE_DESTINATIONS` as JSON.

```json
{
  "default": {
    "webhook_url": "INSERT_DEFAULT_WEBHOOK_URL_HERE",
    "headers": {
      "x-clay-webhook-auth": "INSERT_DEFAULT_AUTH_TOKEN_HERE"
    }
  },
  "enterprise-demo": {
    "webhook_url": "INSERT_ENTERPRISE_WEBHOOK_URL_HERE",
    "headers": {
      "x-clay-webhook-auth": "INSERT_ENTERPRISE_AUTH_TOKEN_HERE"
    }
  },
  "inbound-partners": {
    "webhook_url": "INSERT_PARTNERS_WEBHOOK_URL_HERE",
    "headers": {
      "x-clay-webhook-auth": "INSERT_PARTNERS_AUTH_TOKEN_HERE"
    },
    "timeout_ms": 15000
  }
}
```

If a submission has `form_id: "enterprise-demo"`, Greenware sends it to the `enterprise-demo` destination. If no exact match exists, it uses `default`.

### Step 3: Configure Clay callback

Every Greenware request sent to Clay includes:

```json
{
  "session_id": "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c",
  "callback_url": "https://your-greenware-url/api/callback/...",
  "lead": {
    "email": "alice@example.com"
  },
  "form_id": "enterprise-demo",
  "source": {
    "provider": "tally"
  },
  "meta": {
    "submitted_at": "2026-05-20T10:00:00.000Z"
  }
}
```

Add an HTTP API column in Clay as the last routing step.

**Method:** `POST`

**URL:**

```text
{{callback_url}}
```

**Headers:**

- **Key:** `Content-Type`
- **Value:** `application/json`

**Body:**

```json
{
  "session_id": "{{session_id}}",
  "status": "ok",
  "action": {
    "type": "embed",
    "provider": "calendly",
    "url": "https://calendly.com/your-team/demo",
    "mobile_behavior": "redirect"
  },
  "meta": {
    "source": "clay"
  }
}
```

### Step 4: Use it from your form

#### Custom-coded forms

Add the Greenware attributes and scripts to an existing form:

```html
<form
  data-greenware-attach
  data-greenware-endpoint="https://your-greenware-url"
  data-greenware-form-id="enterprise-demo"
>
  <input name="email" type="email" required>
  <button type="submit">Book a demo</button>
</form>

<script src="https://your-greenware-url/embed/v1.js"></script>
<script src="https://your-greenware-url/embed/v1-default-ui.js"></script>
```

Use only `/embed/v1.js` if you want your own UI and listen for `greenware:*` events.

#### Tally, Typeform, and provider embeds

Use Greenware to create a session before loading the provider form. Greenware then passes these hidden fields into the provider URL or provider hidden-field settings:

```text
greenware_session_id
greenware_read_token
greenware_form_id
```

Create hidden fields with exactly those names in Tally, Typeform, or the provider you use. Do not hard-code values into those fields. Greenware generates fresh values for each visitor session and appends them when it loads the embedded form.

For Tally embeds, Greenware can inject those values directly:

```html
<div
  data-greenware-provider="tally"
  data-greenware-form-id="enterprise-demo"
  data-greenware-iframe-src="https://tally.so/embed/YOUR_FORM_ID?alignLeft=1&hideTitle=1&transparentBackground=1&dynamicHeight=1"
></div>

<script src="https://your-greenware-url/embed/v1.js"></script>
<script src="https://your-greenware-url/embed/v1-default-ui.js"></script>
```

Configure the provider webhook:

```text
https://your-greenware-url/api/ingest/tally
https://your-greenware-url/api/ingest/typeform
https://your-greenware-url/api/ingest/generic
```

Do not add an authorization header or `?token=` query parameter to provider webhook URLs. Provider webhooks are authenticated by the per-session `greenware_read_token` hidden field. `GREENWARE_SETUP_TOKEN` is only needed if you want to enable protected setup endpoints such as `/setup/sessions`.

## API reference

All endpoints return JSON except `/wait/:sessionId`, which is a minimal owned fallback page for redirect-only form providers.

### `GET /health`

Railway health check. No auth.

```bash
curl https://your-greenware-url/health
```

```json
{ "status": "ok" }
```

### `GET /ready`

Configuration readiness check. No auth. Returns `503` until a real Clay destination and at least one non-local, non-Railway website origin are configured.

```json
{ "status": "ok", "destination": "default", "storage": "memory" }
```

### `GET /`

Backend metadata. No auth.

```json
{
  "name": "greenware",
  "status": "ok",
  "kind": "backend"
}
```

### `POST /api/submit`

Accepts a custom-coded browser form submission. Requires the browser `Origin` to match `GREENWARE_ALLOWED_ORIGINS` or the Railway public domain. The endpoint is rate-limited per IP; treat `GREENWARE_ALLOWED_ORIGINS` as browser CORS protection, not as secret authentication.

```bash
curl -X POST https://your-greenware-url/api/submit \
  -H "Origin: https://your-site.com" \
  -H "Content-Type: application/json" \
  -d '{
    "lead": { "email": "alice@example.com" },
    "form_id": "enterprise-demo"
  }'
```

```json
{
  "session_id": "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c",
  "read_token": "...",
  "expires_at": 1779283497
}
```

### `POST /api/session/start`

Creates a pending session for Tally, Typeform, or another provider form before the provider submits.

```json
{
  "provider": "tally",
  "form_id": "enterprise-demo"
}
```

### `POST /api/ingest/:provider`

Receives provider webhooks. Supported providers are `tally`, `typeform`, and `generic`.

Provider submissions must include the Greenware hidden fields returned by `/api/session/start`:

```text
greenware_session_id
greenware_read_token
greenware_form_id
```

### `POST /api/callback/:sessionId`

Clay posts the final routing action to the signed `callback_url` Greenware sent in the Clay webhook body. Do not construct this URL yourself.

### `GET /api/session/:sessionId`

Browser polling endpoint. Requires:

```text
Authorization: Bearer READ_TOKEN
```

### `GET /setup/sessions`

Protected operational view for recent terminal sessions. Requires the setup token and returns redacted metadata only.

```bash
curl https://your-greenware-url/setup/sessions \
  -H "Authorization: Bearer INSERT_SETUP_TOKEN_HERE"
```

## Action payloads

Redirect:

```json
{ "type": "redirect", "url": "https://your-site.com/signup" }
```

Embed:

```json
{
  "type": "embed",
  "provider": "calendly",
  "url": "https://calendly.com/your-team/demo",
  "mobile_behavior": "redirect"
}
```

Message:

```json
{
  "type": "message",
  "title": "Thanks",
  "body": "We will follow up by email."
}
```

Reject:

```json
{
  "type": "reject",
  "reason": "Not a fit right now"
}
```

See [docs/protocol-v1.md](docs/protocol-v1.md) for the full schema.

## Environment variables

Greenware is zero-config at deploy time. If signing/read keys are absent, the runtime uses ephemeral process-local keys, which is acceptable because sessions are short-lived and in memory. Set stable keys only if you want explicit key management across restarts.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GREENWARE_SIGNING_KEY` | No | ephemeral runtime secret | HMAC key for callback URLs |
| `GREENWARE_READ_KEY` | No | ephemeral runtime secret | HMAC key for browser read tokens |
| `GREENWARE_SETUP_TOKEN` | No | disabled | Optional token for protected setup endpoints |
| `GREENWARE_DESTINATIONS` | Yes for live routing | none | JSON map of Clay webhook destinations |
| `GREENWARE_ALLOWED_ORIGINS` | Yes for browser integrations | local development origins only | Comma-separated browser origins allowed to call `/api/submit`, `/api/session/start`, and `/api/session/*` |
| `GREENWARE_PUBLIC_URL` | No | `RAILWAY_PUBLIC_DOMAIN` | Canonical public URL used when Greenware builds signed callback URLs |
| `GREENWARE_ENV` | No | `production` | Runtime environment |
| `GREENWARE_SIGNING_KEY_PREVIOUS` | No | | Previous callback signing key during rotation |
| `PORT` | No | `8787` locally, Railway-provided in deploy | HTTP port |

## Development

```bash
bun install
cp apps/server/.env.example apps/server/.env
bun run dev
```

Useful commands:

| Command | Description |
|---------|-------------|
| `bun run dev` | Start the Bun server locally |
| `bun run build` | Type-check the server |
| `bun run typecheck` | Type-check without deployment |
| `bun run test` | Run the test suite |
| `bun run deploy` | Deploy the current workspace with `railway up` |

## Architecture

Built with [Hono](https://hono.dev), TypeScript, and Bun.

```
apps/server/src/
  index.ts                     Hono app factory and public routes
  server.ts                    Bun/Railway entrypoint
  routes/submit.ts             Custom form submit endpoint
  routes/start.ts              Provider session bootstrap endpoint
  routes/ingest.ts             Tally/Typeform/generic webhook ingest
  routes/callback.ts           Signed Clay callback endpoint
  routes/session.ts            Browser polling endpoint
  lib/enrichment_destinations.ts  Railway-configured Clay routing
  lib/protocol.ts              Callback action schema
  lib/sessions.ts              Session store interface and memory store
```

Railway runs one backend service. Sessions are short-lived in-memory records, so there is no Postgres, SQLite, Redis, or other database service to configure.

## Security measures

- HMAC-signed callback URLs
- HMAC-derived read tokens for browser polling
- Exact-origin CORS checks for browser submit/session endpoints
- Optional setup token for protected operational endpoints
- HTTPS-only action URLs
- Strict Protocol v1 callback schema
- Optional key rotation through `GREENWARE_SIGNING_KEY_PREVIOUS`

## License

[MIT](LICENSE)
