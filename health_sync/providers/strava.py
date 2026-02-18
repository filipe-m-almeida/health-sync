from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime
from urllib.parse import quote, urlencode, urlparse

import requests

from ..config import LoadedConfig, require_str
from ..db import HealthSyncDb
from ..util import (
    dt_to_iso_z,
    iso_to_dt,
    oauth_listen_for_code,
    open_in_browser,
    parse_yyyy_mm_dd,
    request_json,
    sha256_hex,
    to_epoch_seconds,
    utc_now_iso,
)

STRAVA_PROVIDER = "strava"
STRAVA_BASE = "https://www.strava.com/api/v3"
STRAVA_OAUTH_AUTHORIZE = "https://www.strava.com/oauth/authorize"
STRAVA_OAUTH_TOKEN = "https://www.strava.com/oauth/token"


def _strava_default_redirect_uri() -> str:
    return "http://127.0.0.1:8486/callback"


def _strava_redirect(cfg: LoadedConfig) -> tuple[str, int, str]:
    redirect_uri = cfg.config.strava.redirect_uri or _strava_default_redirect_uri()
    u = urlparse(redirect_uri)
    if u.scheme not in ("http", "https"):
        raise RuntimeError(f"Invalid `strava.redirect_uri`: {redirect_uri}")
    return redirect_uri, u.port or (443 if u.scheme == "https" else 80), u.path or "/callback"


def _strava_scopes(cfg: LoadedConfig) -> str:
    raw = cfg.config.strava.scopes
    seen: set[str] = set()
    out = [p for p in (x.strip() for x in raw.replace(" ", ",").split(",")) if p and (p not in seen and not seen.add(p))]
    return ",".join(out) if out else raw


def _strava_expires_to_iso(v: object) -> str | None:
    try:
        return dt_to_iso_z(datetime.fromtimestamp(int(v), tz=UTC)) if v is not None else None
    except Exception:  # noqa: BLE001
        return None


def _strava_expires_to_dt(v: str | None) -> datetime | None:
    if not v:
        return None
    s = v.strip()
    if not s:
        return None
    try:
        return datetime.fromtimestamp(int(s), tz=UTC) if s.isdigit() else iso_to_dt(s)
    except Exception:  # noqa: BLE001
        return None


def _store_token(db: HealthSyncDb, token: dict[str, object], refresh_fallback: str | None = None) -> str:
    access = str(token["access_token"])
    refresh = str(token.get("refresh_token") or refresh_fallback or "") or None
    db.set_oauth_token(
        provider=STRAVA_PROVIDER,
        access_token=access,
        refresh_token=refresh,
        token_type=str(token.get("token_type") or "Bearer"),
        scope=(str(token["scope"]) if token.get("scope") is not None else None),
        expires_at=_strava_expires_to_iso(token.get("expires_at")),
        extra={
            k: v
            for k, v in token.items()
            if k not in {"access_token", "refresh_token", "token_type", "scope", "expires_at"}
        },
    )
    return access


def strava_auth(db: HealthSyncDb, cfg: LoadedConfig, *, listen_host: str = "127.0.0.1", listen_port: int = 0) -> None:
    if cfg.config.strava.access_token:
        db.set_oauth_token(
            provider=STRAVA_PROVIDER,
            access_token=cfg.config.strava.access_token,
            refresh_token=None,
            token_type="Bearer",
            scope=None,
            expires_at=None,
            extra={"method": "static_access_token"},
        )
        print("Stored Strava access token in DB.")
        return

    client_id = require_str(cfg, cfg.config.strava.client_id, key="strava.client_id")
    client_secret = require_str(cfg, cfg.config.strava.client_secret, key="strava.client_secret")
    redirect_uri, redirect_port, callback_path = _strava_redirect(cfg)
    listen_port = listen_port or redirect_port

    state = secrets.token_urlsafe(16)
    auth_url = f"{STRAVA_OAUTH_AUTHORIZE}?{urlencode({'client_id': client_id, 'response_type': 'code', 'redirect_uri': redirect_uri, 'approval_prompt': cfg.config.strava.approval_prompt or 'auto', 'scope': _strava_scopes(cfg), 'state': state}, quote_via=quote)}"
    print("Open this URL to authorize Strava:")
    print(auth_url)
    open_in_browser(auth_url)

    res = oauth_listen_for_code(listen_host=listen_host, listen_port=listen_port, callback_path=callback_path)
    if res.error:
        raise RuntimeError(f"Strava auth error: {res.error}")
    if res.state and res.state != state:
        raise RuntimeError("Strava auth failed: state mismatch")

    token = request_json(
        requests.Session(),
        "POST",
        STRAVA_OAUTH_TOKEN,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": res.code,
            "grant_type": "authorization_code",
        },
    )
    _store_token(db, token)
    print("Stored Strava OAuth token in DB.")


def _strava_refresh_if_needed(db: HealthSyncDb, cfg: LoadedConfig, sess: requests.Session) -> str:
    if cfg.config.strava.access_token:
        return cfg.config.strava.access_token

    tok = db.get_oauth_token(STRAVA_PROVIDER)
    if not tok:
        raise RuntimeError(f"Missing Strava credentials. Run `health-sync auth strava` (config: {cfg.path}).")

    access, refresh, expires_at = tok["access_token"], tok.get("refresh_token"), _strava_expires_to_dt(tok.get("expires_at"))
    if not refresh or not expires_at or (expires_at - datetime.now(UTC)).total_seconds() > 60:
        return access

    token = request_json(
        sess,
        "POST",
        STRAVA_OAUTH_TOKEN,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "client_id": require_str(cfg, cfg.config.strava.client_id, key="strava.client_id"),
            "client_secret": require_str(cfg, cfg.config.strava.client_secret, key="strava.client_secret"),
            "grant_type": "refresh_token",
            "refresh_token": refresh,
        },
    )
    return _store_token(db, token, refresh_fallback=refresh)


def _strava_headers(access_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "health-sync/0.1 (+local sqlite cache)",
        "Accept": "application/json",
    }


def _watermark_epoch(db: HealthSyncDb, *, resource: str) -> int | None:
    state = db.get_sync_state(provider=STRAVA_PROVIDER, resource=resource)
    return to_epoch_seconds(state.watermark) if state and state.watermark else None


def strava_sync(db: HealthSyncDb, cfg: LoadedConfig) -> None:
    sess = requests.Session()
    access = _strava_refresh_if_needed(db, cfg, sess)
    overlap = int(cfg.config.strava.overlap_seconds)
    page_size = max(1, min(200, int(cfg.config.strava.page_size)))

    print("Syncing Strava...")
    with db.sync_run(provider=STRAVA_PROVIDER, resource="athlete") as run:
        with db.transaction():
            athlete = request_json(sess, "GET", f"{STRAVA_BASE}/athlete", headers=_strava_headers(access))
            run.add_upsert(
                db.upsert_record(
                    provider=STRAVA_PROVIDER,
                    resource="athlete",
                    record_id=str(athlete.get("id") or "me"),
                    payload=athlete,
                    source_updated_at=utc_now_iso(),
                )
            )
            db.set_sync_state(provider=STRAVA_PROVIDER, resource="athlete", watermark=utc_now_iso())

    existing = _watermark_epoch(db, resource="activities")
    after_epoch = max(0, existing - overlap) if existing is not None else int(parse_yyyy_mm_dd(cfg.config.strava.start_date).timestamp())
    page, max_start_epoch = 1, existing
    with db.sync_run(provider=STRAVA_PROVIDER, resource="activities") as run:
        with db.transaction():
            while True:
                batch = request_json(
                    sess,
                    "GET",
                    f"{STRAVA_BASE}/athlete/activities",
                    headers=_strava_headers(access),
                    params={"after": str(after_epoch), "page": str(page), "per_page": str(page_size)},
                )
                if not isinstance(batch, list) or not batch:
                    break
                for item in batch:
                    if not isinstance(item, dict):
                        continue
                    rid = str(item.get("id") or sha256_hex(json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=True)))
                    start_time = item.get("start_date")
                    start_epoch = to_epoch_seconds(start_time)
                    if start_epoch is not None and (max_start_epoch is None or start_epoch > max_start_epoch):
                        max_start_epoch = start_epoch
                    run.add_upsert(
                        db.upsert_record(
                            provider=STRAVA_PROVIDER,
                            resource="activities",
                            record_id=rid,
                            payload=item,
                            start_time=start_time,
                            source_updated_at=item.get("updated_at") or start_time,
                        )
                    )
                if len(batch) < page_size:
                    break
                page += 1
            db.set_sync_state(
                provider=STRAVA_PROVIDER,
                resource="activities",
                watermark=after_epoch if max_start_epoch is None else max_start_epoch,
            )

    print(
        "Strava sync complete "
        f"({run.inserted_count + run.updated_count + run.unchanged_count} activity records processed)."
    )
