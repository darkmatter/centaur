"""Standalone auth service for nginx auth_request.

Handles password-based session authentication.  Replace this container with
oauth2-proxy (or any OIDC provider) when upgrading to Okta / SSO.

Endpoints
---------
GET  /login       — render login form
POST /login       — validate password, set session cookie
GET  /logout      — clear session cookie
GET  /auth/check  — 200 if valid session, 401 otherwise (nginx auth_request)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import sys
from datetime import datetime, timezone
from urllib.parse import quote
from urllib.request import Request as URLRequest
from urllib.request import urlopen


class _JsonFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "service": "auth",
            "event": getattr(record, "event", record.funcName or record.name),
            "msg": record.getMessage(),
        }, default=str)


_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(_JsonFormatter())
log = logging.getLogger("auth")
log.handlers = [_handler]
log.setLevel(logging.INFO)
log.propagate = False

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response
from starlette.routing import Route

_SECRET_MANAGER_URL = os.environ.get("SECRET_MANAGER_URL", "http://secrets:8100")


def _fetch_secret(key: str) -> str:
    """Fetch a secret from the secret manager. Returns empty string on failure."""
    if not _SECRET_MANAGER_URL:
        return ""
    try:
        req = URLRequest(f"{_SECRET_MANAGER_URL}/secrets/{quote(key, safe='')}")
        with urlopen(req, timeout=5) as resp:
            if resp.status == 200:
                return _json.loads(resp.read()).get("value", "")
    except Exception:
        pass
    return ""


_PASSWORD = _fetch_secret("UI_PASSWORD")
_SECRET_KEY = _fetch_secret("API_SECRET_KEY")
_COOKIE_NAME = "paradigm_ui_session"
_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days
_COOKIE_SECURE = os.environ.get("AUTH_COOKIE_INSECURE", "") != "1"

if not _SECRET_KEY and _PASSWORD:
    log.critical("API_SECRET_KEY is required when UI_PASSWORD is set", extra={"event": "startup_misconfig"})
    sys.exit(1)


def _make_token() -> str:
    if not _PASSWORD:
        return ""
    return hmac.new(_SECRET_KEY.encode(), _PASSWORD.encode(), hashlib.sha256).hexdigest()


def _check_auth(request: Request) -> bool:
    if not _PASSWORD:
        # Fail closed: no password configured means secrets are unavailable.
        # Never allow unauthenticated access.
        return False

    # Check Bearer token first (API_SECRET_KEY)
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer ") and _SECRET_KEY:
        bearer = auth_header[7:]
        if secrets.compare_digest(bearer, _SECRET_KEY):
            return True

    # Fall back to session cookie
    token = request.cookies.get(_COOKIE_NAME, "")
    if not token:
        return False
    return secrets.compare_digest(token, _make_token())


# ---------------------------------------------------------------------------
# Login page HTML (self-contained, no external assets)
# ---------------------------------------------------------------------------
_LOGIN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Paradigm AI — Login</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
        rel="stylesheet"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #09090b;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #e4e4e7;
    }
    .card {
      width: 100%%;
      max-width: 380px;
      padding: 2.5rem 2rem;
      background: #111113;
      border: 1px solid #1c1c1e;
      border-radius: 12px;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      color: #fafafa;
      margin-bottom: 0.375rem;
      letter-spacing: -0.02em;
    }
    .subtitle {
      font-size: 0.8125rem;
      color: #52525b;
      margin-bottom: 1.75rem;
    }
    label {
      display: block;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #52525b;
      margin-bottom: 0.5rem;
    }
    input {
      width: 100%%;
      padding: 0.625rem 0.875rem;
      background: #09090b;
      border: 1px solid #27272a;
      border-radius: 8px;
      color: #e4e4e7;
      font-size: 0.875rem;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus {
      border-color: #3f3f46;
    }
    button {
      width: 100%%;
      margin-top: 1.25rem;
      padding: 0.625rem;
      background: #fafafa;
      color: #09090b;
      border: none;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.9; }
    .error {
      margin-top: 1rem;
      padding: 0.5rem 0.75rem;
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.15);
      border-radius: 8px;
      font-size: 0.8125rem;
      color: #fca5a5;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Paradigm AI</h1>
    <p class="subtitle">Enter the password to view agent threads</p>
    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password"
             placeholder="••••••••" autofocus autocomplete="current-password"/>
      <button type="submit">Continue</button>
      %(error_html)s
    </form>
  </div>
</body>
</html>"""


async def login_page(request: Request) -> Response:
    if _check_auth(request):
        return RedirectResponse("/", status_code=302)
    error = request.query_params.get("error", "")
    error_html = '<div class="error">Invalid password</div>' if error else ""
    return HTMLResponse(_LOGIN_HTML % {"error_html": error_html})


async def login_submit(request: Request) -> Response:
    form = await request.form()
    password = str(form.get("password", ""))

    if not _PASSWORD:
        # Secrets unavailable — cannot validate password. Show error.
        return RedirectResponse("/login?error=1", status_code=303)

    if not secrets.compare_digest(password, _PASSWORD):
        return RedirectResponse("/login?error=1", status_code=303)

    response = RedirectResponse("/", status_code=303)
    response.set_cookie(
        _COOKIE_NAME,
        _make_token(),
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite="lax",
    )
    return response


async def logout(request: Request) -> Response:
    response = RedirectResponse("/login", status_code=302)
    response.delete_cookie(_COOKIE_NAME)
    return response


async def auth_check(request: Request) -> Response:
    """Return 200 + X-Auth-User header if authenticated, 401 otherwise."""
    if _check_auth(request):
        return Response(status_code=200, headers={"X-Auth-User": "authenticated"})
    return Response(status_code=401)


routes = [
    Route("/login", login_page, methods=["GET"]),
    Route("/login", login_submit, methods=["POST"]),
    Route("/logout", logout, methods=["GET"]),
    Route("/auth/check", auth_check, methods=["GET"]),
]

app = Starlette(routes=routes)
