from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import requests

from health_sync.config import AppConfig, Config, EightSleepConfig, LoadedConfig
from health_sync.db import HealthSyncDb
from health_sync.providers.eightsleep import _eightsleep_refresh_if_needed, eightsleep_sync


class EightSleepProviderTests(unittest.TestCase):
    def _loaded_cfg(
        self,
        db_path: str,
        *,
        access_token: str | None = None,
        start_date: str = "2026-02-01",
        overlap_days: int = 2,
    ) -> LoadedConfig:
        return LoadedConfig(
            path=Path("/tmp/health-sync.toml"),
            exists=True,
            config=Config(
                app=AppConfig(db=db_path),
                eightsleep=EightSleepConfig(
                    enabled=True,
                    access_token=access_token,
                    email="user@example.com",
                    password="pw",
                    client_id="eight-client",
                    client_secret="eight-secret",
                    start_date=start_date,
                    overlap_days=overlap_days,
                ),
            ),
        )

    def test_refresh_uses_cached_unexpired_token(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path)
            future_expiry = (datetime.now(UTC) + timedelta(hours=1)).replace(microsecond=0).isoformat().replace("+00:00", "Z")

            with HealthSyncDb(db_path) as db:
                db.init()
                db.set_oauth_token(
                    provider="eightsleep",
                    access_token="cached-token",
                    refresh_token=None,
                    token_type="Bearer",
                    scope=None,
                    expires_at=future_expiry,
                    extra=None,
                )

                with patch("health_sync.providers.eightsleep.request_json") as mock_request:
                    access = _eightsleep_refresh_if_needed(db, cfg, requests.Session())

                self.assertEqual(access, "cached-token")
                mock_request.assert_not_called()

    def test_refresh_requests_and_persists_new_token(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path)

            with HealthSyncDb(db_path) as db:
                db.init()
                with patch(
                    "health_sync.providers.eightsleep.request_json",
                    return_value={"access_token": "new-token", "expires_in": 3600, "tenant": "demo"},
                ) as mock_request:
                    access = _eightsleep_refresh_if_needed(db, cfg, requests.Session())

                self.assertEqual(access, "new-token")
                self.assertEqual(mock_request.call_count, 1)
                payload = mock_request.call_args.kwargs["json_data"]
                self.assertEqual(payload["grant_type"], "password")
                self.assertEqual(payload["username"], "user@example.com")

                tok = db.get_oauth_token("eightsleep")
                self.assertIsNotNone(tok)
                assert tok is not None
                self.assertEqual(tok["access_token"], "new-token")
                self.assertIsNotNone(tok["expires_at"])
                self.assertEqual(tok["extra"]["tenant"], "demo")

    def test_sync_writes_users_devices_and_trends(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path, start_date="2026-02-01", overlap_days=2)
            trend_calls: list[tuple[str, dict[str, str]]] = []

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
                s = str(url)
                if s.endswith("/users/me"):
                    return {"user": {"id": "u1", "devices": ["d1"]}}
                if s.endswith("/devices/d1"):
                    return {"result": {"leftUserId": "u1", "rightUserId": "u2"}}
                if s.endswith("/users/u1"):
                    return {"user": {"id": "u1", "name": "Left"}}
                if s.endswith("/users/u2"):
                    return {"user": {"id": "u2", "name": "Right"}}
                if s.endswith("/users/u1/trends") or s.endswith("/users/u2/trends"):
                    trend_calls.append((s, dict(params or {})))
                    return {
                        "days": [
                            {
                                "day": "2026-02-11",
                                "presenceStart": "2026-02-11T01:00:00Z",
                                "presenceEnd": "2026-02-11T07:00:00Z",
                                "updatedAt": "2026-02-11T08:00:00Z",
                            }
                        ]
                    }
                raise AssertionError(f"Unexpected URL: {url}")

            with HealthSyncDb(db_path) as db:
                db.init()
                # Existing trend watermark should be used as the overlap anchor.
                db.set_sync_state(provider="eightsleep", resource="trends", watermark="2026-02-10T00:00:00Z")

                with (
                    patch("health_sync.providers.eightsleep._eightsleep_refresh_if_needed", return_value="fake-token"),
                    patch("health_sync.providers.eightsleep.request_json", side_effect=_fake_request_json),
                    patch("health_sync.providers.eightsleep.utc_now_iso", return_value="2026-02-18T00:00:00Z"),
                ):
                    eightsleep_sync(db, cfg)

                self.assertEqual(
                    db._c.execute(  # noqa: SLF001
                        "SELECT COUNT(*) AS cnt FROM records WHERE provider='eightsleep' AND resource='users_me';"
                    ).fetchone()["cnt"],
                    1,
                )
                self.assertEqual(
                    db._c.execute(  # noqa: SLF001
                        "SELECT COUNT(*) AS cnt FROM records WHERE provider='eightsleep' AND resource='devices';"
                    ).fetchone()["cnt"],
                    1,
                )
                self.assertEqual(
                    db._c.execute(  # noqa: SLF001
                        "SELECT COUNT(*) AS cnt FROM records WHERE provider='eightsleep' AND resource='users';"
                    ).fetchone()["cnt"],
                    2,
                )
                self.assertEqual(
                    db._c.execute(  # noqa: SLF001
                        "SELECT COUNT(*) AS cnt FROM records WHERE provider='eightsleep' AND resource='trends';"
                    ).fetchone()["cnt"],
                    2,
                )

                st_users = db.get_sync_state(provider="eightsleep", resource="users")
                st_trends = db.get_sync_state(provider="eightsleep", resource="trends")
                self.assertEqual(st_users.watermark if st_users else None, "2026-02-18T00:00:00Z")
                self.assertEqual(st_trends.watermark if st_trends else None, "2026-02-18T00:00:00Z")

            self.assertEqual(len(trend_calls), 2)
            for _url, params in trend_calls:
                self.assertEqual(params["from"], "2026-02-08")
                self.assertEqual(params["to"], datetime.now(UTC).date().isoformat())
                self.assertEqual(params["tz"], "UTC")


if __name__ == "__main__":
    unittest.main()
