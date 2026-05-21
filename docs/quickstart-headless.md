# Greenware quickstart — headless (Path 1)

This is for teams that already have a design system and want Greenware
purely as the routing brain — submit, wait, decide, act — with the
rendering left to your own components.

If you'd rather drop a snippet and get a working form right now, see
[quickstart-from-zero.md](quickstart-from-zero.md). Both paths share the
same server, same protocol, same network round-trip — only the
client-side rendering differs.

## What you give up vs. Path 2

- The default morph animation (spinner card → action card with a 600ms
  redirect handoff).
- The motion spec (eased entry/exit, dot animation, prefers-reduced-motion
  defaults).
- Brand polish — green (#10b981) accent, system font, shadow stack.

## What you gain

- Full design control. Your spinner, your status copy, your action cards.
- Smaller payload — only the core script (~290 LOC vs. ~890 LOC combined).
- Native integration with your design system — pass payloads to your
  existing components instead of fighting Greenware's CSS.

## Greenware events API

The core embed (`/embed/v1.js`) emits seven CustomEvents on the form
element. All bubble; only `greenware:submit` and `greenware:action`
are cancelable. You can listen on the form, on `document`, or anywhere
in between.

| Event | When | Payload (`event.detail`) | Cancelable |
|-------|------|-------------------------|-----------|
| `greenware:submit`  | Form intercepted, BEFORE `/api/submit` is called | `{ lead, formId }` | YES |
| `greenware:processing` | Form locked and overlay mounted, before `/api/submit` returns | `{ formId }` | no |
| `greenware:wait`    | After `/api/submit` returns 200, before long-poll begins | `{ sessionId, readToken }` | no |
| `greenware:action`  | server returns `status: ready` | `{ type, ...action-specific fields }` | YES |
| `greenware:error`   | Network error, malformed callback, signature mismatch, etc. | `{ errorCode, problem?, fix? }` | no |
| `greenware:expired` | server returned 404 or `status: expired` (TTL exceeded) | `{}` | no |
| `greenware:reset`   | Host emits this to clear the lock and let the user start over | `{}` | no |

`greenware:submit.detail.lead` is the FormData-extracted object the
embed is about to POST. Mutate it in your handler if you need to
massage values before they hit the wire, or call `preventDefault()`
to take over the network call entirely.

`action.type` is one of `redirect | embed | message | reject`. Field
shapes match the protocol v1 callback payload — see
[protocol-v1.md](protocol-v1.md) for the full schema.

`error.errorCode` is one of:
- `NETWORK_ERROR` — fetch failed (offline, DNS, CORS, etc.)
- `SUBMIT_TIMEOUT` — `/api/submit` did not return within 15s
- `SUBMIT_REJECTED` — `/api/submit` returned non-2xx (origin denied, rate-limited, malformed payload, etc.). When present, `problem` and `fix` strings are forwarded from the server's error body.
- `CLIENT_TIMEOUT` — 60s elapsed without a terminal response
- `SUBMIT_FAILED` — server returned `status: failed` with a specific error_code (passed through verbatim)
- `UNKNOWN_STATUS` — server returned an unrecognized status field

Session-expired is its own `greenware:expired` event — host pages
don't need to pattern-match `errorCode === "SESSION_EXPIRED"`.

### Default behaviour

If you do nothing, the core embed will:

- On submit: emit `greenware:submit`, lock the form via `inert` + `aria-hidden` + `pointer-events: none`, mount an empty `<div data-greenware-overlay>` over the form, then emit `greenware:processing` immediately so UI can show a spinner before `/api/submit` returns.
- On `redirect` action: `window.location.href = url` synchronously. To suppress this and render your own handoff, call `event.preventDefault()` in your `greenware:action` listener.
- On `embed` / `message` / `reject` actions: emit the event, do nothing visual. Your listener owns rendering.
- On error before the wait started (NETWORK_ERROR / SUBMIT_REJECTED): emit the event, restore the form so the user can retry.
- On error after the wait started, on `greenware:expired`, or on a successful action: emit the event and leave the form locked + the overlay mounted. Emit `greenware:reset` from your code to clear it.

## Vanilla JS example

Bare minimum — about 30 lines of JS that listens to the events and
renders into a `<div>`.

```html
<!doctype html>
<form data-greenware-attach data-greenware-endpoint="https://your-app.up.railway.app">
  <input name="email" type="email" required>
  <button>Submit</button>
</form>

<div id="status" role="status" aria-live="polite"></div>

<script src="https://your-app.up.railway.app/embed/v1.js"></script>
<script>
  const form = document.querySelector("[data-greenware-attach]");
  const out = document.getElementById("status");
  const show = (msg) => { out.textContent = msg; };

  form.addEventListener("greenware:processing", () => show("Looking you up..."));

  form.addEventListener("greenware:action", (e) => {
    e.preventDefault();              // suppress core's default redirect
    if (e.detail.type === "redirect") {
      show(`Taking you to ${e.detail.url}…`);
      setTimeout(() => location.href = e.detail.url, 600);
    } else if (e.detail.type === "message") {
      show(e.detail.title + ": " + e.detail.body);
    } else if (e.detail.type === "embed") {
      const f = document.createElement("iframe");
      f.src = e.detail.url;
      f.sandbox = "allow-scripts allow-forms allow-same-origin";
      f.style.cssText = "width:100%;min-height:600px;border:0";
      out.replaceChildren(f);
    } else if (e.detail.type === "reject") {
      show(e.detail.reason);
    }
  });

  form.addEventListener("greenware:error", (e) => {
    show("Something went wrong: " + e.detail.errorCode);
  });

  form.addEventListener("greenware:expired", () => {
    show("Session expired — submit again.");
  });
</script>
```

Greenware does not serve hosted HTML examples in production. Keep this
snippet in your own app or website and point it at your Greenware backend.

## React example

Same idea via a `useState` hook driven by event listeners.

```html
<!doctype html>
<form data-greenware-attach data-greenware-endpoint="https://your-app.up.railway.app">
  <input name="email" type="email" required>
  <button>Submit</button>
</form>

<div id="root"></div>

<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://your-app.up.railway.app/embed/v1.js"></script>

<script>
  const e = React.createElement;

  function Status() {
    const [state, setState] = React.useState({ phase: "idle" });

    React.useEffect(() => {
      const form = document.querySelector("[data-greenware-attach]");
      const onProcessing = () => setState({ phase: "wait" });
      const onWait = () => setState({ phase: "wait" });
      const onAction = (ev) => { ev.preventDefault(); setState({ phase: "action", action: ev.detail }); };
      const onError = (ev) => setState({ phase: "error", code: ev.detail.errorCode });
      const onExpired = () => setState({ phase: "expired" });
      form.addEventListener("greenware:processing", onProcessing);
      form.addEventListener("greenware:wait", onWait);
      form.addEventListener("greenware:action", onAction);
      form.addEventListener("greenware:error", onError);
      form.addEventListener("greenware:expired", onExpired);
      return () => {
        form.removeEventListener("greenware:processing", onProcessing);
        form.removeEventListener("greenware:wait", onWait);
        form.removeEventListener("greenware:action", onAction);
        form.removeEventListener("greenware:error", onError);
        form.removeEventListener("greenware:expired", onExpired);
      };
    }, []);

    if (state.phase === "idle") return null;
    if (state.phase === "wait") return e("p", null, "Looking you up...");
    if (state.phase === "expired") return e("p", null, "Session expired.");
    if (state.phase === "error") return e("p", null, "Error: " + state.code);
    if (state.action.type === "message") return e("p", null, state.action.title);
    if (state.action.type === "redirect") {
      setTimeout(() => (window.location.href = state.action.url), 600);
      return e("p", null, "Taking you to " + state.action.url);
    }
    return e("p", null, JSON.stringify(state.action));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(e(Status));
</script>
```

Greenware does not serve hosted React examples in production. Keep this
component in your own app and point it at your Greenware backend.

## Provider / iframe forms

Headless provider flows use the same events, but you start the session before
the provider form submits:

```html
<div id="provider-slot"></div>
<script src="https://your-app.up.railway.app/embed/v1.js"></script>
<script>
  const endpoint = "https://your-app.up.railway.app";
  const slot = document.getElementById("provider-slot");

  const session = await Greenware.startSession({
    endpoint,
    provider: "typeform",
    formId: "enterprise-demo"
  });

  // Pass these into Typeform/Tally as hidden fields.
  console.log(session.hidden_fields);

  // When the provider submit event fires, wait against the same session.
  slot.setAttribute("data-greenware-provider", "typeform");
  Greenware.waitForSession(slot, session, { endpoint });

  slot.addEventListener("greenware:action", (event) => {
    event.preventDefault();
    console.log("route", event.detail);
  });
</script>
```

Provider webhook URLs:

```text
https://your-app.up.railway.app/api/ingest/typeform
https://your-app.up.railway.app/api/ingest/tally
https://your-app.up.railway.app/api/ingest/generic
```

Provider webhooks are authenticated by the per-session `greenware_read_token` hidden field. No global webhook token is required for Tally, Typeform, or generic provider ingest.

## Endpoint-self-discovery tip

When the server serves the page (e.g. via `bun run dev` or a deployed
hostname), you can omit `data-greenware-endpoint` and stamp it from JS
right before the embed boots. Both `/examples/*` files use this pattern:

```html
<script>
  const f = document.querySelector("form[data-greenware-attach]");
  if (f && !f.hasAttribute("data-greenware-endpoint")) {
    f.setAttribute("data-greenware-endpoint", window.location.origin);
  }
</script>
```

## Troubleshooting Path 1 specifically

- **No events fire after submit.** The form is missing `data-greenware-attach` — without it the core won't bind. Adding the attribute is what makes a form Greenware-managed.
- **Redirect navigates before my handoff card appears.** Call `event.preventDefault()` inside your `greenware:action` handler. Otherwise the core's default behaviour kicks in synchronously and the page navigates immediately.
- **My form re-enables itself after a network error.** That's by design — `NETWORK_ERROR` and `SUBMIT_REJECTED` errors restore the form so the user can correct + retry. Other terminal states (successful action, expired, mid-wait error) intentionally leave the form locked; emit `greenware:reset` from your code to clear it.
