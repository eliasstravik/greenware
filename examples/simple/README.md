# Simple — local Python enrichment

A tiny HTTP server that plays the role of an enrichment service for the Greenware server. Use it to exercise the real end-to-end API loop locally.

## What This Proves

- Real `/api/submit` route
- Real HMAC-signed callback URLs
- Real session transition from pending to ready
- Real `/api/session/:id` polling with read-token auth
- Full Protocol v1 callback parsing

## Requirements

- Python 3.8 or later. Standard library only.
- Greenware running on `http://localhost:8787`.

## Run It

Terminal 1:

```bash
cp apps/server/.env.example apps/server/.env
# set GREENWARE_DESTINATIONS to http://localhost:8788/webhook
bun run dev
```

Terminal 2:

```bash
python3 examples/simple/enrich.py
```

Terminal 3:

```bash
curl -X POST http://localhost:8787/api/submit \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://yourcompany.com' \
  -d '{"lead":{"email":"alice@acme.com"}}'
```

Poll with the returned values:

```bash
curl http://localhost:8787/api/session/<SESSION_ID> \
  -H 'Origin: https://yourcompany.com' \
  -H 'Authorization: Bearer <READ_TOKEN>'
```

## Domain Routing Rules

| Domain family | Example | Action |
|---|---|---|
| Free-mail | `alice@gmail.com` | `message` |
| Denylist | `alice@example.com`, `alice@competitor.com` | `reject` |
| Enterprise hints | `alice@acme.com`, `alice@contoso.com` | `embed` |
| Anything else | `alice@some-startup.io` | `redirect` |

## CLI Flags

```bash
python3 examples/simple/enrich.py [--port N] [--delay SECONDS] [--server-url URL]
```

- `--port` defaults to `8788`.
- `--delay` defaults to `4`.
- `--server-url` defaults to `http://localhost:8787` and is only used for printed curl examples.

This is a test harness, not production enrichment.
