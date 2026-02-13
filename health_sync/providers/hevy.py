from __future__ import annotations

from datetime import UTC, datetime, timedelta

import requests

from ..config import LoadedConfig
from ..db import HealthSyncDb
from ..util import iso_to_dt, request_json, sha256_hex, utc_now_iso


HEVY_PROVIDER = "hevy"
HEVY_BASE_DEFAULT = "https://api.hevyapp.com"


def _hevy_api_key(cfg: LoadedConfig) -> str:
    k = cfg.config.hevy.api_key
    if k:
        return k
    raise RuntimeError(
        "Missing Hevy API key. Set `hevy.api_key` in your config file "
        f"({cfg.path}). You can get it from https://hevy.com/settings?developer"
    )


def _hevy_headers(api_key: str) -> dict[str, str]:
    return {
        "api-key": api_key,
        "User-Agent": "health-sync/0.1 (+local sqlite cache)",
        "Accept": "application/json",
    }


def _iso_max(a: str | None, b: str | None) -> str | None:
    if not a:
        return b
    if not b:
        return a
    try:
        return a if iso_to_dt(a) >= iso_to_dt(b) else b
    except Exception:  # noqa: BLE001
        return a


def hevy_sync(db: HealthSyncDb, cfg: LoadedConfig) -> None:
    api_key = _hevy_api_key(cfg)
    sess = requests.Session()

    base_url = cfg.config.hevy.base_url or HEVY_BASE_DEFAULT
    overlap_s = int(cfg.config.hevy.overlap_seconds)
    page_size = int(cfg.config.hevy.page_size)
    if page_size > 10:
        page_size = 10
    if page_size < 1:
        page_size = 1

    state = db.get_sync_state(provider=HEVY_PROVIDER, resource="workouts")
    watermark = state.watermark if state else None

    print("Syncing Hevy...")

    if not watermark:
        # First run: fetch full list.
        with db.sync_run(provider=HEVY_PROVIDER, resource="workouts") as run_workouts:
            with db.transaction():
                page = 1
                max_updated: str | None = None
                while True:
                    j = request_json(
                        sess,
                        "GET",
                        f"{base_url}/v1/workouts",
                        headers=_hevy_headers(api_key),
                        params={"page": page, "pageSize": page_size},
                    )

                    workouts = j.get("workouts") or []
                    for w in workouts:
                        if not isinstance(w, dict):
                            continue
                        rid = str(w.get("id") or sha256_hex(str(w)))
                        start_time = w.get("start_time")
                        end_time = w.get("end_time")
                        updated_at = w.get("updated_at") or w.get("created_at")
                        max_updated = _iso_max(max_updated, updated_at)
                        op = db.upsert_record(
                            provider=HEVY_PROVIDER,
                            resource="workouts",
                            record_id=rid,
                            payload=w,
                            start_time=start_time,
                            end_time=end_time,
                            source_updated_at=updated_at,
                        )
                        run_workouts.add_upsert(op)

                    page_count = j.get("page_count")
                    if isinstance(page_count, int) and page < page_count:
                        page += 1
                        continue
                    break

                db.set_sync_state(provider=HEVY_PROVIDER, resource="workouts", watermark=max_updated or utc_now_iso())
        print("Hevy initial backfill complete.")
        return

    # Delta sync: events since watermark with overlap.
    try:
        since_dt = iso_to_dt(watermark) - timedelta(seconds=overlap_s)
        since = since_dt.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    except Exception:  # noqa: BLE001
        since = cfg.config.hevy.since

    page = 1
    max_event_time: str | None = watermark
    with db.sync_run(provider=HEVY_PROVIDER, resource="workouts") as run_workouts:
        with db.sync_run(provider=HEVY_PROVIDER, resource="workout_events") as run_events:
            with db.transaction():
                while True:
                    j = request_json(
                        sess,
                        "GET",
                        f"{base_url}/v1/workouts/events",
                        headers=_hevy_headers(api_key),
                        params={"since": since, "page": page, "pageSize": page_size},
                    )

                    events = j.get("events") or []
                    for ev in events:
                        if not isinstance(ev, dict):
                            continue
                        ev_type = ev.get("type")
                        if ev_type == "updated":
                            w = ev.get("workout") or {}
                            if isinstance(w, dict):
                                rid = str(w.get("id") or sha256_hex(str(w)))
                                start_time = w.get("start_time")
                                end_time = w.get("end_time")
                                updated_at = w.get("updated_at") or w.get("created_at")
                                max_event_time = _iso_max(max_event_time, updated_at)
                                op = db.upsert_record(
                                    provider=HEVY_PROVIDER,
                                    resource="workouts",
                                    record_id=rid,
                                    payload=w,
                                    start_time=start_time,
                                    end_time=end_time,
                                    source_updated_at=updated_at,
                                )
                                run_workouts.add_upsert(op)
                                # Optional audit trail.
                                op_event = db.upsert_record(
                                    provider=HEVY_PROVIDER,
                                    resource="workout_events",
                                    record_id=f"updated:{rid}:{updated_at or utc_now_iso()}",
                                    payload=ev,
                                    start_time=updated_at,
                                    end_time=None,
                                    source_updated_at=updated_at,
                                )
                                run_events.add_upsert(op_event)
                        elif ev_type == "deleted":
                            rid = str(ev.get("id") or "")
                            deleted_at = ev.get("deleted_at")
                            if rid:
                                deleted = db.delete_record(provider=HEVY_PROVIDER, resource="workouts", record_id=rid)
                                run_workouts.add_delete(deleted)
                                op_event = db.upsert_record(
                                    provider=HEVY_PROVIDER,
                                    resource="workout_events",
                                    record_id=f"deleted:{rid}:{deleted_at or utc_now_iso()}",
                                    payload=ev,
                                    start_time=deleted_at,
                                    end_time=None,
                                    source_updated_at=deleted_at,
                                )
                                run_events.add_upsert(op_event)
                            max_event_time = _iso_max(max_event_time, deleted_at)
                        else:
                            # Unknown event type: store for inspection.
                            op_event = db.upsert_record(
                                provider=HEVY_PROVIDER,
                                resource="workout_events",
                                record_id=f"unknown:{sha256_hex(str(ev))}",
                                payload=ev,
                                start_time=None,
                                end_time=None,
                                source_updated_at=None,
                            )
                            run_events.add_upsert(op_event)

                    page_count = j.get("page_count")
                    if isinstance(page_count, int) and page < page_count:
                        page += 1
                        continue
                    break

                if max_event_time and (not watermark or max_event_time != watermark):
                    db.set_sync_state(provider=HEVY_PROVIDER, resource="workouts", watermark=max_event_time)

    print("Hevy sync complete.")
