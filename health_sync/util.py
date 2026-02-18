from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
import warnings
import webbrowser
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import requests


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso_to_dt(s: str) -> datetime:
    return datetime.fromisoformat(s[:-1] + "+00:00" if s.endswith("Z") else s)


def dt_to_iso_z(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def to_epoch_seconds(v: object) -> int | None:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    if isinstance(v, datetime):
        return int((v if v.tzinfo else v.replace(tzinfo=UTC)).astimezone(UTC).timestamp())

    s = str(v).strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    try:
        if len(s) == 10 and s[4:5] == "-" and s[7:8] == "-":
            return int(parse_yyyy_mm_dd(s).timestamp())
        return int(iso_to_dt(s).timestamp())
    except Exception:  # noqa: BLE001
        return None


def parse_yyyy_mm_dd(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=UTC)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def hmac_sha256_hex(key: str, msg: str) -> str:
    return hmac.new(key.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def basic_auth_header(client_id: str, client_secret: str) -> str:
    return f"Basic {base64.b64encode(f'{client_id}:{client_secret}'.encode('utf-8')).decode('ascii')}"


def _parse_retry_after_seconds(v: str | None) -> int | None:
    if not v or not v.strip():
        return None
    s = v.strip()
    if s.isdigit():
        return max(1, int(s))
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError, OverflowError):
        warnings.warn(
            f"Could not parse Retry-After header value {s!r}; using exponential backoff.",
            RuntimeWarning,
            stacklevel=2,
        )
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return max(1, int((dt.astimezone(UTC) - datetime.now(UTC)).total_seconds()))


def _error_detail(resp: requests.Response) -> str | None:
    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return (resp.text or "").strip().replace("\n", " ")[:500] or None
    if isinstance(payload, dict):
        parts = [
            f"{k}={v.strip()}"
            for k in ("error", "error_description", "detail", "message")
            if isinstance((v := payload.get(k)), str) and v.strip()
        ]
        return ", ".join(parts) if parts else json.dumps(payload, ensure_ascii=True)
    return json.dumps(payload, ensure_ascii=True)


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
    if data is not None and json_data is not None:
        raise ValueError("request_json: pass only one of `data` or `json_data`")

    headers, params, last_err = headers or {}, params or {}, None
    for attempt in range(max_retries):
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

        if resp.status_code == 429:
            time.sleep(min(60, max(1, _parse_retry_after_seconds(resp.headers.get("Retry-After")) or (2**attempt))))
            continue
        if resp.status_code >= 500:
            time.sleep(min(60, 2**attempt))
            continue
        if resp.status_code >= 400:
            trace = resp.headers.get("x-trace-id") or resp.headers.get("x-request-id")
            msg = f"HTTP {resp.status_code} for {method} {url}"
            if trace:
                msg += f" (trace_id={trace})"
            if detail := _error_detail(resp):
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

    candidates: list[dict[str, list[str]]] = []
    looks_structured = False
    if "://" in s or s.startswith(("/", "?")):
        looks_structured = True
        u = urlparse(s)
        if u.query:
            candidates.append(parse_qs(u.query, keep_blank_values=True))
        if u.fragment:
            candidates.append(parse_qs(u.fragment, keep_blank_values=True))
        if s.startswith("?"):
            candidates.append(parse_qs(s[1:], keep_blank_values=True))
    elif "=" in s and ("&" in s or s.startswith(("code=", "state=", "error="))):
        looks_structured = True
        candidates.append(parse_qs(s, keep_blank_values=True))

    for qs in candidates:
        code = (qs.get("code") or [None])[0]
        state = (qs.get("state") or [None])[0]
        error = (qs.get("error") or [None])[0]
        if code is not None or state is not None or error is not None:
            return OAuthResult(code=code or "", state=state, error=error)

    if looks_structured or any(ch.isspace() for ch in s):
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
    lock = threading.Lock()

    def set_result(*, code: str | None, state: str | None, error: str | None) -> None:
        with lock:
            if event.is_set():
                return
            result.update(code=code, state=state, error=error)
            event.set()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != callback_path:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not found")
                return
            qs = parse_qs(parsed.query)
            set_result(
                code=(qs.get("code") or [None])[0],
                state=(qs.get("state") or [None])[0],
                error=(qs.get("error") or [None])[0],
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Authorization received. You can close this tab/window and return to the terminal.\n")

    def read_manual_input() -> None:
        while not event.is_set():
            try:
                raw = input()
            except Exception:  # noqa: BLE001
                return
            parsed = _oauth_result_from_paste(raw)
            if parsed is None:
                print("Input did not contain a recognizable OAuth callback URL or code; still waiting...")
                continue
            set_result(code=parsed.code, state=parsed.state, error=parsed.error)
            return

    httpd = HTTPServer((listen_host, listen_port), Handler)
    callback_port = int(httpd.server_address[1])
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    threading.Thread(target=read_manual_input, daemon=True).start()

    print(f"Waiting for OAuth redirect on http://{listen_host}:{callback_port}{callback_path}")
    print("You may also paste the final callback URL (or just the `code`) here and press Enter.")
    try:
        if not event.wait(timeout_s):
            raise TimeoutError("Timed out waiting for OAuth redirect or manual code input")
        code = result.get("code")
        if not code:
            return OAuthResult(code="", state=result.get("state"), error=result.get("error") or "missing_code")
        return OAuthResult(code=code, state=result.get("state"), error=result.get("error"))
    finally:
        httpd.shutdown()
        httpd.server_close()


def open_in_browser(url: str) -> None:
    try:
        webbrowser.open(url, new=1, autoraise=True)
    except Exception:  # noqa: BLE001
        pass
