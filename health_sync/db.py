from __future__ import annotations

import contextlib
import json
import sqlite3
from dataclasses import dataclass
from typing import Any, Iterable, Iterator

from .util import utc_now_iso


@dataclass(frozen=True)
class SyncState:
    provider: str
    resource: str
    watermark: str | None
    cursor: str | None
    extra: dict[str, Any] | None


class HealthSyncDb:
    def __init__(self, path: str) -> None:
        self.path = path
        self.conn: sqlite3.Connection | None = None

    def __enter__(self) -> "HealthSyncDb":
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.conn is not None:
            if exc is None:
                self.conn.commit()
            else:
                self.conn.rollback()
            self.conn.close()
            self.conn = None

    @property
    def _c(self) -> sqlite3.Connection:
        if self.conn is None:
            raise RuntimeError("DB not opened. Use `with HealthSyncDb(...) as db:`")
        return self.conn

    def init(self) -> None:
        cur = self._c.cursor()

        # WAL makes repeated incremental syncs much faster on SQLite.
        cur.execute("PRAGMA journal_mode=WAL;")
        cur.execute("PRAGMA foreign_keys=ON;")

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
              provider TEXT NOT NULL,
              resource TEXT NOT NULL,
              record_id TEXT NOT NULL,
              start_time TEXT,
              end_time TEXT,
              source_updated_at TEXT,
              payload_json TEXT NOT NULL,
              fetched_at TEXT NOT NULL,
              PRIMARY KEY (provider, resource, record_id)
            );
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_records_prs ON records(provider, resource, start_time);")
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_records_pru ON records(provider, resource, source_updated_at);"
        )

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_state (
              provider TEXT NOT NULL,
              resource TEXT NOT NULL,
              watermark TEXT,
              cursor TEXT,
              extra_json TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (provider, resource)
            );
            """
        )

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS oauth_tokens (
              provider TEXT NOT NULL PRIMARY KEY,
              access_token TEXT NOT NULL,
              refresh_token TEXT,
              token_type TEXT,
              scope TEXT,
              expires_at TEXT,
              obtained_at TEXT NOT NULL,
              extra_json TEXT
            );
            """
        )

        self._c.commit()

    def upsert_record(
        self,
        *,
        provider: str,
        resource: str,
        record_id: str,
        payload: dict[str, Any] | list[Any] | str | int | float | bool | None,
        start_time: str | None = None,
        end_time: str | None = None,
        source_updated_at: str | None = None,
        fetched_at: str | None = None,
    ) -> None:
        fetched_at = fetched_at or utc_now_iso()
        payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
        self._c.execute(
            """
            INSERT INTO records(provider, resource, record_id, start_time, end_time, source_updated_at, payload_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, resource, record_id) DO UPDATE SET
              start_time=excluded.start_time,
              end_time=excluded.end_time,
              source_updated_at=excluded.source_updated_at,
              payload_json=excluded.payload_json,
              fetched_at=excluded.fetched_at;
            """,
            (provider, resource, record_id, start_time, end_time, source_updated_at, payload_json, fetched_at),
        )

    def delete_record(self, *, provider: str, resource: str, record_id: str) -> None:
        self._c.execute(
            "DELETE FROM records WHERE provider=? AND resource=? AND record_id=?;", (provider, resource, record_id)
        )

    def get_max_start_time(self, *, provider: str, resource: str) -> str | None:
        row = self._c.execute(
            "SELECT MAX(start_time) AS mx FROM records WHERE provider=? AND resource=?;", (provider, resource)
        ).fetchone()
        if not row:
            return None
        return row["mx"]

    def get_sync_state(self, *, provider: str, resource: str) -> SyncState | None:
        row = self._c.execute(
            "SELECT provider, resource, watermark, cursor, extra_json FROM sync_state WHERE provider=? AND resource=?;",
            (provider, resource),
        ).fetchone()
        if row is None:
            return None
        extra = json.loads(row["extra_json"]) if row["extra_json"] else None
        return SyncState(provider=row["provider"], resource=row["resource"], watermark=row["watermark"], cursor=row["cursor"], extra=extra)

    def set_sync_state(
        self,
        *,
        provider: str,
        resource: str,
        watermark: str | None = None,
        cursor: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        updated_at = utc_now_iso()
        extra_json = json.dumps(extra, separators=(",", ":"), ensure_ascii=True) if extra is not None else None
        self._c.execute(
            """
            INSERT INTO sync_state(provider, resource, watermark, cursor, extra_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, resource) DO UPDATE SET
              watermark=excluded.watermark,
              cursor=excluded.cursor,
              extra_json=excluded.extra_json,
              updated_at=excluded.updated_at;
            """,
            (provider, resource, watermark, cursor, extra_json, updated_at),
        )

    def get_oauth_token(self, provider: str) -> dict[str, Any] | None:
        row = self._c.execute("SELECT * FROM oauth_tokens WHERE provider=?;", (provider,)).fetchone()
        if row is None:
            return None
        out = dict(row)
        out["extra"] = json.loads(out["extra_json"]) if out.get("extra_json") else None
        return out

    def set_oauth_token(
        self,
        *,
        provider: str,
        access_token: str,
        refresh_token: str | None,
        token_type: str | None,
        scope: str | None,
        expires_at: str | None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        obtained_at = utc_now_iso()
        extra_json = json.dumps(extra, separators=(",", ":"), ensure_ascii=True) if extra is not None else None
        self._c.execute(
            """
            INSERT INTO oauth_tokens(provider, access_token, refresh_token, token_type, scope, expires_at, obtained_at, extra_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider) DO UPDATE SET
              access_token=excluded.access_token,
              refresh_token=excluded.refresh_token,
              token_type=excluded.token_type,
              scope=excluded.scope,
              expires_at=excluded.expires_at,
              obtained_at=excluded.obtained_at,
              extra_json=excluded.extra_json;
            """,
            (provider, access_token, refresh_token, token_type, scope, expires_at, obtained_at, extra_json),
        )

    def iter_sync_state(self) -> Iterable[sqlite3.Row]:
        return self._c.execute("SELECT provider, resource, watermark, updated_at FROM sync_state ORDER BY provider, resource;")

    def iter_record_counts(self) -> Iterable[sqlite3.Row]:
        return self._c.execute(
            "SELECT provider, resource, COUNT(*) AS cnt FROM records GROUP BY provider, resource ORDER BY provider, resource;"
        )

    @contextlib.contextmanager
    def transaction(self) -> Iterator[None]:
        self._c.execute("BEGIN;")
        try:
            yield
        except Exception:
            self._c.rollback()
            raise
        else:
            self._c.commit()

