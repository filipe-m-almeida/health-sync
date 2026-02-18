from __future__ import annotations

import secrets
from datetime import UTC, datetime

import requests

from ..config import LoadedConfig, require_str
from ..db import HealthSyncDb
from .runtime import (
    build_auth_url,
    first_present,
    parse_redirect_uri,
    sync_resource,
    token_expiring_soon,
    token_extra,
    upsert_item,
)
from ..util import (
    dt_to_iso_z,
    oauth_listen_for_code,
    open_in_browser,
    parse_yyyy_mm_dd,
    request_json,
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
    spec = parse_redirect_uri(
        cfg.config.strava.redirect_uri,
        default_uri=_strava_default_redirect_uri(),
        key_name="strava.redirect_uri",
    )
    return spec.redirect_uri, spec.listen_port, spec.callback_path


def _strava_scopes(cfg: LoadedConfig) -> str:
    raw = cfg.config.strava.scopes
    parts = [p.strip() for p in raw.replace(" ", ",").split(",") if p and p.strip()]
    out: list[str] = []
    for p in parts:
        if p not in out:
            out.append(p)
    return ",".join(out) if out else raw


def _strava_expires_to_iso(v: object) -> str | None:
    if v is None:
        return None
    try:
        epoch = int(v)
        return dt_to_iso_z(datetime.fromtimestamp(epoch, tz=UTC))
    except Exception:  # noqa: BLE001
        return None


def _strava_expires_to_dt(v: str | None) -> datetime | None:
    if v is None:
        return None
    try:
        epoch = int(v)
        return datetime.fromtimestamp(epoch, tz=UTC)
    except Exception:  # noqa: BLE001
        pass
    if not v.strip():
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return None


def strava_auth(db: HealthSyncDb, cfg: LoadedConfig, *, listen_host: str = "127.0.0.1", listen_port: int = 0) -> None:
    # Fast path: static access token from config.
    static_access_token = cfg.config.strava.access_token
    if static_access_token:
        db.set_oauth_token(
            provider=STRAVA_PROVIDER,
            access_token=static_access_token,
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

    if listen_port == 0:
        listen_port = redirect_port

    state = secrets.token_urlsafe(16)
    scope = _strava_scopes(cfg)
    approval_prompt = cfg.config.strava.approval_prompt or "auto"

    auth_url = build_auth_url(
        STRAVA_OAUTH_AUTHORIZE,
        {
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "approval_prompt": approval_prompt,
            "scope": scope,
            "state": state,
        },
    )

    print("Open this URL to authorize Strava:")
    print(auth_url)
    open_in_browser(auth_url)

    res = oauth_listen_for_code(listen_host=listen_host, listen_port=listen_port, callback_path=callback_path)
    if res.error:
        raise RuntimeError(f"Strava auth error: {res.error}")
    if res.state and res.state != state:
        raise RuntimeError("Strava auth failed: state mismatch")

    sess = requests.Session()
    token = request_json(
        sess,
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

    access_token = token["access_token"]
    refresh_token = token.get("refresh_token")
    expires_at = _strava_expires_to_iso(token.get("expires_at"))
    token_type = token.get("token_type") or "Bearer"
    scope_resp = token.get("scope")

    db.set_oauth_token(
        provider=STRAVA_PROVIDER,
        access_token=access_token,
        refresh_token=refresh_token,
        token_type=token_type,
        scope=scope_resp,
        expires_at=expires_at,
        extra=token_extra(
            token,
            excluded=("access_token", "refresh_token", "token_type", "scope", "expires_at"),
        ),
    )
    print("Stored Strava OAuth token in DB.")


def _strava_refresh_if_needed(db: HealthSyncDb, cfg: LoadedConfig, sess: requests.Session) -> str:
    # Static token from config takes precedence.
    static_access_token = cfg.config.strava.access_token
    if static_access_token:
        return static_access_token

    tok = db.get_oauth_token(STRAVA_PROVIDER)
    if not tok:
        raise RuntimeError(
            "Missing Strava credentials. Run `health-sync auth strava` "
            f"(config: {cfg.path})."
        )

    access_token = tok["access_token"]
    refresh_token = tok.get("refresh_token")
    expires_at = tok.get("expires_at")

    if not refresh_token or not expires_at:
        return access_token

    if not token_expiring_soon(expires_at, skew_seconds=60):
        return access_token

    client_id = require_str(cfg, cfg.config.strava.client_id, key="strava.client_id")
    client_secret = require_str(cfg, cfg.config.strava.client_secret, key="strava.client_secret")

    token = request_json(
        sess,
        "POST",
        STRAVA_OAUTH_TOKEN,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
    )

    new_access = token["access_token"]
    new_refresh = token.get("refresh_token") or refresh_token
    new_expires_at = _strava_expires_to_iso(token.get("expires_at"))
    token_type = token.get("token_type") or "Bearer"
    scope_resp = token.get("scope")

    db.set_oauth_token(
        provider=STRAVA_PROVIDER,
        access_token=new_access,
        refresh_token=new_refresh,
        token_type=token_type,
        scope=scope_resp,
        expires_at=new_expires_at,
        extra=token_extra(
            token,
            excluded=("access_token", "refresh_token", "token_type", "scope", "expires_at"),
        ),
    )
    return new_access


def _strava_headers(access_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "health-sync/0.1 (+local sqlite cache)",
        "Accept": "application/json",
    }


def _watermark_epoch(db: HealthSyncDb, *, resource: str) -> int | None:
    state = db.get_sync_state(provider=STRAVA_PROVIDER, resource=resource)
    if not state or not state.watermark:
        return None
    return to_epoch_seconds(state.watermark)


def strava_sync(db: HealthSyncDb, cfg: LoadedConfig) -> None:
    sess = requests.Session()
    access_token = _strava_refresh_if_needed(db, cfg, sess)

    overlap_seconds = max(0, int(cfg.config.strava.overlap_seconds))
    page_size = min(200, max(1, int(cfg.config.strava.page_size)))

    print("Syncing Strava...")

    with sync_resource(db, provider=STRAVA_PROVIDER, resource="athlete") as run:
        athlete = request_json(
            sess,
            "GET",
            f"{STRAVA_BASE}/athlete",
            headers=_strava_headers(access_token),
        )
        athlete_id = str(athlete.get("id") or "me")
        op = db.upsert_record(
            provider=STRAVA_PROVIDER,
            resource="athlete",
            record_id=athlete_id,
            payload=athlete,
            start_time=None,
            end_time=None,
            source_updated_at=utc_now_iso(),
        )
        run.add_upsert(op)
        db.set_sync_state(provider=STRAVA_PROVIDER, resource="athlete", watermark=utc_now_iso())

    existing_wm = _watermark_epoch(db, resource="activities")
    if existing_wm is not None:
        after_epoch = max(0, existing_wm - overlap_seconds)
    else:
        after_epoch = int(parse_yyyy_mm_dd(cfg.config.strava.start_date).timestamp())

    page = 1
    max_start_epoch: int | None = existing_wm

    with sync_resource(db, provider=STRAVA_PROVIDER, resource="activities") as run:
        while True:
            batch = request_json(
                sess,
                "GET",
                f"{STRAVA_BASE}/athlete/activities",
                headers=_strava_headers(access_token),
                params={
                    "after": str(after_epoch),
                    "page": str(page),
                    "per_page": str(page_size),
                },
            )
            if not isinstance(batch, list) or not batch:
                break

            for item in batch:
                if not isinstance(item, dict):
                    continue

                start_time = first_present(item, ("start_date",))
                start_epoch = to_epoch_seconds(start_time)
                if start_epoch is not None and (max_start_epoch is None or start_epoch > max_start_epoch):
                    max_start_epoch = start_epoch

                upsert_item(
                    db,
                    run,
                    provider=STRAVA_PROVIDER,
                    resource="activities",
                    item=item,
                    record_id_keys=("id",),
                    start_keys=("start_date",),
                    updated_keys=("updated_at", "start_date"),
                )

            if len(batch) < page_size:
                break
            page += 1

        if max_start_epoch is None:
            # No prior watermark and no activities returned. Keep the initial
            # backfill anchor rather than advancing to "now", which can skip
            # late-imported historical activities.
            max_start_epoch = after_epoch
        db.set_sync_state(provider=STRAVA_PROVIDER, resource="activities", watermark=max_start_epoch)

    print(
        "Strava sync complete "
        f"({run.inserted_count + run.updated_count + run.unchanged_count} activity records processed)."
    )
