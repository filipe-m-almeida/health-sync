from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

from .config import DEFAULT_CONFIG_FILENAME, LoadedConfig, load_config
from .db import HealthSyncDb
from .plugins import BUILTIN_PROVIDER_IDS, PluginHelpers, load_provider_plugins, provider_enabled


def _add_common_cli_flags(parser: argparse.ArgumentParser, *, suppress_defaults: bool = False) -> None:
    config_default: str | object = DEFAULT_CONFIG_FILENAME
    db_default: str | None | object = None
    if suppress_defaults:
        # Prevent subparser defaults from overwriting top-level values.
        config_default = argparse.SUPPRESS
        db_default = argparse.SUPPRESS

    parser.add_argument(
        "--config",
        default=config_default,
        help=f"Config file path (default: ./{DEFAULT_CONFIG_FILENAME})",
    )
    parser.add_argument(
        "--db",
        default=db_default,
        help="SQLite DB path (default: from config [app].db or ./health.sqlite)",
    )


def cmd_init_db(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    with HealthSyncDb(args.db) as db:
        db.init()
    print(f"Initialized DB at: {args.db}")
    return 0


def _enable_hint(provider_id: str) -> str:
    if provider_id in BUILTIN_PROVIDER_IDS:
        return f"[{provider_id}].enabled = true"
    return f"[plugins.{provider_id}].enabled = true"


def _resolve_plugins(cfg: LoadedConfig) -> dict[str, object]:
    plugins = load_provider_plugins(cfg)
    return dict(plugins)


def _known_providers_text(plugins: dict[str, object]) -> str:
    return ", ".join(sorted(plugins.keys())) if plugins else "(none)"


def _validate_known_providers(
    requested: list[str],
    plugins: dict[str, object],
    *,
    singular: bool = False,
) -> None:
    unknown = [p for p in requested if p not in plugins]
    if not unknown:
        return
    known = _known_providers_text(plugins)
    if singular and len(unknown) == 1:
        raise RuntimeError(
            f"Unknown provider `{unknown[0]}`. Available providers: {known}. "
            "Use `health-sync providers` to inspect discovery/config status."
        )
    raise RuntimeError(
        f"Unknown provider(s): {', '.join(unknown)}. Available providers: {known}. "
        "Use `health-sync providers` to inspect discovery/config status."
    )


@dataclass(frozen=True)
class SyncSelection:
    requested: list[str]
    to_sync: list[str]
    skipped: list[str]


def _build_sync_selection(
    cfg: LoadedConfig,
    plugins: dict[str, object],
    requested: list[str] | None,
) -> SyncSelection:
    requested_list = list(plugins.keys()) if requested is None else list(requested)
    _validate_known_providers(requested_list, plugins, singular=False)
    to_sync = [p for p in requested_list if provider_enabled(cfg, p)]
    skipped = [p for p in requested_list if not provider_enabled(cfg, p)]
    return SyncSelection(requested=requested_list, to_sync=to_sync, skipped=skipped)


def _warn_undiscovered_enabled_plugins(cfg: LoadedConfig, plugins: dict[str, object]) -> None:
    # If users enabled plugin config entries but the plugin is not installed/discovered,
    # make that failure mode explicit.
    for provider_id in sorted(cfg.config.plugins.keys()):
        if provider_enabled(cfg, provider_id) and provider_id not in plugins:
            print(
                f"WARNING: [plugins.{provider_id}] is enabled but provider code was not discovered.",
                file=sys.stderr,
            )


def cmd_auth(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    plugins = _resolve_plugins(cfg)
    helpers = PluginHelpers()

    _validate_known_providers([args.provider], plugins, singular=True)
    plugin = plugins[args.provider]

    if not bool(getattr(plugin, "supports_auth", False)):
        raise RuntimeError(f"Provider `{args.provider}` does not support auth.")

    with HealthSyncDb(args.db) as db:
        db.init()
        plugin.auth(db, cfg, helpers, listen_host=args.listen_host, listen_port=args.listen_port)
    return 0


def cmd_sync(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    plugins = _resolve_plugins(cfg)
    helpers = PluginHelpers()
    selection = _build_sync_selection(cfg, plugins, args.providers)
    _warn_undiscovered_enabled_plugins(cfg, plugins)

    with HealthSyncDb(args.db) as db:
        db.init()

        for p in selection.skipped:
            print(f"Skipping {p}: disabled in config (set {_enable_hint(p)}).")

        if not selection.to_sync:
            if args.providers is None:
                print(
                    "No providers enabled; nothing to sync. "
                    f"Enable one or more providers in {cfg.path} (e.g. set {_enable_hint('hevy')})."
                )
            elif selection.requested:
                print("No enabled providers selected; nothing to sync.")
            else:
                print("No providers specified; nothing to sync.")
            return 0

        successes = 0
        failures: list[tuple[str, Exception]] = []

        for p in selection.to_sync:
            try:
                plugin = plugins[p]
                plugin.sync(db, cfg, helpers)  # type: ignore[attr-defined]
                successes += 1
            except Exception as e:  # noqa: BLE001
                failures.append((p, e))
                print(f"WARNING: {p} sync failed: {e}", file=sys.stderr)

        if failures:
            failed_names = ", ".join(p for p, _ in failures)
            print(
                f"Sync completed with warnings ({len(failures)}/{len(selection.to_sync)} providers failed): {failed_names}",
                file=sys.stderr,
            )

        if failures:
            if successes == 0:
                print("All selected providers failed.", file=sys.stderr)
            return 1

    return 0


def cmd_providers(args: argparse.Namespace, cfg: LoadedConfig) -> int:
    plugins = _resolve_plugins(cfg)
    helpers = PluginHelpers()

    if not plugins:
        print("No providers discovered.")
        return 0

    print("Providers:")
    for provider_id in sorted(plugins.keys()):
        plugin = plugins[provider_id]
        enabled = helpers.is_enabled(cfg, provider_id)
        supports_auth = bool(getattr(plugin, "supports_auth", False))
        source = getattr(plugin, "source", "unknown")
        description = getattr(plugin, "description", None) or ""

        line = (
            f"- {provider_id}: enabled={str(enabled).lower()} "
            f"auth={str(supports_auth).lower()} source={source}"
        )
        if description:
            line += f" — {description}"
        print(line)

        # Show config-backed plugin module information when available.
        cfg_block = cfg.config.plugins.get(provider_id)
        if args.verbose and isinstance(cfg_block, dict):
            module_spec = cfg_block.get("module")
            if isinstance(module_spec, str) and module_spec.strip():
                print(f"    module={module_spec.strip()}")

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
        print("")
        print("Recent sync runs:")
        for row in db.iter_sync_runs(limit=20):
            print(
                f"- #{row['id']} {row['provider']}/{row['resource']} {row['status']} "
                f"ins={row['inserted_count']} upd={row['updated_count']} del={row['deleted_count']} same={row['unchanged_count']} "
                f"start={row['started_at']} end={row['finished_at']}"
            )
            if row["error_text"]:
                print(f"    error: {row['error_text']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="health-sync",
        description="Sync Oura/Withings/Hevy/Strava/Eight Sleep data to SQLite.",
    )
    # NOTE: We add common flags both at the top-level and on each subcommand so they can be
    # passed either before or after the subcommand (argparse normally requires global
    # options to appear before the subcommand token).
    _add_common_cli_flags(p, suppress_defaults=False)

    sub = p.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init-db", help="Create tables if missing.")
    _add_common_cli_flags(p_init, suppress_defaults=True)
    p_init.set_defaults(func=cmd_init_db)

    p_auth = sub.add_parser("auth", help="Run OAuth2 auth flow for a provider/plugin.")
    _add_common_cli_flags(p_auth, suppress_defaults=True)
    p_auth.add_argument("provider", help="Provider id (built-in or discovered plugin)")
    p_auth.add_argument("--listen-host", default="127.0.0.1")
    p_auth.add_argument("--listen-port", type=int, default=0, help="0 = pick provider default port")
    p_auth.set_defaults(func=cmd_auth)

    p_sync = sub.add_parser("sync", help="Run synchronization (full backfill on first run, delta afterwards).")
    _add_common_cli_flags(p_sync, suppress_defaults=True)
    p_sync.add_argument(
        "--providers",
        nargs="*",
        metavar="PROVIDER",
        help=(
            "Subset of providers/plugins to sync "
            "(still requires provider to be enabled in config)."
        ),
    )
    p_sync.set_defaults(func=cmd_sync)

    p_providers = sub.add_parser("providers", help="List discovered providers/plugins and enablement state.")
    _add_common_cli_flags(p_providers, suppress_defaults=True)
    p_providers.add_argument("--verbose", action="store_true", help="Include plugin module metadata when available")
    p_providers.set_defaults(func=cmd_providers)

    p_status = sub.add_parser("status", help="Show sync watermarks and record counts.")
    _add_common_cli_flags(p_status, suppress_defaults=True)
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
