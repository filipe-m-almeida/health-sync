from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

from health_sync.db import HealthSyncDb
from health_sync.providers.runtime import (
    build_auth_url,
    parse_redirect_uri,
    sync_resource,
    token_expiring_soon,
    upsert_item,
)


class ProviderRuntimeTests(unittest.TestCase):
    def test_parse_redirect_uri_uses_defaults_when_not_set(self) -> None:
        spec = parse_redirect_uri(None, default_uri="http://127.0.0.1:8486/callback", key_name="strava.redirect_uri")
        self.assertEqual(spec.redirect_uri, "http://127.0.0.1:8486/callback")
        self.assertEqual(spec.listen_host, "127.0.0.1")
        self.assertEqual(spec.listen_port, 8486)
        self.assertEqual(spec.callback_path, "/callback")

    def test_parse_redirect_uri_rejects_invalid_scheme(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "Invalid `oura.redirect_uri`"):
            parse_redirect_uri("ftp://localhost/callback", default_uri="http://localhost:8484/callback", key_name="oura.redirect_uri")

    def test_build_auth_url_encodes_params(self) -> None:
        url = build_auth_url(
            "https://example.test/auth",
            {
                "scope": "read write",
                "state": "abc123",
                "nullable": None,
            },
        )
        self.assertIn("scope=read%20write", url)
        self.assertIn("state=abc123", url)
        self.assertNotIn("nullable=", url)

    def test_token_expiring_soon(self) -> None:
        now = datetime(2026, 2, 18, 0, 0, 0, tzinfo=UTC)
        self.assertFalse(token_expiring_soon("2026-02-18T00:10:00Z", now=now, skew_seconds=60))
        self.assertTrue(token_expiring_soon("2026-02-18T00:00:20Z", now=now, skew_seconds=60))
        self.assertTrue(token_expiring_soon("not-a-date", now=now, skew_seconds=60))

    def test_sync_resource_wraps_sync_run_and_transaction(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            with HealthSyncDb(db_path) as db:
                db.init()
                with sync_resource(db, provider="demo", resource="items") as run:
                    upsert_item(
                        db,
                        run,
                        provider="demo",
                        resource="items",
                        item={"id": "1", "start_time": "2026-02-18T00:00:00Z", "updated_at": "2026-02-18T00:10:00Z"},
                        record_id_keys=("id",),
                        start_keys=("start_time",),
                        updated_keys=("updated_at",),
                    )
                    db.set_sync_state(provider="demo", resource="items", watermark="2026-02-18T00:10:00Z")

                runs = list(db.iter_sync_runs(limit=1))
                self.assertEqual(len(runs), 1)
                self.assertEqual(runs[0]["status"], "success")
                self.assertEqual(runs[0]["inserted_count"], 1)


if __name__ == "__main__":
    unittest.main()
