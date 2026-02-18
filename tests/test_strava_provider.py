from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from health_sync.config import AppConfig, Config, LoadedConfig, StravaConfig
from health_sync.db import HealthSyncDb
from health_sync.providers.strava import strava_sync
from health_sync.util import parse_yyyy_mm_dd, to_epoch_seconds


class StravaSyncWatermarkTests(unittest.TestCase):
    def _loaded_cfg(self, db_path: str, *, start_date: str, overlap_seconds: int = 604800) -> LoadedConfig:
        return LoadedConfig(
            path=Path("/tmp/health-sync.toml"),
            exists=True,
            config=Config(
                app=AppConfig(db=db_path),
                strava=StravaConfig(
                    enabled=True,
                    start_date=start_date,
                    overlap_seconds=overlap_seconds,
                    page_size=100,
                ),
            ),
        )

    def test_first_sync_with_no_activities_keeps_start_date_anchor(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path, start_date="2026-02-01")

            activity_params: list[dict[str, str]] = []

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
                if str(url).endswith("/athlete"):
                    return {"id": 123}
                if str(url).endswith("/athlete/activities"):
                    activity_params.append(dict(params or {}))
                    return []
                raise AssertionError(f"Unexpected URL: {url}")

            with HealthSyncDb(db_path) as db:
                db.init()
                with (
                    patch("health_sync.providers.strava._strava_refresh_if_needed", return_value="fake-token"),
                    patch("health_sync.providers.strava.request_json", side_effect=_fake_request_json),
                ):
                    strava_sync(db, cfg)

                st = db.get_sync_state(provider="strava", resource="activities")
                self.assertIsNotNone(st)
                self.assertEqual(st.watermark if st else None, "2026-02-01T00:00:00Z")

            self.assertEqual(len(activity_params), 1)
            expected_after = int(parse_yyyy_mm_dd("2026-02-01").timestamp())
            self.assertEqual(activity_params[0]["after"], str(expected_after))

    def test_no_new_activities_preserves_existing_watermark(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path, start_date="2026-02-01", overlap_seconds=3600)
            existing_wm = "2026-02-10T09:30:52Z"

            activity_params: list[dict[str, str]] = []

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
                if str(url).endswith("/athlete"):
                    return {"id": 123}
                if str(url).endswith("/athlete/activities"):
                    activity_params.append(dict(params or {}))
                    return []
                raise AssertionError(f"Unexpected URL: {url}")

            with HealthSyncDb(db_path) as db:
                db.init()
                db.set_sync_state(provider="strava", resource="activities", watermark=existing_wm)
                with (
                    patch("health_sync.providers.strava._strava_refresh_if_needed", return_value="fake-token"),
                    patch("health_sync.providers.strava.request_json", side_effect=_fake_request_json),
                ):
                    strava_sync(db, cfg)

                st = db.get_sync_state(provider="strava", resource="activities")
                self.assertIsNotNone(st)
                self.assertEqual(st.watermark if st else None, existing_wm)

            self.assertEqual(len(activity_params), 1)
            wm_epoch = to_epoch_seconds(existing_wm)
            assert wm_epoch is not None
            self.assertEqual(activity_params[0]["after"], str(max(0, wm_epoch - 3600)))

    def test_new_activities_advance_watermark_to_latest_start_date(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path, start_date="2026-02-01")

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
                if str(url).endswith("/athlete"):
                    return {"id": 123}
                if str(url).endswith("/athlete/activities"):
                    return [{"id": 1, "start_date": "2026-02-10T09:30:52Z"}]
                raise AssertionError(f"Unexpected URL: {url}")

            with HealthSyncDb(db_path) as db:
                db.init()
                with (
                    patch("health_sync.providers.strava._strava_refresh_if_needed", return_value="fake-token"),
                    patch("health_sync.providers.strava.request_json", side_effect=_fake_request_json),
                ):
                    strava_sync(db, cfg)

                st = db.get_sync_state(provider="strava", resource="activities")
                self.assertIsNotNone(st)
                self.assertEqual(st.watermark if st else None, "2026-02-10T09:30:52Z")


if __name__ == "__main__":
    unittest.main()
