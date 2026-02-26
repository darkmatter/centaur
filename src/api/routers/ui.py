"""UI proxy — serves the thread viewer from the slackbot Next.js app behind a password."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets

import httpx
import structlog
from fastapi import APIRouter, Request
from starlette.responses import HTMLResponse, RedirectResponse, Response

from shared.config import settings

log = structlog.get_logger()

router = APIRouter(tags=["ui"])

_SLACKBOT_URL = os.environ.get("SLACKBOT_URL", "http://localhost:3001")
_COOKIE_NAME = "tempo_ui_session"
_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def _make_token() -> str:
    """Create a session token from the UI password."""
    key = (settings.api_secret_key or "tempo-ui-key").encode()
    return hmac.new(key, settings.ui_password.encode(), hashlib.sha256).hexdigest()


def _check_auth(request: Request) -> bool:
    """Check if the request has a valid session cookie."""
    if not settings.ui_password:
        return True  # No password configured, allow all
    token = request.cookies.get(_COOKIE_NAME, "")
    if not token:
        return False
    return secrets.compare_digest(token, _make_token())


_LOGIN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Tempo AI — Login</title>
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
    <h1>Tempo AI</h1>
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


@router.get("/login")
async def login_page(request: Request):
    """Serve the login form."""
    if _check_auth(request):
        return RedirectResponse("/threads", status_code=302)
    error = request.query_params.get("error", "")
    error_html = '<div class="error">Invalid password</div>' if error else ""
    return HTMLResponse(_LOGIN_HTML % {"error_html": error_html})


@router.post("/login")
async def login_submit(request: Request):
    """Validate password and set session cookie."""
    form = await request.form()
    password = str(form.get("password", ""))

    if not settings.ui_password:
        return RedirectResponse("/threads", status_code=302)

    if not secrets.compare_digest(password, settings.ui_password):
        return RedirectResponse("/login?error=1", status_code=303)

    response = RedirectResponse("/threads", status_code=303)
    response.set_cookie(
        _COOKIE_NAME,
        _make_token(),
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        secure=True,
        samesite="lax",
    )
    return response


@router.get("/logout")
async def logout():
    """Clear session cookie."""
    response = RedirectResponse("/login", status_code=302)
    response.delete_cookie(_COOKIE_NAME)
    return response
