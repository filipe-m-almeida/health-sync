# health-sync SQLite Database (health.sqlite)

This reference documents the `health-sync` local SQLite cache: what tables exist, what the columns mean, how providers map to `provider/resource`, and a set of copy/paste SQL queries for common analysis and debugging tasks.

Source of truth:

- SQLite schema creation: `health_sync/db.py`
- Provider sync behavior: `health_sync/providers/oura.py`, `health_sync/providers/withings.py`, `health_sync/providers/hevy.py`

## Table Of Contents

- Safety and file handling
- Schema overview
- Provider and resource map
- Query cookbook

## Safety And File Handling

- Default DB path is `./health.sqlite` (see `[app].db` in `health-sync.toml`).
- SQLite WAL mode is enabled by `health_sync/db.py`, so you may also see:
  - `health.sqlite-wal`
  - `health.sqlite-shm`
- For analysis, prefer read-only access:

```bash
sqlite3 -readonly health.sqlite
```

- If you copy the DB for experiments, copy all three files (`.sqlite`, `-wal`, `-shm`) together, or checkpoint first.

## Schema Overview

`health-sync` uses a deliberately generic schema:

- Store raw provider JSON (so upstream schema changes do not require DB migrations).
- Keep sync state separate (watermarks/cursors).
- Keep OAuth secrets separate (tokens).

### `records` (Main Event Store)

One row per provider record.

Columns:

- `provider` (TEXT, required): one of `oura`, `withings`, `hevy`
- `resource` (TEXT, required): logical collection name, provider-specific
- `record_id` (TEXT, required): stable id within `(provider, resource)`
- `start_time` (TEXT, optional): usually ISO-8601 string; semantics vary by resource
- `end_time` (TEXT, optional): usually ISO-8601 string
- `source_updated_at` (TEXT, optional): provider-side update time (when available)
- `payload_json` (TEXT, required): raw JSON from provider
- `fetched_at` (TEXT, required): when the row was stored

Primary key:

- `(provider, resource, record_id)`

Indexes (important for analysis performance):

- `idx_records_prs` on `(provider, resource, start_time)`
- `idx_records_pru` on `(provider, resource, source_updated_at)`

Practical implications:

- Always filter by `provider` and `resource` first in queries.
- Prefer `start_time` window filters for time-range analysis (the `(provider, resource, start_time)` index is useful).

### `sync_state` (Watermarks And Cursors)

One row per `(provider, resource)` tracking how far sync has progressed.

Columns:

- `provider`, `resource` (primary key)
- `watermark` (TEXT): meaning depends on provider/resource
- `cursor` (TEXT): pagination cursor (provider-specific; often unused)
- `extra_json` (TEXT): provider-specific metadata
- `updated_at` (TEXT): when the state was last updated

Watermark formats vary:

- Withings: epoch seconds (stored as string, e.g. `"1700000000"`)
- Hevy: ISO timestamp
- Oura: mix of date strings (`YYYY-MM-DD`) and ISO timestamps depending on resource

### `oauth_tokens` (OAuth Secrets)

Contains access/refresh tokens and expiry information.

Columns include:

- `access_token`, `refresh_token`, `expires_at`, `scope`, `obtained_at`

Rules:

- Treat this table as secrets.
- Do not print tokens in logs, issues, PRs, or chat transcripts.
- Avoid `select * from oauth_tokens;` in ad-hoc debugging.

## Provider And Resource Map

The `provider` and `resource` values you will typically see in `records`:

### Oura (`provider = 'oura'`)

- `personal_info`
- `daily_activity`
- `daily_sleep`
- `daily_readiness`
- `sleep`
- `workout`
- `heartrate`

Notes:

- Most date-window collections use `start_date`/`end_date` and store a `sync_state.watermark` like `YYYY-MM-DD`.
- Heart rate (`heartrate`) is time-series and uses `start_datetime`/`end_datetime`; `sync_state.watermark` is ISO timestamp.

### Withings (`provider = 'withings'`)

- `measures` (from `measure/getmeas`)
- `activity` (from `v2/measure?action=getactivity`)
- `workouts` (from `v2/measure?action=getworkouts`)
- `sleep_summary` (from `v2/sleep?action=getsummary`)

Notes:

- Watermarks are epoch seconds (stringified ints).

### Hevy (`provider = 'hevy'`)

- `workouts` (primary resource)
- `workout_events` (optional audit trail of updated/deleted events)

Notes:

- On first run, `workouts` is a full backfill via `/v1/workouts`.
- Subsequent runs use `/v1/workouts/events?since=...` and update `sync_state` based on event times.

## Query Cookbook

The queries below assume you are in `sqlite3`.

Helpful defaults:

```sql
.headers on
.mode column
.nullvalue NULL
```

### Inventory: What Data Exists?

Providers present:

```sql
select provider, count(*) as n
from records
group by provider
order by n desc;
```

Resources present per provider:

```sql
select provider, resource, count(*) as n
from records
group by provider, resource
order by provider, n desc;
```

### Coverage: Date Ranges Per Resource

This is usually the fastest first-pass "do we have data?" check:

```sql
select
  provider,
  resource,
  min(start_time) as min_start,
  max(start_time) as max_start,
  count(*) as n
from records
group by provider, resource
order by provider, resource;
```

### Sync State: Watermarks

```sql
select provider, resource, watermark, updated_at
from sync_state
order by provider, resource;
```

### Inspect A Few Raw Payloads (Without Dumping Everything)

```sql
select
  provider,
  resource,
  record_id,
  start_time,
  substr(payload_json, 1, 200) as payload_head
from records
order by fetched_at desc
limit 20;
```

### JSON Extraction Cheatsheet

Check JSON support:

```sql
select json_extract('{\"a\": 1}', '$.a') as a;
```

Extract a scalar field:

```sql
select
  record_id,
  json_extract(payload_json, '$.id') as upstream_id
from records
where provider = 'hevy' and resource = 'workouts'
limit 10;
```

Iterate an array with `json_each`:

```sql
with workouts as (
  select record_id, payload_json
  from records
  where provider = 'hevy' and resource = 'workouts'
),
exercises as (
  select
    workouts.record_id as workout_id,
    json_extract(e.value, '$.title') as exercise_title
  from workouts, json_each(workouts.payload_json, '$.exercises') e
)
select exercise_title, count(*) as n
from exercises
where exercise_title is not null
group by exercise_title
order by n desc
limit 30;
```

### Hevy Workouts: Basic Summary

Counts and coverage:

```sql
select
  count(*) as workouts,
  min(start_time) as first_start,
  max(start_time) as last_start
from records
where provider = 'hevy' and resource = 'workouts';
```

Workouts per month:

```sql
select substr(start_time, 1, 7) as month, count(*) as workouts
from records
where provider = 'hevy' and resource = 'workouts'
group by month
order by month;
```

Workout duration distribution (minutes):

```sql
select
  round(min((julianday(end_time) - julianday(start_time)) * 24 * 60), 1) as min_minutes,
  round(avg((julianday(end_time) - julianday(start_time)) * 24 * 60), 1) as avg_minutes,
  round(max((julianday(end_time) - julianday(start_time)) * 24 * 60), 1) as max_minutes
from records
where provider = 'hevy' and resource = 'workouts'
  and start_time is not null and end_time is not null;
```

### Withings Measures: Count By Measure Type

This flattens the `measures[]` array inside each `measuregrps` record.

```sql
with grp as (
  select record_id, payload_json
  from records
  where provider = 'withings' and resource = 'measures'
),
meas as (
  select
    json_extract(m.value, '$.type') as type,
    json_extract(m.value, '$.unit') as unit
  from grp, json_each(grp.payload_json, '$.measures') m
)
select type, count(*) as n
from meas
where type is not null
group by type
order by n desc;
```

### Export Results

Export a query to CSV:

```sql
.headers on
.mode csv
.once /tmp/health-sync-export.csv
select provider, resource, count(*) as n
from records
group by provider, resource
order by provider, n desc;
.once stdout
```

