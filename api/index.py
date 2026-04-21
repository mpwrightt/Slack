"""Slack Archive Curator — Vercel serverless entry point.

Vercel's @vercel/python runtime imports `app` from this module and serves
it as a WSGI application. This file is deliberately self-contained (no
imports from ../webapp) so the serverless deployment has minimal surface.

Routing on Vercel (see vercel.json):
    /api/slack/<method>  ->  this function (proxy to slack.com)
    /healthz             ->  this function (health check)
    /<anything else>     ->  public/ on the edge CDN

For local dev, see `python api/index.py` below or `vercel dev` from the
repo root (recommended, because it matches production routing).
"""

import os
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory

REPO_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = REPO_ROOT / "public"

ALLOWED_METHODS = frozenset({
    "auth.test",
    "conversations.list",
    "conversations.history",
    "conversations.replies",
    "conversations.info",
    "users.list",
    "users.info",
    "users.conversations",
})
VALID_TOKEN_PREFIXES = ("xoxp-", "xoxb-", "xoxe-", "xoxa-")

app = Flask(__name__)


@app.route("/api/slack/<method>", methods=["POST"])
def slack_proxy(method):
    """Forward one Slack Web API call on behalf of the browser.

    The user's token rides in the X-Slack-Token header. We never log it,
    never persist it, never echo it back. On 429 we forward Retry-After
    so the client's rate limiter can honor Slack's backoff.
    """
    if method not in ALLOWED_METHODS:
        return jsonify({"ok": False, "error": "method_not_allowed", "method": method}), 400

    token = (request.headers.get("X-Slack-Token") or "").strip()
    if not token:
        return jsonify({"ok": False, "error": "missing_token"}), 401
    if not token.startswith(VALID_TOKEN_PREFIXES):
        return jsonify({"ok": False, "error": "invalid_token_format"}), 401

    params = request.get_json(silent=True) or {}
    try:
        upstream = requests.post(
            f"https://slack.com/api/{method}",
            headers={"Authorization": f"Bearer {token}"},
            data=params,
            timeout=25,
        )
    except requests.exceptions.Timeout:
        return jsonify({"ok": False, "error": "upstream_timeout"}), 504
    except requests.exceptions.RequestException as exc:
        return jsonify({"ok": False, "error": "upstream_error", "detail": type(exc).__name__}), 502

    try:
        body = upstream.json()
    except ValueError:
        return jsonify({"ok": False, "error": "upstream_non_json", "status": upstream.status_code}), 502

    resp = jsonify(body)
    retry_after = upstream.headers.get("Retry-After")
    if retry_after:
        resp.headers["Retry-After"] = retry_after
    return resp, upstream.status_code


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


# -- local dev only --------------------------------------------------------
# Under Vercel, static assets are served from public/ by the edge CDN and
# never hit this function. Locally we mount them on Flask for convenience
# so `python api/index.py` gives a working end-to-end dev loop without
# requiring the `vercel` CLI.

@app.route("/")
def _local_index():
    return send_from_directory(str(PUBLIC_DIR), "index.html")


@app.route("/<path:filename>")
def _local_static(filename):
    # Guard against path traversal — send_from_directory does it, but be
    # extra explicit. This handler only fires locally because Vercel's
    # router rewrites non-api paths to /public/* before Python runs.
    return send_from_directory(str(PUBLIC_DIR), filename)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5173))
    print(f"Slack Archive Curator running at http://localhost:{port}")
    print("  This server is a stateless Slack API proxy. All scraping and")
    print("  storage happens in your browser. Your token is never persisted.")
    app.run(host="127.0.0.1", port=port, debug=True, use_reloader=False)
