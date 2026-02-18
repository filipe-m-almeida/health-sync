from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Iterator
from urllib.parse import quote, urlencode, urlparse

from ..db import HealthSyncDb, SyncRunStats
from ..util import iso_to_dt, sha256_hex


@dataclass(frozen=True)
class OAuthRedirectSpec:
    redirect_uri: str
    listen_host: str
    listen_port: int
    callback_path: str


def parse_redirect_uri(
    raw_uri: str | None,
    *,
    default_uri: str,
    key_name: str,
) -> OAuthRedirectSpec:
    redirect_uri = (raw_uri or default_uri).strip()
    parsed = urlparse(redirect_uri)
    if parsed.scheme not in {"http", "https"}:
        raise RuntimeError(f"Invalid `{key_name}`: {redirect_uri}")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = parsed.path or "/callback"
    return OAuthRedirectSpec(
        redirect_uri=redirect_uri,
        listen_host=host,
        listen_port=port,
        callback_path=path,
    )


def build_auth_url(base_url: str, params: Mapping[str, Any]) -> str:
    clean = {k: str(v) for k, v in params.items() if v is not None}
    return f"{base_url}?{urlencode(clean, quote_via=quote)}"


def normalize_expires_at(expires_at: object) -> datetime | None:
    if expires_at is None:
        return None
    if isinstance(expires_at, datetime):
        return expires_at if expires_at.tzinfo is not None else expires_at.replace(tzinfo=UTC)

    raw = str(expires_at).strip()
    if not raw:
        return None

    if raw.isdigit():
        return datetime.fromtimestamp(int(raw), tz=UTC)

    if len(raw) == 10 and raw[4:5] == "-" and raw[7:8] == "-":
        try:
            return datetime.fromisoformat(f"{raw}T00:00:00+00:00")
        except Exception:  # noqa: BLE001
            return None

    try:
        return iso_to_dt(raw)
    except Exception:  # noqa: BLE001
        return None


def token_expiring_soon(
    expires_at: object,
    *,
    now: datetime | None = None,
    skew_seconds: int = 60,
) -> bool:
    exp = normalize_expires_at(expires_at)
    if exp is None:
        return True
    now_dt = now or datetime.now(UTC)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=UTC)
    return exp <= now_dt + timedelta(seconds=max(0, int(skew_seconds)))


def token_extra(payload: Mapping[str, Any], *, excluded: Sequence[str]) -> dict[str, Any]:
    excluded_set = set(excluded)
    return {k: v for k, v in payload.items() if k not in excluded_set}


def stable_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def first_present(item: Mapping[str, Any], keys: Sequence[str]) -> Any:
    for key in keys:
        if key in item:
            value = item.get(key)
            if value is not None and value != "":
                return value
    return None


def record_id_for(
    item: Mapping[str, Any],
    *,
    keys: Sequence[str],
    fallback_prefix: str | None = None,
) -> str:
    value = first_present(item, keys)
    if value is not None:
        return str(value)

    rid = sha256_hex(stable_json(item))
    if fallback_prefix:
        return f"{fallback_prefix}:{rid}"
    return rid


def upsert_item(
    db: HealthSyncDb,
    run: SyncRunStats,
    *,
    provider: str,
    resource: str,
    item: Mapping[str, Any],
    record_id_keys: Sequence[str],
    start_keys: Sequence[str] = (),
    end_keys: Sequence[str] = (),
    updated_keys: Sequence[str] = (),
    fallback_prefix: str | None = None,
) -> str:
    rid = record_id_for(item, keys=record_id_keys, fallback_prefix=fallback_prefix)
    start_time = first_present(item, start_keys)
    end_time = first_present(item, end_keys)
    source_updated_at = first_present(item, updated_keys)
    op = db.upsert_record(
        provider=provider,
        resource=resource,
        record_id=rid,
        payload=dict(item),
        start_time=str(start_time) if start_time is not None else None,
        end_time=str(end_time) if end_time is not None else None,
        source_updated_at=str(source_updated_at) if source_updated_at is not None else None,
    )
    run.add_upsert(op)
    return op


@contextmanager
def sync_resource(db: HealthSyncDb, *, provider: str, resource: str) -> Iterator[SyncRunStats]:
    with db.sync_run(provider=provider, resource=resource) as run:
        with db.transaction():
            yield run
