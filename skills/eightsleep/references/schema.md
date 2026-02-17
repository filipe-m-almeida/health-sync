# Eight Sleep Data Reference

## Table of Contents

1. Source of Truth
2. Provider Resource Mapping
3. Observed Database Snapshot
4. JSON Field Map
5. Query Cookbook
6. Troubleshooting Checklist

## Source of Truth

- Sync implementation: `health_sync/providers/eightsleep.py`
- Generic DB schema: `health_sync/db.py`
- Config keys/defaults: `health_sync/config.py` and `health-sync.example.toml`
- Live cache file: `health.sqlite`

This reference summarizes both code behavior and observed data from the current local DB snapshot.

## Provider Resource Mapping

All Eight Sleep rows are stored in `records` with `provider = 'eightsleep'`.

### `users_me`

- Endpoint: `GET /v1/users/me`
- `record_id`: `$.user.id` fallback `"me"`
- `start_time`: `NULL`
- `end_time`: `NULL`
- `source_updated_at`: sync time (`utc_now_iso()`), not provider-side update time

### `devices`

- Endpoint: `GET /v1/devices/{device_id}`
- `record_id`: first value from `users_me.user.devices[]`
- `start_time`: `NULL`
- `end_time`: `NULL`
- `source_updated_at`: sync time (`utc_now_iso()`)

### `users`

- Endpoint: `GET /v1/users/{user_id}`
- `record_id`: each distinct user id gathered from `users_me.user.id` (if present), `devices.result.leftUserId`, `devices.result.rightUserId`, and `devices.result.awaySides.*`
- `start_time`: `NULL`
- `end_time`: `NULL`
- `source_updated_at`: sync time (`utc_now_iso()`)

### `trends`

- Endpoint: `GET /v1/users/{user_id}/trends`
- Request params used by this repo: `tz`, `from`, `to`, `include-main=false`, `include-all-sessions=true`, `model-version=v2`
- `record_id`: `{user_id}:{day}` fallback `{user_id}:{sha256(day_json)}`
- `start_time`: `$.day` fallback `$.presenceStart`
- `end_time`: `$.presenceEnd`
- `source_updated_at`: `$.updatedAt` fallback `$.presenceStart` fallback `start_time`

## Observed Database Snapshot

Observed in `health.sqlite` on 2026-02-17:

- resources present: `users_me` 1 row, `devices` 1 row, `users` 2 rows, `trends` 194 rows
- trend coverage: min day `2025-08-05`, max day `2026-02-17`
- `users_me.record_id` is currently `"me"` (because payload has `user.userId` but not `user.id` in observed data)
- `sync_state` exists for all four Eight Sleep resources

Incremental behavior note:

- `sync_state('eightsleep','trends').watermark` stores sync time.
- `_trend_start_date()` parses that watermark, subtracts `[eightsleep].overlap_days`, and uses the result as next `from` date.
- First run falls back to `[eightsleep].start_date`.

## JSON Field Map

This map lists high-signal fields seen in current data. Use key-discovery queries for newly introduced fields.

### `users_me.payload_json.user`

- identity/profile: `userId`, `firstName`, `lastName`, `email`, `dob`, `gender`, `zip`
- account/settings: `emailVerified`, `sleepTracking`, `autopilotEnabled`, `tempPreference`
- device linkage: `devices`, `currentDevice`
- app metadata examples: `features`, `notifications`, `displaySettings`, `experimentalFeatures`

### `devices.payload_json.result`

- identity/linkage: `deviceId`, `ownerId`, `leftUserId`, `rightUserId`, `awaySides`
- connectivity/state: `online`, `timezone`, `lastHeard`, `needsPriming`, `hasWater`
- firmware: `firmwareVersion`, `firmwareCommit`, `firmwareUpdating`, `firmwareUpdated`
- heating/sides: `leftHeatingLevel`, `rightHeatingLevel`, `leftKelvin`, `rightKelvin`, schedules
- hardware info: `hubInfo`, `sensorInfo`, `mattressInfo`, `wifiInfo`

### `users.payload_json.user`

Generally matches `users_me.user` shape for each related user id.

### `trends.payload_json`

- identity and session groups: `day`, `mainSessionId`, `sessionIds`, `sessions`
- timing: `presenceStart`, `presenceEnd`, `sleepStart`, `sleepEnd`
- durations and percentages: `presenceDuration`, `sleepDuration`, `lightDuration`, `deepDuration`, `remDuration`, `snoreDuration`, `heavySnoreDuration`, and related percent fields
- scoring: `score`, `sleepQualityScore` (object), `sleepRoutineScore` (object)
- additional arrays/objects: `performanceWindows`, `tags`, `tnt`
- optional mitigation fields in most rows: `mitigationEvents`, `stoppedSnoringEvents`, `reducedSnoringEvents`, `elevationDuration`, `snoringReductionPercent`

Nested sessions (`$.sessions[]`) commonly include:

- `id`, `duration`, `sleepStart`, `sleepEnd`, `presenceEnd`, `timezone`, `score`
- algorithm metadata: `sleepAlgorithmVersion`, `presenceAlgorithmVersion`, `hrvAlgorithmVersion`
- detail payloads: `stages`, `stageSummary`, `timeseries`, `snoring`
- optional fields observed in subsets: `mitigationEvents`, `edit`, `editDate`

## Query Cookbook

### Resource coverage and date span

```sql
select
  resource,
  count(*) as rows,
  min(start_time) as min_start,
  max(start_time) as max_start,
  min(fetched_at) as first_fetch,
  max(fetched_at) as last_fetch
from records
where provider = 'eightsleep'
group by resource
order by resource;
```

### Latest nightly score and components

```sql
select
  record_id,
  start_time as day,
  json_extract(payload_json, '$.score') as score,
  json_extract(payload_json, '$.sleepQualityScore.total') as sleep_quality_total,
  json_extract(payload_json, '$.sleepRoutineScore.total') as sleep_routine_total,
  json_extract(payload_json, '$.sleepDuration') as sleep_duration_seconds
from records
where provider = 'eightsleep' and resource = 'trends'
order by day desc
limit 30;
```

### Flatten session-level rows

```sql
with trend_days as (
  select record_id, start_time as day, payload_json
  from records
  where provider = 'eightsleep' and resource = 'trends'
)
select
  td.record_id as trend_record_id,
  td.day,
  json_extract(s.value, '$.id') as session_id,
  json_extract(s.value, '$.duration') as session_duration_seconds,
  json_extract(s.value, '$.score') as session_score,
  json_extract(s.value, '$.sleepStart') as session_sleep_start,
  json_extract(s.value, '$.sleepEnd') as session_sleep_end
from trend_days td, json_each(td.payload_json, '$.sessions') s
order by td.day desc
limit 200;
```

### Inspect sync health for Eight Sleep

```sql
select provider, resource, watermark, updated_at
from sync_state
where provider = 'eightsleep'
order by resource;

select
  id, resource, status,
  inserted_count, updated_count, deleted_count, unchanged_count,
  started_at, finished_at, error_text
from sync_runs
where provider = 'eightsleep'
order by id desc
limit 20;
```

### Discover unknown keys safely

```sql
select j.key, count(*) as n
from records r, json_each(r.payload_json) j
where r.provider = 'eightsleep' and r.resource = 'trends'
group by j.key
order by n desc, j.key;
```

## Troubleshooting Checklist

1. Confirm provider enablement: `[eightsleep].enabled = true`.
2. Confirm auth path: static token (`eightsleep.access_token`) or password grant (`email`, `password`, `client_id`, `client_secret`).
3. If no trend rows arrive:
- inspect `sync_runs` error text for `resource='trends'`
- verify `sync_state` watermark format parses as date/datetime
- verify `timezone`, `start_date`, and `overlap_days`
4. If rows exist but fields seem missing:
- check key prevalence with `json_each`
- compare by date range and by user segment (`substr(record_id, 1, instr(record_id, ':') - 1)`)
5. Treat `users_me/devices/users` as snapshots:
- `source_updated_at` reflects sync time, not provider update time.
