from __future__ import annotations

import tempfile
import unittest
import warnings

from health_sync.db import HealthSyncDb


class DbWarningTests(unittest.TestCase):
    def test_get_sync_state_warns_on_invalid_extra_json(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = f"{td}/db.sqlite"
            with HealthSyncDb(db_path) as db:
                db.init()
                db._c.execute(  # noqa: SLF001
                    """
                    INSERT INTO sync_state(provider, resource, watermark, cursor, extra_json, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?);
                    """,
                    ("oura", "daily_sleep", "2026-02-12", None, "{broken-json", "2026-02-12T00:00:00Z"),
                )
                with warnings.catch_warnings(record=True) as caught:
                    warnings.simplefilter("always")
                    state = db.get_sync_state(provider="oura", resource="daily_sleep")
                self.assertIsNotNone(state)
                self.assertIsNone(state.extra if state else None)
                self.assertTrue(any("Invalid JSON in sync_state oura/daily_sleep" in str(w.message) for w in caught))

    def test_get_oauth_token_warns_on_invalid_extra_json(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = f"{td}/db.sqlite"
            with HealthSyncDb(db_path) as db:
                db.init()
                db._c.execute(  # noqa: SLF001
                    """
                    INSERT INTO oauth_tokens(provider, access_token, refresh_token, token_type, scope, expires_at, obtained_at, extra_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                    """,
                    ("oura", "abc", None, "Bearer", None, None, "2026-02-12T00:00:00Z", "{bad-json"),
                )
                with warnings.catch_warnings(record=True) as caught:
                    warnings.simplefilter("always")
                    tok = db.get_oauth_token("oura")
                self.assertIsNotNone(tok)
                self.assertIsNone(tok["extra"] if tok else None)
                self.assertTrue(any("Invalid JSON in oauth_tokens oura" in str(w.message) for w in caught))


if __name__ == "__main__":
    unittest.main()
