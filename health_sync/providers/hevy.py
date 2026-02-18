from __future__ import annotations

from datetime import timedelta

import requests

from ..config import LoadedConfig
from ..db import HealthSyncDb
from ..util import dt_to_iso_z, iso_to_dt, request_json, sha256_hex, utc_now_iso

HEVY_PROVIDER = "hevy"
HEVY_BASE_DEFAULT = "https://api.hevyapp.com"


def _hevy_api_key(cfg: LoadedConfig) -> str:
    if cfg.config.hevy.api_key:
        return cfg.config.hevy.api_key
    raise RuntimeError(
        "Missing Hevy API key. Set `hevy.api_key` in your config file "
        f"({cfg.path}). You can get it from https://hevy.com/settings?developer"
    )


def _hevy_headers(api_key: str) -> dict[str, str]:
    return {"api-key": api_key, "User-Agent": "health-sync/0.1 (+local sqlite cache)", "Accept": "application/json"}


def _iso_max(a: str | None, b: str | None) -> str | None:
    if not a:
        return b
    if not b:
        return a
    try:
        return a if iso_to_dt(a) >= iso_to_dt(b) else b
    except Exception:  # noqa: BLE001
        return a


def _page_size(cfg: LoadedConfig) -> int:
    return max(1, min(10, int(cfg.config.hevy.page_size)))


def hevy_sync(db: HealthSyncDb, cfg: LoadedConfig) -> None:
    api_key = _hevy_api_key(cfg)
    sess = requests.Session()
    base_url = cfg.config.hevy.base_url or HEVY_BASE_DEFAULT
    state = db.get_sync_state(provider=HEVY_PROVIDER, resource="workouts")
    watermark = state.watermark if state else None
    page_size = _page_size(cfg)
    overlap_s = int(cfg.config.hevy.overlap_seconds)

    print("Syncing Hevy...")
    if not watermark:
        with db.sync_run(provider=HEVY_PROVIDER, resource="workouts") as run:
            with db.transaction():
                page, max_updated = 1, None
                while True:
                    j = request_json(
                        sess,
                        "GET",
                        f"{base_url}/v1/workouts",
                        headers=_hevy_headers(api_key),
                        params={"page": page, "pageSize": page_size},
                    )
                    for w in j.get("workouts") or []:
                        if not isinstance(w, dict):
                            continue
                        updated_at = w.get("updated_at") or w.get("created_at")
                        max_updated = _iso_max(max_updated, updated_at)
                        run.add_upsert(
                            db.upsert_record(
                                provider=HEVY_PROVIDER,
                                resource="workouts",
                                record_id=str(w.get("id") or sha256_hex(str(w))),
                                payload=w,
                                start_time=w.get("start_time"),
                                end_time=w.get("end_time"),
                                source_updated_at=updated_at,
                            )
                        )
                    if isinstance(j.get("page_count"), int) and page < j["page_count"]:
                        page += 1
                        continue
                    break
                db.set_sync_state(provider=HEVY_PROVIDER, resource="workouts", watermark=max_updated or utc_now_iso())
        print("Hevy initial backfill complete.")
        return

    try:
        since = dt_to_iso_z(iso_to_dt(watermark) - timedelta(seconds=overlap_s))
    except Exception:  # noqa: BLE001
        since = cfg.config.hevy.since

    with db.sync_run(provider=HEVY_PROVIDER, resource="workouts") as run_workouts:
        with db.sync_run(provider=HEVY_PROVIDER, resource="workout_events") as run_events:
            with db.transaction():
                page, max_event_time = 1, watermark
                while True:
                    j = request_json(
                        sess,
                        "GET",
                        f"{base_url}/v1/workouts/events",
                        headers=_hevy_headers(api_key),
                        params={"since": since, "page": page, "pageSize": page_size},
                    )
                    for ev in j.get("events") or []:
                        if not isinstance(ev, dict):
                            continue
                        ev_type = ev.get("type")
                        if ev_type == "updated" and isinstance(ev.get("workout"), dict):
                            w = ev["workout"]
                            rid = str(w.get("id") or sha256_hex(str(w)))
                            updated_at = w.get("updated_at") or w.get("created_at")
                            max_event_time = _iso_max(max_event_time, updated_at)
                            run_workouts.add_upsert(
                                db.upsert_record(
                                    provider=HEVY_PROVIDER,
                                    resource="workouts",
                                    record_id=rid,
                                    payload=w,
                                    start_time=w.get("start_time"),
                                    end_time=w.get("end_time"),
                                    source_updated_at=updated_at,
                                )
                            )
                            run_events.add_upsert(
                                db.upsert_record(
                                    provider=HEVY_PROVIDER,
                                    resource="workout_events",
                                    record_id=f"updated:{rid}:{updated_at or utc_now_iso()}",
                                    payload=ev,
                                    start_time=updated_at,
                                    end_time=None,
                                    source_updated_at=updated_at,
                                )
                            )
                        elif ev_type == "deleted":
                            rid, deleted_at = str(ev.get("id") or ""), ev.get("deleted_at")
                            max_event_time = _iso_max(max_event_time, deleted_at)
                            if rid:
                                run_workouts.add_delete(
                                    db.delete_record(provider=HEVY_PROVIDER, resource="workouts", record_id=rid)
                                )
                                run_events.add_upsert(
                                    db.upsert_record(
                                        provider=HEVY_PROVIDER,
                                        resource="workout_events",
                                        record_id=f"deleted:{rid}:{deleted_at or utc_now_iso()}",
                                        payload=ev,
                                        start_time=deleted_at,
                                        end_time=None,
                                        source_updated_at=deleted_at,
                                    )
                                )
                        else:
                            run_events.add_upsert(
                                db.upsert_record(
                                    provider=HEVY_PROVIDER,
                                    resource="workout_events",
                                    record_id=f"unknown:{sha256_hex(str(ev))}",
                                    payload=ev,
                                )
                            )
                    if isinstance(j.get("page_count"), int) and page < j["page_count"]:
                        page += 1
                        continue
                    break
                if max_event_time and max_event_time != watermark:
                    db.set_sync_state(provider=HEVY_PROVIDER, resource="workouts", watermark=max_event_time)

    print("Hevy sync complete.")
