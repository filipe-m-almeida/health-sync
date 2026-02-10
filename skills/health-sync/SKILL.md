---
name: health-sync
description: Analyze the health-sync SQLite cache (health.sqlite) and its schema (records, sync_state, oauth_tokens). Use when querying or debugging synced health data from Oura, Withings, or Hevy; validating sync coverage/watermarks; or writing SQL that extracts fields from provider JSON payloads.
---

# Health Sync DB Analysis

## Overview

Use this skill to inspect and analyze the local SQLite database created by `health-sync`, including the high-level schema and repeatable SQL workflows for answering questions like "what data is present?", "what time range is covered?", and "why is a provider missing data?".

## Quick Workflow

1. Locate the database:
- Default path is `./health.sqlite` (or read `[app].db` in `health-sync.toml`).
- If the DB uses WAL mode, expect sibling files `health.sqlite-wal` and `health.sqlite-shm`.

2. Open it read-only (recommended):
```bash
sqlite3 -readonly health.sqlite
```

3. Inspect the schema and what data exists:
- Use `.tables` and `.schema` in the `sqlite3` shell.
- Start with counts grouped by `provider` and `resource`.

4. Use JSON extraction for analysis:
- `records.payload_json` stores raw provider JSON; use `json_extract(payload_json, '$.field')` and `json_each(...)` to analyze it.

5. Debug sync coverage:
- Use `sync_state` watermarks to understand what each provider/resource last synced.
- Compare `sync_state.watermark` to `records.start_time`/`source_updated_at`.

## Guardrails

- Treat `oauth_tokens` as secrets. Avoid printing access tokens/refresh tokens, and avoid queries like `select * from oauth_tokens;`.
- When exploring `records`, always filter by `provider` and `resource` first. The schema is indexed on `(provider, resource, start_time)` which keeps analysis fast.
- If you copy the DB for analysis, copy `health.sqlite`, `health.sqlite-wal`, and `health.sqlite-shm` together (or checkpoint WAL first) to get a consistent snapshot.

## References

For detailed schema notes and a SQL query cookbook, read `references/db.md`.
