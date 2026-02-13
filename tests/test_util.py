from __future__ import annotations

import unittest
import warnings
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

from health_sync.util import _parse_retry_after_seconds, to_epoch_seconds


class RetryAfterParsingTests(unittest.TestCase):
    def test_retry_after_seconds_numeric(self) -> None:
        self.assertEqual(_parse_retry_after_seconds("5"), 5)

    def test_retry_after_http_date(self) -> None:
        future = datetime.now(UTC) + timedelta(seconds=20)
        header = format_datetime(future, usegmt=True)
        parsed = _parse_retry_after_seconds(header)
        self.assertIsNotNone(parsed)
        self.assertGreaterEqual(parsed or 0, 1)
        self.assertLessEqual(parsed or 0, 25)

    def test_retry_after_invalid_warns(self) -> None:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            parsed = _parse_retry_after_seconds("nonsense")
        self.assertIsNone(parsed)
        self.assertTrue(any("Could not parse Retry-After header value" in str(w.message) for w in caught))


class EpochParsingTests(unittest.TestCase):
    def test_epoch_parsing_accepts_epoch_string(self) -> None:
        self.assertEqual(to_epoch_seconds("1770715852"), 1770715852)

    def test_epoch_parsing_accepts_iso(self) -> None:
        self.assertEqual(to_epoch_seconds("2026-02-10T09:30:52Z"), 1770715852)

    def test_epoch_parsing_accepts_date(self) -> None:
        self.assertEqual(to_epoch_seconds("2026-02-10"), 1770681600)


if __name__ == "__main__":
    unittest.main()
