from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol, runtime_checkable

from ..config import LoadedConfig
from ..db import HealthSyncDb


_BUILTIN_ENABLED = {
    "oura": lambda cfg: cfg.config.oura.enabled,
    "withings": lambda cfg: cfg.config.withings.enabled,
    "hevy": lambda cfg: cfg.config.hevy.enabled,
    "strava": lambda cfg: cfg.config.strava.enabled,
    "eightsleep": lambda cfg: cfg.config.eightsleep.enabled,
}


def _boolish(v: Any, *, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in {"true", "1", "yes", "y", "on"}:
            return True
        if s in {"false", "0", "no", "n", "off"}:
            return False
    return default


def provider_config(cfg: LoadedConfig, provider_id: str) -> dict[str, Any]:
    raw = cfg.config.plugins.get(provider_id)
    return dict(raw) if isinstance(raw, dict) else {}


def provider_enabled(cfg: LoadedConfig, provider_id: str) -> bool:
    if provider_id in _BUILTIN_ENABLED:
        return bool(_BUILTIN_ENABLED[provider_id](cfg))
    return _boolish(provider_config(cfg, provider_id).get("enabled"), default=False)


@dataclass(frozen=True)
class PluginHelpers:
    def config_for(self, cfg: LoadedConfig, provider_id: str) -> dict[str, Any]:
        return provider_config(cfg, provider_id)

    def is_enabled(self, cfg: LoadedConfig, provider_id: str) -> bool:
        return provider_enabled(cfg, provider_id)

    def require_str(self, cfg: LoadedConfig, provider_id: str, key: str) -> str:
        value = provider_config(cfg, provider_id).get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if not cfg.exists:
            raise RuntimeError(f"Config file not found: {cfg.path}. Create it and set [plugins.{provider_id}].{key}.")
        raise RuntimeError(f"Missing required config value [plugins.{provider_id}].{key} in {cfg.path}.")


@runtime_checkable
class ProviderPlugin(Protocol):
    id: str
    source: str
    description: str | None
    supports_auth: bool

    def sync(self, db: HealthSyncDb, cfg: LoadedConfig, helpers: PluginHelpers) -> None: ...

    def auth(
        self,
        db: HealthSyncDb,
        cfg: LoadedConfig,
        helpers: PluginHelpers,
        *,
        listen_host: str,
        listen_port: int,
    ) -> None: ...


@dataclass
class FunctionalProviderPlugin:
    id: str
    sync_fn: Callable[[HealthSyncDb, LoadedConfig], None]
    auth_fn: Callable[[HealthSyncDb, LoadedConfig], None] | Callable[..., None] | None = None
    source: str = "builtin"
    description: str | None = None

    @property
    def supports_auth(self) -> bool:
        return callable(self.auth_fn)

    def sync(self, db: HealthSyncDb, cfg: LoadedConfig, helpers: PluginHelpers) -> None:  # noqa: ARG002
        self.sync_fn(db, cfg)

    def auth(
        self,
        db: HealthSyncDb,
        cfg: LoadedConfig,
        helpers: PluginHelpers,  # noqa: ARG002
        *,
        listen_host: str,
        listen_port: int,
    ) -> None:
        if not callable(self.auth_fn):
            raise RuntimeError(f"Provider `{self.id}` does not support auth.")
        self.auth_fn(db, cfg, listen_host=listen_host, listen_port=listen_port)
