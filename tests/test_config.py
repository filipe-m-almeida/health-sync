from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from health_sync.config import load_config


class ConfigLoadingTests(unittest.TestCase):
    def test_missing_file_returns_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cfg_path = Path(td) / "missing.toml"
            loaded = load_config(cfg_path)
            self.assertFalse(loaded.exists)
            self.assertEqual(loaded.config.app.db, "./health.sqlite")
            self.assertFalse(loaded.config.oura.enabled)

    def test_parses_bool_int_and_list_coercions(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cfg_path = Path(td) / "health-sync.toml"
            cfg_path.write_text(
                """
[oura]
enabled = "true"

[withings]
enabled = 1
meastypes = "1, 4, 5"

[hevy]
enabled = "yes"
page_size = "7"
""".strip()
            )
            loaded = load_config(cfg_path)
            self.assertTrue(loaded.config.oura.enabled)
            self.assertTrue(loaded.config.withings.enabled)
            self.assertEqual(loaded.config.withings.meastypes, ["1", "4", "5"])
            self.assertTrue(loaded.config.hevy.enabled)
            self.assertEqual(loaded.config.hevy.page_size, 7)

    def test_explicit_zero_values_are_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cfg_path = Path(td) / "health-sync.toml"
            cfg_path.write_text(
                """
[oura]
overlap_days = 0

[withings]
overlap_seconds = 0

[strava]
overlap_seconds = 0
page_size = 0

[eightsleep]
overlap_days = 0
""".strip()
            )
            loaded = load_config(cfg_path)
            self.assertEqual(loaded.config.oura.overlap_days, 0)
            self.assertEqual(loaded.config.withings.overlap_seconds, 0)
            self.assertEqual(loaded.config.strava.overlap_seconds, 0)
            self.assertEqual(loaded.config.strava.page_size, 0)
            self.assertEqual(loaded.config.eightsleep.overlap_days, 0)

    def test_invalid_toml_raises_runtime_error(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cfg_path = Path(td) / "health-sync.toml"
            cfg_path.write_text("[oura\nenabled = true")
            with self.assertRaisesRegex(RuntimeError, "Invalid TOML"):
                load_config(cfg_path)


if __name__ == "__main__":
    unittest.main()
