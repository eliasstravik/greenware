#!/usr/bin/env python3
"""
Greenware — Local Python enrichment example.

A tiny HTTP server that plays the role of an enrichment service
(Clay / Clearbit / n8n / custom) for the Greenware server. Lets you
exercise the real server end-to-end — signed callback URLs, HMAC
verification, session state, Protocol v1 schema — without any
external SaaS.

Flow this script participates in:
  1. You POST to http://localhost:8787/api/submit with a lead.
  2. Greenware mints a session + signed callback URL and fire-and-forget
     POSTs the webhook body to this server at /webhook.
  3. This server picks an action type based on the lead's email domain.
  4. After a short delay, this server POSTs the Protocol v1 payload
     back to the signed callback URL.
  5. Browser (or curl) polls /api/session/:id and sees the action.

Requirements: Python 3.8+. Standard library only — no pip install.
Cross-platform: macOS, Linux, Windows.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, Optional


# --------------------------------------------------------------------------- #
# Configuration — constants + defaults. No secrets live here; the server
# owns the HMAC signing key, and this script just echoes back a URL it
# was given.
# --------------------------------------------------------------------------- #

DEFAULT_PORT = 8788
DEFAULT_DELAY_SECONDS = 4.0
DEFAULT_SERVER_URL = "http://localhost:8787"

# Domain rules. Tuples of (predicate-description, action-type).
PERSONAL_DOMAINS = frozenset(
    {"gmail.com", "hotmail.com", "yahoo.com", "outlook.com", "icloud.com"}
)
REJECTED_DOMAINS = frozenset({"example.com", "competitor.com"})
# Heuristic for "enterprise-y": corporate-sounding TLDs + known enterprise
# vendors. This is a stub; real enrichment (Clay / Apollo) would replace
# this with actual firmographic lookups.
ENTERPRISE_HINT_DOMAINS = frozenset(
    {
        "acme.com",
        "bigcorp.com",
        "enterprise.io",
        "corp.com",
        "contoso.com",
        "fabrikam.com",
    }
)

SOURCE_TAG = "python-enrich-example"


# --------------------------------------------------------------------------- #
# Action-builders. Each returns the `action` sub-object of a Protocol v1
# callback payload. The full callback body is assembled in `send_callback`.
# --------------------------------------------------------------------------- #


def build_action(lead: Dict[str, Any]) -> Dict[str, Any]:
    """Decide what action type to return based on the lead's email
    domain. Returns the `action` object from Protocol v1."""
    email = str(lead.get("email") or "").lower().strip()
    domain = email.rsplit("@", 1)[-1] if "@" in email else ""

    if domain in PERSONAL_DOMAINS:
        return {
            "type": "message",
            "title": "Thanks, we'll be in touch",
            "body": (
                "Personal email addresses get a reply by email. "
                "We'll route you to the right team within one business day."
            ),
        }

    if domain in REJECTED_DOMAINS:
        return {
            "type": "reject",
            "reason": (
                "Thanks for your interest — we're not the right fit right now."
            ),
            "alternative": {
                "label": "Join our community",
                "url": "https://your-product.com/community",
            },
        }

    if domain in ENTERPRISE_HINT_DOMAINS:
        return {
            "type": "embed",
            "provider": "cal",
            "url": "https://cal.com/demo",
            "mobile_behavior": "redirect",
        }

    # Default: treat as SMB-ish signup.
    return {
        "type": "redirect",
        "url": "https://your-product.com/signup?utm_source=greenware",
    }


# --------------------------------------------------------------------------- #
# Callback POST — fired after a configurable delay. Uses urllib so the
# script has zero external deps.
# --------------------------------------------------------------------------- #


def send_callback(callback_url: str, session_id: str, action: Dict[str, Any]) -> None:
    """POST the Protocol v1 payload to `callback_url`. The URL already
    carries the signed sig/exp/nonce/kid query params — we send it
    verbatim and let the server verify."""
    payload = {
        "session_id": session_id,
        "status": "ok",
        "action": action,
        "meta": {
            "enriched_at": datetime.now(timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"),
            "source": SOURCE_TAG,
        },
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url=callback_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"greenware-example/{SOURCE_TAG}",
        },
    )
    print(f"[callback] POST {_redact_sig(callback_url)}")
    print(f"[callback] action.type={action.get('type')}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.status
            resp_body = resp.read().decode("utf-8", errors="replace")
            print(f"[callback] -> {status} {resp_body.strip()[:200]}")
    except urllib.error.HTTPError as e:
        # Greenware responded with 4xx/5xx — log body for debugging.
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        print(
            f"[callback] !! HTTP {e.code} from Greenware: {err_body.strip()[:400]}",
            file=sys.stderr,
        )
    except urllib.error.URLError as e:
        print(f"[callback] !! network error: {e.reason}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001 — last-ditch logging
        print(f"[callback] !! unexpected error: {e!r}", file=sys.stderr)


def _redact_sig(url: str) -> str:
    """Shorten the sig query param in logs so long lines stay readable
    but the rest of the URL (including session_id path segment) is
    still visible for debugging."""
    if "sig=" not in url:
        return url
    before, sep, after = url.partition("sig=")
    end = after.find("&")
    sig = after if end == -1 else after[:end]
    tail = "" if end == -1 else after[end:]
    short = sig[:8] + "..." if len(sig) > 12 else sig
    return f"{before}{sep}{short}{tail}"


# --------------------------------------------------------------------------- #
# HTTP handler. Only POST /webhook is meaningful; everything else 404s.
# --------------------------------------------------------------------------- #


class EnrichmentHandler(BaseHTTPRequestHandler):
    # Populated by the serve() factory before the server starts.
    delay_seconds: float = DEFAULT_DELAY_SECONDS

    # Suppress the default access-log format; we roll our own so stdout
    # reads uniformly.
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def _send_json(self, status: int, body: Dict[str, Any]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler API
        # Friendly landing for curl / browser checks.
        if self.path in ("/", "/healthz"):
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": SOURCE_TAG,
                    "message": "POST /webhook with a Greenware submit body.",
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler API
        if self.path != "/webhook":
            self._send_json(404, {"ok": False, "error": "not_found"})
            return

        length_header = self.headers.get("Content-Length")
        try:
            length = int(length_header) if length_header else 0
        except ValueError:
            self._send_json(400, {"ok": False, "error": "bad_content_length"})
            return

        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            self._send_json(400, {"ok": False, "error": f"bad_json: {e}"})
            return

        if not isinstance(body, dict):
            self._send_json(400, {"ok": False, "error": "body must be an object"})
            return

        session_id = body.get("session_id")
        callback_url = body.get("callback_url")
        lead = body.get("lead") or {}
        form_id = body.get("form_id")

        if not isinstance(session_id, str) or not isinstance(callback_url, str):
            self._send_json(
                400,
                {
                    "ok": False,
                    "error": "missing session_id or callback_url",
                },
            )
            return
        if not isinstance(lead, dict):
            self._send_json(400, {"ok": False, "error": "lead must be an object"})
            return

        # Decide the action up front. Cheap and lets the log line make
        # it obvious what the script is going to do.
        action = build_action(lead)

        email = str(lead.get("email") or "(no email)")
        print("--")
        print(f"[webhook] session_id={session_id}")
        if form_id:
            print(f"[webhook] form_id={form_id}")
        print(f"[webhook] lead.email={email}")
        print(f"[webhook] decided action.type={action['type']} (delay={self.delay_seconds}s)")

        # Schedule the callback POST. threading.Timer fires on a one-shot
        # daemon thread — no thread pool, no state to manage. The HTTP
        # response is returned immediately (the server's waitUntil is
        # fire-and-forget anyway).
        timer = threading.Timer(
            self.delay_seconds, send_callback, args=(callback_url, session_id, action)
        )
        timer.daemon = True
        timer.start()

        self._send_json(
            202,
            {
                "ok": True,
                "session_id": session_id,
                "action_type": action["type"],
                "will_callback_in_seconds": self.delay_seconds,
            },
        )


# --------------------------------------------------------------------------- #
# Server lifecycle. Handle Ctrl-C gracefully.
# --------------------------------------------------------------------------- #


class _ThreadingHTTPServer(HTTPServer):
    """Single-threaded HTTPServer is fine here — each request just
    schedules a Timer and returns. We don't need ThreadingMixIn."""

    daemon_threads = True


def serve(port: int, delay_seconds: float, server_url: str) -> None:
    EnrichmentHandler.delay_seconds = delay_seconds

    server = _ThreadingHTTPServer(("127.0.0.1", port), EnrichmentHandler)

    def _graceful_shutdown(signum: int, frame: Optional[Any]) -> None:
        del signum, frame
        print("\n[server] shutting down...")
        # server.shutdown() from a signal handler inside serve_forever
        # blocks; schedule it on a thread so the main loop can exit.
        threading.Thread(target=server.shutdown, daemon=True).start()

    # SIGTERM isn't delivered on Windows; register it only when available.
    signal.signal(signal.SIGINT, _graceful_shutdown)
    if hasattr(signal, "SIGTERM"):
        try:
            signal.signal(signal.SIGTERM, _graceful_shutdown)
        except (ValueError, OSError):
            # Some platforms (or non-main threads) reject this; ignore.
            pass

    _print_banner(port=port, delay_seconds=delay_seconds, server_url=server_url)

    try:
        server.serve_forever()
    finally:
        server.server_close()
        print("[server] stopped.")


def _print_banner(port: int, delay_seconds: float, server_url: str) -> None:
    bar = "=" * 72
    print(bar)
    print("  Greenware — local Python enrichment example")
    print(bar)
    print(f"  Listening on http://127.0.0.1:{port}/webhook")
    print(f"  Callback delay: {delay_seconds:g}s")
    print(f"  Expecting Greenware server at {server_url}")
    print()
    print("  Domain routing rules:")
    print("    @gmail.com / @hotmail.com / @yahoo.com / ... -> message")
    print("    @example.com / @competitor.com              -> reject")
    print("    @acme.com / @bigcorp.com / @contoso.com ... -> embed (Cal.com)")
    print("    anything else                               -> redirect")
    print()
    print("  IMPORTANT: Greenware must point its enrichment webhook at")
    print(f"  http://localhost:{port}/webhook for this to work.")
    print()
    print("  Set this in apps/server/.env for local development:")
    print(
        "    GREENWARE_DESTINATIONS="
        f"'{{\"default\":{{\"webhook_url\":\"http://localhost:{port}/webhook\"}}}}'"
    )
    print()
    print("  Try it with curl (two terminals: Greenware + this script):")
    print(
        f"    curl -X POST {server_url}/api/submit \\\n"
        "         -H 'Content-Type: application/json' \\\n"
        "         -H 'Origin: https://yourcompany.com' \\\n"
        "         -d '{\"lead\":{\"email\":\"alice@acme.com\"}}'"
    )
    print()
    print("  Then poll the session (swap in the returned session_id + read_token):")
    print(
        f"    curl {server_url}/api/session/<SESSION_ID> \\\n"
        "         -H 'Origin: https://yourcompany.com' \\\n"
        "         -H 'Authorization: Bearer <READ_TOKEN>'"
    )
    print(bar)
    print("  Ready. Waiting for webhook POSTs. (Ctrl-C to quit.)")
    print(bar, flush=True)


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Local Greenware enrichment mock (Protocol v1).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Port to listen on (default: {DEFAULT_PORT}).",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY_SECONDS,
        help=(
            f"Seconds to wait before POSTing the callback "
            f"(default: {DEFAULT_DELAY_SECONDS:g})."
        ),
    )
    parser.add_argument(
        "--server-url",
        default=DEFAULT_SERVER_URL,
        help=f"Greenware server base URL (default: {DEFAULT_SERVER_URL}).",
    )
    args = parser.parse_args(argv)

    if args.delay < 0:
        print("--delay must be >= 0", file=sys.stderr)
        return 2

    try:
        serve(port=args.port, delay_seconds=args.delay, server_url=args.server_url)
    except OSError as e:
        print(f"[server] failed to bind :{args.port}: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
