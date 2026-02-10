from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import tomllib


DEFAULT_CONFIG_FILENAME = "health-sync.toml"


@dataclass(frozen=True)
class AppConfig:
    db: str = "./health.sqlite"


@dataclass(frozen=True)
class OuraConfig:
    enabled: bool = False

    # If set, this is treated as a Personal Access Token (PAT).
    access_token: str | None = None

    # OAuth2 (Authorization Code + refresh token)
    client_id: str | None = None
    client_secret: str | None = None
    # Oura's OAuth authorize endpoint rejects `http://127.0.0.1/...` with
    # `400 invalid_request`; `http://localhost/...` works for local flows.
    redirect_uri: str = "http://localhost:8484/callback"
    scopes: str = "personal daily sleep workout heartrate tag session spo2"

    # Sync tuning
    start_date: str = "2010-01-01"
    overlap_days: int = 7


@dataclass(frozen=True)
class WithingsConfig:
    enabled: bool = False

    client_id: str | None = None
    client_secret: str | None = None
    redirect_uri: str = "http://127.0.0.1:8485/callback"
    # Withings scopes are comma-separated. Sleep endpoints are covered by `user.activity`
    # (there is no `user.sleep` scope).
    scopes: str = "user.metrics,user.activity"

    # Sync tuning
    overlap_seconds: int = 300
    meastypes: list[str] | None = None


@dataclass(frozen=True)
class HevyConfig:
    enabled: bool = False

    api_key: str | None = None
    base_url: str = "https://api.hevyapp.com"

    # Sync tuning
    overlap_seconds: int = 300
    page_size: int = 10
    since: str = "1970-01-01T00:00:00Z"


@dataclass(frozen=True)
class Config:
    app: AppConfig = field(default_factory=AppConfig)
    oura: OuraConfig = field(default_factory=OuraConfig)
    withings: WithingsConfig = field(default_factory=WithingsConfig)
    hevy: HevyConfig = field(default_factory=HevyConfig)


@dataclass(frozen=True)
class LoadedConfig:
    path: Path
    exists: bool
    config: Config


def _as_dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _get_str(d: dict[str, Any], key: str) -> str | None:
    v = d.get(key)
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s if s else None
    if isinstance(v, bool):
        return None
    return str(v)


def _get_int(d: dict[str, Any], key: str) -> int | None:
    v = d.get(key)
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        s = v.strip()
        if s.lstrip("-").isdigit():
            try:
                return int(s)
            except Exception:  # noqa: BLE001
                return None
    return None


def _get_bool(d: dict[str, Any], key: str) -> bool | None:
    v = d.get(key)
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    # Be forgiving: `enabled = 1` / `enabled = "true"` can happen with env/template tooling.
    if isinstance(v, int):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in {"true", "1", "yes", "y", "on"}:
            return True
        if s in {"false", "0", "no", "n", "off"}:
            return False
    return None


def _get_list_str(d: dict[str, Any], key: str) -> list[str] | None:
    v = d.get(key)
    if v is None:
        return None

    # Allow `meastypes = "1,4,5"` as shorthand.
    if isinstance(v, str):
        parts = [p.strip() for p in v.split(",")]
        out = [p for p in parts if p]
        return out or None

    if not isinstance(v, list):
        return None

    out: list[str] = []
    for item in v:
        if item is None or isinstance(item, bool):
            continue
        if isinstance(item, str):
            s = item.strip()
            if s:
                out.append(s)
        else:
            out.append(str(item))
    return out or None


def load_config(path: str | Path | None = None) -> LoadedConfig:
    cfg_path = Path(path) if path else (Path.cwd() / DEFAULT_CONFIG_FILENAME)
    cfg_path = cfg_path.expanduser()

    if not cfg_path.exists():
        return LoadedConfig(path=cfg_path, exists=False, config=Config())

    try:
        with cfg_path.open("rb") as f:
            raw = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        raise RuntimeError(f"Invalid TOML in config file: {cfg_path}") from e

    raw = _as_dict(raw)
    raw_app = _as_dict(raw.get("app"))
    raw_oura = _as_dict(raw.get("oura"))
    raw_withings = _as_dict(raw.get("withings"))
    raw_hevy = _as_dict(raw.get("hevy"))

    oura_enabled = _get_bool(raw_oura, "enabled")
    withings_enabled = _get_bool(raw_withings, "enabled")
    hevy_enabled = _get_bool(raw_hevy, "enabled")

    app = AppConfig(
        db=_get_str(raw_app, "db") or AppConfig().db,
    )
    oura = OuraConfig(
        enabled=oura_enabled if oura_enabled is not None else OuraConfig().enabled,
        access_token=_get_str(raw_oura, "access_token"),
        client_id=_get_str(raw_oura, "client_id"),
        client_secret=_get_str(raw_oura, "client_secret"),
        redirect_uri=_get_str(raw_oura, "redirect_uri") or OuraConfig().redirect_uri,
        scopes=_get_str(raw_oura, "scopes") or OuraConfig().scopes,
        start_date=_get_str(raw_oura, "start_date") or OuraConfig().start_date,
        overlap_days=_get_int(raw_oura, "overlap_days") or OuraConfig().overlap_days,
    )
    withings = WithingsConfig(
        enabled=withings_enabled if withings_enabled is not None else WithingsConfig().enabled,
        client_id=_get_str(raw_withings, "client_id"),
        client_secret=_get_str(raw_withings, "client_secret"),
        redirect_uri=_get_str(raw_withings, "redirect_uri") or WithingsConfig().redirect_uri,
        scopes=_get_str(raw_withings, "scopes") or WithingsConfig().scopes,
        overlap_seconds=_get_int(raw_withings, "overlap_seconds") or WithingsConfig().overlap_seconds,
        meastypes=_get_list_str(raw_withings, "meastypes"),
    )
    hevy = HevyConfig(
        enabled=hevy_enabled if hevy_enabled is not None else HevyConfig().enabled,
        api_key=_get_str(raw_hevy, "api_key"),
        base_url=_get_str(raw_hevy, "base_url") or HevyConfig().base_url,
        overlap_seconds=_get_int(raw_hevy, "overlap_seconds") or HevyConfig().overlap_seconds,
        page_size=_get_int(raw_hevy, "page_size") or HevyConfig().page_size,
        since=_get_str(raw_hevy, "since") or HevyConfig().since,
    )

    return LoadedConfig(path=cfg_path, exists=True, config=Config(app=app, oura=oura, withings=withings, hevy=hevy))


def require_str(cfg: LoadedConfig, v: str | None, *, key: str) -> str:
    if v:
        return v
    if not cfg.exists:
        raise RuntimeError(
            f"Config file not found: {cfg.path}. Create it from `health-sync.example.toml` and set `{key}`."
        )
    raise RuntimeError(f"Missing required config value `{key}` in {cfg.path}.")
