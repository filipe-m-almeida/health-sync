from __future__ import annotations

import argparse
import io
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from health_sync.cli import build_parser, cmd_sync
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


class CliArgParsingTests(unittest.TestCase):
    def test_global_db_before_subcommand_is_preserved(self) -> None:
        parser = build_parser()
        args = parser.parse_args(["--db", "/tmp/global.sqlite", "status"])
        self.assertEqual(args.db, "/tmp/global.sqlite")

    def test_global_config_before_subcommand_is_preserved(self) -> None:
        parser = build_parser()
        args = parser.parse_args(["--config", "/tmp/health-sync.toml", "status"])
        self.assertEqual(args.config, "/tmp/health-sync.toml")

    def test_subcommand_value_overrides_global_value(self) -> None:
        parser = build_parser()
        args = parser.parse_args(["--db", "/tmp/global.sqlite", "status", "--db", "/tmp/sub.sqlite"])
        self.assertEqual(args.db, "/tmp/sub.sqlite")

    def test_providers_subcommand_is_available(self) -> None:
        parser = build_parser()
        args = parser.parse_args(["providers"])
        self.assertEqual(args.cmd, "providers")


class _FakePlugin:
    def __init__(self, provider_id: str, sync_fn) -> None:
        self.id = provider_id
        self.source = "test"
        self.description = None
        self.supports_auth = False
        self._sync_fn = sync_fn

    def sync(self, db, cfg, helpers) -> None:  # noqa: ANN001
        self._sync_fn(db, cfg, helpers)


class SyncResilienceTests(unittest.TestCase):
    def _loaded_cfg(self, db_path: str) -> LoadedConfig:
        return LoadedConfig(
            path=Path("/tmp/health-sync.toml"),
            exists=True,
            config=Config(
                app=AppConfig(db=db_path),
                oura=OuraConfig(enabled=True),
                withings=WithingsConfig(enabled=True),
                hevy=HevyConfig(enabled=True),
                strava=StravaConfig(enabled=False),
                eightsleep=EightSleepConfig(enabled=False),
            ),
        )

    def test_cmd_sync_continues_when_one_provider_fails(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path)
            args = argparse.Namespace(db=db_path, providers=["oura", "withings", "hevy"])

            calls: list[str] = []

            def _ok_oura(*_args, **_kwargs) -> None:
                calls.append("oura")

            def _fail_withings(*_args, **_kwargs) -> None:
                calls.append("withings")
                raise RuntimeError("boom")

            def _ok_hevy(*_args, **_kwargs) -> None:
                calls.append("hevy")

            plugins = {
                "oura": _FakePlugin("oura", _ok_oura),
                "withings": _FakePlugin("withings", _fail_withings),
                "hevy": _FakePlugin("hevy", _ok_hevy),
            }

            stderr = io.StringIO()
            with (
                patch("health_sync.cli.load_provider_plugins", return_value=plugins),
                redirect_stderr(stderr),
            ):
                rc = cmd_sync(args, cfg)

            self.assertEqual(rc, 0)
            self.assertEqual(calls, ["oura", "withings", "hevy"])
            err = stderr.getvalue()
            self.assertIn("WARNING: withings sync failed: boom", err)
            self.assertIn("Sync completed with warnings (1/3 providers failed): withings", err)

    def test_cmd_sync_returns_nonzero_if_all_selected_providers_fail(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db_path = str(Path(td) / "health.sqlite")
            cfg = self._loaded_cfg(db_path)
            args = argparse.Namespace(db=db_path, providers=["oura", "withings"])

            calls: list[str] = []

            def _fail_oura(*_args, **_kwargs) -> None:
                calls.append("oura")
                raise RuntimeError("oura down")

            def _fail_withings(*_args, **_kwargs) -> None:
                calls.append("withings")
                raise RuntimeError("withings down")

            plugins = {
                "oura": _FakePlugin("oura", _fail_oura),
                "withings": _FakePlugin("withings", _fail_withings),
            }

            stderr = io.StringIO()
            with (
                patch("health_sync.cli.load_provider_plugins", return_value=plugins),
                redirect_stderr(stderr),
            ):
                rc = cmd_sync(args, cfg)

            self.assertEqual(rc, 1)
            self.assertEqual(calls, ["oura", "withings"])
            err = stderr.getvalue()
            self.assertIn("WARNING: oura sync failed: oura down", err)
            self.assertIn("WARNING: withings sync failed: withings down", err)
            self.assertIn("All selected providers failed.", err)


if __name__ == "__main__":
    unittest.main()
