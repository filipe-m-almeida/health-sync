from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import requests

from ..db import HealthSyncDb
from ..util import getenv_default, iso_to_dt, request_json, sha256_hex, utc_now_iso


HEVY_PROVIDER = "hevy"
HEVY_BASE = os.environ.get("HEVY_BASE_URL", "https://api.hevyapp.com")


def _hevy_api_key() -> str:
    k = os.environ.get("HEVY_API_KEY")
    if not k:
        raise RuntimeError("Missing HEVY_API_KEY (get it from https://hevy.com/settings?developer)")
    return k


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


def hevy_sync(db: HealthSyncDb) -> None:
    api_key = _hevy_api_key()
    sess = requests.Session()

    overlap_s = int(getenv_default("HEVY_OVERLAP_SECONDS", "300"))
    page_size = int(getenv_default("HEVY_PAGE_SIZE", "10"))
    if page_size > 10:
        page_size = 10
    if page_size < 1:
        page_size = 1

    state = db.get_sync_state(provider=HEVY_PROVIDER, resource="workouts")
    watermark = state.watermark if state else None

    print("Syncing Hevy...")
    with db.transaction():
        if not watermark:
            # First run: fetch full list.
            page = 1
            max_updated: str | None = None
            while True:
                j = request_json(
                    sess,
                    "GET",
                    f"{HEVY_BASE}/v1/workouts",
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
                    db.upsert_record(
                        provider=HEVY_PROVIDER,
                        resource="workouts",
                        record_id=rid,
                        payload=w,
                        start_time=start_time,
                        end_time=end_time,
                        source_updated_at=updated_at,
                    )

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
            since = getenv_default("HEVY_SINCE", "1970-01-01T00:00:00Z")

        page = 1
        max_event_time: str | None = watermark
        while True:
            j = request_json(
                sess,
                "GET",
                f"{HEVY_BASE}/v1/workouts/events",
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
                        db.upsert_record(
                            provider=HEVY_PROVIDER,
                            resource="workouts",
                            record_id=rid,
                            payload=w,
                            start_time=start_time,
                            end_time=end_time,
                            source_updated_at=updated_at,
                        )
                        # Optional audit trail.
                        db.upsert_record(
                            provider=HEVY_PROVIDER,
                            resource="workout_events",
                            record_id=f"updated:{rid}:{updated_at or utc_now_iso()}",
                            payload=ev,
                            start_time=updated_at,
                            end_time=None,
                            source_updated_at=updated_at,
                        )
                elif ev_type == "deleted":
                    rid = str(ev.get("id") or "")
                    deleted_at = ev.get("deleted_at")
                    if rid:
                        db.delete_record(provider=HEVY_PROVIDER, resource="workouts", record_id=rid)
                        db.upsert_record(
                            provider=HEVY_PROVIDER,
                            resource="workout_events",
                            record_id=f"deleted:{rid}:{deleted_at or utc_now_iso()}",
                            payload=ev,
                            start_time=deleted_at,
                            end_time=None,
                            source_updated_at=deleted_at,
                        )
                    max_event_time = _iso_max(max_event_time, deleted_at)
                else:
                    # Unknown event type: store for inspection.
                    db.upsert_record(
                        provider=HEVY_PROVIDER,
                        resource="workout_events",
                        record_id=f"unknown:{sha256_hex(str(ev))}",
                        payload=ev,
                        start_time=None,
                        end_time=None,
                        source_updated_at=None,
                    )

            page_count = j.get("page_count")
            if isinstance(page_count, int) and page < page_count:
                page += 1
                continue
            break

        if max_event_time and (not watermark or max_event_time != watermark):
            db.set_sync_state(provider=HEVY_PROVIDER, resource="workouts", watermark=max_event_time)

    print("Hevy sync complete.")
