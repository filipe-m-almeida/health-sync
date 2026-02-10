from __future__ import annotations

import re
import secrets
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlencode, urlparse

import requests

from ..config import LoadedConfig, require_str
from ..db import HealthSyncDb
from ..util import (
    hmac_sha256_hex,
    iso_to_dt,
    oauth_listen_for_code,
    open_in_browser,
    request_json,
    sha256_hex,
    utc_now_iso,
)


WITHINGS_PROVIDER = "withings"
WITHINGS_AUTHORIZE = "https://account.withings.com/oauth2_user/authorize2"
WITHINGS_TOKEN = "https://wbsapi.withings.net/v2/oauth2"
WITHINGS_SIGNATURE = "https://wbsapi.withings.net/v2/signature"

WITHINGS_MEASURE = "https://wbsapi.withings.net/measure"
WITHINGS_MEASURE_V2 = "https://wbsapi.withings.net/v2/measure"
WITHINGS_SLEEP_V2 = "https://wbsapi.withings.net/v2/sleep"


def _withings_default_redirect_uri() -> str:
    return "http://127.0.0.1:8485/callback"


def _withings_redirect(cfg: LoadedConfig) -> tuple[str, int, str]:
    redirect_uri = cfg.config.withings.redirect_uri or _withings_default_redirect_uri()
    u = urlparse(redirect_uri)
    if u.scheme not in ("http", "https"):
        raise RuntimeError(f"Invalid `withings.redirect_uri`: {redirect_uri}")
    host = u.hostname or "127.0.0.1"
    port = u.port or (443 if u.scheme == "https" else 80)
    path = u.path or "/callback"
    return redirect_uri, port, path


def _withings_scopes(cfg: LoadedConfig) -> str:
    # Withings scopes are comma-separated. Sleep endpoints are covered by
    # `user.activity` (there is no `user.sleep` scope).
    raw = cfg.config.withings.scopes
    parts = [p.strip() for p in re.split(r"[\\s,]+", raw) if p and p.strip()]
    out: list[str] = []
    for p in parts:
        if p == "user.sleep":
            # Backwards-compat for older configs/docs.
            p = "user.activity"
        if p not in out:
            out.append(p)

    if "user.activity" in out and "user.sleep" in parts:
        print("Note: Withings scope `user.sleep` is not valid; using `user.activity` instead.")

    return ",".join(out) if out else raw


def _withings_signature_for(secret: str, *, action: str, client_id: str, timestamp: int | None = None, nonce: str | None = None) -> str:
    values: list[str] = [action, client_id]
    if timestamp is not None:
        values.append(str(timestamp))
    if nonce is not None:
        values.append(str(nonce))
    msg = ",".join(values)
    return hmac_sha256_hex(secret, msg)


def _withings_get_nonce(sess: requests.Session, *, client_id: str, client_secret: str) -> str:
    ts = int(time.time())
    sig = _withings_signature_for(client_secret, action="getnonce", client_id=client_id, timestamp=ts)
    j = request_json(
        sess,
        "POST",
        WITHINGS_SIGNATURE,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "action": "getnonce",
            "client_id": client_id,
            "timestamp": str(ts),
            "signature": sig,
        },
    )
    if j.get("status") != 0:
        raise RuntimeError(f"Withings getnonce failed: {j}")
    body = j.get("body") or {}
    nonce = body.get("nonce")
    if not nonce:
        raise RuntimeError(f"Withings getnonce response missing nonce: {j}")
    return str(nonce)


def withings_auth(db: HealthSyncDb, cfg: LoadedConfig, *, listen_host: str = "127.0.0.1", listen_port: int = 0) -> None:
    client_id = require_str(cfg, cfg.config.withings.client_id, key="withings.client_id")
    client_secret = require_str(cfg, cfg.config.withings.client_secret, key="withings.client_secret")
    redirect_uri, redirect_port, callback_path = _withings_redirect(cfg)

    if listen_port == 0:
        listen_port = redirect_port

    state = secrets.token_urlsafe(16)
    scope = _withings_scopes(cfg)

    auth_url = f"{WITHINGS_AUTHORIZE}?{urlencode({'response_type': 'code', 'client_id': client_id, 'redirect_uri': redirect_uri, 'scope': scope, 'state': state}, quote_via=quote)}"

    print("Open this URL to authorize Withings:")
    print(auth_url)
    open_in_browser(auth_url)

    res = oauth_listen_for_code(listen_host=listen_host, listen_port=listen_port, callback_path=callback_path)
    if res.error:
        raise RuntimeError(f"Withings auth error: {res.error}")
    if res.state and res.state != state:
        raise RuntimeError("Withings auth failed: state mismatch")

    sess = requests.Session()
    nonce = _withings_get_nonce(sess, client_id=client_id, client_secret=client_secret)
    sig = _withings_signature_for(client_secret, action="requesttoken", client_id=client_id, nonce=nonce)

    token = request_json(
        sess,
        "POST",
        WITHINGS_TOKEN,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "action": "requesttoken",
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": res.code,
            "redirect_uri": redirect_uri,
            "nonce": nonce,
            "signature": sig,
        },
    )

    if token.get("status") != 0:
        raise RuntimeError(f"Withings token exchange failed: {token}")
    body = token.get("body") or {}

    access_token = body["access_token"]
    refresh_token = body.get("refresh_token")
    token_type = body.get("token_type") or "Bearer"
    scope_resp = body.get("scope")
    expires_in = body.get("expires_in")

    expires_at = None
    if expires_in is not None:
        expires_at = (datetime.now(UTC) + timedelta(seconds=int(expires_in))).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    db.set_oauth_token(
        provider=WITHINGS_PROVIDER,
        access_token=access_token,
        refresh_token=refresh_token,
        token_type=token_type,
        scope=scope_resp,
        expires_at=expires_at,
        extra={k: v for k, v in body.items() if k not in {"access_token", "refresh_token", "token_type", "scope", "expires_in"}},
    )
    print("Stored Withings OAuth token in DB.")


def _withings_refresh_if_needed(db: HealthSyncDb, cfg: LoadedConfig, sess: requests.Session) -> str:
    tok = db.get_oauth_token(WITHINGS_PROVIDER)
    if not tok:
        raise RuntimeError(
            "Missing Withings credentials. Run `health-sync auth withings` "
            f"(config: {cfg.path})."
        )

    access_token = tok["access_token"]
    refresh_token = tok.get("refresh_token")
    expires_at = tok.get("expires_at")

    if not refresh_token or not expires_at:
        return access_token

    try:
        exp = iso_to_dt(expires_at)
    except Exception:  # noqa: BLE001
        exp = datetime.now(UTC) - timedelta(days=1)

    if exp - datetime.now(UTC) > timedelta(seconds=60):
        return access_token

    client_id = require_str(cfg, cfg.config.withings.client_id, key="withings.client_id")
    client_secret = require_str(cfg, cfg.config.withings.client_secret, key="withings.client_secret")

    nonce = _withings_get_nonce(sess, client_id=client_id, client_secret=client_secret)
    sig = _withings_signature_for(client_secret, action="requesttoken", client_id=client_id, nonce=nonce)

    token = request_json(
        sess,
        "POST",
        WITHINGS_TOKEN,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "action": "requesttoken",
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": refresh_token,
            "nonce": nonce,
            "signature": sig,
        },
    )

    if token.get("status") != 0:
        raise RuntimeError(f"Withings token refresh failed: {token}")
    body = token.get("body") or {}

    new_access = body["access_token"]
    new_refresh = body.get("refresh_token") or refresh_token
    token_type = body.get("token_type") or "Bearer"
    scope_resp = body.get("scope")
    expires_in = body.get("expires_in")

    expires_at_new = None
    if expires_in is not None:
        expires_at_new = (datetime.now(UTC) + timedelta(seconds=int(expires_in))).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    db.set_oauth_token(
        provider=WITHINGS_PROVIDER,
        access_token=new_access,
        refresh_token=new_refresh,
        token_type=token_type,
        scope=scope_resp,
        expires_at=expires_at_new,
        extra={k: v for k, v in body.items() if k not in {"access_token", "refresh_token", "token_type", "scope", "expires_in"}},
    )
    return new_access


def _withings_headers(access_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "health-sync/0.1 (+local sqlite cache)",
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
    }


def _watermark_epoch(db: HealthSyncDb, *, resource: str) -> int:
    st = db.get_sync_state(provider=WITHINGS_PROVIDER, resource=resource)
    if st and st.watermark and st.watermark.isdigit():
        return int(st.watermark)
    return 0


def _set_watermark_epoch(db: HealthSyncDb, *, resource: str, epoch: int) -> None:
    db.set_sync_state(provider=WITHINGS_PROVIDER, resource=resource, watermark=str(int(epoch)))


def withings_sync(db: HealthSyncDb, cfg: LoadedConfig) -> None:
    sess = requests.Session()
    access_token = _withings_refresh_if_needed(db, cfg, sess)

    overlap_s = int(cfg.config.withings.overlap_seconds)
    now_epoch = int(time.time())

    # Default to a broad list of measure types; can be overridden via config.
    meastypes = cfg.config.withings.meastypes
    if not meastypes:
        meastypes = [
            "1",   # Weight
            "4",   # Height
            "5",   # FatFreeMass
            "6",   # FatRatio
            "8",   # FatMassWeight
            "9",   # DiastolicBP
            "10",  # SystolicBP
            "11",  # HeartPulse
            "12",  # Temp
            "54",  # SPO2
            "71",  # BodyTemp
            "73",  # SkinTemp
            "76",  # MuscleMass
            "77",  # Hydration
            "88",  # BoneMass
            "91",  # Pulse Wave Velocity
            "123", # VO2 max
        ]

    activity_fields = [
        "steps",
        "distance",
        "elevation",
        "soft",
        "moderate",
        "intense",
        "active",
        "calories",
        "totalcalories",
        "hr_average",
        "hr_min",
        "hr_max",
        "hr_zone_0",
        "hr_zone_1",
        "hr_zone_2",
        "hr_zone_3",
    ]

    workout_fields = [
        "calories",
        "effduration",
        "intensity",
        "manual_distance",
        "manual_calories",
        "hr_average",
        "hr_min",
        "hr_max",
        "hr_zone_0",
        "hr_zone_1",
        "hr_zone_2",
        "hr_zone_3",
        "pause_duration",
        "algo_pause_duration",
        "spo2_average",
        "steps",
        "distance",
        "elevation",
        "pool_laps",
        "strokes",
        "pool_length",
    ]

    sleep_summary_fields = [
        "sleep_score",
        "lightsleepduration",
        "deepsleepduration",
        "remsleepduration",
        "wakeupcount",
        "wakeupduration",
        "durationtosleep",
        "durationtowakeup",
        "hr_average",
        "hr_min",
        "hr_max",
        "rr_average",
        "rr_min",
        "rr_max",
        "snoring",
        "snoringepisodecount",
        "breathing_disturbances_intensity",
    ]

    print("Syncing Withings...")

    with db.transaction():
        # Measures (body / vitals)
        resource = "measures"
        wm = max(0, _watermark_epoch(db, resource=resource) - overlap_s)
        offset = 0
        max_wm = wm
        while True:
            data = {
                "action": "getmeas",
                "meastype": ",".join(meastypes),
                "category": "1",
                "lastupdate": str(wm),
            }
            if offset:
                data["offset"] = str(offset)

            j = request_json(sess, "POST", WITHINGS_MEASURE, headers=_withings_headers(access_token), data=data)
            if j.get("status") != 0:
                raise RuntimeError(f"Withings getmeas failed: {j}")
            body = j.get("body") or {}

            measuregrps = body.get("measuregrps") or []
            for grp in measuregrps:
                if not isinstance(grp, dict):
                    continue
                rid = str(grp.get("grpid") or sha256_hex(str(grp)))
                ts = grp.get("date")
                start_time = None
                if isinstance(ts, int):
                    start_time = datetime.fromtimestamp(ts, tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
                modified = grp.get("modified")
                db.upsert_record(
                    provider=WITHINGS_PROVIDER,
                    resource=resource,
                    record_id=rid,
                    payload=grp,
                    start_time=start_time,
                    end_time=None,
                    source_updated_at=str(modified) if modified is not None else None,
                )

            # Watermark guidance: body.updatetime is common for getmeas.
            updatetime = body.get("updatetime")
            if isinstance(updatetime, int) and updatetime > max_wm:
                max_wm = updatetime

            more = body.get("more")
            offset_next = body.get("offset")
            if more in (1, True, "1") and offset_next:
                offset = int(offset_next)
                continue
            break

        _set_watermark_epoch(db, resource=resource, epoch=max(max_wm, now_epoch))

        # Activity (daily)
        resource = "activity"
        wm = max(0, _watermark_epoch(db, resource=resource) - overlap_s)
        offset = 0
        max_wm = now_epoch
        while True:
            data = {
                "action": "getactivity",
                "lastupdate": str(wm),
                "offset": str(offset),
                "data_fields": ",".join(activity_fields),
            }
            j = request_json(sess, "POST", WITHINGS_MEASURE_V2, headers=_withings_headers(access_token), data=data)
            if j.get("status") != 0:
                raise RuntimeError(f"Withings getactivity failed: {j}")
            body = j.get("body") or {}

            activities = body.get("activities") or []
            for act in activities:
                if not isinstance(act, dict):
                    continue
                rid = str(act.get("date") or act.get("id") or sha256_hex(str(act)))
                start_time = act.get("date")
                db.upsert_record(
                    provider=WITHINGS_PROVIDER,
                    resource=resource,
                    record_id=rid,
                    payload=act,
                    start_time=start_time,
                    end_time=None,
                    source_updated_at=None,
                )

            more = body.get("more")
            offset_next = body.get("offset")
            if more in (1, True, "1") and offset_next:
                offset = int(offset_next)
                continue
            break

        _set_watermark_epoch(db, resource=resource, epoch=max_wm)

        # Workouts
        resource = "workouts"
        wm = max(0, _watermark_epoch(db, resource=resource) - overlap_s)
        offset = 0
        max_wm = wm
        while True:
            data = {
                "action": "getworkouts",
                "lastupdate": str(wm),
                "offset": str(offset),
                "data_fields": ",".join(workout_fields),
            }
            j = request_json(sess, "POST", WITHINGS_MEASURE_V2, headers=_withings_headers(access_token), data=data)
            if j.get("status") != 0:
                raise RuntimeError(f"Withings getworkouts failed: {j}")
            body = j.get("body") or {}

            series = body.get("series") or []
            for w in series:
                if not isinstance(w, dict):
                    continue
                rid = str(w.get("id") or w.get("startdate") or sha256_hex(str(w)))
                start_time = None
                sd = w.get("startdate")
                ed = w.get("enddate")
                if isinstance(sd, int):
                    start_time = datetime.fromtimestamp(sd, tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
                end_time = None
                if isinstance(ed, int):
                    end_time = datetime.fromtimestamp(ed, tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
                modified = w.get("modified")
                if isinstance(modified, int) and modified > max_wm:
                    max_wm = modified
                db.upsert_record(
                    provider=WITHINGS_PROVIDER,
                    resource=resource,
                    record_id=rid,
                    payload=w,
                    start_time=start_time,
                    end_time=end_time,
                    source_updated_at=str(modified) if modified is not None else None,
                )

            more = body.get("more")
            offset_next = body.get("offset")
            if more in (1, True, "1") and offset_next:
                offset = int(offset_next)
                continue
            break

        _set_watermark_epoch(db, resource=resource, epoch=max(max_wm, now_epoch))

        # Sleep summaries (aggregated)
        resource = "sleep_summary"
        wm = max(0, _watermark_epoch(db, resource=resource) - overlap_s)
        max_wm = wm
        offset = 0
        while True:
            data = {
                "action": "getsummary",
                "lastupdate": str(wm),
                "data_fields": ",".join(sleep_summary_fields),
            }
            if offset:
                data["offset"] = str(offset)

            j = request_json(sess, "POST", WITHINGS_SLEEP_V2, headers=_withings_headers(access_token), data=data)
            if j.get("status") != 0:
                raise RuntimeError(f"Withings getsummary failed: {j}")
            body = j.get("body") or {}
            series = body.get("series") or []
            for s in series:
                if not isinstance(s, dict):
                    continue
                rid = str(s.get("id") or s.get("startdate") or sha256_hex(str(s)))
                start_time = None
                sd = s.get("startdate")
                ed = s.get("enddate")
                if isinstance(sd, int):
                    start_time = datetime.fromtimestamp(sd, tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
                end_time = None
                if isinstance(ed, int):
                    end_time = datetime.fromtimestamp(ed, tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
                modified = s.get("modified")
                if isinstance(modified, int) and modified > max_wm:
                    max_wm = modified
                db.upsert_record(
                    provider=WITHINGS_PROVIDER,
                    resource=resource,
                    record_id=rid,
                    payload=s,
                    start_time=start_time,
                    end_time=end_time,
                    source_updated_at=str(modified) if modified is not None else None,
                )

            more = body.get("more")
            offset_next = body.get("offset")
            if more in (1, True, "1") and offset_next:
                offset = int(offset_next)
                continue
            break

        _set_watermark_epoch(db, resource=resource, epoch=max(max_wm, now_epoch))

    print("Withings sync complete.")
