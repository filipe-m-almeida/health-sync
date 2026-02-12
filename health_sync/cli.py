from __future__ import annotations

import argparse
import sys

from .config import DEFAULT_CONFIG_FILENAME, LoadedConfig, load_config
from .db import HealthSyncDb
from .providers.eightsleep import eightsleep_sync
from .providers.hevy import hevy_sync
from .providers.oura import oura_auth, oura_sync
from .providers.strava import strava_auth, strava_sync
from .providers.withings import withings_auth, withings_sync


def cmd_init_db(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    with HealthSyncDb(args.db) as db:
        db.init()
    print(f"Initialized DB at: {args.db}")
    return 0


def cmd_auth(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    with HealthSyncDb(args.db) as db:
        db.init()
        if args.provider == "oura":
            oura_auth(db, cfg, listen_host=args.listen_host, listen_port=args.listen_port)
            return 0
        if args.provider == "withings":
            withings_auth(db, cfg, listen_host=args.listen_host, listen_port=args.listen_port)
            return 0
        if args.provider == "strava":
            strava_auth(db, cfg, listen_host=args.listen_host, listen_port=args.listen_port)
            return 0
        raise ValueError(f"Unknown provider: {args.provider}")


def cmd_sync(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    all_providers = ["oura", "withings", "hevy", "strava", "eightsleep"]

    enabled = {
        "oura": bool(cfg.config.oura.enabled),
        "withings": bool(cfg.config.withings.enabled),
        "hevy": bool(cfg.config.hevy.enabled),
        "strava": bool(cfg.config.strava.enabled),
        "eightsleep": bool(cfg.config.eightsleep.enabled),
    }

    # Default behavior: only sync providers explicitly enabled in config.
    # If the user passes `--providers ...`, we treat that as an override/subset, but we
    # still won't sync a provider that is disabled in config.
    if args.providers is None:
        providers = [p for p in all_providers if enabled.get(p, False)]
        to_sync = providers
        skipped: list[str] = []
    else:
        providers = args.providers
        to_sync = [p for p in providers if enabled.get(p, False)]
        skipped = [p for p in providers if not enabled.get(p, False)]

    with HealthSyncDb(args.db) as db:
        db.init()

        for p in skipped:
            print(f"Skipping {p}: disabled in config (set [{p}].enabled = true).")

        if not to_sync:
            if args.providers is None:
                print(
                    "No providers enabled; nothing to sync. "
                    f"Enable one or more providers in {cfg.path} (e.g. set [hevy].enabled = true)."
                )
            elif providers:
                print("No enabled providers selected; nothing to sync.")
            else:
                print("No providers specified; nothing to sync.")
            return 0

        for p in to_sync:
            if p == "oura":
                oura_sync(db, cfg)
            elif p == "withings":
                withings_sync(db, cfg)
            elif p == "hevy":
                hevy_sync(db, cfg)
            elif p == "strava":
                strava_sync(db, cfg)
            elif p == "eightsleep":
                eightsleep_sync(db, cfg)
            else:
                raise ValueError(f"Unknown provider: {p}")

    return 0


def cmd_status(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    with HealthSyncDb(args.db) as db:
        db.init()
        print("Sync state:")
        for row in db.iter_sync_state():
            print(
                f"- {row['provider']}/{row['resource']}: watermark={row['watermark']}, updated_at={row['updated_at']}"
            )
        print("")
        print("Record counts:")
        for row in db.iter_record_counts():
            print(f"- {row['provider']}/{row['resource']}: {row['cnt']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="health-sync",
        description="Sync Oura/Withings/Hevy/Strava/Eight Sleep data to SQLite.",
    )
    # NOTE: We add --db both at the top-level and on each subcommand so it can be
    # passed either before or after the subcommand (argparse normally requires global
    # options to appear before the subcommand token).
    p.add_argument(
        "--config",
        default=DEFAULT_CONFIG_FILENAME,
        help=f"Config file path (default: ./{DEFAULT_CONFIG_FILENAME})",
    )
    p.add_argument(
        "--db",
        default=None,
        help="SQLite DB path (default: from config [app].db or ./health.sqlite)",
    )

    sub = p.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init-db", help="Create tables if missing.")
    p_init.add_argument(
        "--config",
        default=DEFAULT_CONFIG_FILENAME,
        help=f"Config file path (default: ./{DEFAULT_CONFIG_FILENAME})",
    )
    p_init.add_argument(
        "--db",
        default=None,
        help="SQLite DB path (default: from config [app].db or ./health.sqlite)",
    )
    p_init.set_defaults(func=cmd_init_db)

    p_auth = sub.add_parser("auth", help="Run OAuth2 auth flow for a provider.")
    p_auth.add_argument(
        "--config",
        default=DEFAULT_CONFIG_FILENAME,
        help=f"Config file path (default: ./{DEFAULT_CONFIG_FILENAME})",
    )
    p_auth.add_argument(
        "--db",
        default=None,
        help="SQLite DB path (default: from config [app].db or ./health.sqlite)",
    )
    p_auth.add_argument("provider", choices=["oura", "withings", "strava"])
    p_auth.add_argument("--listen-host", default="127.0.0.1")
    p_auth.add_argument("--listen-port", type=int, default=0, help="0 = pick provider default port")
    p_auth.set_defaults(func=cmd_auth)

    p_sync = sub.add_parser("sync", help="Run synchronization (full backfill on first run, delta afterwards).")
    p_sync.add_argument(
        "--config",
        default=DEFAULT_CONFIG_FILENAME,
        help=f"Config file path (default: ./{DEFAULT_CONFIG_FILENAME})",
    )
    p_sync.add_argument(
        "--db",
        default=None,
        help="SQLite DB path (default: from config [app].db or ./health.sqlite)",
    )
    p_sync.add_argument(
        "--providers",
        nargs="*",
        choices=["oura", "withings", "hevy", "strava", "eightsleep"],
        help="Subset of providers to sync (still requires [provider].enabled = true in config)",
    )
    p_sync.set_defaults(func=cmd_sync)

    p_status = sub.add_parser("status", help="Show sync watermarks and record counts.")
    p_status.add_argument(
        "--config",
        default=DEFAULT_CONFIG_FILENAME,
        help=f"Config file path (default: ./{DEFAULT_CONFIG_FILENAME})",
    )
    p_status.add_argument(
        "--db",
        default=None,
        help="SQLite DB path (default: from config [app].db or ./health.sqlite)",
    )
    p_status.set_defaults(func=cmd_status)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    cfg = load_config(args.config)
    if args.db is None:
        args.db = cfg.config.app.db
    try:
        return int(args.func(args, cfg))
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
