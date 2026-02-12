from __future__ import annotations

import base64
import hashlib
import hmac
import json
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
    json_data: dict[str, Any] | None = None,
    timeout_s: int = 60,
    max_retries: int = 5,
) -> dict[str, Any]:
    headers = headers or {}
    params = params or {}
    if data is not None and json_data is not None:
        raise ValueError("request_json: pass only one of `data` or `json_data`")

    last_err: Exception | None = None
    for attempt in range(max_retries):
        resp: requests.Response | None = None
        try:
            resp = session.request(
                method,
                url,
                headers=headers,
                params=params,
                data=data,
                json=json_data,
                timeout=timeout_s,
            )
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(min(60, 2**attempt))
            continue

        # Retry only when it makes sense.
        if resp.status_code == 429:
            retry_after = resp.headers.get("Retry-After")
            sleep_s = int(retry_after) if retry_after and retry_after.isdigit() else (2**attempt)
            time.sleep(min(60, max(1, sleep_s)))
            continue
        if resp.status_code >= 500:
            time.sleep(min(60, 2**attempt))
            continue

        # Do not retry other 4xx: they're usually misconfiguration, bad params, or revoked scopes.
        if resp.status_code >= 400:
            trace_id = resp.headers.get("x-trace-id") or resp.headers.get("x-request-id")

            detail: str | None = None
            try:
                j = resp.json()
                if isinstance(j, dict):
                    # Common error shapes: {"error": "...", "error_description": "..."}, {"detail": "..."}
                    parts = []
                    for k in ("error", "error_description", "detail", "message"):
                        v = j.get(k)
                        if isinstance(v, str) and v.strip():
                            parts.append(f"{k}={v.strip()}")
                    detail = ", ".join(parts) if parts else json.dumps(j, ensure_ascii=True)
                else:
                    detail = json.dumps(j, ensure_ascii=True)
            except Exception:  # noqa: BLE001
                # Fall back to a small snippet of text/html (or plain text).
                detail = (resp.text or "").strip().replace("\n", " ")[:500] or None

            msg = f"HTTP {resp.status_code} for {method} {url}"
            if trace_id:
                msg += f" (trace_id={trace_id})"
            if detail:
                msg += f": {detail}"
            raise RuntimeError(msg)

        try:
            return resp.json()
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"Failed to parse JSON response for {method} {url}") from e

    raise RuntimeError(f"HTTP request failed after {max_retries} attempts: {method} {url}") from last_err


@dataclass(frozen=True)
class OAuthResult:
    code: str
    state: str | None
    error: str | None


def _oauth_result_from_paste(raw: str) -> OAuthResult | None:
    s = raw.strip()
    if not s:
        return None

    parsed_qs_values: list[dict[str, list[str]]] = []
    looks_structured = False
    if "://" in s:
        looks_structured = True
        u = urlparse(s)
        if u.query:
            parsed_qs_values.append(parse_qs(u.query, keep_blank_values=True))
        if u.fragment:
            parsed_qs_values.append(parse_qs(u.fragment, keep_blank_values=True))
    elif s.startswith("/"):
        looks_structured = True
        u = urlparse(s)
        if u.query:
            parsed_qs_values.append(parse_qs(u.query, keep_blank_values=True))
    elif s.startswith("?"):
        looks_structured = True
        parsed_qs_values.append(parse_qs(s[1:], keep_blank_values=True))
    elif "=" in s and ("&" in s or s.startswith(("code=", "state=", "error="))):
        looks_structured = True
        parsed_qs_values.append(parse_qs(s, keep_blank_values=True))

    for qs in parsed_qs_values:
        code = (qs.get("code") or [None])[0]
        state = (qs.get("state") or [None])[0]
        error = (qs.get("error") or [None])[0]
        if code is not None or state is not None or error is not None:
            return OAuthResult(code=code or "", state=state, error=error)

    if looks_structured:
        # User pasted URL/query-looking input but there was no recognizable OAuth field.
        return None

    # Fallback: treat paste as a raw code string.
    if any(ch.isspace() for ch in s):
        return None
    return OAuthResult(code=s, state=None, error=None)


def oauth_listen_for_code(
    *,
    listen_host: str,
    listen_port: int,
    callback_path: str = "/callback",
    timeout_s: int = 300,
) -> OAuthResult:
    event = threading.Event()
    result: dict[str, Any] = {}
    result_lock = threading.Lock()

    def _set_result(*, code: str | None, state: str | None, error: str | None) -> None:
        with result_lock:
            if event.is_set():
                return
            result["code"] = code
            result["state"] = state
            result["error"] = error
            event.set()

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
            _set_result(
                code=(qs.get("code") or [None])[0],
                state=(qs.get("state") or [None])[0],
                error=(qs.get("error") or [None])[0],
            )

            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Authorization received. You can close this tab/window and return to the terminal.\n")

    def _read_manual_input() -> None:
        while not event.is_set():
            try:
                raw = input()
            except EOFError:
                return
            except Exception:  # noqa: BLE001
                return

            parsed = _oauth_result_from_paste(raw)
            if parsed is None:
                print("Input did not contain a recognizable OAuth callback URL or code; still waiting...")
                continue
            _set_result(code=parsed.code, state=parsed.state, error=parsed.error)
            return

    httpd = HTTPServer((listen_host, listen_port), Handler)
    callback_port = int(httpd.server_address[1])

    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    t_stdin = threading.Thread(target=_read_manual_input, daemon=True)
    t_stdin.start()

    print(f"Waiting for OAuth redirect on http://{listen_host}:{callback_port}{callback_path}")
    print("You may also paste the final callback URL (or just the `code`) here and press Enter.")
    try:
        ok = event.wait(timeout_s)
        if not ok:
            raise TimeoutError("Timed out waiting for OAuth redirect or manual code input")
        code = result.get("code")
        if not code:
            return OAuthResult(code="", state=result.get("state"), error=result.get("error") or "missing_code")
        return OAuthResult(code=code, state=result.get("state"), error=result.get("error"))
    finally:
        httpd.shutdown()
        httpd.server_close()


def open_in_browser(url: str) -> None:
    # Best-effort; if this is a headless environment, user can manually copy/paste.
    try:
        webbrowser.open(url, new=1, autoraise=True)
    except Exception:  # noqa: BLE001
        pass
