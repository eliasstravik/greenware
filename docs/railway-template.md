# Railway Template

This is the production Railway template configuration used by the README deploy button.

Template URL:

```text
https://railway.com/deploy/PqFdW4?utm_medium=integration&utm_source=button&utm_campaign=greenware
```

Railway's CLI can deploy existing templates and deploy the current project, but template creation and publishing are done from the Railway dashboard/template composer. The CLI can search and deploy published template codes; it cannot publish this template.

## Template shape

Create a template from the Railway project after the Greenware service is working.

### Services

1. `greenware`
   - Source: `https://github.com/eliasstravik/greenware`
   - Builder: Railpack
   - Build command: `bun install --frozen-lockfile && bun run build`
   - Start command: `bun run start`
   - Healthcheck path: `/health`
   - Public networking: enabled

After saving the template, deploy it once from the public template URL and verify that
the service boots cleanly. Railway does not always create a public service domain
automatically; if the service is unexposed, use Settings -> Networking -> Public
Networking -> Generate Domain, or run `railway domain`.

## Optional stable variables

Greenware can deploy without any variables. If signing/read keys are absent,
the runtime uses ephemeral process-local keys; because sessions are in-memory,
pending sessions are already lost on restart.

Set these only if you want stable keys across restarts or want to enable
protected setup endpoints:

```text
GREENWARE_SIGNING_KEY=${{ secret(64) }}
GREENWARE_READ_KEY=${{ secret(64) }}
GREENWARE_SETUP_TOKEN=${{ secret(32) }}
GREENWARE_ENV=production
```

Do not prompt the deployer for these.

## Optional variables users can add later

These should not block deployment:

```text
GREENWARE_DESTINATIONS={"default":{"webhook_url":"INSERT_WEBHOOK_URL_HERE","headers":{"x-clay-webhook-auth":"INSERT_AUTH_TOKEN_HERE"}}}
GREENWARE_ALLOWED_ORIGINS=https://example.com,https://www.example.com
GREENWARE_PUBLIC_URL=https://greenware.example.com
GREENWARE_SIGNING_KEY_PREVIOUS=
```

`GREENWARE_DESTINATIONS` is intentionally edited after deploy because each company owns its Clay webhook URLs and tokens. `GREENWARE_PUBLIC_URL` is only needed for a custom domain; Railway's generated domain is available through `RAILWAY_PUBLIC_DOMAIN`.

Greenware intentionally ships without a database service. Sessions are short-lived in-memory records, so the template should deploy a single `greenware` web service and no Postgres/Redis/SQLite service.

## Template validation

Use the Railway CLI to validate a fresh template deploy without printing secret values:

```bash
railway link --project <project-id> --service <service-id> --environment <environment-id>
railway variable list --json | jq 'keys | map(select(startswith("GREENWARE_") or . == "RAILWAY_PUBLIC_DOMAIN"))'
railway status --json | jq -r '.environments.edges[].node.serviceInstances.edges[].node.latestDeployment.status'
railway domain --json
curl -i https://<generated-domain>/health
```

The variable list may include stable keys if the template defines them:

```text
GREENWARE_ENV
GREENWARE_READ_KEY
GREENWARE_SETUP_TOKEN
GREENWARE_SIGNING_KEY
RAILWAY_PUBLIC_DOMAIN
```

`/health` must return `200` even when no Greenware variables are set. `/ready`
returns `503` until the owner adds `GREENWARE_DESTINATIONS` and a real
`GREENWARE_ALLOWED_ORIGINS` website origin. After both are configured it should
return `{"status":"ok","destination":"default","storage":"memory"}`.

## README button

Use this button in public docs:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/PqFdW4?utm_medium=integration&utm_source=button&utm_campaign=greenware)
```
