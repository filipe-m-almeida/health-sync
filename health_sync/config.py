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
class StravaConfig:
    enabled: bool = False

    # If set, this is treated as a static access token.
    access_token: str | None = None

    # OAuth2 (Authorization Code + refresh token)
    client_id: str | None = None
    client_secret: str | None = None
    redirect_uri: str = "http://127.0.0.1:8486/callback"
    scopes: str = "read,activity:read_all"
    approval_prompt: str = "auto"

    # Sync tuning
    start_date: str = "2010-01-01"
    overlap_seconds: int = 604800
    page_size: int = 100


@dataclass(frozen=True)
class EightSleepConfig:
    enabled: bool = False

    # Option A: static bearer token (advanced/unstable API usage)
    access_token: str | None = None

    # Option B: username/password grant
    email: str | None = None
    password: str | None = None
    client_id: str | None = None
    client_secret: str | None = None

    # API hosts / sync tuning
    timezone: str = "UTC"
    auth_url: str = "https://auth-api.8slp.net/v1/tokens"
    client_api_url: str = "https://client-api.8slp.net/v1"
    start_date: str = "2010-01-01"
    overlap_days: int = 2


@dataclass(frozen=True)
class Config:
    app: AppConfig = field(default_factory=AppConfig)
    oura: OuraConfig = field(default_factory=OuraConfig)
    withings: WithingsConfig = field(default_factory=WithingsConfig)
    hevy: HevyConfig = field(default_factory=HevyConfig)
    strava: StravaConfig = field(default_factory=StravaConfig)
    eightsleep: EightSleepConfig = field(default_factory=EightSleepConfig)
    # Generic plugin config blocks loaded from [plugins.<provider_id>] tables.
    # Keep values untyped so external plugins can own validation/defaults.
    plugins: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass(frozen=True)
class LoadedConfig:
    path: Path
    exists: bool
    config: Config


def _as_dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _coalesce(value: Any, default: Any) -> Any:
    return default if value is None else value


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
    raw_strava = _as_dict(raw.get("strava"))
    raw_eightsleep = _as_dict(raw.get("eightsleep"))
    raw_plugins = _as_dict(raw.get("plugins"))
    defaults = Config()

    app = AppConfig(
        db=_coalesce(_get_str(raw_app, "db"), defaults.app.db),
    )
    oura = OuraConfig(
        enabled=_coalesce(_get_bool(raw_oura, "enabled"), defaults.oura.enabled),
        access_token=_get_str(raw_oura, "access_token"),
        client_id=_get_str(raw_oura, "client_id"),
        client_secret=_get_str(raw_oura, "client_secret"),
        redirect_uri=_coalesce(_get_str(raw_oura, "redirect_uri"), defaults.oura.redirect_uri),
        scopes=_coalesce(_get_str(raw_oura, "scopes"), defaults.oura.scopes),
        start_date=_coalesce(_get_str(raw_oura, "start_date"), defaults.oura.start_date),
        overlap_days=_coalesce(_get_int(raw_oura, "overlap_days"), defaults.oura.overlap_days),
    )
    withings = WithingsConfig(
        enabled=_coalesce(_get_bool(raw_withings, "enabled"), defaults.withings.enabled),
        client_id=_get_str(raw_withings, "client_id"),
        client_secret=_get_str(raw_withings, "client_secret"),
        redirect_uri=_coalesce(_get_str(raw_withings, "redirect_uri"), defaults.withings.redirect_uri),
        scopes=_coalesce(_get_str(raw_withings, "scopes"), defaults.withings.scopes),
        overlap_seconds=_coalesce(_get_int(raw_withings, "overlap_seconds"), defaults.withings.overlap_seconds),
        meastypes=_get_list_str(raw_withings, "meastypes"),
    )
    hevy = HevyConfig(
        enabled=_coalesce(_get_bool(raw_hevy, "enabled"), defaults.hevy.enabled),
        api_key=_get_str(raw_hevy, "api_key"),
        base_url=_coalesce(_get_str(raw_hevy, "base_url"), defaults.hevy.base_url),
        overlap_seconds=_coalesce(_get_int(raw_hevy, "overlap_seconds"), defaults.hevy.overlap_seconds),
        page_size=_coalesce(_get_int(raw_hevy, "page_size"), defaults.hevy.page_size),
        since=_coalesce(_get_str(raw_hevy, "since"), defaults.hevy.since),
    )
    strava = StravaConfig(
        enabled=_coalesce(_get_bool(raw_strava, "enabled"), defaults.strava.enabled),
        access_token=_get_str(raw_strava, "access_token"),
        client_id=_get_str(raw_strava, "client_id"),
        client_secret=_get_str(raw_strava, "client_secret"),
        redirect_uri=_coalesce(_get_str(raw_strava, "redirect_uri"), defaults.strava.redirect_uri),
        scopes=_coalesce(_get_str(raw_strava, "scopes"), defaults.strava.scopes),
        approval_prompt=_coalesce(_get_str(raw_strava, "approval_prompt"), defaults.strava.approval_prompt),
        start_date=_coalesce(_get_str(raw_strava, "start_date"), defaults.strava.start_date),
        overlap_seconds=_coalesce(_get_int(raw_strava, "overlap_seconds"), defaults.strava.overlap_seconds),
        page_size=_coalesce(_get_int(raw_strava, "page_size"), defaults.strava.page_size),
    )
    eightsleep = EightSleepConfig(
        enabled=_coalesce(_get_bool(raw_eightsleep, "enabled"), defaults.eightsleep.enabled),
        access_token=_get_str(raw_eightsleep, "access_token"),
        email=_get_str(raw_eightsleep, "email"),
        password=_get_str(raw_eightsleep, "password"),
        client_id=_get_str(raw_eightsleep, "client_id"),
        client_secret=_get_str(raw_eightsleep, "client_secret"),
        timezone=_coalesce(_get_str(raw_eightsleep, "timezone"), defaults.eightsleep.timezone),
        auth_url=_coalesce(_get_str(raw_eightsleep, "auth_url"), defaults.eightsleep.auth_url),
        client_api_url=_coalesce(_get_str(raw_eightsleep, "client_api_url"), defaults.eightsleep.client_api_url),
        start_date=_coalesce(_get_str(raw_eightsleep, "start_date"), defaults.eightsleep.start_date),
        overlap_days=_coalesce(_get_int(raw_eightsleep, "overlap_days"), defaults.eightsleep.overlap_days),
    )

    plugins: dict[str, dict[str, Any]] = {}
    for plugin_id, plugin_cfg in raw_plugins.items():
        if not isinstance(plugin_id, str):
            continue
        if not isinstance(plugin_cfg, dict):
            continue
        plugins[plugin_id] = dict(plugin_cfg)

    return LoadedConfig(
        path=cfg_path,
        exists=True,
        config=Config(
            app=app,
            oura=oura,
            withings=withings,
            hevy=hevy,
            strava=strava,
            eightsleep=eightsleep,
            plugins=plugins,
        ),
    )


def require_str(cfg: LoadedConfig, v: str | None, *, key: str) -> str:
    if v:
        return v
    if not cfg.exists:
        raise RuntimeError(
            f"Config file not found: {cfg.path}. Create it from `health-sync.example.toml` and set `{key}`."
        )
    raise RuntimeError(f"Missing required config value `{key}` in {cfg.path}.")
