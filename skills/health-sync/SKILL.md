---
name: health-sync
description: Analyze the health-sync SQLite cache (health.sqlite) and its schema (records, sync_state, oauth_tokens). Use when querying or debugging synced health data from Oura, Withings, or Hevy; validating sync coverage/watermarks; or writing SQL that extracts fields from provider JSON payloads.
---

# Health Sync DB Analysis

## Overview

Use this skill to inspect and analyze the local SQLite database created by `health-sync`, including the high-level schema and repeatable SQL workflows for answering questions like "what data is present?", "what time range is covered?", and "why is a provider missing data?".

## Core SQLite Schema (Hit The Ground Running)

`health-sync` uses a generic schema so upstream provider JSON can be stored without migrations.

### `records` (Main Event Store)

One row per provider record (raw JSON).

Columns:

- `provider` (TEXT): `oura`, `withings`, `hevy`
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

### `oauth_tokens` (Secrets)

Contains OAuth access/refresh tokens for providers that require it.

Do not print or export this table.

## Provider Schemas

Provider-specific schemas are documented in dedicated reference files:

- Oura: `references/oura.md`
- Withings: `references/withings.md`
- Hevy: `references/hevy.md`

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
