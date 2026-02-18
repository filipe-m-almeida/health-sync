from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from health_sync.config import AppConfig, Config, HevyConfig, LoadedConfig
from health_sync.db import HealthSyncDb
from health_sync.providers.hevy import hevy_sync


class HevySyncTests(unittest.TestCase):
    def _loaded_cfg(self, db_path: str, *, overlap_seconds: int = 300) -> LoadedConfig:
        return LoadedConfig(
            path=Path("/tmp/health-sync.toml"),
            exists=True,
            config=Config(
                app=AppConfig(db=db_path),
                hevy=HevyConfig(
                    enabled=True,
                    api_key="hevy-key",
                    overlap_seconds=overlap_seconds,
                    page_size=10,
                ),
            ),
        )

    def test_initial_backfill_sets_watermark_from_latest_workout_update(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path)

            def _fake_request_json(  # noqa: ANN202
                _sess,
                _method,
                url,
                *,
                headers=None,  # noqa: ARG001
                params=None,  # noqa: ARG001
                data=None,  # noqa: ARG001
                json_data=None,  # noqa: ARG001
                timeout_s=60,  # noqa: ARG001
                max_retries=5,  # noqa: ARG001
            ):
                if str(url).endswith("/v1/workouts"):
                    return {
                        "workouts": [
                            {"id": "w1", "start_time": "2026-02-10T07:00:00Z", "updated_at": "2026-02-10T08:00:00Z"},
                            {"id": "w2", "start_time": "2026-02-11T07:00:00Z", "updated_at": "2026-02-11T08:00:00Z"},
                        ],
                        "page_count": 1,
                    }
                raise AssertionError(f"Unexpected URL: {url}")

            with HealthSyncDb(db_path) as db:
                db.init()
                with patch("health_sync.providers.hevy.request_json", side_effect=_fake_request_json):
                    hevy_sync(db, cfg)

                st = db.get_sync_state(provider="hevy", resource="workouts")
                self.assertIsNotNone(st)
                self.assertEqual(st.watermark if st else None, "2026-02-11T08:00:00Z")
                cnt = db._c.execute(  # noqa: SLF001
                    "SELECT COUNT(*) AS cnt FROM records WHERE provider='hevy' AND resource='workouts';"
                ).fetchone()["cnt"]
                self.assertEqual(cnt, 2)

    def test_delta_sync_processes_updated_deleted_and_unknown_events(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path, overlap_seconds=300)

            seen_since: list[str] = []

            def _fake_request_json(  # noqa: ANN202
                _sess,
                _method,
                url,
                *,
                headers=None,  # noqa: ARG001
                params=None,
                data=None,  # noqa: ARG001
                json_data=None,  # noqa: ARG001
                timeout_s=60,  # noqa: ARG001
                max_retries=5,  # noqa: ARG001
            ):
                if str(url).endswith("/v1/workouts/events"):
                    seen_since.append(str((params or {}).get("since")))
                    return {
                        "events": [
                            {
                                "type": "updated",
                                "workout": {
                                    "id": "w-updated",
                                    "start_time": "2026-02-12T06:00:00Z",
                                    "end_time": "2026-02-12T07:00:00Z",
                                    "updated_at": "2026-02-12T08:00:00Z",
                                },
                            },
                            {
                                "type": "deleted",
                                "id": "w-deleted",
                                "deleted_at": "2026-02-13T09:00:00Z",
                            },
                            {"type": "mystery", "foo": "bar"},
                        ],
                        "page_count": 1,
                    }
                raise AssertionError(f"Unexpected URL: {url}")

            with HealthSyncDb(db_path) as db:
                db.init()
                db.set_sync_state(provider="hevy", resource="workouts", watermark="2026-02-12T00:00:00Z")
                db.upsert_record(
                    provider="hevy",
                    resource="workouts",
                    record_id="w-deleted",
                    payload={"id": "w-deleted"},
                    start_time="2026-02-11T00:00:00Z",
                )

                with patch("health_sync.providers.hevy.request_json", side_effect=_fake_request_json):
                    hevy_sync(db, cfg)

                st = db.get_sync_state(provider="hevy", resource="workouts")
                self.assertIsNotNone(st)
                self.assertEqual(st.watermark if st else None, "2026-02-13T09:00:00Z")
                self.assertEqual(len(seen_since), 1)
                self.assertEqual(seen_since[0], "2026-02-11T23:55:00Z")

                deleted = db._c.execute(  # noqa: SLF001
                    """
                    SELECT 1 FROM records
                    WHERE provider='hevy' AND resource='workouts' AND record_id='w-deleted';
                    """
                ).fetchone()
                self.assertIsNone(deleted)

                events_cnt = db._c.execute(  # noqa: SLF001
                    "SELECT COUNT(*) AS cnt FROM records WHERE provider='hevy' AND resource='workout_events';"
                ).fetchone()["cnt"]
                self.assertEqual(events_cnt, 3)


if __name__ == "__main__":
    unittest.main()
