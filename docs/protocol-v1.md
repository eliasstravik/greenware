# Greenware Protocol v1

**Status:** v1 (stable)
**Audience:** Anyone building an enrichment integration, alternative server implementation, alternative embed, or protocol-compliant tooling.

---

## What Greenware Protocol v1 is

Greenware Protocol v1 is **two things together**:

1. **A JSON schema for async callback payloads** — the shape an enrichment service (Clay, Clearbit, custom script, n8n, etc.) POSTs back to the Greenware server after enriching a form submission.
2. **A signed callback URL contract** — the HTTPS URL the server hands to the enrichment service. The URL carries an HMAC signature the server verifies before accepting the POST body.

The protocol is deliberately small. A v1-compliant enrichment integration needs to do two things:

- Accept the signed callback URL as an opaque string and POST the result to it.
- Format the POST body per this spec.

No session state, no polling logic, no retries in-band. The server owns the browser-facing routing state; the enrichment service is stateless w.r.t. Greenware.

---

## Signed callback URL contract

### URL shape

```
https://<server-host>/api/callback/<session_id>?exp=<unix_ts>&sig=<base64url_hmac>&nonce=<random>&kid=<key_id>
```

| Component | Meaning |
|-----------|---------|
| `<server-host>` | The deployed Greenware server. Typically `<name>.up.railway.app` or a custom hostname. |
| `<session_id>` | UUIDv4 generated at form-submit time. |
| `exp` | Unix timestamp (seconds). The server rejects callbacks after this. |
| `sig` | `base64url(HMAC-SHA256(signing_key, session_id + ":" + exp + ":" + nonce + ":" + kid))`. `kid` is in the signing input to prevent a signature from being replayed across different key IDs during rotation. |
| `nonce` | Random ≥64 bits of entropy. Scopes idempotency and defeats replay across sessions. |
| `kid` | Key ID. Lets the server verify against a rotated set of signing keys. |

Enrichment services treat the URL as opaque — never parse, modify, or re-sign it. Path and query components must survive round-trip unchanged.

### HMAC signing flow (10 steps)

```
┌─────────┐       ┌──────────────┐       ┌───────────────────┐
│ Browser │       │ Server       │       │ Enrichment (Clay) │
└────┬────┘       └──────┬───────┘       └─────────┬─────────┘
     │ 1. POST /api/submit {fields}              │
     │ ──────────────────▶                       │
     │                   │                       │
     │           2. Generate session_id (UUIDv4) │
     │           3. Compute sig = HMAC-SHA256(   │
     │                signing_key,               │
     │                session_id+":"+exp+":"     │
     │                +nonce+":"+kid)            │
     │           4. Build callback URL with      │
     │                sig, exp, nonce, kid       │
     │           5. Store pending session, TTL=600s│
     │                   │                       │
     │           6. Fire-and-forget POST         │
     │                   │ ──────────────────▶   │
     │                   │  {fields, callback_url}
     │ 7. 200 {session_id, read_token}           │
     │ ◀──────────────────                       │
     │                   │                       │
     │                   │      (enrichment runs)│
     │                   │                       │
     │                   │ 8. POST <callback_url>│
     │                   │ ◀──────────────────── │
     │                   │     Protocol v1 JSON  │
     │           9. Verify:                      │
     │              - kid resolves to a key      │
     │              - HMAC matches               │
     │              - exp not past               │
     │              - session exists / pending   │
     │          10. zod parse → mark ready         │
     │                   │                       │
     │  (browser polls   │                       │
     │   GET /api/session/:id with read_token;   │
     │   renders action when status=ready)       │
     │                   │                       │
```

**Signing key management:**

- `signing_key` is held by the server (`GREENWARE_SIGNING_KEY` when configured, otherwise an ephemeral runtime key), never leaves the server.
- Rotation uses `kid`. The server keeps a primary plus grace-period previous key; callbacks signed with either verify successfully.
- The signing contract is **opaque to enrichment services** — they never touch the signing logic, only the fully-formed URL.

**Trust model:** the callback URL is the capability. Possession of a valid signed URL authorizes exactly one callback to exactly one session before `exp`. The server enforces single-use via session state; duplicate callbacks with identical payload return 200 (idempotent), divergent payloads return 409.

---

## Callback payload shape

Every v1 callback POST body is JSON matching this top-level shape:

```json
{
  "session_id": "string (UUID)",
  "status": "ok" | "error",
  "action": { ... },
  "meta": { ... }
}
```

- `session_id` — must match the `<session_id>` path segment of the callback URL.
- `status` — `"ok"` for normal routing outcomes, `"error"` for enrichment-side failures the integration wants surfaced to the browser.
- `action` — one of the four action types below (required when `status: "ok"`).
- `meta` — optional enrichment metadata. Shape: `{ enriched_at?: string (ISO-8601), source?: string }`.

### Action types

Protocol v1 defines exactly four action types, identified by the `type` discriminant. Unknown types MUST be rendered by v1 consumers as a generic error `message` action (see *Forward compatibility* below).

#### `redirect` — HTTPS URL navigation

Navigate the browser to a URL. Used for Cal.com scheduling links, signup pages, or any external destination.

```json
{
  "session_id": "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c",
  "status": "ok",
  "action": {
    "type": "redirect",
    "url": "https://cal.com/acme/enterprise-demo"
  },
  "meta": {
    "enriched_at": "2026-04-23T12:34:56Z",
    "source": "clay"
  }
}
```

**Fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `"redirect"` | yes | Discriminant. |
| `url` | `string` | yes | Must be HTTPS. No `javascript:`, `data:`, `vbscript:`, `file:` schemes. |

**Renderer behavior:** 600ms handoff state ("Taking you to <domain>...") then `window.location.href = url`.

---

#### `embed` — inline iframe

Render a provider iframe (Cal.com, Calendly, or generic HTTPS iframe) inside the form container. Falls back to `redirect` on mobile by default to avoid scroll-trap UX.

```json
{
  "session_id": "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c",
  "status": "ok",
  "action": {
    "type": "embed",
    "provider": "cal",
    "url": "https://cal.com/acme/enterprise-demo",
    "mobile_behavior": "redirect"
  }
}
```

**Fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `"embed"` | yes | Discriminant. |
| `provider` | `"cal" \| "calendly" \| "iframe"` | yes | Hints the renderer for provider-specific sizing/chrome. |
| `url` | `string` | yes | Must be HTTPS. |
| `mobile_behavior` | `"redirect" \| "iframe"` | no | Default `"redirect"`. On viewports <768px, the embed converts to a `redirect` action unless `"iframe"` is set. |

**Renderer behavior:** Desktop — inline iframe with `sandbox="allow-scripts allow-forms allow-same-origin"`, `title="Scheduling widget"`, and a "Skip scheduling widget" link for keyboard users. Mobile — auto-opens URL in a new tab via `target="_blank" rel="noopener"` unless `mobile_behavior: "iframe"` is explicit.

If `security.iframe_allowlist` is non-empty, iframe destinations must match one of those hosts or subdomains. Out-of-allowlist embed requests are rejected and the session is marked failed. An empty allowlist disables host restriction while keeping HTTPS-only URL validation.

---

#### `message` — custom message with optional CTA

Arbitrary informational message. The most flexible action; good for "thanks, we'll be in touch" or "here's our docs link."

```json
{
  "session_id": "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c",
  "status": "ok",
  "action": {
    "type": "message",
    "title": "Thanks, we'll be in touch",
    "body": "Our team reviews every request within one business day.\nIn the meantime, check out our blog.",
    "cta": {
      "label": "Read the blog",
      "url": "https://acme.com/blog"
    }
  }
}
```

**Fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `"message"` | yes | Discriminant. |
| `title` | `string` | yes | Rendered via `textContent`. |
| `body` | `string` | yes | Rendered via `textContent`. `\n` → `<br>` is the only permitted transform. |
| `cta` | `{ label: string, url: string }` | no | Optional call-to-action button. `url` must be HTTPS. |

---

#### `reject` — polite rejection with optional off-ramp

Surfaces a qualified "not right now" outcome. Enforced tonal shape — a required `reason` and an optional `alternative` off-ramp.

```json
{
  "session_id": "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c",
  "status": "ok",
  "action": {
    "type": "reject",
    "reason": "We're focused on mid-market teams right now. Thanks for reaching out.",
    "alternative": {
      "label": "Join our community Slack",
      "url": "https://acme.com/community"
    }
  }
}
```

**Fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `"reject"` | yes | Discriminant. |
| `reason` | `string` | yes | Max 280 chars. Rendered via `textContent`. |
| `alternative` | `{ label: string, url: string }` | no | Optional off-ramp. `url` must be HTTPS. |

**Renderer behavior:** Never red, never muted/dimmed. Polite conveyed by copy, not by visual recession. Writing guidance lives in `docs/writing-rejections.md`.

---

## Error payload shape

When the enrichment service itself hit an error (webhook timeout, malformed data it couldn't complete, upstream rejection), it MAY POST `status: "error"` with the same session_id. The server stores that terminal failure; the browser-polled `/api/session/:id` endpoint then returns `{ "status": "failed", "error_code": "..." }`.

```json
{
  "session_id": "6f2a7cba-5f63-4cf5-9f14-41c4f9c5b84c",
  "status": "error",
  "error_code": "INVALID_CALLBACK_PAYLOAD",
  "problem": "Clay posted a callback Greenware could not parse.",
  "cause": "Missing required field 'action.type'",
  "fix": "In Clay's HTTP API action body, wrap as: { \"action\": { \"type\": \"message\", ... } }",
  "docs": "https://greenware.dev/docs/protocol-v1#message"
}
```

**Fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `session_id` | `string` | yes | UUID. |
| `status` | `"error"` | yes | Literal. |
| `error_code` | enum | yes | See below. |
| `problem` | `string` | no | One-sentence user-facing summary. |
| `cause` | `string` | no | One-sentence technical cause. |
| `fix` | `string` | no | One-sentence actionable fix. |
| `docs` | `string` | no | URL to relevant docs section (HTTPS only). |

**Error codes:**

| Code | Meaning |
|------|---------|
| `INVALID_CALLBACK_PAYLOAD` | Callback body failed zod parse. |
| `UNKNOWN_ACTION_TYPE` | `action.type` is not one of the four v1 values. |
| `INVALID_SIGNATURE` | HMAC verification failed. |
| `EXPIRED_CALLBACK` | `exp` is in the past. |
| `SESSION_NOT_FOUND` | No session for the given `session_id`. |
| `SESSION_ALREADY_COMPLETED` | Callback arrived after session transitioned to `ready` with divergent payload. |
| `WEBHOOK_TIMEOUT` | Enrichment webhook did not respond within configured timeout. |
| `WEBHOOK_NON_2XX` | Enrichment webhook returned a non-2xx status. |
| `PAYLOAD_TOO_LARGE` | Callback body exceeded `/api/callback` size cap (64KB). |

---

## Rendering safety rules

Any v1-compliant embed/renderer MUST obey these rules. These are part of the protocol, not implementation details — a renderer that violates them is non-compliant regardless of how its UI looks.

### Text fields → `textContent`

`message.title`, `message.body`, `reject.reason`, `message.cta.label`, `reject.alternative.label`, all `error.problem` / `error.cause` / `error.fix` strings: rendered via `Node.textContent` (or framework equivalent) — **never** `innerHTML`, never `eval`, never template-string HTML concatenation.

### The only HTML transform: `\n` → `<br>`

To preserve line breaks in messages, renderers MAY split the string on `\n` and join with a literal `<br>` element (created via `document.createElement("br")`, not HTML string). No other transforms are permitted — no markdown, no autolink, no emoji expansion.

### URL scheme must be HTTPS

For all URL fields (`redirect.url`, `embed.url`, `message.cta.url`, `reject.alternative.url`, `error.docs`): the scheme MUST be `https:`. Renderers MUST reject `javascript:`, `data:`, `vbscript:`, `file:`, and any other non-HTTPS scheme. `http:` is permitted only in explicit dev mode (off by default).

Validation occurs **twice** — once at the protocol parse boundary (zod refinement, server-side) and once at the render boundary (embed.js re-validates before `location.href = ...` or iframe `src` assignment). Defense in depth is required.

### Iframe sandbox + allowlist

`embed` action iframes MUST use `sandbox="allow-scripts allow-forms allow-same-origin"`. Hosts MAY configure `iframe_allowlist`; when it is non-empty, out-of-allowlist embed requests MUST fail closed and not render.

---

## XSS protection at the zod boundary

Protocol v1 mandates that the parse step reject any text or URL field containing these substrings (case-insensitive — inputs are lowercased before matching):

- `<script`
- `javascript:`
- `data:`
- `vbscript:`

These patterns catch the baseline XSS vectors even if downstream rendering defense-in-depth ever fails. They apply to **every** string field in the payload, including `message.title`, `message.body`, `reject.reason`, CTA labels, alternative labels, all URLs, and error payload fields.

A string that fails this check causes the whole payload to be rejected with `INVALID_CALLBACK_PAYLOAD`.

**Not a full sanitizer.** This is a belt-and-suspenders check at the protocol boundary. Renderers still use `textContent` for text and scheme-checked HTTPS for URLs. Don't rely on this refinement as the only defense.

---

## Forward compatibility

Protocol v1 consumers receiving a callback whose `action.type` is not one of the four v1 values MUST render a generic `message` error action. Concretely:

- The default-UI script's `renderAction(action)` function has a default branch that treats unknown `type` as a generic message error: `{ type: "message", title: "Something went wrong", body: "We couldn't route your request. Please try again in a moment." }`. Path 1 consumers (own UI) handle the unknown-type branch themselves.
- The server still parses the payload for structural validity; an unknown `type` trips the zod discriminated union and surfaces as `UNKNOWN_ACTION_TYPE`.
- v2 may add new action types. v1 consumers gracefully downgrade; v2+ consumers render them natively.

This rule makes the protocol additive — new action types do not require breaking v1 deployments.

### Versioning

- The protocol version is implicit in the deployed server. Callback payloads do NOT carry a `version` field (it would just be ignored by v1 consumers and introduce an upgrade ordering bug).
- When v2 lands, it will be a new document (`docs/protocol-v2.md`) and a new zod schema. v1 and v2 can coexist in the same server, selected by config.

### Unknown fields

Payload objects use `.strict()` parsing — extra unknown fields cause rejection. This forces integrations to ship cleanly against the versioned spec instead of piling on undocumented fields that later collide with v2 additions.

---

## Embed integration: events emitted by the core embed

The reference embed (`apps/server/public/embed/v1.js`) is event-driven.
It does the network round-trip and emits seven CustomEvents on the
attached form element. These are the contract between the core and any
UI layer (the bundled `v1-default-ui.js`, a host page's listeners,
React/Vue components, etc.).

| Event | Fires when | `event.detail` | Cancelable |
|-------|-----------|----------------|-----------|
| `greenware:submit`  | Form intercepted, BEFORE `/api/submit` is called | `{ lead, formId }` | YES — `preventDefault()` cancels Greenware's submit and lets the host take over |
| `greenware:processing` | Form locked and overlay mounted, before `/api/submit` returns | `{ formId }` | no |
| `greenware:wait`    | After successful POST `/api/submit`, before long-poll begins | `{ sessionId, readToken }` | no |
| `greenware:action`  | server returns `status: ready` | flat: `{ type, ...action fields }` | YES — `preventDefault()` cancels the core's default redirect on `type: "redirect"` |
| `greenware:error`   | Network error, malformed callback, signature mismatch — anything not happy-path | `{ errorCode, problem?, fix? }` | no |
| `greenware:expired` | server returned 404 / `status: expired` (TTL exceeded) | `{}` | no |
| `greenware:reset`   | Host code (or default UI's Try Again button) wants to clear the lock | `{}` | no |

All events `bubble: true`. Only `greenware:submit` and `greenware:action`
are cancelable. The core's default behaviours:
- `greenware:action` with `type: "redirect"` and a safe URL — executes
  `window.location.href = url` synchronously unless a listener calls
  `event.preventDefault()`. The default-UI script does exactly that so
  it can render a 600ms handoff card before navigating.
- `greenware:reset` — restores the form (removes the inert/aria-hidden
  lock, tears down the overlay container) so the user can submit again.

Error codes the core may emit on `greenware:error.detail.errorCode`:
- `NETWORK_ERROR` — fetch threw (offline, DNS, CORS preflight blocked).
- `SUBMIT_TIMEOUT` — `/api/submit` did not return within 15s.
- `SUBMIT_REJECTED` — `/api/submit` returned non-2xx.
- `CLIENT_TIMEOUT` — 60s elapsed without a terminal response.
- `SUBMIT_FAILED` — server returned `status: failed` with a specific `error_code` (passed through verbatim).
- `UNKNOWN_STATUS` — server returned a status field outside the v1 vocabulary.

Session-expired is its own `greenware:expired` event — host pages don't
need to pattern-match `errorCode === "SESSION_EXPIRED"`.

The full headless integration walkthrough lives in
[quickstart-headless.md](quickstart-headless.md).

## Implementation reference

The canonical zod schema lives at `apps/server/src/lib/protocol.ts` in this repository. That file is the source of truth for field types and refinements; this document is the source of truth for the intent and the renderer contract.

A payload is v1-valid iff `parseCallback(raw)` accepts it without throwing, AND the rendering rules above are honored by the consumer.
