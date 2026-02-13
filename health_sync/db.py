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
        if deleted:
            self.deleted_count += 1


class HealthSyncDb:
    def __init__(self, path: str) -> None:
        self.path = path
        self.conn: sqlite3.Connection | None = None
        self._savepoint_seq = 0

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

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_runs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              provider TEXT NOT NULL,
              resource TEXT NOT NULL,
              status TEXT NOT NULL,
              started_at TEXT NOT NULL,
              finished_at TEXT,
              watermark_before TEXT,
              watermark_after TEXT,
              inserted_count INTEGER NOT NULL DEFAULT 0,
              updated_count INTEGER NOT NULL DEFAULT 0,
              deleted_count INTEGER NOT NULL DEFAULT 0,
              unchanged_count INTEGER NOT NULL DEFAULT 0,
              error_text TEXT
            );
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_sync_runs_prs ON sync_runs(provider, resource, started_at DESC);"
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON sync_runs(status, started_at DESC);")

        # Best-effort normalization of legacy timestamp/watermark formats.
        sync_rows = list(cur.execute("SELECT provider, resource, watermark FROM sync_state WHERE watermark IS NOT NULL;"))
        for row in sync_rows:
            wm = row["watermark"]
            wm_norm = self._normalize_watermark(wm)
            if wm_norm != wm:
                cur.execute(
                    "UPDATE sync_state SET watermark=?, updated_at=? WHERE provider=? AND resource=?;",
                    (wm_norm, utc_now_iso(), row["provider"], row["resource"]),
                )

        token_rows = list(cur.execute("SELECT provider, expires_at FROM oauth_tokens WHERE expires_at IS NOT NULL;"))
        for row in token_rows:
            exp = row["expires_at"]
            exp_norm = self._normalize_watermark(exp)
            if exp_norm != exp:
                cur.execute(
                    "UPDATE oauth_tokens SET expires_at=? WHERE provider=?;",
                    (exp_norm, row["provider"]),
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
    ) -> str:
        fetched_at = fetched_at or utc_now_iso()
        payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)

        existing = self._c.execute(
            """
            SELECT payload_json, start_time, end_time, source_updated_at
            FROM records
            WHERE provider=? AND resource=? AND record_id=?;
            """,
            (provider, resource, record_id),
        ).fetchone()

        if existing is None:
            op = "inserted"
        else:
            unchanged = (
                existing["payload_json"] == payload_json
                and existing["start_time"] == start_time
                and existing["end_time"] == end_time
                and existing["source_updated_at"] == source_updated_at
            )
            op = "unchanged" if unchanged else "updated"

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
        return op

    def delete_record(self, *, provider: str, resource: str, record_id: str) -> bool:
        cur = self._c.execute(
            "DELETE FROM records WHERE provider=? AND resource=? AND record_id=?;", (provider, resource, record_id)
        )
        return cur.rowcount > 0

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
        extra = self._json_loads_or_none(row["extra_json"], context=f"sync_state {provider}/{resource}")
        return SyncState(provider=row["provider"], resource=row["resource"], watermark=row["watermark"], cursor=row["cursor"], extra=extra)

    def set_sync_state(
        self,
        *,
        provider: str,
        resource: str,
        watermark: str | int | float | datetime | None = None,
        cursor: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        updated_at = utc_now_iso()
        extra_json = json.dumps(extra, separators=(",", ":"), ensure_ascii=True) if extra is not None else None
        watermark_norm = self._normalize_watermark(watermark)
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
            (provider, resource, watermark_norm, cursor, extra_json, updated_at),
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
        obtained_at = utc_now_iso()
        extra_json = json.dumps(extra, separators=(",", ":"), ensure_ascii=True) if extra is not None else None
        expires_at_norm = self._normalize_watermark(expires_at)
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
            (provider, access_token, refresh_token, token_type, scope, expires_at_norm, obtained_at, extra_json),
        )

    def start_sync_run(
        self,
        *,
        provider: str,
        resource: str,
        watermark_before: str | int | float | datetime | None = None,
    ) -> int:
        started_at = utc_now_iso()
        wm_before = self._normalize_watermark(watermark_before)
        cur = self._c.execute(
            """
            INSERT INTO sync_runs(provider, resource, status, started_at, watermark_before)
            VALUES (?, ?, 'running', ?, ?);
            """,
            (provider, resource, started_at, wm_before),
        )
        return int(cur.lastrowid)

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
        finished_at = utc_now_iso()
        wm_after = self._normalize_watermark(watermark_after)
        self._c.execute(
            """
            UPDATE sync_runs
            SET status=?,
                finished_at=?,
                inserted_count=?,
                updated_count=?,
                deleted_count=?,
                unchanged_count=?,
                watermark_after=?,
                error_text=?
            WHERE id=?;
            """,
            (
                status,
                finished_at,
                int(inserted_count),
                int(updated_count),
                int(deleted_count),
                int(unchanged_count),
                wm_after,
                error_text,
                int(run_id),
            ),
        )

    @contextlib.contextmanager
    def sync_run(self, *, provider: str, resource: str) -> Iterator[SyncRunStats]:
        state_before = self.get_sync_state(provider=provider, resource=resource)
        run_id = self.start_sync_run(
            provider=provider,
            resource=resource,
            watermark_before=state_before.watermark if state_before else None,
        )
        stats = SyncRunStats()
        try:
            yield stats
        except Exception as e:  # noqa: BLE001
            state_after = self.get_sync_state(provider=provider, resource=resource)
            self.finish_sync_run(
                run_id=run_id,
                status="error",
                inserted_count=stats.inserted_count,
                updated_count=stats.updated_count,
                deleted_count=stats.deleted_count,
                unchanged_count=stats.unchanged_count,
                watermark_after=state_after.watermark if state_after else None,
                error_text=str(e),
            )
            raise
        else:
            state_after = self.get_sync_state(provider=provider, resource=resource)
            self.finish_sync_run(
                run_id=run_id,
                status="success",
                inserted_count=stats.inserted_count,
                updated_count=stats.updated_count,
                deleted_count=stats.deleted_count,
                unchanged_count=stats.unchanged_count,
                watermark_after=state_after.watermark if state_after else None,
            )

    def iter_sync_state(self) -> Iterable[sqlite3.Row]:
        return self._c.execute("SELECT provider, resource, watermark, updated_at FROM sync_state ORDER BY provider, resource;")

    def iter_record_counts(self) -> Iterable[sqlite3.Row]:
        return self._c.execute(
            "SELECT provider, resource, COUNT(*) AS cnt FROM records GROUP BY provider, resource ORDER BY provider, resource;"
        )

    def iter_sync_runs(self, *, limit: int = 25) -> Iterable[sqlite3.Row]:
        lim = max(1, int(limit))
        return self._c.execute(
            """
            SELECT id, provider, resource, status, started_at, finished_at,
                   inserted_count, updated_count, deleted_count, unchanged_count,
                   watermark_before, watermark_after, error_text
            FROM sync_runs
            ORDER BY id DESC
            LIMIT ?;
            """,
            (lim,),
        )

    @staticmethod
    def _normalize_watermark(v: str | int | float | datetime | None) -> str | None:
        if v is None:
            return None

        if isinstance(v, datetime):
            dt = v if v.tzinfo is not None else v.replace(tzinfo=UTC)
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

        # Date-only watermark -> midnight UTC.
        if len(s) == 10 and s[4:5] == "-" and s[7:8] == "-":
            try:
                return datetime.fromisoformat(f"{s}T00:00:00+00:00").replace(microsecond=0).isoformat().replace("+00:00", "Z")
            except Exception:  # noqa: BLE001
                return s

        raw = s[:-1] + "+00:00" if s.endswith("Z") else s
        try:
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return dt.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        except Exception:  # noqa: BLE001
            return s

    @staticmethod
    def _json_loads_or_none(v: str | None, *, context: str) -> dict[str, Any] | None:
        if not v:
            return None
        try:
            j = json.loads(v)
        except json.JSONDecodeError:
            warnings.warn(
                f"Invalid JSON in {context}; ignoring stored metadata.",
                RuntimeWarning,
                stacklevel=2,
            )
            return None
        return j if isinstance(j, dict) else None

    @contextlib.contextmanager
    def transaction(self) -> Iterator[None]:
        # Use SAVEPOINT so this works both at top-level and when nested inside
        # an already-open transaction from prior writes (e.g., token refresh).
        self._savepoint_seq += 1
        sp = f"tx_{self._savepoint_seq}"
        self._c.execute(f"SAVEPOINT {sp};")
        try:
            yield
        except Exception:
            self._c.execute(f"ROLLBACK TO SAVEPOINT {sp};")
            self._c.execute(f"RELEASE SAVEPOINT {sp};")
            raise
        else:
            self._c.execute(f"RELEASE SAVEPOINT {sp};")
