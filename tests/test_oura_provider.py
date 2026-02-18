from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import requests

from health_sync.config import AppConfig, Config, LoadedConfig, OuraConfig
from health_sync.db import HealthSyncDb
from health_sync.providers.oura import _oura_refresh_if_needed, oura_sync


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


class OuraAuthRefreshTests(unittest.TestCase):
    def _loaded_cfg(self, db_path: str) -> LoadedConfig:
        return LoadedConfig(
            path=Path("/tmp/health-sync.toml"),
            exists=True,
            config=Config(
                app=AppConfig(db=db_path),
                oura=OuraConfig(enabled=True, client_id="oura-client", client_secret="oura-secret"),
            ),
        )

    def test_expired_oauth_token_is_refreshed_and_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path)
            expired_at = (datetime.now(UTC) - timedelta(minutes=5)).replace(microsecond=0).isoformat().replace("+00:00", "Z")

            with HealthSyncDb(db_path) as db:
                db.init()
                db.set_oauth_token(
                    provider="oura",
                    access_token="old-access",
                    refresh_token="old-refresh",
                    token_type="Bearer",
                    scope="old-scope",
                    expires_at=expired_at,
                    extra={"old": True},
                )

                with patch(
                    "health_sync.providers.oura.request_json",
                    return_value={
                        "access_token": "new-access",
                        "refresh_token": "new-refresh",
                        "token_type": "Bearer",
                        "scope": "new-scope",
                        "expires_in": 3600,
                        "provider_user_id": "123",
                    },
                ) as mock_request:
                    access = _oura_refresh_if_needed(db, cfg, requests.Session())

                self.assertEqual(access, "new-access")
                self.assertEqual(mock_request.call_count, 1)
                self.assertEqual(mock_request.call_args.kwargs["data"]["grant_type"], "refresh_token")

                tok = db.get_oauth_token("oura")
                self.assertIsNotNone(tok)
                assert tok is not None
                self.assertEqual(tok["access_token"], "new-access")
                self.assertEqual(tok["refresh_token"], "new-refresh")
                self.assertEqual(tok["scope"], "new-scope")
                self.assertIsNotNone(tok["expires_at"])
                self.assertEqual(tok["extra"]["provider_user_id"], "123")

    def test_missing_oauth_token_raises_helpful_error(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path)
            with HealthSyncDb(db_path) as db:
                db.init()
                with self.assertRaisesRegex(RuntimeError, "Missing Oura credentials"):
                    _oura_refresh_if_needed(db, cfg, requests.Session())


if __name__ == "__main__":
    unittest.main()
