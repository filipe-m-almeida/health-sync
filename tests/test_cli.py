from __future__ import annotations

import unittest

from health_sync.cli import build_parser


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


if __name__ == "__main__":
    unittest.main()
