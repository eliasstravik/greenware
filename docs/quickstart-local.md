# Local quickstart

Goal: run the Greenware backend locally and exercise the real API loop with the Python enrichment harness. The project no longer serves hosted HTML preview pages.

## Prerequisites

- Bun >= 1.0
- Python 3.8 or later

## 1. Install

```bash
git clone <greenware-repo-url> greenware
cd greenware
bun install
```

## 2. Configure local variables

```bash
cp apps/server/.env.example apps/server/.env
```

Greenware can boot without stable keys. Add stable local keys only if you want
sessions and signed URLs to survive process restarts:

```bash
openssl rand -hex 32
```

For the local Python harness, keep or set:

```text
GREENWARE_DESTINATIONS={"default":{"webhook_url":"http://localhost:8788/webhook"}}
GREENWARE_ALLOWED_ORIGINS=https://yourcompany.com,http://localhost:8787
```

## 3. Start Greenware

```bash
bun run dev
```

The backend listens on `http://localhost:8787` unless `PORT` is set.

## 4. Start the local enrichment harness

```bash
python3 examples/simple/enrich.py
```

## 5. Submit a test lead

```bash
curl -X POST http://localhost:8787/api/submit \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://yourcompany.com' \
  -d '{"lead":{"email":"alice@acme.com"},"form_id":"local-test"}'
```

Poll with the returned values:

```bash
curl http://localhost:8787/api/session/<SESSION_ID> \
  -H 'Origin: https://yourcompany.com' \
  -H 'Authorization: Bearer <READ_TOKEN>'
```

## Useful checks

```bash
curl http://localhost:8787/health
curl http://localhost:8787/
```

## Troubleshooting

- **Port 8787 in use** — run with another port: `PORT=3000 bun run dev`.
- **`/ready` returns 503** — set `GREENWARE_DESTINATIONS` to the local harness URL.
- **CORS error** — add the exact `Origin` to `GREENWARE_ALLOWED_ORIGINS`.
- **Spinner never finishes in a browser integration** — confirm the enrichment service POSTed to `callback_url`.
