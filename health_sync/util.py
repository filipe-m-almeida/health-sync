from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
import webbrowser
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import requests


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso_to_dt(s: str) -> datetime:
    # Handles common `...Z` strings.
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def dt_to_iso_z(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    dt = dt.astimezone(UTC).replace(microsecond=0)
    return dt.isoformat().replace("+00:00", "Z")


def date_to_str(d: datetime) -> str:
    return d.date().isoformat()


def parse_yyyy_mm_dd(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=UTC)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def hmac_sha256_hex(key: str, msg: str) -> str:
    return hmac.new(key.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def basic_auth_header(client_id: str, client_secret: str) -> str:
    b = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    return f"Basic {b}"


def request_json(
    session: requests.Session,
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
    timeout_s: int = 60,
    max_retries: int = 5,
) -> dict[str, Any]:
    headers = headers or {}
    params = params or {}

    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            resp = session.request(
                method,
                url,
                headers=headers,
                params=params,
                data=data,
                timeout=timeout_s,
            )
            if resp.status_code == 429:
                retry_after = resp.headers.get("Retry-After")
                sleep_s = int(retry_after) if retry_after and retry_after.isdigit() else (2**attempt)
                time.sleep(min(60, max(1, sleep_s)))
                continue
            if resp.status_code >= 500:
                time.sleep(min(60, 2**attempt))
                continue
            resp.raise_for_status()
            return resp.json()
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(min(60, 2**attempt))
            continue

    raise RuntimeError(f"HTTP request failed after {max_retries} attempts: {method} {url}") from last_err


@dataclass(frozen=True)
class OAuthResult:
    code: str
    state: str | None
    error: str | None


def oauth_listen_for_code(
    *,
    listen_host: str,
    listen_port: int,
    callback_path: str = "/callback",
    timeout_s: int = 300,
) -> OAuthResult:
    event = threading.Event()
    result: dict[str, Any] = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            # Keep CLI quiet.
            return

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != callback_path:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not found")
                return

            qs = parse_qs(parsed.query)
            result["code"] = (qs.get("code") or [None])[0]
            result["state"] = (qs.get("state") or [None])[0]
            result["error"] = (qs.get("error") or [None])[0]

            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Authorization received. You can close this tab/window and return to the terminal.\n")
            event.set()

    httpd = HTTPServer((listen_host, listen_port), Handler)

    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        ok = event.wait(timeout_s)
        if not ok:
            raise TimeoutError("Timed out waiting for OAuth redirect")
        code = result.get("code")
        if not code:
            return OAuthResult(code="", state=result.get("state"), error=result.get("error") or "missing_code")
        return OAuthResult(code=code, state=result.get("state"), error=result.get("error"))
    finally:
        httpd.shutdown()


def open_in_browser(url: str) -> None:
    # Best-effort; if this is a headless environment, user can manually copy/paste.
    try:
        webbrowser.open(url, new=1, autoraise=True)
    except Exception:  # noqa: BLE001
        pass


def getenv_required(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v


def getenv_default(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v else default

