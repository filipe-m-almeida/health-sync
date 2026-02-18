---
name: health-sync
description: Analyze the health-sync SQLite cache (health.sqlite) and its schema (`records`, `sync_state`, `oauth_tokens`, `sync_runs`). Use when querying or debugging synced health data from Oura, Withings, Hevy, Strava, or Eight Sleep; validating sync coverage/watermarks; or writing SQL that extracts fields from provider JSON payloads.
---

# Health Sync DB Analysis

## Overview

Use this skill to inspect and analyze the local SQLite database created by `health-sync`, including the high-level schema and repeatable SQL workflows for answering questions like "what data is present?", "what time range is covered?", and "why is a provider missing data?".

## Core SQLite Schema (Hit The Ground Running)

`health-sync` uses a generic schema so upstream provider JSON can be stored without migrations.

### `records` (Main Event Store)

One row per provider record (raw JSON).

Columns:

- `provider` (TEXT): `oura`, `withings`, `hevy`, `strava`, `eightsleep`
- `resource` (TEXT): provider-specific collection name (see provider reference files below)
- `record_id` (TEXT): stable id within `(provider, resource)`
- `start_time` (TEXT): usually ISO string or `YYYY-MM-DD` (semantics vary by provider/resource)
- `end_time` (TEXT): usually ISO string (often null)
- `source_updated_at` (TEXT): provider-side update timestamp when available (often null)
- `payload_json` (TEXT): raw provider JSON
- `fetched_at` (TEXT): when this row was written

Indexes:

- `(provider, resource, start_time)` for fast time-range queries
- `(provider, resource, source_updated_at)` for delta/debug queries

### `sync_state` (Watermarks/Cursors)

Tracks incremental sync progress per `(provider, resource)`.

Key points:

- `watermark` is normalized and stored as UTC ISO (`YYYY-MM-DDTHH:MM:SSZ`) by the DB layer.
- `cursor` is available for providers that need cursor-style pagination.
- `extra_json` stores optional provider metadata.

### `oauth_tokens` (Secrets)

Contains OAuth access/refresh tokens for providers that require it.

Do not print or export this table.

### `sync_runs` (Per-Sync Run Telemetry)

Tracks each sync run per `(provider, resource)` and status.

Key columns:

- `status`: `running`, `success`, or `error`
- `started_at`, `finished_at`
- `watermark_before`, `watermark_after`
- `inserted_count`, `updated_count`, `deleted_count`, `unchanged_count`
- `error_text` (only populated on failures)

## Provider Schemas

Provider-specific schemas are documented in dedicated reference files:

- Oura: `references/oura.md`
- Withings: `references/withings.md`
- Hevy: `references/hevy.md`
- Strava: `references/strava.md`
- Eight Sleep: `references/eightsleep.md`

Those files describe:

- Which `resource` values exist for that provider
- What `record_id` is derived from
- What `start_time`/`end_time`/`source_updated_at` mean
- The important JSON keys inside `payload_json` (including nested arrays/objects)

Default behavior:

- When the user asks about a specific provider, read the corresponding reference file first and start writing SQL from the documented schema.
- Only run schema-discovery queries (e.g., listing JSON keys with `json_each`) when the question depends on fields that are not documented or when a provider has introduced a new shape.

## References

Read only what you need:

- For Oura questions: `references/oura.md`
- For Withings questions: `references/withings.md`
- For Hevy questions: `references/hevy.md`
- For Strava questions: `references/strava.md`
- For Eight Sleep questions: `references/eightsleep.md`
