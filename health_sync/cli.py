from __future__ import annotations

import argparse
import sys

from .config import DEFAULT_CONFIG_FILENAME, LoadedConfig, load_config
from .db import HealthSyncDb
from .plugins import PluginHelpers, load_provider_plugins, provider_enabled


def _add_common_cli_flags(parser: argparse.ArgumentParser, *, suppress_defaults: bool = False) -> None:
    parser.add_argument(
        "--config",
        default=argparse.SUPPRESS if suppress_defaults else DEFAULT_CONFIG_FILENAME,
        help=f"Config file path (default: ./{DEFAULT_CONFIG_FILENAME})",
    )
    parser.add_argument(
        "--db",
        default=argparse.SUPPRESS if suppress_defaults else None,
        help="SQLite DB path (default: from config [app].db or ./health.sqlite)",
    )


def _resolve_plugins(cfg: LoadedConfig) -> dict[str, object]:
    return dict(load_provider_plugins(cfg))


def _enable_hint(provider_id: str) -> str:
    return f"[{provider_id}].enabled = true" if provider_id in {"oura", "withings", "hevy", "strava", "eightsleep"} else f"[plugins.{provider_id}].enabled = true"


def _provider_or_die(plugins: dict[str, object], provider_id: str) -> object:
    plugin = plugins.get(provider_id)
    if plugin is not None:
        return plugin
    known = ", ".join(sorted(plugins)) if plugins else "(none)"
    raise RuntimeError(
        f"Unknown provider `{provider_id}`. Available providers: {known}. "
        "Use `health-sync providers` to inspect discovery/config status."
    )


def cmd_init_db(args: argparse.Namespace, cfg: LoadedConfig) -> int:  # noqa: ARG001
    with HealthSyncDb(args.db) as db:
        db.init()
    print(f"Initialized DB at: {args.db}")
    return 0


def cmd_auth(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    plugin = _provider_or_die(_resolve_plugins(cfg), args.provider)
    if not bool(getattr(plugin, "supports_auth", False)):
        raise RuntimeError(f"Provider `{args.provider}` does not support auth.")
    with HealthSyncDb(args.db) as db:
        db.init()
        plugin.auth(db, cfg, PluginHelpers(), listen_host=args.listen_host, listen_port=args.listen_port)
    return 0


def cmd_sync(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    plugins = _resolve_plugins(cfg)
    requested = list(plugins) if args.providers is None else list(args.providers)
    unknown = [p for p in requested if p not in plugins]
    if unknown:
        known = ", ".join(sorted(plugins)) if plugins else "(none)"
        raise RuntimeError(
            f"Unknown provider(s): {', '.join(unknown)}. Available providers: {known}. "
            "Use `health-sync providers` to inspect discovery/config status."
        )

    for provider_id in sorted(cfg.config.plugins):
        if provider_enabled(cfg, provider_id) and provider_id not in plugins:
            print(f"WARNING: [plugins.{provider_id}] is enabled but provider code was not discovered.", file=sys.stderr)

    to_sync = [p for p in requested if provider_enabled(cfg, p)]
    skipped = [p for p in requested if p not in to_sync]
    with HealthSyncDb(args.db) as db:
        db.init()
        for p in skipped:
            print(f"Skipping {p}: disabled in config (set {_enable_hint(p)}).")

        if not to_sync:
            if args.providers is None:
                print(
                    "No providers enabled; nothing to sync. "
                    f"Enable one or more providers in {cfg.path} (e.g. set {_enable_hint('hevy')})."
                )
            elif requested:
                print("No enabled providers selected; nothing to sync.")
            else:
                print("No providers specified; nothing to sync.")
            return 0

        failed: list[tuple[str, Exception]] = []
        successes = 0
        for provider_id in to_sync:
            try:
                plugins[provider_id].sync(db, cfg, PluginHelpers())
                successes += 1
            except Exception as e:  # noqa: BLE001
                failed.append((provider_id, e))
                print(f"WARNING: {provider_id} sync failed: {e}", file=sys.stderr)

        if failed:
            names = ", ".join(p for p, _ in failed)
            print(
                f"Sync completed with warnings ({len(failed)}/{len(to_sync)} providers failed): {names}",
                file=sys.stderr,
            )
            if successes == 0:
                print("All selected providers failed.", file=sys.stderr)
            return 1
    return 0


def cmd_providers(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    plugins = _resolve_plugins(cfg)
    if not plugins:
        print("No providers discovered.")
        return 0
    helpers = PluginHelpers()
    print("Providers:")
    for provider_id in sorted(plugins):
        plugin = plugins[provider_id]
        line = (
            f"- {provider_id}: enabled={str(helpers.is_enabled(cfg, provider_id)).lower()} "
            f"auth={str(bool(getattr(plugin, 'supports_auth', False))).lower()} "
            f"source={getattr(plugin, 'source', 'unknown')}"
        )
        desc = getattr(plugin, "description", None)
        if desc:
            line += f" — {desc}"
        print(line)
        cfg_block = cfg.config.plugins.get(provider_id)
        module_spec = cfg_block.get("module") if isinstance(cfg_block, dict) else None
        if args.verbose and isinstance(module_spec, str) and module_spec.strip():
            print(f"    module={module_spec.strip()}")
    return 0


def cmd_status(args: argparse.Namespace, cfg: LoadedConfig) -> int:  # noqa: ARG001
    with HealthSyncDb(args.db) as db:
        db.init()
        print("Sync state:")
        for row in db.iter_sync_state():
            print(f"- {row['provider']}/{row['resource']}: watermark={row['watermark']}, updated_at={row['updated_at']}")
        print("\nRecord counts:")
        for row in db.iter_record_counts():
            print(f"- {row['provider']}/{row['resource']}: {row['cnt']}")
        print("\nRecent sync runs:")
        for row in db.iter_sync_runs(limit=20):
            print(
                f"- #{row['id']} {row['provider']}/{row['resource']} {row['status']} "
                f"ins={row['inserted_count']} upd={row['updated_count']} del={row['deleted_count']} same={row['unchanged_count']} "
                f"start={row['started_at']} end={row['finished_at']}"
            )
            if row["error_text"]:
                print(f"    error: {row['error_text']}")
    return 0


def _add_subcommand(subparsers: argparse._SubParsersAction[argparse.ArgumentParser], name: str, help_text: str, func) -> argparse.ArgumentParser:
    sp = subparsers.add_parser(name, help=help_text)
    _add_common_cli_flags(sp, suppress_defaults=True)
    sp.set_defaults(func=func)
    return sp


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="health-sync", description="Sync Oura/Withings/Hevy/Strava/Eight Sleep data to SQLite.")
    _add_common_cli_flags(p)
    sub = p.add_subparsers(dest="cmd", required=True)

    _add_subcommand(sub, "init-db", "Create tables if missing.", cmd_init_db)

    auth = _add_subcommand(sub, "auth", "Run OAuth2 auth flow for a provider/plugin.", cmd_auth)
    auth.add_argument("provider", help="Provider id (built-in or discovered plugin)")
    auth.add_argument("--listen-host", default="127.0.0.1")
    auth.add_argument("--listen-port", type=int, default=0, help="0 = pick provider default port")

    sync = _add_subcommand(sub, "sync", "Run synchronization (full backfill on first run, delta afterwards).", cmd_sync)
    sync.add_argument("--providers", nargs="*", metavar="PROVIDER", help="Subset of providers/plugins to sync")

    providers = _add_subcommand(sub, "providers", "List discovered providers/plugins and enablement state.", cmd_providers)
    providers.add_argument("--verbose", action="store_true", help="Include plugin module metadata when available")

    _add_subcommand(sub, "status", "Show sync watermarks and record counts.", cmd_status)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_config(args.config)
    args.db = args.db if args.db is not None else cfg.config.app.db
    try:
        return int(args.func(args, cfg))
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
