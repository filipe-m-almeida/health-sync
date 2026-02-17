from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from health_sync.config import AppConfig, Config, LoadedConfig, OuraConfig
from health_sync.db import HealthSyncDb
from health_sync.providers.oura import oura_sync


class OuraSyncWindowTests(unittest.TestCase):
    def _loaded_cfg(self, db_path: str, *, start_date: str) -> LoadedConfig:
        return LoadedConfig(
            path=Path("/tmp/health-sync.toml"),
            exists=True,
            config=Config(
                app=AppConfig(db=db_path),
                oura=OuraConfig(enabled=True, start_date=start_date, overlap_days=1),
            ),
        )

    def test_sleep_endpoint_uses_next_day_end_date(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            today = datetime.now(UTC).date()
            cfg = self._loaded_cfg(db_path, start_date=today.isoformat())

            calls: list[tuple[str, dict | None]] = []

            def _fake_request_json(  # noqa: ANN202
                _sess,
                _method,
                url,
                *,
                headers=None,  # noqa: ARG001
                params=None,
                data=None,  # noqa: ARG001
                json_data=None,  # noqa: ARG001
                timeout_s=30,  # noqa: ARG001
            ):
                calls.append((str(url), params))
                if str(url).endswith("/v2/usercollection/personal_info"):
                    return {}
                return {"data": []}

            with HealthSyncDb(db_path) as db:
                db.init()
                with (
                    patch("health_sync.providers.oura._oura_refresh_if_needed", return_value="fake-token"),
                    patch("health_sync.providers.oura.request_json", side_effect=_fake_request_json),
                ):
                    oura_sync(db, cfg)

            daily_sleep_calls = [params for url, params in calls if url.endswith("/v2/usercollection/daily_sleep")]
            sleep_calls = [params for url, params in calls if url.endswith("/v2/usercollection/sleep")]

            self.assertEqual(len(daily_sleep_calls), 1)
            self.assertEqual(len(sleep_calls), 1)

            self.assertIsNotNone(daily_sleep_calls[0])
            self.assertIsNotNone(sleep_calls[0])

            assert daily_sleep_calls[0] is not None
            assert sleep_calls[0] is not None

            self.assertEqual(daily_sleep_calls[0]["end_date"], today.isoformat())
            self.assertEqual(sleep_calls[0]["end_date"], (today + timedelta(days=1)).isoformat())


if __name__ == "__main__":
    unittest.main()
