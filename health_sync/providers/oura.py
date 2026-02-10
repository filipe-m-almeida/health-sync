from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlencode, urlparse

import requests

from ..config import LoadedConfig, require_str
from ..db import HealthSyncDb
from ..util import (
    basic_auth_header,
    dt_to_iso_z,
    iso_to_dt,
    parse_yyyy_mm_dd,
    oauth_listen_for_code,
    open_in_browser,
    request_json,
    sha256_hex,
    utc_now_iso,
)


OURA_PROVIDER = "oura"
OURA_BASE = "https://api.ouraring.com"
OURA_OAUTH_AUTHORIZE = "https://cloud.ouraring.com/oauth/authorize"
OURA_OAUTH_TOKEN = "https://api.ouraring.com/oauth/token"


def _oura_default_redirect_uri() -> str:
    # Oura accepts `http://localhost/...` for local redirect URIs but rejects
    # `http://127.0.0.1/...` with `400 invalid_request`.
    return "http://localhost:8484/callback"


def _oura_scopes(cfg: LoadedConfig) -> str:
    # Keep it broad; users can override if their app is configured with different scopes.
    return cfg.config.oura.scopes


def _oura_redirect(cfg: LoadedConfig) -> tuple[str, int, str]:
    redirect_uri = cfg.config.oura.redirect_uri or _oura_default_redirect_uri()
    u = urlparse(redirect_uri)
    if u.scheme not in ("http", "https"):
        raise RuntimeError(f"Invalid `oura.redirect_uri`: {redirect_uri}")
    host = u.hostname or "127.0.0.1"
    port = u.port or (443 if u.scheme == "https" else 80)
    path = u.path or "/callback"
    return redirect_uri, port, path


def oura_auth(db: HealthSyncDb, cfg: LoadedConfig, *, listen_host: str = "127.0.0.1", listen_port: int = 0) -> None:
    # Fast path: PAT from config.
    pat = cfg.config.oura.access_token
    if pat:
        db.set_oauth_token(
            provider=OURA_PROVIDER,
            access_token=pat,
            refresh_token=None,
            token_type="Bearer",
            scope=None,
            expires_at=None,
            extra={"method": "pat"},
        )
        print("Stored Oura personal access token in DB.")
        return

    client_id = require_str(cfg, cfg.config.oura.client_id, key="oura.client_id")
    client_secret = require_str(cfg, cfg.config.oura.client_secret, key="oura.client_secret")
    redirect_uri, redirect_port, callback_path = _oura_redirect(cfg)

    if listen_port == 0:
        listen_port = redirect_port

    state = secrets.token_urlsafe(16)
    scope = _oura_scopes(cfg)

    auth_url = f"{OURA_OAUTH_AUTHORIZE}?{urlencode({'response_type': 'code', 'client_id': client_id, 'redirect_uri': redirect_uri, 'scope': scope, 'state': state}, quote_via=quote)}"

    print("Open this URL to authorize Oura:")
    print(auth_url)
    open_in_browser(auth_url)

    res = oauth_listen_for_code(listen_host=listen_host, listen_port=listen_port, callback_path=callback_path)
    if res.error:
        raise RuntimeError(f"Oura auth error: {res.error}")
    if res.state and res.state != state:
        raise RuntimeError("Oura auth failed: state mismatch")

    sess = requests.Session()
    token = request_json(
        sess,
        "POST",
        OURA_OAUTH_TOKEN,
        headers={
            "Authorization": basic_auth_header(client_id, client_secret),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "authorization_code",
            "code": res.code,
            "redirect_uri": redirect_uri,
        },
    )

    access_token = token["access_token"]
    refresh_token = token.get("refresh_token")
    token_type = token.get("token_type")
    scope_resp = token.get("scope")
    expires_in = token.get("expires_in")
    expires_at = None
    if isinstance(expires_in, int):
        expires_at = dt_to_iso_z(datetime.now(UTC) + timedelta(seconds=int(expires_in)))

    db.set_oauth_token(
        provider=OURA_PROVIDER,
        access_token=access_token,
        refresh_token=refresh_token,
        token_type=token_type,
        scope=scope_resp,
        expires_at=expires_at,
        extra={k: v for k, v in token.items() if k not in {"access_token", "refresh_token", "token_type", "scope", "expires_in"}},
    )
    print("Stored Oura OAuth token in DB.")


def _oura_refresh_if_needed(db: HealthSyncDb, cfg: LoadedConfig, sess: requests.Session) -> str:
    # PAT via config: use directly.
    pat = cfg.config.oura.access_token
    if pat:
        return pat

    tok = db.get_oauth_token(OURA_PROVIDER)
    if not tok:
        raise RuntimeError(
            "Missing Oura credentials. Set `oura.access_token` in your config file "
            f"({cfg.path}) or run `health-sync auth oura`."
        )

    access_token = tok["access_token"]
    refresh_token = tok.get("refresh_token")
    expires_at = tok.get("expires_at")

    # PAT stored in DB: no refresh.
    if not refresh_token or not expires_at:
        return access_token

    try:
        exp = iso_to_dt(expires_at)
    except Exception:  # noqa: BLE001
        exp = datetime.now(UTC) - timedelta(days=1)

    if exp - datetime.now(UTC) > timedelta(seconds=60):
        return access_token

    client_id = require_str(cfg, cfg.config.oura.client_id, key="oura.client_id")
    client_secret = require_str(cfg, cfg.config.oura.client_secret, key="oura.client_secret")

    token = request_json(
        sess,
        "POST",
        OURA_OAUTH_TOKEN,
        headers={
            "Authorization": basic_auth_header(client_id, client_secret),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
    )

    new_access = token["access_token"]
    new_refresh = token.get("refresh_token") or refresh_token
    token_type = token.get("token_type")
    scope_resp = token.get("scope")
    expires_in = token.get("expires_in")
    new_expires_at = None
    if isinstance(expires_in, int):
        new_expires_at = dt_to_iso_z(datetime.now(UTC) + timedelta(seconds=int(expires_in)))

    db.set_oauth_token(
        provider=OURA_PROVIDER,
        access_token=new_access,
        refresh_token=new_refresh,
        token_type=token_type,
        scope=scope_resp,
        expires_at=new_expires_at,
        extra={k: v for k, v in token.items() if k not in {"access_token", "refresh_token", "token_type", "scope", "expires_in"}},
    )
    return new_access


def _oura_headers(access_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "health-sync/0.1 (+local sqlite cache)",
        "Accept": "application/json",
    }


def _oura_fetch_all(
    sess: requests.Session,
    *,
    access_token: str,
    path: str,
    params: dict[str, str] | None = None,
) -> list[dict]:
    params = dict(params or {})
    url = f"{OURA_BASE}{path}"

    items: list[dict] = []
    next_token: str | None = None
    while True:
        if next_token:
            params["next_token"] = next_token

        j = request_json(sess, "GET", url, headers=_oura_headers(access_token), params=params)

        if "data" not in j:
            # e.g. personal_info
            if isinstance(j, dict):
                items.append(j)
            break

        data = j.get("data")
        if isinstance(data, list):
            items.extend([x for x in data if isinstance(x, dict)])
        elif isinstance(data, dict):
            items.append(data)

        next_token = j.get("next_token")
        if not next_token:
            break

    return items


def oura_sync(db: HealthSyncDb, cfg: LoadedConfig) -> None:
    sess = requests.Session()
    access_token = _oura_refresh_if_needed(db, cfg, sess)

    start_date = cfg.config.oura.start_date
    today = datetime.now(UTC).date().isoformat()
    overlap_days = int(cfg.config.oura.overlap_days)

    # Daily + session collections use date windows; Oura doesn't provide a general updated_since flag.
    resources: list[tuple[str, str]] = [
        ("personal_info", "/v2/usercollection/personal_info"),
        ("daily_activity", "/v2/usercollection/daily_activity"),
        ("daily_sleep", "/v2/usercollection/daily_sleep"),
        ("daily_readiness", "/v2/usercollection/daily_readiness"),
        ("sleep", "/v2/usercollection/sleep"),
        ("workout", "/v2/usercollection/workout"),
    ]

    # Heartrate is time-series; we keep it, but only backfill up to the same start date.
    ts_resources: list[tuple[str, str]] = [
        ("heartrate", "/v2/usercollection/heartrate"),
    ]

    print("Syncing Oura...")
    with db.transaction():
        # personal_info (single object)
        items = _oura_fetch_all(sess, access_token=access_token, path="/v2/usercollection/personal_info")
        if items:
            db.upsert_record(
                provider=OURA_PROVIDER,
                resource="personal_info",
                record_id="me",
                payload=items[0],
                start_time=None,
                end_time=None,
                source_updated_at=None,
                fetched_at=utc_now_iso(),
            )
        db.set_sync_state(provider=OURA_PROVIDER, resource="personal_info", watermark=utc_now_iso())

        # date-window collections
        for name, path in resources[1:]:
            state = db.get_sync_state(provider=OURA_PROVIDER, resource=name)
            if state and state.watermark:
                # Re-fetch a small overlap to catch backfilled/edited data.
                try:
                    wm_dt = datetime.fromisoformat(state.watermark).date()
                except Exception:  # noqa: BLE001
                    wm_dt = datetime.now(UTC).date()
                start_dt = datetime.combine(wm_dt, datetime.min.time(), tzinfo=UTC) - timedelta(days=overlap_days)
                start_s = start_dt.date().isoformat()
            else:
                start_s = start_date

            params = {"start_date": start_s, "end_date": today}
            items = _oura_fetch_all(sess, access_token=access_token, path=path, params=params)

            for item in items:
                stable = json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
                record_id = str(item.get("id") or item.get("day") or item.get("timestamp") or sha256_hex(stable))
                start_time = item.get("day") or item.get("start_datetime") or item.get("timestamp") or item.get("start_time")
                end_time = item.get("end_datetime") or item.get("end_time")
                updated_at = item.get("updated_at") or item.get("modified_at") or item.get("timestamp")
                db.upsert_record(
                    provider=OURA_PROVIDER,
                    resource=name,
                    record_id=record_id,
                    payload=item,
                    start_time=start_time,
                    end_time=end_time,
                    source_updated_at=updated_at,
                )

            # Keep watermark simple: this run covered until today.
            db.set_sync_state(provider=OURA_PROVIDER, resource=name, watermark=today)

        # time-series collections (HR): delta by last stored timestamp.
        for name, path in ts_resources:
            max_ts = db.get_max_start_time(provider=OURA_PROVIDER, resource=name)
            if max_ts:
                try:
                    start_dt = iso_to_dt(max_ts) - timedelta(days=1)
                except Exception:  # noqa: BLE001
                    start_dt = datetime.now(UTC) - timedelta(days=overlap_days)
            else:
                start_dt = parse_yyyy_mm_dd(start_date)

            end_dt = datetime.now(UTC)
            # Oura will reject very large time windows for time-series endpoints
            # (e.g., requesting many years at once), so we fetch in chunks.
            chunk_days = 30
            chunk = timedelta(days=chunk_days)
            print(f"- {name}: {dt_to_iso_z(start_dt)} -> {dt_to_iso_z(end_dt)} ({chunk_days}-day chunks)")
            cur = start_dt
            while cur < end_dt:
                chunk_end = min(end_dt, cur + chunk)
                params = {"start_datetime": dt_to_iso_z(cur), "end_datetime": dt_to_iso_z(chunk_end)}
                items = _oura_fetch_all(sess, access_token=access_token, path=path, params=params)

                for item in items:
                    # HR samples have timestamps; use them as stable ids.
                    ts = item.get("timestamp") or item.get("time") or item.get("datetime")
                    stable = json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
                    record_id = str(item.get("id") or ts or sha256_hex(stable))
                    db.upsert_record(
                        provider=OURA_PROVIDER,
                        resource=name,
                        record_id=record_id,
                        payload=item,
                        start_time=ts,
                        end_time=None,
                        source_updated_at=ts,
                    )

                # Advance window. We don't add an overlap here; record ids dedupe anyway.
                cur = chunk_end

            db.set_sync_state(provider=OURA_PROVIDER, resource=name, watermark=dt_to_iso_z(end_dt))

    print("Oura sync complete.")
