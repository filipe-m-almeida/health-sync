from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import tomllib

DEFAULT_CONFIG_FILENAME = "health-sync.toml"


@dataclass(frozen=True)
class AppConfig: db: str = "./health.sqlite"


@dataclass(frozen=True)
class OuraConfig:
    enabled: bool = False; access_token: str | None = None; client_id: str | None = None; client_secret: str | None = None
    redirect_uri: str = "http://localhost:8484/callback"; scopes: str = "personal daily sleep workout heartrate tag session spo2"
    start_date: str = "2010-01-01"; overlap_days: int = 7


@dataclass(frozen=True)
class WithingsConfig:
    enabled: bool = False; client_id: str | None = None; client_secret: str | None = None
    redirect_uri: str = "http://127.0.0.1:8485/callback"; scopes: str = "user.metrics,user.activity"
    overlap_seconds: int = 300; meastypes: list[str] | None = None


@dataclass(frozen=True)
class HevyConfig:
    enabled: bool = False; api_key: str | None = None; base_url: str = "https://api.hevyapp.com"
    overlap_seconds: int = 300; page_size: int = 10; since: str = "1970-01-01T00:00:00Z"


@dataclass(frozen=True)
class StravaConfig:
    enabled: bool = False; access_token: str | None = None; client_id: str | None = None; client_secret: str | None = None
    redirect_uri: str = "http://127.0.0.1:8486/callback"; scopes: str = "read,activity:read_all"; approval_prompt: str = "auto"
    start_date: str = "2010-01-01"; overlap_seconds: int = 604800; page_size: int = 100


@dataclass(frozen=True)
class EightSleepConfig:
    enabled: bool = False; access_token: str | None = None; email: str | None = None; password: str | None = None
    client_id: str | None = None; client_secret: str | None = None; timezone: str = "UTC"
    auth_url: str = "https://auth-api.8slp.net/v1/tokens"; client_api_url: str = "https://client-api.8slp.net/v1"
    start_date: str = "2010-01-01"; overlap_days: int = 2


@dataclass(frozen=True)
class Config:
    app: AppConfig = field(default_factory=AppConfig)
    oura: OuraConfig = field(default_factory=OuraConfig)
    withings: WithingsConfig = field(default_factory=WithingsConfig)
    hevy: HevyConfig = field(default_factory=HevyConfig)
    strava: StravaConfig = field(default_factory=StravaConfig)
    eightsleep: EightSleepConfig = field(default_factory=EightSleepConfig)
    plugins: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass(frozen=True)
class LoadedConfig:
    path: Path
    exists: bool
    config: Config


_as_dict = lambda v: v if isinstance(v, dict) else {}


def _to_str(v: Any) -> str | None:
    if v is None or isinstance(v, bool):
        return None
    return (v.strip() if isinstance(v, str) else str(v)) or None


def _to_int(v: Any) -> int | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, int):
        return v
    return int(v) if isinstance(v, str) and v.strip().lstrip("-").isdigit() else None


def _to_bool(v: Any) -> bool | None:
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
    return None


def _to_list_str(v: Any) -> list[str] | None:
    if v is None:
        return None
    if isinstance(v, str):
        return [p.strip() for p in v.split(",") if p.strip()] or None
    if isinstance(v, list):
        return [s for item in v if (s := _to_str(item))] or None
    return None


def _build(default_obj: Any, raw: dict[str, Any], spec: dict[str, tuple[str, ...]]) -> Any:
    conv = {"s": _to_str, "i": _to_int, "b": _to_bool, "ls": _to_list_str}
    patch = {
        key: out
        for typ, keys in spec.items()
        for key in keys
        if (out := conv[typ](raw.get(key))) is not None
    }
    return replace(default_obj, **patch)


_SECTIONS: dict[str, tuple[type[Any], dict[str, tuple[str, ...]]]] = {
    "app": (AppConfig, {"s": ("db",)}),
    "oura": (OuraConfig, {"s": ("access_token", "client_id", "client_secret", "redirect_uri", "scopes", "start_date"), "i": ("overlap_days",), "b": ("enabled",)}),
    "withings": (WithingsConfig, {"s": ("client_id", "client_secret", "redirect_uri", "scopes"), "i": ("overlap_seconds",), "b": ("enabled",), "ls": ("meastypes",)}),
    "hevy": (HevyConfig, {"s": ("api_key", "base_url", "since"), "i": ("overlap_seconds", "page_size"), "b": ("enabled",)}),
    "strava": (StravaConfig, {"s": ("access_token", "client_id", "client_secret", "redirect_uri", "scopes", "approval_prompt", "start_date"), "i": ("overlap_seconds", "page_size"), "b": ("enabled",)}),
    "eightsleep": (EightSleepConfig, {"s": ("access_token", "email", "password", "client_id", "client_secret", "timezone", "auth_url", "client_api_url", "start_date"), "i": ("overlap_days",), "b": ("enabled",)}),
}


def load_config(path: str | Path | None = None) -> LoadedConfig:
    cfg_path = (Path(path) if path else Path.cwd() / DEFAULT_CONFIG_FILENAME).expanduser()
    if not cfg_path.exists():
        return LoadedConfig(path=cfg_path, exists=False, config=Config())
    try:
        with cfg_path.open("rb") as f:
            raw = _as_dict(tomllib.load(f))
    except tomllib.TOMLDecodeError as e:
        raise RuntimeError(f"Invalid TOML in config file: {cfg_path}") from e

    out = {name: _build(cls(), _as_dict(raw.get(name)), spec) for name, (cls, spec) in _SECTIONS.items()}
    out["plugins"] = {
        str(k): dict(v)
        for k, v in _as_dict(raw.get("plugins")).items()
        if isinstance(k, str) and isinstance(v, dict)
    }
    return LoadedConfig(path=cfg_path, exists=True, config=Config(**out))


def require_str(cfg: LoadedConfig, v: str | None, *, key: str) -> str:
    if v:
        return v
    if not cfg.exists:
        raise RuntimeError(f"Config file not found: {cfg.path}. Create it from `health-sync.example.toml` and set `{key}`.")
    raise RuntimeError(f"Missing required config value `{key}` in {cfg.path}.")
