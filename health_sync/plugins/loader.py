from __future__ import annotations

import importlib
import warnings
from dataclasses import dataclass
from importlib import metadata
from typing import Any

from ..config import LoadedConfig
from ..providers.eightsleep import eightsleep_sync
from ..providers.hevy import hevy_sync
from ..providers.oura import oura_auth, oura_sync
from ..providers.strava import strava_auth, strava_sync
from ..providers.withings import withings_auth, withings_sync
from .base import FunctionalProviderPlugin, PluginHelpers, ProviderPlugin

ENTRYPOINT_GROUP = "health_sync.providers"


@dataclass
class ObjectProviderPlugin:
    id: str
    object_: Any
    source: str
    description: str | None = None
    supports_auth: bool = False

    def sync(self, db, cfg, helpers: PluginHelpers) -> None:  # noqa: ANN001
        self.object_.sync(db, cfg, helpers)

    def auth(self, db, cfg, helpers: PluginHelpers, *, listen_host: str, listen_port: int) -> None:  # noqa: ANN001
        fn = getattr(self.object_, "auth", None)
        if not callable(fn):
            raise RuntimeError(f"Provider `{self.id}` does not support auth.")
        try:
            fn(db, cfg, helpers, listen_host=listen_host, listen_port=listen_port)
        except TypeError:
            fn(db, cfg, helpers, listen_host, listen_port)


def _builtin_plugins() -> list[ProviderPlugin]:
    data = [
        ("oura", oura_sync, oura_auth, "Oura Cloud API v2"),
        ("withings", withings_sync, withings_auth, "Withings Advanced Health Data API"),
        ("hevy", hevy_sync, None, "Hevy public API"),
        ("strava", strava_sync, strava_auth, "Strava API"),
        ("eightsleep", eightsleep_sync, None, "Eight Sleep (unofficial API)"),
    ]
    return [FunctionalProviderPlugin(id=i, sync_fn=s, auth_fn=a, source="builtin", description=d) for i, s, a, d in data]


def _coerce_plugin_object(obj: Any, *, source: str) -> ProviderPlugin:
    candidate = obj() if isinstance(obj, type) else obj
    if callable(candidate) and not callable(getattr(candidate, "sync", None)):
        candidate = candidate()
    plugin_id, sync_fn = getattr(candidate, "id", None), getattr(candidate, "sync", None)
    if not isinstance(plugin_id, str) or not plugin_id.strip():
        raise RuntimeError(f"Invalid provider plugin from {source}: missing non-empty `id`.")
    if not callable(sync_fn):
        raise RuntimeError(f"Invalid provider plugin `{plugin_id}` from {source}: missing callable `sync`.")
    auth_fn = getattr(candidate, "auth", None)
    supports_auth = bool(getattr(candidate, "supports_auth", callable(auth_fn)))
    return ObjectProviderPlugin(
        id=plugin_id.strip(),
        object_=candidate,
        source=source,
        description=getattr(candidate, "description", None),
        supports_auth=supports_auth,
    )


def _iter_entry_points() -> list[metadata.EntryPoint]:
    eps = metadata.entry_points()
    if hasattr(eps, "select"):
        return list(eps.select(group=ENTRYPOINT_GROUP))
    return list(eps.get(ENTRYPOINT_GROUP, []))  # type: ignore[union-attr]


def _load_from_module_spec(spec: str) -> Any:
    module_path, sep, attr_name = spec.partition(":")
    if not module_path:
        raise RuntimeError(f"Invalid plugin module spec `{spec}`.")
    module = importlib.import_module(module_path)
    try:
        return getattr(module, attr_name or "provider")
    except AttributeError as e:
        raise RuntimeError(f"Plugin module `{module_path}` has no attribute `{attr_name or 'provider'}`.") from e


def load_provider_plugins(cfg: LoadedConfig | None = None) -> dict[str, ProviderPlugin]:
    plugins: dict[str, ProviderPlugin] = {}
    builtin_ids: set[str] = set()

    def register(plugin: ProviderPlugin, *, override: bool = False) -> None:
        pid = plugin.id
        if pid in plugins and not override:
            warnings.warn(
                f"Provider plugin id `{pid}` already registered from {plugins[pid].source}; ignoring {plugin.source}.",
                RuntimeWarning,
                stacklevel=2,
            )
            return
        if pid in builtin_ids and override:
            raise RuntimeError(f"Cannot override built-in provider `{pid}`.")
        plugins[pid] = plugin

    for plugin in _builtin_plugins():
        builtin_ids.add(plugin.id)
        register(plugin)

    for ep in _iter_entry_points():
        register(_coerce_plugin_object(ep.load(), source=f"entrypoint:{ep.module}:{ep.attr}"))

    if cfg is None:
        return plugins

    for provider_id, plugin_cfg in cfg.config.plugins.items():
        module_spec = plugin_cfg.get("module") if isinstance(plugin_cfg, dict) else None
        if not isinstance(module_spec, str) or not module_spec.strip():
            continue
        plugin = _coerce_plugin_object(
            _load_from_module_spec(module_spec.strip()),
            source=f"config-module:{module_spec.strip()}",
        )
        if plugin.id != provider_id:
            raise RuntimeError(
                "Plugin id mismatch for configured module "
                f"[plugins.{provider_id}] module={module_spec!r}: loaded id `{plugin.id}`"
            )
        register(plugin, override=True)

    return plugins
