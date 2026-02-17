---
name: eightsleep
description: Analyze and troubleshoot Eight Sleep integration in this health-sync repo. Use when inspecting `health_sync/providers/eightsleep.py`, validating `[eightsleep]` config, debugging sync runs/watermarks, or writing SQL against `health.sqlite` for Eight Sleep resources (`users_me`, `devices`, `users`, `trends`).
---

# Eight Sleep Sync + SQLite Analysis

## Overview

Use this skill to answer Eight Sleep questions without re-discovering provider behavior each time. Prefer this workflow for sync/debug tasks and for SQL analysis of cached Eight Sleep records.

## Workflow

### 1. Classify the request

- Sync/config issue
- Data/query analysis
- Schema drift or unknown JSON field

### 2. Handle sync/config issues

- Read `health_sync/providers/eightsleep.py` first.
- Verify `[eightsleep]` values in `health-sync.toml` (`enabled`, auth fields, `timezone`, `start_date`, `overlap_days`).
- Check `sync_runs` and `sync_state` for resource-level failures or stale watermarks.
- Run targeted sync with `health-sync sync --providers eightsleep` when needed.

### 3. Handle data analysis

- Read `references/schema.md` before writing SQL.
- Scope queries with `where provider = 'eightsleep'`.
- Start from `resource = 'trends'` for daily sleep metrics.
- Use `json_extract(payload_json, ...)` for nested fields.

### 4. Handle schema drift

- Enumerate keys with `json_each(payload_json)` for the affected resource.
- Compare new keys against the documented map in `references/schema.md`.
- Keep documentation updates focused on high-signal fields used in queries/debugging.

## Quick Commands

```bash
# Sync only Eight Sleep
health-sync sync --providers eightsleep

# Show high-level state and run history
health-sync status
```

If `sqlite3` CLI is unavailable, use a short `python3` + `sqlite3` snippet for ad hoc queries.

## Guardrails

- Do not print secrets from `oauth_tokens`.
- Avoid dumping full `payload_json` when a focused field extraction is enough.
- Treat API behavior as unstable: this provider uses unofficial Eight Sleep endpoints.

## References

- Schema and query cookbook: `references/schema.md`
