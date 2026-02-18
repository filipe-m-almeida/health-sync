from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from health_sync.config import (
    AppConfig,
    Config,
    EightSleepConfig,
    HevyConfig,
    LoadedConfig,
    OuraConfig,
    StravaConfig,
    WithingsConfig,
)
from health_sync.plugins import load_provider_plugins, provider_enabled


class _DemoPlugin:
    id = "demo"
    supports_auth = False
    description = "Demo plugin"

    def sync(self, db, cfg, helpers) -> None:  # noqa: ANN001
        _ = (db, cfg, helpers)


class _OtherIdPlugin:
    id = "other"
    supports_auth = False

    def sync(self, db, cfg, helpers) -> None:  # noqa: ANN001
        _ = (db, cfg, helpers)


class PluginLoadingTests(unittest.TestCase):
    def _cfg(self, db_path: str) -> LoadedConfig:
        return LoadedConfig(
            path=Path("/tmp/health-sync.toml"),
            exists=True,
            config=Config(
                app=AppConfig(db=db_path),
                oura=OuraConfig(enabled=False),
                withings=WithingsConfig(enabled=False),
                hevy=HevyConfig(enabled=False),
                strava=StravaConfig(enabled=False),
                eightsleep=EightSleepConfig(enabled=False),
                plugins={
                    "demo": {
                        "enabled": True,
                        "module": "demo_plugin:provider",
                    }
                },
            ),
        )

    def test_load_provider_plugins_accepts_config_module_plugin(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cfg = self._cfg(str(Path(td) / "health.sqlite"))

            with (
                patch("health_sync.plugins.loader._iter_entry_points", return_value=[]),
                patch("health_sync.plugins.loader._load_from_module_spec", return_value=_DemoPlugin()),
            ):
                plugins = load_provider_plugins(cfg)

            self.assertIn("demo", plugins)
            self.assertTrue(provider_enabled(cfg, "demo"))
            self.assertIn("oura", plugins)  # built-ins still present

    def test_load_provider_plugins_rejects_id_mismatch_for_config_module(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cfg = self._cfg(str(Path(td) / "health.sqlite"))

            with (
                patch("health_sync.plugins.loader._iter_entry_points", return_value=[]),
                patch("health_sync.plugins.loader._load_from_module_spec", return_value=_OtherIdPlugin()),
            ):
                with self.assertRaises(RuntimeError):
                    load_provider_plugins(cfg)

    def test_builtin_eightsleep_supports_auth(self) -> None:
        with patch("health_sync.plugins.loader._iter_entry_points", return_value=[]):
            plugins = load_provider_plugins(None)

        self.assertIn("eightsleep", plugins)
        self.assertTrue(bool(getattr(plugins["eightsleep"], "supports_auth", False)))


if __name__ == "__main__":
    unittest.main()
