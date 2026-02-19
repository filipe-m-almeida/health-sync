from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import re
from typing import Any

import tomllib


DEFAULT_CONFIG_FILENAME = "health-sync.toml"


@dataclass(frozen=True)
class AppConfig:
    db: str = "./health.sqlite"


@dataclass(frozen=True)
class OuraConfig:
    enabled: bool = False

    # OAuth2 (Authorization Code + refresh token)
    client_id: str | None = None
    client_secret: str | None = None
    authorize_url: str = "https://moi.ouraring.com/oauth/v2/ext/oauth-authorize"
    token_url: str = "https://moi.ouraring.com/oauth/v2/ext/oauth-token"
    # Oura's OAuth authorize endpoint rejects `http://127.0.0.1/...` with
    # `400 invalid_request`; `http://localhost/...` works for local flows.
    redirect_uri: str = "http://localhost:8080/callback"
    scopes: str = "extapi:daily extapi:heartrate extapi:personal extapi:workout extapi:session extapi:tag extapi:spo2"

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
    # Known public Eight Sleep OAuth client values used by the official app.
    client_id: str = "0894c7f33bb94800a03f1f4df13a4f38"
    client_secret: str = "f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76"

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

    oura_enabled = _get_bool(raw_oura, "enabled")
    withings_enabled = _get_bool(raw_withings, "enabled")
    hevy_enabled = _get_bool(raw_hevy, "enabled")
    strava_enabled = _get_bool(raw_strava, "enabled")
    eightsleep_enabled = _get_bool(raw_eightsleep, "enabled")

    app = AppConfig(
        db=_get_str(raw_app, "db") or AppConfig().db,
    )
    oura = OuraConfig(
        enabled=oura_enabled if oura_enabled is not None else OuraConfig().enabled,
        client_id=_get_str(raw_oura, "client_id"),
        client_secret=_get_str(raw_oura, "client_secret"),
        authorize_url=_get_str(raw_oura, "authorize_url") or OuraConfig().authorize_url,
        token_url=_get_str(raw_oura, "token_url") or OuraConfig().token_url,
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
    strava_overlap_seconds = _get_int(raw_strava, "overlap_seconds")
    strava_page_size = _get_int(raw_strava, "page_size")
    strava = StravaConfig(
        enabled=strava_enabled if strava_enabled is not None else StravaConfig().enabled,
        access_token=_get_str(raw_strava, "access_token"),
        client_id=_get_str(raw_strava, "client_id"),
        client_secret=_get_str(raw_strava, "client_secret"),
        redirect_uri=_get_str(raw_strava, "redirect_uri") or StravaConfig().redirect_uri,
        scopes=_get_str(raw_strava, "scopes") or StravaConfig().scopes,
        approval_prompt=_get_str(raw_strava, "approval_prompt") or StravaConfig().approval_prompt,
        start_date=_get_str(raw_strava, "start_date") or StravaConfig().start_date,
        overlap_seconds=strava_overlap_seconds if strava_overlap_seconds is not None else StravaConfig().overlap_seconds,
        page_size=strava_page_size if strava_page_size is not None else StravaConfig().page_size,
    )
    eightsleep_overlap_days = _get_int(raw_eightsleep, "overlap_days")
    eightsleep = EightSleepConfig(
        enabled=eightsleep_enabled if eightsleep_enabled is not None else EightSleepConfig().enabled,
        access_token=_get_str(raw_eightsleep, "access_token"),
        email=_get_str(raw_eightsleep, "email"),
        password=_get_str(raw_eightsleep, "password"),
        client_id=_get_str(raw_eightsleep, "client_id") or EightSleepConfig().client_id,
        client_secret=_get_str(raw_eightsleep, "client_secret") or EightSleepConfig().client_secret,
        timezone=_get_str(raw_eightsleep, "timezone") or EightSleepConfig().timezone,
        auth_url=_get_str(raw_eightsleep, "auth_url") or EightSleepConfig().auth_url,
        client_api_url=_get_str(raw_eightsleep, "client_api_url") or EightSleepConfig().client_api_url,
        start_date=_get_str(raw_eightsleep, "start_date") or EightSleepConfig().start_date,
        overlap_days=eightsleep_overlap_days if eightsleep_overlap_days is not None else EightSleepConfig().overlap_days,
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


_SECTION_HEADER_RE = re.compile(r"(?m)^\[(?P<section>[^\]\n]+)\]\s*$")
_BUILTIN_PROVIDERS = {"oura", "withings", "hevy", "strava", "eightsleep"}


def _toml_literal(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, str):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    raise TypeError(f"Unsupported TOML value type: {type(value).__name__}")


def _find_section_span(content: str, section: str) -> tuple[int, int] | None:
    matches = list(_SECTION_HEADER_RE.finditer(content))
    for idx, match in enumerate(matches):
        if match.group("section").strip() != section:
            continue
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(content)
        return start, end
    return None


def _upsert_section_values(content: str, section: str, updates: dict[str, Any]) -> str:
    span = _find_section_span(content, section)
    if span is None:
        out = content
        if out and not out.endswith("\n"):
            out += "\n"
        if out and not out.endswith("\n\n"):
            out += "\n"
        out += f"[{section}]\n"
        for key, value in updates.items():
            out += f"{key} = {_toml_literal(value)}\n"
        return out

    start, end = span
    body = content[start:end]
    for key, value in updates.items():
        line = f"{key} = {_toml_literal(value)}"
        key_re = re.compile(rf"(?m)^[ \t]*{re.escape(key)}[ \t]*=.*$")
        if key_re.search(body):
            body = key_re.sub(line, body, count=1)
        else:
            if body and not body.endswith("\n"):
                body += "\n"
            body += f"{line}\n"

    return f"{content[:start]}{body}{content[end:]}"


def _read_config_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def init_config_file(path: Path, *, db_path: str) -> None:
    cfg_path = Path(path).expanduser()
    current = _read_config_text(cfg_path)
    updated = _upsert_section_values(current, "app", {"db": db_path})
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(updated, encoding="utf-8")


def scaffold_provider_config(path: Path, provider_id: str) -> None:
    cfg_path = Path(path).expanduser()

    if provider_id in _BUILTIN_PROVIDERS:
        section = provider_id
        updates: dict[str, Any] = {"enabled": True}
        if provider_id == "eightsleep":
            updates["client_id"] = EightSleepConfig().client_id
            updates["client_secret"] = EightSleepConfig().client_secret
    else:
        section = f"plugins.{provider_id}"
        updates = {"enabled": True}

    current = _read_config_text(cfg_path)
    updated = _upsert_section_values(current, section, updates)
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(updated, encoding="utf-8")
