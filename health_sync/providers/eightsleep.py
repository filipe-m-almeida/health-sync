from __future__ import annotations

from datetime import UTC, datetime, timedelta

import requests

from ..config import LoadedConfig, require_str
from ..db import HealthSyncDb
from .runtime import stable_json, sync_resource, token_expiring_soon, token_extra
from ..util import iso_to_dt, parse_yyyy_mm_dd, request_json, sha256_hex, utc_now_iso


EIGHTSLEEP_PROVIDER = "eightsleep"


def _eightsleep_auth_headers() -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "User-Agent": "health-sync/0.1 (+local sqlite cache)",
        "Accept": "application/json",
    }


def _eightsleep_api_headers(access_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "User-Agent": "health-sync/0.1 (+local sqlite cache)",
        "Accept": "application/json",
    }


def _parse_date(s: str | None) -> datetime | None:
    if not s:
        return None
    raw = s.strip()
    if not raw:
        return None
    try:
        return iso_to_dt(raw)
    except Exception:  # noqa: BLE001
        pass
    if len(raw) >= 10 and raw[4:5] == "-" and raw[7:8] == "-":
        try:
            return parse_yyyy_mm_dd(raw[:10])
        except Exception:  # noqa: BLE001
            return None
    return None


def _eightsleep_refresh_if_needed(db: HealthSyncDb, cfg: LoadedConfig, sess: requests.Session) -> str:
    # Static token in config takes precedence.
    static_access_token = cfg.config.eightsleep.access_token
    if static_access_token:
        return static_access_token

    tok = db.get_oauth_token(EIGHTSLEEP_PROVIDER)
    if tok:
        if not token_expiring_soon(tok.get("expires_at"), skew_seconds=60):
            return tok["access_token"]

    auth_url = cfg.config.eightsleep.auth_url.rstrip("/")
    email = require_str(cfg, cfg.config.eightsleep.email, key="eightsleep.email")
    password = require_str(cfg, cfg.config.eightsleep.password, key="eightsleep.password")
    client_id = require_str(cfg, cfg.config.eightsleep.client_id, key="eightsleep.client_id")
    client_secret = require_str(cfg, cfg.config.eightsleep.client_secret, key="eightsleep.client_secret")

    token = request_json(
        sess,
        "POST",
        auth_url,
        headers=_eightsleep_auth_headers(),
        json_data={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "password",
            "username": email,
            "password": password,
        },
    )

    access_token = token["access_token"]
    expires_at = None
    expires_in = token.get("expires_in")
    try:
        if expires_in is not None:
            expires_at = (datetime.now(UTC) + timedelta(seconds=int(float(expires_in)))).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    except Exception:  # noqa: BLE001
        expires_at = None

    db.set_oauth_token(
        provider=EIGHTSLEEP_PROVIDER,
        access_token=access_token,
        refresh_token=None,
        token_type="Bearer",
        scope=None,
        expires_at=expires_at,
        extra=token_extra(token, excluded=("access_token", "expires_in")),
    )
    return access_token


def _trend_start_date(db: HealthSyncDb, cfg: LoadedConfig) -> str:
    state = db.get_sync_state(provider=EIGHTSLEEP_PROVIDER, resource="trends")
    overlap_days = int(cfg.config.eightsleep.overlap_days)

    if state and state.watermark:
        dt = _parse_date(state.watermark)
        if dt is not None:
            return (dt.date() - timedelta(days=overlap_days)).isoformat()
    return cfg.config.eightsleep.start_date


def eightsleep_sync(db: HealthSyncDb, cfg: LoadedConfig) -> None:
    sess = requests.Session()
    access_token = _eightsleep_refresh_if_needed(db, cfg, sess)
    headers = _eightsleep_api_headers(access_token)

    client_api_url = cfg.config.eightsleep.client_api_url.rstrip("/")
    tz = cfg.config.eightsleep.timezone or "UTC"
    today = datetime.now(UTC).date().isoformat()

    print("Syncing Eight Sleep...")

    me_resp = request_json(sess, "GET", f"{client_api_url}/users/me", headers=headers)
    me_user = me_resp.get("user") if isinstance(me_resp, dict) else None
    me_id = str((me_user or {}).get("id") or "me")

    with sync_resource(db, provider=EIGHTSLEEP_PROVIDER, resource="users_me") as run_users_me:
        op = db.upsert_record(
            provider=EIGHTSLEEP_PROVIDER,
            resource="users_me",
            record_id=me_id,
            payload=me_resp,
            start_time=None,
            end_time=None,
            source_updated_at=utc_now_iso(),
        )
        run_users_me.add_upsert(op)
        db.set_sync_state(provider=EIGHTSLEEP_PROVIDER, resource="users_me", watermark=utc_now_iso())

    user_ids: set[str] = set()
    if me_id != "me":
        user_ids.add(me_id)

    device_ids = (me_user or {}).get("devices")
    device_id = str(device_ids[0]) if isinstance(device_ids, list) and device_ids else None
    if device_id:
        device_resp = request_json(sess, "GET", f"{client_api_url}/devices/{device_id}", headers=headers)
        result = device_resp.get("result") if isinstance(device_resp, dict) else {}
        if isinstance(result, dict):
            left_id = result.get("leftUserId")
            right_id = result.get("rightUserId")
            if left_id:
                user_ids.add(str(left_id))
            if right_id:
                user_ids.add(str(right_id))
            away_sides = result.get("awaySides")
            if isinstance(away_sides, dict):
                for uid in away_sides.values():
                    if uid:
                        user_ids.add(str(uid))

        with sync_resource(db, provider=EIGHTSLEEP_PROVIDER, resource="devices") as run_devices:
            op = db.upsert_record(
                provider=EIGHTSLEEP_PROVIDER,
                resource="devices",
                record_id=device_id,
                payload=device_resp,
                start_time=None,
                end_time=None,
                source_updated_at=utc_now_iso(),
            )
            run_devices.add_upsert(op)
            db.set_sync_state(provider=EIGHTSLEEP_PROVIDER, resource="devices", watermark=utc_now_iso())

    total_profiles = 0
    total_trends = 0
    from_date = _trend_start_date(db, cfg)

    with db.sync_run(provider=EIGHTSLEEP_PROVIDER, resource="users") as run_users:
        with db.sync_run(provider=EIGHTSLEEP_PROVIDER, resource="trends") as run_trends:
            with db.transaction():
                for user_id in sorted(user_ids):
                    profile_resp = request_json(sess, "GET", f"{client_api_url}/users/{user_id}", headers=headers)
                    op = db.upsert_record(
                        provider=EIGHTSLEEP_PROVIDER,
                        resource="users",
                        record_id=str(user_id),
                        payload=profile_resp,
                        start_time=None,
                        end_time=None,
                        source_updated_at=utc_now_iso(),
                    )
                    run_users.add_upsert(op)
                    total_profiles += 1

                    trend_resp = request_json(
                        sess,
                        "GET",
                        f"{client_api_url}/users/{user_id}/trends",
                        headers=headers,
                        params={
                            "tz": tz,
                            "from": from_date,
                            "to": today,
                            "include-main": "false",
                            "include-all-sessions": "true",
                            "model-version": "v2",
                        },
                    )

                    days = trend_resp.get("days") if isinstance(trend_resp, dict) else None
                    if not isinstance(days, list):
                        continue
                    for day in days:
                        if not isinstance(day, dict):
                            continue
                        day_key = day.get("day")
                        rid = f"{user_id}:{day_key}" if day_key else f"{user_id}:{sha256_hex(stable_json(day))}"
                        start_time = day.get("day") or day.get("presenceStart")
                        end_time = day.get("presenceEnd")
                        source_updated_at = day.get("updatedAt") or day.get("presenceStart") or start_time
                        op_trend = db.upsert_record(
                            provider=EIGHTSLEEP_PROVIDER,
                            resource="trends",
                            record_id=rid,
                            payload=day,
                            start_time=start_time,
                            end_time=end_time,
                            source_updated_at=source_updated_at,
                        )
                        run_trends.add_upsert(op_trend)
                        total_trends += 1

                db.set_sync_state(provider=EIGHTSLEEP_PROVIDER, resource="users", watermark=utc_now_iso())
                db.set_sync_state(provider=EIGHTSLEEP_PROVIDER, resource="trends", watermark=utc_now_iso())

    print(f"Eight Sleep sync complete ({total_profiles} user profiles, {total_trends} trend rows).")
