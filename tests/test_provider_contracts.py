from __future__ import annotations

import tempfile
import unittest

from health_sync.db import HealthSyncDb
from health_sync.providers.strava import _watermark_epoch as strava_watermark_epoch
from health_sync.providers.withings import _watermark_epoch as withings_watermark_epoch


class ProviderWatermarkContractTests(unittest.TestCase):
    def test_withings_watermark_parses_normalized_iso(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = f"{td}/db.sqlite"
            with HealthSyncDb(db_path) as db:
                db.init()
                db.set_sync_state(provider="withings", resource="activity", watermark="1770715852")
                # set_sync_state normalizes epoch -> ISO, provider parser should still work.
                self.assertEqual(withings_watermark_epoch(db, resource="activity"), 1770715852)

    def test_strava_watermark_parses_date_watermark(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = f"{td}/db.sqlite"
            with HealthSyncDb(db_path) as db:
                db.init()
                db.set_sync_state(provider="strava", resource="activities", watermark="2026-02-10")
                self.assertEqual(strava_watermark_epoch(db, resource="activities"), 1770681600)


if __name__ == "__main__":
    unittest.main()
