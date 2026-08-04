# Getting started — route your first form through Clay

This guide takes you from a new Greenware deployment to a form that sends a lead through Clay and shows Clay's selected action in the same browser.

## What you need

- A Railway account
- A Clay table with a webhook source
- An existing website form, Tally form, or Typeform
- The ability to add a script to the page or configure the form provider's webhook

## 1. Deploy Greenware

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/PqFdW4?utm_medium=integration&utm_source=button&utm_campaign=greenware)

1. Open the Railway template.
2. Sign in or create an account.
3. Give the project any name, such as `greenware`.
4. Leave the variables unchanged for the first deployment.
5. Wait for the build to finish.
6. Open the Greenware service.
7. If the service has no public URL, open **Settings → Networking → Public Networking** and choose **Generate Domain**.
8. Copy the public URL. It will look similar to:

   ```text
   https://greenware-production-xxxx.up.railway.app
   ```

Check the deployment:

```bash
curl https://your-greenware-url/health
```

The response should be:

```json
{ "status": "ok" }
```

A new deployment can start without any environment variables. It will not route a real submission until you connect Clay and allow your website origin.

### Run Greenware somewhere else

```bash
git clone https://github.com/eliasstravik/greenware.git
cd greenware
bun install
cp apps/server/.env.example apps/server/.env
bun run build
bun run start
```

Greenware uses an in-memory session store. Run one process unless you add shared storage for sessions and rate limits.

## 2. Connect your Clay webhook

Open your Clay table and add **Pull in data from a Webhook** as its source. Copy the webhook URL and authentication token Clay provides.

In Railway, open the Greenware service, go to **Variables**, and add:

```text
GREENWARE_DESTINATIONS={"default":{"webhook_url":"INSERT_WEBHOOK_URL_HERE","headers":{"x-clay-webhook-auth":"INSERT_AUTH_TOKEN_HERE"}}}
```

Replace:

- `INSERT_WEBHOOK_URL_HERE` with the Clay webhook source URL
- `INSERT_AUTH_TOKEN_HERE` with the Clay webhook authentication token

Then add the exact origins of the websites that will call Greenware:

```text
GREENWARE_ALLOWED_ORIGINS=https://yourcompany.com,https://www.yourcompany.com
```

Include the scheme and hostname, plus the port when the site uses a nonstandard one. Do not include paths.

Set the production URL and environment:

```text
GREENWARE_ENV=production
GREENWARE_PUBLIC_URL=https://your-greenware-url
```

Redeploy, then check readiness:

```bash
curl https://your-greenware-url/ready
```

The configured service should return:

```json
{ "status": "ok", "destination": "default", "storage": "memory" }
```

### Route different forms to different Clay tables

Add a named destination for each form:

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

Greenware matches the submitted `form_id` to a destination name. An unmatched ID uses the `default` destination.

## 3. Return the next action from Clay

Every row Greenware sends to Clay includes a session ID and a signed callback URL:

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

Build the enrichment and qualification columns you need, then add an **HTTP API** column as the last routing step.

- **Method:** `POST`
- **URL:** `{{callback_url}}`
- **Header:** `Content-Type: application/json`

For a qualified lead, the body can return a calendar:

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

Greenware accepts four action types:

- `embed` — show a supported HTTPS calendar or iframe where the form was
- `redirect` — send the visitor to another HTTPS page
- `message` — show a message with an optional call to action
- `reject` — show a polite rejection with an optional off-ramp

Keep the signed `callback_url` unchanged. It is scoped to one session and expires.

## 4. Attach Greenware to the form

### Custom website form

Add the Greenware attributes to the form and load the two browser scripts:

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

The core script manages the submission and waits for Clay. The default UI script renders processing, action, error, and expired states.

Load only `/embed/v1.js` when the site should render those states with its own components. Listen for the `greenware:*` browser events described in [the headless quickstart](quickstart-headless.md).

### Tally

Add these hidden fields to the Tally form:

```text
greenware_session_id
greenware_read_token
greenware_form_id
```

Do not hard-code their values. Greenware creates fresh values for every visitor.

Add the embed to the host page:

```html
<div
  data-greenware-provider="tally"
  data-greenware-form-id="enterprise-demo"
  data-greenware-iframe-src="https://tally.so/embed/YOUR_FORM_ID?alignLeft=1&hideTitle=1&transparentBackground=1&dynamicHeight=1"
></div>

<script src="https://your-greenware-url/embed/v1.js"></script>
<script src="https://your-greenware-url/embed/v1-default-ui.js"></script>
```

Set the Tally webhook URL to:

```text
https://your-greenware-url/api/ingest/tally
```

### Typeform

Create the same three hidden fields and set the Typeform webhook URL to:

```text
https://your-greenware-url/api/ingest/typeform
```

Provider webhooks use the per-session `greenware_read_token`. Do not add a shared authorization header or token query parameter.

## 5. Test the full route

1. Submit the form with a test lead.
2. Confirm the row reaches the expected Clay table.
3. Confirm Clay receives `session_id`, `callback_url`, `lead`, and `form_id`.
4. Run Clay's final HTTP API column.
5. Confirm the open page replaces the form with the returned action.
6. Test at least one alternate route, such as a message or rejection.

## Troubleshooting

- **`/ready` returns `not_ready`:** Check that `GREENWARE_DESTINATIONS` is valid and `GREENWARE_ALLOWED_ORIGINS` contains the real website origin.
- **The browser reports an origin error:** Add its exact origin to `GREENWARE_ALLOWED_ORIGINS` and redeploy.
- **The provider webhook returns 400:** Confirm the form contains `greenware_session_id`, `greenware_read_token`, and `greenware_form_id`.
- **The provider webhook returns 403:** Confirm the generated read token passed through the provider unchanged.
- **The browser never updates:** Confirm Clay posted to the exact signed `callback_url` before it expired.
- **The wrong Clay table receives the row:** Match the form's ID exactly to a key in `GREENWARE_DESTINATIONS`.
- **Pending routes disappear after a restart:** This is expected with the built-in in-memory store.
- **Requests reach different instances:** Use one Greenware process or add shared session storage.

For protocol details, see [Protocol v1](protocol-v1.md). For a local walkthrough, see [the local quickstart](quickstart-local.md).
