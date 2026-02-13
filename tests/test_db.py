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


class DbTransactionTests(unittest.TestCase):
    def test_nested_transaction_after_prior_write(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = f"{td}/db.sqlite"
            with HealthSyncDb(db_path) as db:
                db.init()
                # Simulate provider token refresh write before an explicit transaction.
                db.set_oauth_token(
                    provider="withings",
                    access_token="token",
                    refresh_token="refresh",
                    token_type="Bearer",
                    scope="x",
                    expires_at="2026-02-12T00:00:00Z",
                    extra=None,
                )
                with db.transaction():
                    db.set_sync_state(provider="withings", resource="activity", watermark="1770715852")

                st = db.get_sync_state(provider="withings", resource="activity")
                self.assertIsNotNone(st)
                self.assertTrue((st.watermark if st else "").endswith("Z"))


class DbWatermarkAndRunTests(unittest.TestCase):
    def test_watermark_normalization(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = f"{td}/db.sqlite"
            with HealthSyncDb(db_path) as db:
                db.init()

                db.set_sync_state(provider="withings", resource="activity", watermark="1770715852")
                st_epoch = db.get_sync_state(provider="withings", resource="activity")
                self.assertIsNotNone(st_epoch)
                self.assertRegex(st_epoch.watermark if st_epoch else "", r"^\d{4}-\d{2}-\d{2}T")

                db.set_sync_state(provider="oura", resource="daily_sleep", watermark="2026-02-11")
                st_date = db.get_sync_state(provider="oura", resource="daily_sleep")
                self.assertEqual(st_date.watermark if st_date else None, "2026-02-11T00:00:00Z")

    def test_sync_run_records_counts_and_status(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = f"{td}/db.sqlite"
            with HealthSyncDb(db_path) as db:
                db.init()

                with db.sync_run(provider="oura", resource="daily_sleep") as run:
                    with db.transaction():
                        op = db.upsert_record(
                            provider="oura",
                            resource="daily_sleep",
                            record_id="2026-02-11",
                            payload={"id": "2026-02-11", "score": 80},
                            start_time="2026-02-11",
                        )
                        run.add_upsert(op)
                        op_same = db.upsert_record(
                            provider="oura",
                            resource="daily_sleep",
                            record_id="2026-02-11",
                            payload={"id": "2026-02-11", "score": 80},
                            start_time="2026-02-11",
                        )
                        run.add_upsert(op_same)
                        deleted = db.delete_record(provider="oura", resource="daily_sleep", record_id="2026-02-11")
                        run.add_delete(deleted)
                        db.set_sync_state(provider="oura", resource="daily_sleep", watermark="2026-02-12")

                runs = list(db.iter_sync_runs(limit=1))
                self.assertEqual(len(runs), 1)
                row = runs[0]
                self.assertEqual(row["status"], "success")
                self.assertEqual(row["inserted_count"], 1)
                self.assertEqual(row["updated_count"], 0)
                self.assertEqual(row["unchanged_count"], 1)
                self.assertEqual(row["deleted_count"], 1)
                self.assertEqual(row["watermark_after"], "2026-02-12T00:00:00Z")

    def test_sync_run_records_error(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = f"{td}/db.sqlite"
            with HealthSyncDb(db_path) as db:
                db.init()

                with self.assertRaisesRegex(RuntimeError, "boom"):
                    with db.sync_run(provider="oura", resource="daily_activity") as run:
                        with db.transaction():
                            op = db.upsert_record(
                                provider="oura",
                                resource="daily_activity",
                                record_id="2026-02-12",
                                payload={"id": "2026-02-12", "steps": 10000},
                                start_time="2026-02-12",
                            )
                            run.add_upsert(op)
                            raise RuntimeError("boom")

                runs = list(db.iter_sync_runs(limit=1))
                self.assertEqual(len(runs), 1)
                row = runs[0]
                self.assertEqual(row["status"], "error")
                self.assertIn("boom", row["error_text"])


if __name__ == "__main__":
    unittest.main()
