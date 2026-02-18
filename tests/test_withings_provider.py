from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import requests

from health_sync.config import AppConfig, Config, LoadedConfig, WithingsConfig
from health_sync.db import HealthSyncDb
from health_sync.providers.withings import _withings_refresh_if_needed


class WithingsAuthRefreshTests(unittest.TestCase):
    def _loaded_cfg(self, db_path: str) -> LoadedConfig:
        return LoadedConfig(
            path=Path("/tmp/health-sync.toml"),
            exists=True,
            config=Config(
                app=AppConfig(db=db_path),
                withings=WithingsConfig(enabled=True, client_id="withings-client", client_secret="withings-secret"),
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
                    provider="withings",
                    access_token="old-access",
                    refresh_token="old-refresh",
                    token_type="Bearer",
                    scope="user.metrics",
                    expires_at=expired_at,
                    extra={"old": True},
                )

                with (
                    patch("health_sync.providers.withings._withings_get_nonce", return_value="nonce-1"),
                    patch(
                        "health_sync.providers.withings.request_json",
                        return_value={
                            "status": 0,
                            "body": {
                                "access_token": "new-access",
                                "refresh_token": "new-refresh",
                                "token_type": "Bearer",
                                "scope": "user.metrics,user.activity",
                                "expires_in": 3600,
                                "userid": 12345,
                            },
                        },
                    ) as mock_request,
                ):
                    access = _withings_refresh_if_needed(db, cfg, requests.Session())

                self.assertEqual(access, "new-access")
                self.assertEqual(mock_request.call_count, 1)
                data = mock_request.call_args.kwargs["data"]
                self.assertEqual(data["grant_type"], "refresh_token")
                self.assertEqual(data["nonce"], "nonce-1")

                tok = db.get_oauth_token("withings")
                self.assertIsNotNone(tok)
                assert tok is not None
                self.assertEqual(tok["access_token"], "new-access")
                self.assertEqual(tok["refresh_token"], "new-refresh")
                self.assertEqual(tok["scope"], "user.metrics,user.activity")
                self.assertIsNotNone(tok["expires_at"])
                self.assertEqual(tok["extra"]["userid"], 12345)

    def test_missing_oauth_token_raises_helpful_error(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path)
            with HealthSyncDb(db_path) as db:
                db.init()
                with self.assertRaisesRegex(RuntimeError, "Missing Withings credentials"):
                    _withings_refresh_if_needed(db, cfg, requests.Session())

    def test_failed_refresh_response_raises(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path)
            expired_at = (datetime.now(UTC) - timedelta(minutes=5)).replace(microsecond=0).isoformat().replace("+00:00", "Z")

            with HealthSyncDb(db_path) as db:
                db.init()
                db.set_oauth_token(
                    provider="withings",
                    access_token="old-access",
                    refresh_token="old-refresh",
                    token_type="Bearer",
                    scope="user.metrics",
                    expires_at=expired_at,
                    extra=None,
                )

                with (
                    patch("health_sync.providers.withings._withings_get_nonce", return_value="nonce-1"),
                    patch(
                        "health_sync.providers.withings.request_json",
                        return_value={"status": 401, "error": "invalid_grant"},
                    ),
                ):
                    with self.assertRaisesRegex(RuntimeError, "Withings token refresh failed"):
                        _withings_refresh_if_needed(db, cfg, requests.Session())


if __name__ == "__main__":
    unittest.main()
