from __future__ import annotations

import importlib
from dataclasses import dataclass
from importlib import metadata
from typing import Any
import warnings

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

    def sync(self, db, cfg, helpers: PluginHelpers) -> None:
        self.object_.sync(db, cfg, helpers)

    def auth(self, db, cfg, helpers: PluginHelpers, *, listen_host: str, listen_port: int) -> None:
        fn = getattr(self.object_, "auth", None)
        if not callable(fn):
            raise RuntimeError(f"Provider `{self.id}` does not support auth.")

        try:
            fn(db, cfg, helpers, listen_host=listen_host, listen_port=listen_port)
        except TypeError:
            # Tolerate positional implementations from external plugins.
            fn(db, cfg, helpers, listen_host, listen_port)


@dataclass(frozen=True)
class BuiltinPluginSpec:
    id: str
    sync_fn: Any
    auth_fn: Any
    description: str


BUILTIN_PLUGIN_SPECS: tuple[BuiltinPluginSpec, ...] = (
    BuiltinPluginSpec(
        id="oura",
        sync_fn=oura_sync,
        auth_fn=oura_auth,
        description="Oura Cloud API v2",
    ),
    BuiltinPluginSpec(
        id="withings",
        sync_fn=withings_sync,
        auth_fn=withings_auth,
        description="Withings Advanced Health Data API",
    ),
    BuiltinPluginSpec(
        id="hevy",
        sync_fn=hevy_sync,
        auth_fn=None,
        description="Hevy public API",
    ),
    BuiltinPluginSpec(
        id="strava",
        sync_fn=strava_sync,
        auth_fn=strava_auth,
        description="Strava API",
    ),
    BuiltinPluginSpec(
        id="eightsleep",
        sync_fn=eightsleep_sync,
        auth_fn=None,
        description="Eight Sleep (unofficial API)",
    ),
)


def _builtin_plugins() -> list[ProviderPlugin]:
    return [
        FunctionalProviderPlugin(
            id=spec.id,
            sync_fn=spec.sync_fn,
            auth_fn=spec.auth_fn,
            source="builtin",
            description=spec.description,
        )
        for spec in BUILTIN_PLUGIN_SPECS
    ]


def _coerce_plugin_object(obj: Any, *, source: str) -> ProviderPlugin:
    candidate = obj

    if isinstance(candidate, type):
        candidate = candidate()
    elif callable(candidate) and not callable(getattr(candidate, "sync", None)):
        # Treat plain callables as no-arg factories.
        candidate = candidate()

    plugin_id = getattr(candidate, "id", None)
    sync_fn = getattr(candidate, "sync", None)

    if not isinstance(plugin_id, str) or not plugin_id.strip():
        raise RuntimeError(f"Invalid provider plugin from {source}: missing non-empty `id`.")
    if not callable(sync_fn):
        raise RuntimeError(f"Invalid provider plugin `{plugin_id}` from {source}: missing callable `sync`.")

    supports_auth_attr = getattr(candidate, "supports_auth", None)
    auth_fn = getattr(candidate, "auth", None)
    supports_auth = bool(supports_auth_attr) if supports_auth_attr is not None else callable(auth_fn)

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
    group = eps.get(ENTRYPOINT_GROUP, [])  # type: ignore[assignment]
    return list(group)


def _load_from_module_spec(spec: str) -> Any:
    module_path, sep, attr_name = spec.partition(":")
    if not module_path:
        raise RuntimeError(f"Invalid plugin module spec `{spec}`.")
    if not sep:
        attr_name = "provider"

    module = importlib.import_module(module_path)
    try:
        return getattr(module, attr_name)
    except AttributeError as e:
        raise RuntimeError(f"Plugin module `{module_path}` has no attribute `{attr_name}`.") from e


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

    for p in _builtin_plugins():
        builtin_ids.add(p.id)
        register(p)

    for ep in _iter_entry_points():
        loaded = ep.load()
        plugin = _coerce_plugin_object(loaded, source=f"entrypoint:{ep.module}:{ep.attr}")
        register(plugin)

    if cfg is not None:
        for provider_id, plugin_cfg in cfg.config.plugins.items():
            module_spec = plugin_cfg.get("module") if isinstance(plugin_cfg, dict) else None
            if not isinstance(module_spec, str) or not module_spec.strip():
                continue

            loaded = _load_from_module_spec(module_spec.strip())
            plugin = _coerce_plugin_object(loaded, source=f"config-module:{module_spec.strip()}")
            if plugin.id != provider_id:
                raise RuntimeError(
                    "Plugin id mismatch for configured module "
                    f"[plugins.{provider_id}] module={module_spec!r}: loaded id `{plugin.id}`"
                )
            register(plugin, override=True)

    return plugins
