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
    return "http://localhost:8484/callback"


def _oura_scopes(cfg: LoadedConfig) -> str:
    return cfg.config.oura.scopes


def _oura_redirect(cfg: LoadedConfig) -> tuple[str, int, str]:
    redirect_uri = cfg.config.oura.redirect_uri or _oura_default_redirect_uri()
    u = urlparse(redirect_uri)
    if u.scheme not in ("http", "https"):
        raise RuntimeError(f"Invalid `oura.redirect_uri`: {redirect_uri}")
    return redirect_uri, u.port or (443 if u.scheme == "https" else 80), u.path or "/callback"


def _store_token(db: HealthSyncDb, token: dict[str, object], refresh_fallback: str | None = None) -> str:
    access = str(token["access_token"])
    refresh = str(token.get("refresh_token") or refresh_fallback or "") or None
    expires_at = None
    if (expires := token.get("expires_in")) is not None:
        try:
            expires_at = dt_to_iso_z(datetime.now(UTC) + timedelta(seconds=int(expires)))
        except Exception:  # noqa: BLE001
            expires_at = None
    db.set_oauth_token(
        provider=OURA_PROVIDER,
        access_token=access,
        refresh_token=refresh,
        token_type=(str(token["token_type"]) if token.get("token_type") is not None else None),
        scope=(str(token["scope"]) if token.get("scope") is not None else None),
        expires_at=expires_at,
        extra={
            k: v
            for k, v in token.items()
            if k not in {"access_token", "refresh_token", "token_type", "scope", "expires_in"}
        },
    )
    return access


def oura_auth(db: HealthSyncDb, cfg: LoadedConfig, *, listen_host: str = "127.0.0.1", listen_port: int = 0) -> None:
    if cfg.config.oura.access_token:
        db.set_oauth_token(
            provider=OURA_PROVIDER,
            access_token=cfg.config.oura.access_token,
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
    listen_port = listen_port or redirect_port

    state = secrets.token_urlsafe(16)
    auth_url = f"{OURA_OAUTH_AUTHORIZE}?{urlencode({'response_type': 'code', 'client_id': client_id, 'redirect_uri': redirect_uri, 'scope': _oura_scopes(cfg), 'state': state}, quote_via=quote)}"
    print("Open this URL to authorize Oura:")
    print(auth_url)
    open_in_browser(auth_url)

    res = oauth_listen_for_code(listen_host=listen_host, listen_port=listen_port, callback_path=callback_path)
    if res.error:
        raise RuntimeError(f"Oura auth error: {res.error}")
    if res.state and res.state != state:
        raise RuntimeError("Oura auth failed: state mismatch")

    token = request_json(
        requests.Session(),
        "POST",
        OURA_OAUTH_TOKEN,
        headers={
            "Authorization": basic_auth_header(client_id, client_secret),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={"grant_type": "authorization_code", "code": res.code, "redirect_uri": redirect_uri},
    )
    _store_token(db, token)
    print("Stored Oura OAuth token in DB.")


def _oura_refresh_if_needed(db: HealthSyncDb, cfg: LoadedConfig, sess: requests.Session) -> str:
    if cfg.config.oura.access_token:
        return cfg.config.oura.access_token

    tok = db.get_oauth_token(OURA_PROVIDER)
    if not tok:
        raise RuntimeError(
            "Missing Oura credentials. Set `oura.access_token` in your config file "
            f"({cfg.path}) or run `health-sync auth oura`."
        )

    access, refresh, expires = tok["access_token"], tok.get("refresh_token"), tok.get("expires_at")
    if not refresh or not expires:
        return access
    try:
        if iso_to_dt(expires) - datetime.now(UTC) > timedelta(seconds=60):
            return access
    except Exception:  # noqa: BLE001
        pass

    token = request_json(
        sess,
        "POST",
        OURA_OAUTH_TOKEN,
        headers={
            "Authorization": basic_auth_header(
                require_str(cfg, cfg.config.oura.client_id, key="oura.client_id"),
                require_str(cfg, cfg.config.oura.client_secret, key="oura.client_secret"),
            ),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={"grant_type": "refresh_token", "refresh_token": refresh},
    )
    return _store_token(db, token, refresh_fallback=refresh)


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
    url, params, out, next_token = f"{OURA_BASE}{path}", dict(params or {}), [], None
    while True:
        if next_token:
            params["next_token"] = next_token
        j = request_json(sess, "GET", url, headers=_oura_headers(access_token), params=params)
        if "data" not in j:
            if isinstance(j, dict):
                out.append(j)
            break
        data = j.get("data")
        if isinstance(data, list):
            out.extend(x for x in data if isinstance(x, dict))
        elif isinstance(data, dict):
            out.append(data)
        next_token = j.get("next_token")
        if not next_token:
            break
    return out


def oura_sync(db: HealthSyncDb, cfg: LoadedConfig) -> None:
    sess = requests.Session()
    access = _oura_refresh_if_needed(db, cfg, sess)
    now = datetime.now(UTC)
    today = now.date().isoformat()
    sleep_end = (now.date() + timedelta(days=1)).isoformat()
    overlap = int(cfg.config.oura.overlap_days)

    print("Syncing Oura...")
    with db.sync_run(provider=OURA_PROVIDER, resource="personal_info") as run:
        with db.transaction():
            items = _oura_fetch_all(sess, access_token=access, path="/v2/usercollection/personal_info")
            if items:
                run.add_upsert(db.upsert_record(provider=OURA_PROVIDER, resource="personal_info", record_id="me", payload=items[0]))
            db.set_sync_state(provider=OURA_PROVIDER, resource="personal_info", watermark=utc_now_iso())

    for name, path in [
        ("daily_activity", "/v2/usercollection/daily_activity"),
        ("daily_sleep", "/v2/usercollection/daily_sleep"),
        ("daily_readiness", "/v2/usercollection/daily_readiness"),
        ("sleep", "/v2/usercollection/sleep"),
        ("workout", "/v2/usercollection/workout"),
    ]:
        with db.sync_run(provider=OURA_PROVIDER, resource=name) as run:
            with db.transaction():
                st = db.get_sync_state(provider=OURA_PROVIDER, resource=name)
                start = cfg.config.oura.start_date
                if st and st.watermark:
                    start = (iso_to_dt(st.watermark) - timedelta(days=overlap)).date().isoformat()
                params = {"start_date": start, "end_date": sleep_end if name == "sleep" else today}
                for item in _oura_fetch_all(sess, access_token=access, path=path, params=params):
                    stable = json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
                    run.add_upsert(
                        db.upsert_record(
                            provider=OURA_PROVIDER,
                            resource=name,
                            record_id=str(item.get("id") or item.get("day") or item.get("timestamp") or sha256_hex(stable)),
                            payload=item,
                            start_time=item.get("day")
                            or item.get("start_datetime")
                            or item.get("timestamp")
                            or item.get("start_time"),
                            end_time=item.get("end_datetime") or item.get("end_time"),
                            source_updated_at=item.get("updated_at") or item.get("modified_at") or item.get("timestamp"),
                        )
                    )
                db.set_sync_state(provider=OURA_PROVIDER, resource=name, watermark=utc_now_iso())

    with db.sync_run(provider=OURA_PROVIDER, resource="heartrate") as run:
        with db.transaction():
            max_ts = db.get_max_start_time(provider=OURA_PROVIDER, resource="heartrate")
            try:
                start_dt = iso_to_dt(max_ts) - timedelta(days=1) if max_ts else parse_yyyy_mm_dd(cfg.config.oura.start_date)
            except Exception:  # noqa: BLE001
                start_dt = datetime.now(UTC) - timedelta(days=overlap)
            end_dt, cur, chunk = datetime.now(UTC), start_dt, timedelta(days=30)
            print(f"- heartrate: {dt_to_iso_z(start_dt)} -> {dt_to_iso_z(end_dt)} (30-day chunks)")
            while cur < end_dt:
                end = min(end_dt, cur + chunk)
                for item in _oura_fetch_all(
                    sess,
                    access_token=access,
                    path="/v2/usercollection/heartrate",
                    params={"start_datetime": dt_to_iso_z(cur), "end_datetime": dt_to_iso_z(end)},
                ):
                    ts = item.get("timestamp") or item.get("time") or item.get("datetime")
                    run.add_upsert(
                        db.upsert_record(
                            provider=OURA_PROVIDER,
                            resource="heartrate",
                            record_id=str(item.get("id") or ts or sha256_hex(json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=True))),
                            payload=item,
                            start_time=ts,
                            source_updated_at=ts,
                        )
                    )
                cur = end
            db.set_sync_state(provider=OURA_PROVIDER, resource="heartrate", watermark=dt_to_iso_z(end_dt))

    print("Oura sync complete.")
