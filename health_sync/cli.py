from __future__ import annotations

import argparse
import os
import sys

from .db import HealthSyncDb
from .providers.hevy import hevy_sync
from .providers.oura import oura_auth, oura_sync
from .providers.withings import withings_auth, withings_sync


def _default_db_path() -> str:
    return os.environ.get("HEALTH_SYNC_DB", os.path.join(os.getcwd(), "health.sqlite"))


def cmd_init_db(args: argparse.Namespace) -> int:
    with HealthSyncDb(args.db) as db:
        db.init()
    print(f"Initialized DB at: {args.db}")
    return 0


def cmd_auth(args: argparse.Namespace) -> int:
    with HealthSyncDb(args.db) as db:
        db.init()
        if args.provider == "oura":
            oura_auth(db, listen_host=args.listen_host, listen_port=args.listen_port)
            return 0
        if args.provider == "withings":
            withings_auth(db, listen_host=args.listen_host, listen_port=args.listen_port)
            return 0
        raise ValueError(f"Unknown provider: {args.provider}")


def cmd_sync(args: argparse.Namespace) -> int:
    providers = args.providers or ["oura", "withings", "hevy"]

    with HealthSyncDb(args.db) as db:
        db.init()
        for p in providers:
            if p == "oura":
                oura_sync(db)
            elif p == "withings":
                withings_sync(db)
            elif p == "hevy":
                hevy_sync(db)
            else:
                raise ValueError(f"Unknown provider: {p}")

    return 0


def cmd_status(args: argparse.Namespace) -> int:
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
    p = argparse.ArgumentParser(prog="health-sync", description="Sync Oura/Withings/Hevy data to SQLite.")
    # NOTE: We add --db both at the top-level and on each subcommand so it can be
    # passed either before or after the subcommand (argparse normally requires global
    # options to appear before the subcommand token).
    p.add_argument(
        "--db",
        default=_default_db_path(),
        help="SQLite DB path (default: $HEALTH_SYNC_DB or ./health.sqlite)",
    )

    sub = p.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init-db", help="Create tables if missing.")
    p_init.add_argument(
        "--db",
        default=_default_db_path(),
        help="SQLite DB path (default: $HEALTH_SYNC_DB or ./health.sqlite)",
    )
    p_init.set_defaults(func=cmd_init_db)

    p_auth = sub.add_parser("auth", help="Run OAuth2 auth flow for a provider.")
    p_auth.add_argument(
        "--db",
        default=_default_db_path(),
        help="SQLite DB path (default: $HEALTH_SYNC_DB or ./health.sqlite)",
    )
    p_auth.add_argument("provider", choices=["oura", "withings"])
    p_auth.add_argument("--listen-host", default="127.0.0.1")
    p_auth.add_argument("--listen-port", type=int, default=0, help="0 = pick provider default port")
    p_auth.set_defaults(func=cmd_auth)

    p_sync = sub.add_parser("sync", help="Run synchronization (full backfill on first run, delta afterwards).")
    p_sync.add_argument(
        "--db",
        default=_default_db_path(),
        help="SQLite DB path (default: $HEALTH_SYNC_DB or ./health.sqlite)",
    )
    p_sync.add_argument("--providers", nargs="*", choices=["oura", "withings", "hevy"], help="Subset of providers to sync")
    p_sync.set_defaults(func=cmd_sync)

    p_status = sub.add_parser("status", help="Show sync watermarks and record counts.")
    p_status.add_argument(
        "--db",
        default=_default_db_path(),
        help="SQLite DB path (default: $HEALTH_SYNC_DB or ./health.sqlite)",
    )
    p_status.set_defaults(func=cmd_status)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
