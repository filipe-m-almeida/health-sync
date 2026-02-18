from __future__ import annotations

import contextlib
import json
import sqlite3
import warnings
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Iterable, Iterator

from .util import utc_now_iso


@dataclass(frozen=True)
class SyncState:
    provider: str
    resource: str
    watermark: str | None
    cursor: str | None
    extra: dict[str, Any] | None


@dataclass
class SyncRunStats:
    inserted_count: int = 0
    updated_count: int = 0
    deleted_count: int = 0
    unchanged_count: int = 0

    def add_upsert(self, operation: str) -> None:
        if operation == "inserted":
            self.inserted_count += 1
        elif operation == "updated":
            self.updated_count += 1
        elif operation == "unchanged":
            self.unchanged_count += 1

    def add_delete(self, deleted: bool) -> None:
        self.deleted_count += int(bool(deleted))


_SCHEMA = (
    "PRAGMA journal_mode=WAL;",
    "PRAGMA foreign_keys=ON;",
    "CREATE TABLE IF NOT EXISTS records (provider TEXT NOT NULL,resource TEXT NOT NULL,record_id TEXT NOT NULL,start_time TEXT,end_time TEXT,source_updated_at TEXT,payload_json TEXT NOT NULL,fetched_at TEXT NOT NULL,PRIMARY KEY (provider, resource, record_id));",
    "CREATE INDEX IF NOT EXISTS idx_records_prs ON records(provider, resource, start_time);",
    "CREATE INDEX IF NOT EXISTS idx_records_pru ON records(provider, resource, source_updated_at);",
    "CREATE TABLE IF NOT EXISTS sync_state (provider TEXT NOT NULL,resource TEXT NOT NULL,watermark TEXT,cursor TEXT,extra_json TEXT,updated_at TEXT NOT NULL,PRIMARY KEY (provider, resource));",
    "CREATE TABLE IF NOT EXISTS oauth_tokens (provider TEXT NOT NULL PRIMARY KEY,access_token TEXT NOT NULL,refresh_token TEXT,token_type TEXT,scope TEXT,expires_at TEXT,obtained_at TEXT NOT NULL,extra_json TEXT);",
    "CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT NOT NULL,resource TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,watermark_before TEXT,watermark_after TEXT,inserted_count INTEGER NOT NULL DEFAULT 0,updated_count INTEGER NOT NULL DEFAULT 0,deleted_count INTEGER NOT NULL DEFAULT 0,unchanged_count INTEGER NOT NULL DEFAULT 0,error_text TEXT);",
    "CREATE INDEX IF NOT EXISTS idx_sync_runs_prs ON sync_runs(provider, resource, started_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON sync_runs(status, started_at DESC);",
)


class HealthSyncDb:
    def __init__(self, path: str) -> None:
        self.path = path
        self.conn: sqlite3.Connection | None = None
        self._savepoint_seq = 0

    def __enter__(self) -> HealthSyncDb:
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.conn is None:
            return
        (self.conn.commit if exc is None else self.conn.rollback)()
        self.conn.close()
        self.conn = None

    @property
    def _c(self) -> sqlite3.Connection:
        if self.conn is None:
            raise RuntimeError("DB not opened. Use `with HealthSyncDb(...) as db:`")
        return self.conn

    def init(self) -> None:
        for sql in _SCHEMA:
            self._c.execute(sql)
        self._normalize_column(table="sync_state", keys=("provider", "resource"), col="watermark", touch="updated_at")
        self._normalize_column(table="oauth_tokens", keys=("provider",), col="expires_at")
        self._c.commit()

    def _normalize_column(self, *, table: str, keys: tuple[str, ...], col: str, touch: str | None = None) -> None:
        key_sql = ", ".join(keys)
        for row in list(self._c.execute(f"SELECT {key_sql}, {col} FROM {table} WHERE {col} IS NOT NULL;")):
            if (after := self._normalize_watermark(row[col])) == row[col]:
                continue
            where = " AND ".join(f"{k}=?" for k in keys)
            params: list[Any] = [after]
            extra_set = f", {touch}=?" if touch else ""
            if touch:
                params.append(utc_now_iso())
            params.extend(row[k] for k in keys)
            self._c.execute(f"UPDATE {table} SET {col}=?{extra_set} WHERE {where};", params)

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
    ) -> str:
        payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
        row = self._c.execute(
            "SELECT payload_json,start_time,end_time,source_updated_at FROM records WHERE provider=? AND resource=? AND record_id=?;",
            (provider, resource, record_id),
        ).fetchone()
        op = "inserted" if row is None else (
            "unchanged" if row["payload_json"] == payload_json and row["start_time"] == start_time and row["end_time"] == end_time and row["source_updated_at"] == source_updated_at else "updated"
        )
        self._c.execute(
            "INSERT INTO records(provider,resource,record_id,start_time,end_time,source_updated_at,payload_json,fetched_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider,resource,record_id) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time,source_updated_at=excluded.source_updated_at,payload_json=excluded.payload_json,fetched_at=excluded.fetched_at;",
            (provider, resource, record_id, start_time, end_time, source_updated_at, payload_json, fetched_at or utc_now_iso()),
        )
        return op

    def delete_record(self, *, provider: str, resource: str, record_id: str) -> bool:
        return self._c.execute("DELETE FROM records WHERE provider=? AND resource=? AND record_id=?;", (provider, resource, record_id)).rowcount > 0

    def get_max_start_time(self, *, provider: str, resource: str) -> str | None:
        row = self._c.execute("SELECT MAX(start_time) AS mx FROM records WHERE provider=? AND resource=?;", (provider, resource)).fetchone()
        return row["mx"] if row else None

    def get_sync_state(self, *, provider: str, resource: str) -> SyncState | None:
        row = self._c.execute(
            "SELECT provider,resource,watermark,cursor,extra_json FROM sync_state WHERE provider=? AND resource=?;",
            (provider, resource),
        ).fetchone()
        if row is None:
            return None
        return SyncState(row["provider"], row["resource"], row["watermark"], row["cursor"], self._json_loads_or_none(row["extra_json"], context=f"sync_state {provider}/{resource}"))

    def set_sync_state(
        self,
        *,
        provider: str,
        resource: str,
        watermark: str | int | float | datetime | None = None,
        cursor: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        self._c.execute(
            "INSERT INTO sync_state(provider,resource,watermark,cursor,extra_json,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(provider,resource) DO UPDATE SET watermark=excluded.watermark,cursor=excluded.cursor,extra_json=excluded.extra_json,updated_at=excluded.updated_at;",
            (provider, resource, self._normalize_watermark(watermark), cursor, self._json_dumps(extra), utc_now_iso()),
        )

    def get_oauth_token(self, provider: str) -> dict[str, Any] | None:
        row = self._c.execute("SELECT * FROM oauth_tokens WHERE provider=?;", (provider,)).fetchone()
        if row is None:
            return None
        out = dict(row)
        out["extra"] = self._json_loads_or_none(out.get("extra_json"), context=f"oauth_tokens {provider}")
        return out

    def set_oauth_token(
        self,
        *,
        provider: str,
        access_token: str,
        refresh_token: str | None,
        token_type: str | None,
        scope: str | None,
        expires_at: str | int | float | datetime | None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        self._c.execute(
            "INSERT INTO oauth_tokens(provider,access_token,refresh_token,token_type,scope,expires_at,obtained_at,extra_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET access_token=excluded.access_token,refresh_token=excluded.refresh_token,token_type=excluded.token_type,scope=excluded.scope,expires_at=excluded.expires_at,obtained_at=excluded.obtained_at,extra_json=excluded.extra_json;",
            (provider, access_token, refresh_token, token_type, scope, self._normalize_watermark(expires_at), utc_now_iso(), self._json_dumps(extra)),
        )

    def start_sync_run(self, *, provider: str, resource: str, watermark_before: str | int | float | datetime | None = None) -> int:
        return int(
            self._c.execute(
                "INSERT INTO sync_runs(provider,resource,status,started_at,watermark_before) VALUES (?,?,'running',?,?);",
                (provider, resource, utc_now_iso(), self._normalize_watermark(watermark_before)),
            ).lastrowid
        )

    def finish_sync_run(
        self,
        *,
        run_id: int,
        status: str,
        inserted_count: int = 0,
        updated_count: int = 0,
        deleted_count: int = 0,
        unchanged_count: int = 0,
        watermark_after: str | int | float | datetime | None = None,
        error_text: str | None = None,
    ) -> None:
        self._c.execute(
            "UPDATE sync_runs SET status=?,finished_at=?,inserted_count=?,updated_count=?,deleted_count=?,unchanged_count=?,watermark_after=?,error_text=? WHERE id=?;",
            (status, utc_now_iso(), int(inserted_count), int(updated_count), int(deleted_count), int(unchanged_count), self._normalize_watermark(watermark_after), error_text, int(run_id)),
        )

    @contextlib.contextmanager
    def sync_run(self, *, provider: str, resource: str) -> Iterator[SyncRunStats]:
        before = self.get_sync_state(provider=provider, resource=resource)
        run_id = self.start_sync_run(provider=provider, resource=resource, watermark_before=before.watermark if before else None)
        stats = SyncRunStats()
        try:
            yield stats
            status, err = "success", None
        except Exception as e:  # noqa: BLE001
            status, err = "error", str(e)
            raise
        finally:
            after = self.get_sync_state(provider=provider, resource=resource)
            self.finish_sync_run(
                run_id=run_id,
                status=status,
                inserted_count=stats.inserted_count,
                updated_count=stats.updated_count,
                deleted_count=stats.deleted_count,
                unchanged_count=stats.unchanged_count,
                watermark_after=after.watermark if after else None,
                error_text=err,
            )

    def iter_sync_state(self) -> Iterable[sqlite3.Row]:
        return self._c.execute("SELECT provider,resource,watermark,updated_at FROM sync_state ORDER BY provider,resource;")

    def iter_record_counts(self) -> Iterable[sqlite3.Row]:
        return self._c.execute("SELECT provider,resource,COUNT(*) AS cnt FROM records GROUP BY provider,resource ORDER BY provider,resource;")

    def iter_sync_runs(self, *, limit: int = 25) -> Iterable[sqlite3.Row]:
        return self._c.execute("SELECT id,provider,resource,status,started_at,finished_at,inserted_count,updated_count,deleted_count,unchanged_count,watermark_before,watermark_after,error_text FROM sync_runs ORDER BY id DESC LIMIT ?;", (max(1, int(limit)),))

    @staticmethod
    def _normalize_watermark(v: str | int | float | datetime | None) -> str | None:
        if v is None:
            return None
        if isinstance(v, datetime):
            dt = v if v.tzinfo else v.replace(tzinfo=UTC)
            return dt.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(int(v), tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")

        s = str(v).strip()
        if not s:
            return None
        if s.isdigit():
            try:
                return datetime.fromtimestamp(int(s), tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            except Exception:  # noqa: BLE001
                return s
        try:
            dt = datetime.fromisoformat((f"{s}T00:00:00+00:00" if len(s) == 10 and s[4:5] == "-" and s[7:8] == "-" else (s[:-1] + "+00:00" if s.endswith("Z") else s)))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return dt.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        except Exception:  # noqa: BLE001
            return s

    @staticmethod
    def _json_dumps(v: dict[str, Any] | None) -> str | None:
        return json.dumps(v, separators=(",", ":"), ensure_ascii=True) if v is not None else None

    @staticmethod
    def _json_loads_or_none(v: str | None, *, context: str) -> dict[str, Any] | None:
        if not v:
            return None
        try:
            out = json.loads(v)
        except json.JSONDecodeError:
            warnings.warn(f"Invalid JSON in {context}; ignoring stored metadata.", RuntimeWarning, stacklevel=2)
            return None
        return out if isinstance(out, dict) else None

    @contextlib.contextmanager
    def transaction(self) -> Iterator[None]:
        self._savepoint_seq += 1
        sp = f"tx_{self._savepoint_seq}"
        self._c.execute(f"SAVEPOINT {sp};")
        try:
            yield
        except Exception:
            self._c.execute(f"ROLLBACK TO SAVEPOINT {sp};")
            self._c.execute(f"RELEASE SAVEPOINT {sp};")
            raise
        self._c.execute(f"RELEASE SAVEPOINT {sp};")
