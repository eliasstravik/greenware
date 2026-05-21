import { Hono } from "hono";
import type { AppBindings } from "../types";

export function waitRoute(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get("/wait/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId") ?? "";
    const readToken = c.req.query("read_token") ?? "";
    const nonce = crypto.randomUUID().replace(/-/g, "");
    return new Response(renderWaitPage(sessionId, readToken, nonce), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          "style-src 'unsafe-inline'",
          "connect-src 'self'",
          "frame-src https:",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "),
      },
    });
  });

  return app;
}

function renderWaitPage(sessionId: string, readToken: string, nonce: string): string {
  const sessionJson = htmlSafeJson(sessionId);
  const tokenJson = htmlSafeJson(readToken);
  const sessionPath = `/api/session/${escapeHtml(sessionId)}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Greenware Routing</title>
  <style>
    :root{color-scheme:light;--ink:#17211d;--muted:#66736c;--line:#d9e0da;--green:#17684a;--soft:#e7f4ee}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfcfa;color:var(--ink);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(560px,calc(100vw - 32px));background:white;border:1px solid var(--line);border-radius:12px;padding:28px;box-shadow:0 18px 44px rgba(23,33,29,.08)}
    h1{margin:0 0 8px;font-size:28px;line-height:1.1;letter-spacing:0}
    p{margin:0;color:var(--muted)}
    .spinner{width:36px;height:36px;border:3px solid #cfe3d8;border-top-color:var(--green);border-radius:50%;animation:spin 1s linear infinite;margin-bottom:18px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .card{display:grid;gap:12px}
    .cta{display:inline-block;margin-top:8px;padding:11px 16px;border-radius:8px;background:var(--green);color:white;text-decoration:none;font-weight:700}
    iframe{width:100%;min-height:520px;border:0;border-radius:8px;background:white}
    code{background:#f3f6f2;border:1px solid var(--line);border-radius:6px;padding:2px 6px}
  </style>
</head>
<body>
  <main id="app">
    <div class="spinner" aria-hidden="true"></div>
    <h1>Routing your request</h1>
    <p>Greenware is waiting for enrichment to finish, then this page will update automatically.</p>
    <p style="margin-top:12px"><code>${sessionPath}</code></p>
  </main>
  <script nonce="${nonce}">
    const sessionId = ${sessionJson};
    const initialReadToken = ${tokenJson};
    const readToken = initialReadToken || new URLSearchParams((location.hash || "").replace(/^#/, "")).get("read_token") || "";
    const app = document.getElementById("app");
    const endpoint = "/api/session/" + encodeURIComponent(sessionId) + "?wait=1";

    function safeUrl(url) {
      try { return new URL(url).protocol === "https:"; } catch (_) { return false; }
    }

    function text(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch];
      });
    }

    function render(action) {
      if (!action || typeof action !== "object") {
        app.innerHTML = "<h1>Something went wrong</h1><p>The routing action was missing.</p>";
        return;
      }
      if (action.type === "redirect" && safeUrl(action.url)) {
        app.innerHTML = "<h1>Sending you to the right place</h1><p>Redirecting now.</p>";
        setTimeout(function(){ location.href = action.url; }, 500);
        return;
      }
      if (action.type === "embed" && safeUrl(action.url)) {
        app.innerHTML = "<h1>Pick a time</h1><p>Your route is ready.</p><iframe title='Scheduling widget' sandbox='allow-scripts allow-forms allow-same-origin' src='" + text(action.url) + "'></iframe>";
        return;
      }
      if (action.type === "message") {
        var cta = action.cta && safeUrl(action.cta.url)
          ? "<a class='cta' href='" + text(action.cta.url) + "'>" + text(action.cta.label || "Continue") + "</a>"
          : "";
        app.innerHTML = "<h1>" + text(action.title || "Thanks") + "</h1><p>" + text(action.body || "We will be in touch.") + "</p>" + cta;
        return;
      }
      if (action.type === "reject") {
        var alt = action.alternative && safeUrl(action.alternative.url)
          ? "<a class='cta' href='" + text(action.alternative.url) + "'>" + text(action.alternative.label || "Learn more") + "</a>"
          : "";
        app.innerHTML = "<h1>Thanks for your interest</h1><p>" + text(action.reason || "We are not the right fit right now.") + "</p>" + alt;
        return;
      }
      app.innerHTML = "<h1>Unsupported route</h1><p>The callback returned an action this wait page does not understand.</p>";
    }

    async function poll() {
      if (!readToken) {
        app.innerHTML = "<h1>Missing read token</h1><p>The provider redirect must include <code>read_token</code>.</p>";
        return;
      }
      try {
        const res = await fetch(endpoint, { headers: { Authorization: "Bearer " + readToken }, credentials: "omit" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const body = await res.json();
        if (body.status === "ready") { render(body.action); return; }
        if (body.status === "failed") {
          app.innerHTML = "<h1>Routing failed</h1><p>Error code: " + text(body.error_code || "UNKNOWN") + "</p>";
          return;
        }
        if (body.status === "expired") {
          app.innerHTML = "<h1>Session expired</h1><p>Please submit the form again.</p>";
          return;
        }
      } catch (_) {}
      setTimeout(poll, 1000);
    }
    poll();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function htmlSafeJson(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => {
    switch (ch) {
      case "<":
        return "\\u003C";
      case ">":
        return "\\u003E";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return ch;
    }
  });
}
