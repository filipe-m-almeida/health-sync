from __future__ import annotations

import re
import secrets
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlencode, urlparse

import requests

from ..config import LoadedConfig, require_str
from ..db import HealthSyncDb
from ..util import hmac_sha256_hex, iso_to_dt, oauth_listen_for_code, open_in_browser, request_json, sha256_hex, to_epoch_seconds

WITHINGS_PROVIDER = "withings"
WITHINGS_AUTHORIZE = "https://account.withings.com/oauth2_user/authorize2"
WITHINGS_TOKEN = "https://wbsapi.withings.net/v2/oauth2"
WITHINGS_SIGNATURE = "https://wbsapi.withings.net/v2/signature"
WITHINGS_MEASURE = "https://wbsapi.withings.net/measure"
WITHINGS_MEASURE_V2 = "https://wbsapi.withings.net/v2/measure"
WITHINGS_SLEEP_V2 = "https://wbsapi.withings.net/v2/sleep"


def _withings_default_redirect_uri() -> str: return "http://127.0.0.1:8485/callback"


def _withings_redirect(cfg: LoadedConfig) -> tuple[str, int, str]:
    uri = cfg.config.withings.redirect_uri or _withings_default_redirect_uri()
    u = urlparse(uri)
    if u.scheme not in ("http", "https"):
        raise RuntimeError(f"Invalid `withings.redirect_uri`: {uri}")
    return uri, u.port or (443 if u.scheme == "https" else 80), u.path or "/callback"


def _withings_scopes(cfg: LoadedConfig) -> str:
    raw = cfg.config.withings.scopes
    parts = [p.strip() for p in re.split(r"[\s,]+", raw) if p.strip()]
    if "user.sleep" in parts:
        print("Note: Withings scope `user.sleep` is not valid; using `user.activity` instead.")
    out: list[str] = []
    for p in parts:
        p = "user.activity" if p == "user.sleep" else p
        if p not in out:
            out.append(p)
    return ",".join(out) if out else raw


def _withings_signature_for(secret: str, *, action: str, client_id: str, timestamp: int | None = None, nonce: str | None = None) -> str:
    return hmac_sha256_hex(secret, ",".join([action, client_id, *([str(timestamp)] if timestamp is not None else []), *([str(nonce)] if nonce is not None else [])]))


def _withings_get_nonce(sess: requests.Session, *, client_id: str, client_secret: str) -> str:
    ts = int(time.time())
    j = request_json(
        sess,
        "POST",
        WITHINGS_SIGNATURE,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"action": "getnonce", "client_id": client_id, "timestamp": str(ts), "signature": _withings_signature_for(client_secret, action="getnonce", client_id=client_id, timestamp=ts)},
    )
    if j.get("status") != 0:
        raise RuntimeError(f"Withings getnonce failed: {j}")
    nonce = (j.get("body") or {}).get("nonce")
    if not nonce:
        raise RuntimeError(f"Withings getnonce response missing nonce: {j}")
    return str(nonce)


def _oauth_body(sess: requests.Session, *, client_id: str, client_secret: str, data: dict[str, str], err: str) -> dict[str, object]:
    nonce = _withings_get_nonce(sess, client_id=client_id, client_secret=client_secret)
    payload = dict(data)
    payload.update({"client_id": client_id, "nonce": nonce, "signature": _withings_signature_for(client_secret, action="requesttoken", client_id=client_id, nonce=nonce)})
    token = request_json(sess, "POST", WITHINGS_TOKEN, headers={"Content-Type": "application/x-www-form-urlencoded"}, data=payload)
    if token.get("status") != 0:
        raise RuntimeError(f"{err}: {token}")
    return token.get("body") or {}


def _store_token(db: HealthSyncDb, body: dict[str, object], *, refresh_fallback: str | None = None) -> str:
    expires_at = (datetime.now(UTC) + timedelta(seconds=int(body["expires_in"]))).replace(microsecond=0).isoformat().replace("+00:00", "Z") if body.get("expires_in") is not None else None
    access = str(body["access_token"])
    db.set_oauth_token(
        provider=WITHINGS_PROVIDER,
        access_token=access,
        refresh_token=str(body.get("refresh_token") or refresh_fallback or "") or None,
        token_type=str(body.get("token_type") or "Bearer"),
        scope=(str(body["scope"]) if body.get("scope") is not None else None),
        expires_at=expires_at,
        extra={k: v for k, v in body.items() if k not in {"access_token", "refresh_token", "token_type", "scope", "expires_in"}},
    )
    return access


def withings_auth(db: HealthSyncDb, cfg: LoadedConfig, *, listen_host: str = "127.0.0.1", listen_port: int = 0) -> None:
    client_id = require_str(cfg, cfg.config.withings.client_id, key="withings.client_id")
    client_secret = require_str(cfg, cfg.config.withings.client_secret, key="withings.client_secret")
    redirect_uri, redirect_port, callback_path = _withings_redirect(cfg)
    listen_port = listen_port or redirect_port

    state = secrets.token_urlsafe(16)
    auth_url = f"{WITHINGS_AUTHORIZE}?{urlencode({'response_type': 'code', 'client_id': client_id, 'redirect_uri': redirect_uri, 'scope': _withings_scopes(cfg), 'state': state}, quote_via=quote)}"
    print("Open this URL to authorize Withings:")
    print(auth_url)
    open_in_browser(auth_url)

    res = oauth_listen_for_code(listen_host=listen_host, listen_port=listen_port, callback_path=callback_path)
    if res.error:
        raise RuntimeError(f"Withings auth error: {res.error}")
    if res.state and res.state != state:
        raise RuntimeError("Withings auth failed: state mismatch")

    body = _oauth_body(
        requests.Session(),
        client_id=client_id,
        client_secret=client_secret,
        data={"action": "requesttoken", "grant_type": "authorization_code", "code": res.code, "redirect_uri": redirect_uri},
        err="Withings token exchange failed",
    )
    _store_token(db, body)
    print("Stored Withings OAuth token in DB.")


def _withings_refresh_if_needed(db: HealthSyncDb, cfg: LoadedConfig, sess: requests.Session) -> str:
    tok = db.get_oauth_token(WITHINGS_PROVIDER)
    if not tok:
        raise RuntimeError(f"Missing Withings credentials. Run `health-sync auth withings` (config: {cfg.path}).")

    access, refresh, expires = tok["access_token"], tok.get("refresh_token"), tok.get("expires_at")
    if not refresh or not expires:
        return access
    try:
        if iso_to_dt(expires) - datetime.now(UTC) > timedelta(seconds=60):
            return access
    except Exception:  # noqa: BLE001
        pass

    body = _oauth_body(
        sess,
        client_id=require_str(cfg, cfg.config.withings.client_id, key="withings.client_id"),
        client_secret=require_str(cfg, cfg.config.withings.client_secret, key="withings.client_secret"),
        data={"action": "requesttoken", "grant_type": "refresh_token", "refresh_token": refresh},
        err="Withings token refresh failed",
    )
    return _store_token(db, body, refresh_fallback=refresh)


def _withings_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}", "User-Agent": "health-sync/0.1 (+local sqlite cache)", "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"}


def _watermark_epoch(db: HealthSyncDb, *, resource: str) -> int:
    st = db.get_sync_state(provider=WITHINGS_PROVIDER, resource=resource)
    return (to_epoch_seconds(st.watermark) or 0) if st else 0


def _set_watermark_epoch(db: HealthSyncDb, *, resource: str, epoch: int) -> None:
    db.set_sync_state(provider=WITHINGS_PROVIDER, resource=resource, watermark=int(epoch))


def _epoch_to_iso(v: object) -> str | None:
    return datetime.fromtimestamp(v, tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z") if isinstance(v, int) else None


def _iter_pages(sess: requests.Session, *, access_token: str, url: str, data: dict[str, str], key: str) -> tuple[list[dict], int]:
    offset = max_wm = 0
    out: list[dict] = []
    while True:
        payload = dict(data)
        if offset:
            payload["offset"] = str(offset)
        j = request_json(sess, "POST", url, headers=_withings_headers(access_token), data=payload)
        if j.get("status") != 0:
            raise RuntimeError(f"Withings {data['action']} failed: {j}")
        body = j.get("body") or {}
        out.extend(x for x in (body.get(key) or []) if isinstance(x, dict))
        if isinstance(body.get("updatetime"), int):
            max_wm = max(max_wm, body["updatetime"])
        if body.get("more") in (1, True, "1") and body.get("offset"):
            offset = int(body["offset"])
            continue
        return out, max_wm


def withings_sync(db: HealthSyncDb, cfg: LoadedConfig) -> None:
    sess = requests.Session()
    access = _withings_refresh_if_needed(db, cfg, sess)
    overlap, now_epoch = int(cfg.config.withings.overlap_seconds), int(time.time())

    meastypes = cfg.config.withings.meastypes or "1,4,5,6,8,9,10,11,12,54,71,73,76,77,88,91,123".split(",")
    activity_fields = "steps,distance,elevation,soft,moderate,intense,active,calories,totalcalories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3"
    workout_fields = "calories,effduration,intensity,manual_distance,manual_calories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3,pause_duration,algo_pause_duration,spo2_average,steps,distance,elevation,pool_laps,strokes,pool_length"
    sleep_fields = "sleep_score,lightsleepduration,deepsleepduration,remsleepduration,wakeupcount,wakeupduration,durationtosleep,durationtowakeup,hr_average,hr_min,hr_max,rr_average,rr_min,rr_max,snoring,snoringepisodecount,breathing_disturbances_intensity"

    print("Syncing Withings...")

    with db.sync_run(provider=WITHINGS_PROVIDER, resource="measures") as run:
        with db.transaction():
            wm = max(0, _watermark_epoch(db, resource="measures") - overlap)
            rows, updatetime = _iter_pages(sess, access_token=access, url=WITHINGS_MEASURE, data={"action": "getmeas", "meastype": ",".join(meastypes), "category": "1", "lastupdate": str(wm)}, key="measuregrps")
            for row in rows:
                modified = row.get("modified")
                run.add_upsert(db.upsert_record(provider=WITHINGS_PROVIDER, resource="measures", record_id=str(row.get("grpid") or sha256_hex(str(row))), payload=row, start_time=_epoch_to_iso(row.get("date")), source_updated_at=str(modified) if modified is not None else None))
            _set_watermark_epoch(db, resource="measures", epoch=max(updatetime, now_epoch))

    with db.sync_run(provider=WITHINGS_PROVIDER, resource="activity") as run:
        with db.transaction():
            wm = max(0, _watermark_epoch(db, resource="activity") - overlap)
            rows, _ = _iter_pages(sess, access_token=access, url=WITHINGS_MEASURE_V2, data={"action": "getactivity", "lastupdate": str(wm), "offset": "0", "data_fields": activity_fields}, key="activities")
            for row in rows:
                run.add_upsert(db.upsert_record(provider=WITHINGS_PROVIDER, resource="activity", record_id=str(row.get("date") or row.get("id") or sha256_hex(str(row))), payload=row, start_time=row.get("date")))
            _set_watermark_epoch(db, resource="activity", epoch=now_epoch)

    for resource, action, fields, url, key in [("workouts", "getworkouts", workout_fields, WITHINGS_MEASURE_V2, "series"), ("sleep_summary", "getsummary", sleep_fields, WITHINGS_SLEEP_V2, "series")]:
        with db.sync_run(provider=WITHINGS_PROVIDER, resource=resource) as run:
            with db.transaction():
                wm = max(0, _watermark_epoch(db, resource=resource) - overlap)
                rows, updatetime = _iter_pages(sess, access_token=access, url=url, data={"action": action, "lastupdate": str(wm), "data_fields": fields}, key=key)
                max_mod = 0
                for row in rows:
                    modified = row.get("modified")
                    if isinstance(modified, int):
                        max_mod = max(max_mod, modified)
                    run.add_upsert(db.upsert_record(provider=WITHINGS_PROVIDER, resource=resource, record_id=str(row.get("id") or row.get("startdate") or sha256_hex(str(row))), payload=row, start_time=_epoch_to_iso(row.get("startdate")), end_time=_epoch_to_iso(row.get("enddate")), source_updated_at=str(modified) if modified is not None else None))
                _set_watermark_epoch(db, resource=resource, epoch=max(now_epoch, updatetime, max_mod))

    print("Withings sync complete.")
