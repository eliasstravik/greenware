# Greenware quickstart — Railway to Clay

This takes you from a one-click Railway deploy to a Clay-backed routing backend. Greenware owns submit/session/callback state; your website owns the form UI; Clay owns the routing logic.

## Prerequisites

- Railway account
- Clay table with a webhook source
- A website, form builder, or no-code form that can load JavaScript or send webhooks

## Step 1: Deploy on Railway

Use the Railway template from the README. The template creates:

- one `greenware` backend service
- zero required deploy-time variables
- ephemeral signing/read keys unless you choose to set stable keys

No deploy-time variables should be typed by the user.

If the service shows as unexposed after deploy, generate a Railway domain from
Settings -> Networking -> Public Networking before continuing.

Open:

```text
https://<your-greenware-url>/health
```

Expected:

```json
{ "status": "ok" }
```

After adding a Clay destination and website origin in the next step, also check:

```text
https://<your-greenware-url>/ready
```

Expected once configured:

```json
{ "status": "ok", "destination": "default", "storage": "memory" }
```

## Step 2: Add Clay destinations and website origins

In Railway, open the `greenware` service variables and add `GREENWARE_DESTINATIONS`.

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
  }
}
```

Use `form_id` to choose the destination. Unknown `form_id` values fall back to `default`.

Then add the website origins that will load the Greenware embed or call the browser APIs:

```text
GREENWARE_ALLOWED_ORIGINS=https://yourcompany.com,https://www.yourcompany.com
```

Use exact origins only. Do not include paths.

## Step 3: Configure Clay callback

Greenware sends Clay:

```json
{
  "session_id": "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c",
  "callback_url": "https://<your-greenware-url>/api/callback/...",
  "lead": {
    "email": "alice@example.com"
  },
  "form_id": "enterprise-demo",
  "meta": {
    "submitted_at": "2026-05-20T10:00:00.000Z"
  }
}
```

In Clay, add an HTTP API column as the last routing step:

**Method:** `POST`

**URL:**

```text
{{callback_url}}
```

**Headers:**

- `Content-Type`: `application/json`

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

## Step 4: Wire your form

Custom-coded form:

```html
<form
  data-greenware-attach
  data-greenware-endpoint="https://<your-greenware-url>"
  data-greenware-form-id="enterprise-demo"
>
  <input name="email" type="email" required>
  <button type="submit">Book a demo</button>
</form>

<script src="https://<your-greenware-url>/embed/v1.js"></script>
<script src="https://<your-greenware-url>/embed/v1-default-ui.js"></script>
```

Tally embed:

```html
<div
  data-greenware-provider="tally"
  data-greenware-form-id="enterprise-demo"
  data-greenware-iframe-src="https://tally.so/embed/YOUR_FORM_ID?alignLeft=1&hideTitle=1&transparentBackground=1&dynamicHeight=1"
></div>

<script src="https://<your-greenware-url>/embed/v1.js"></script>
<script src="https://<your-greenware-url>/embed/v1-default-ui.js"></script>
```

Tally webhook URL:

```text
https://<your-greenware-url>/api/ingest/tally
```

Typeform webhook URL:

```text
https://<your-greenware-url>/api/ingest/typeform
```

## Step 5: Test end to end

1. Submit the form.
2. Confirm the provider or custom form reaches Greenware.
3. Confirm Clay receives `session_id`, `callback_url`, `lead`, and `form_id`.
4. Confirm Clay POSTs a valid action body to `callback_url`.
5. Watch the browser render the action.

## Troubleshooting

- **Origin denied** — add the website origin to `GREENWARE_ALLOWED_ORIGINS`.
- **Provider webhook returns 403** — confirm `greenware_read_token` was passed through the provider hidden fields unchanged.
- **Provider webhook returns 400** — confirm hidden fields include `greenware_session_id`, `greenware_read_token`, and `greenware_form_id`.
- **Browser never updates** — confirm Clay POSTed to the exact signed `callback_url`.
- **Wrong Clay table receives the lead** — check that the submitted `form_id` exactly matches a key in `GREENWARE_DESTINATIONS`.
- **Need recent routing state** — set `GREENWARE_SETUP_TOKEN`, redeploy, then call `/setup/sessions` with `Authorization: Bearer <GREENWARE_SETUP_TOKEN>`. It returns redacted session metadata only; no form payloads or read tokens.
