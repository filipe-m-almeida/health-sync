# health-sync

Sync your health data from:

- Oura Cloud API (v2)
- Withings Advanced Health Data API
- Hevy public API (Pro-only, `api-key` header)

into a local SQLite database.

This repo was scaffolded as a pragmatic “local cache” tool:

- First run: backfills history (bounded by optional start-date config values).
- Subsequent runs: fetch deltas (Withings `lastupdate`, Hevy workout events, Oura date windows with overlap).

## Quick Start

1. Create a config file:

```bash
cp health-sync.example.toml health-sync.toml
```

Fill in `health-sync.toml` (DB path, API keys, OAuth client ids/secrets).

2. Install deps with `uv`:

```bash
uv venv
. .venv/bin/activate
uv pip install -e .
```

3. Initialize DB:

```bash
health-sync init-db
```

4. Authenticate providers (choose what you use):

### Oura

Option A (simplest): Personal Access Token

Set `oura.access_token` in `health-sync.toml`.

Option B: OAuth2 (Authorization Code)

Set `oura.client_id`, `oura.client_secret`, and `oura.redirect_uri` in `health-sync.toml`, then run:

```bash
health-sync auth oura
```

### Withings (OAuth2)

Set `withings.client_id`, `withings.client_secret`, and `withings.redirect_uri` in `health-sync.toml`, then run:

```bash
health-sync auth withings
```

Withings token exchange uses their `nonce` + HMAC signature protocol (implemented in this repo).

### Hevy

Hevy’s API is Pro-only; you get your API key at `https://hevy.com/settings?developer`.

Set `hevy.api_key` in `health-sync.toml`.

5. Enable the providers you actually want to sync (defaults to disabled):

- Set `[oura].enabled = true` to sync Oura
- Set `[withings].enabled = true` to sync Withings
- Set `[hevy].enabled = true` to sync Hevy

6. Sync:

```bash
health-sync sync
```

## Configuration (TOML)

By default, `health-sync` reads `./health-sync.toml` (relative to your current working directory).
You can override it via `--config /path/to/health-sync.toml`.

All config keys live in the example file: `health-sync.example.toml`.

Common:

- `[app].db`: Path to SQLite DB (default: `./health.sqlite`)

Oura:

- `[oura].enabled`: Set to `true` to sync Oura (default: `false`)
- `[oura].access_token`: Oura PAT (simplest)
- `[oura].client_id`, `[oura].client_secret`, `[oura].redirect_uri`: OAuth2
- Note: for local OAuth, use `http://localhost:8484/callback`. Oura rejects `http://127.0.0.1:...` with `400 invalid_request`.
- `[oura].start_date`: YYYY-MM-DD (default: `2010-01-01`)
- `[oura].overlap_days`: Re-fetch overlap window on each sync (default: `7`)

Withings:

- `[withings].enabled`: Set to `true` to sync Withings (default: `false`)
- `[withings].client_id`, `[withings].client_secret`, `[withings].redirect_uri`: OAuth2
- `[withings].scopes`: OAuth scopes (default: `user.metrics,user.activity`). Note: sleep endpoints are included in `user.activity` (there is no `user.sleep` scope).
- `[withings].overlap_seconds`: Re-fetch overlap window on each sync (default: `300`)
- `[withings].meastypes`: Optional list of measure type ids (default is a broad list)

Hevy:

- `[hevy].enabled`: Set to `true` to sync Hevy (default: `false`)
- `[hevy].api_key`: Hevy API key
- `[hevy].base_url`: Override API base (default: `https://api.hevyapp.com`)
- `[hevy].overlap_seconds`: Re-fetch overlap for events (default: `300`)
- `[hevy].page_size`: 1-10 (default: `10`)
- `[hevy].since`: Fallback ISO timestamp used if watermark parsing fails (default: `1970-01-01T00:00:00Z`)

## Database Layout (high level)

- `records`: generic JSON records keyed by `(provider, resource, record_id)`.
- `sync_state`: per `(provider, resource)` watermarks/cursors.
- `oauth_tokens`: stored access/refresh tokens for OAuth providers.

The schema is intentionally generic: it stores raw provider JSON so you can reprocess later without
needing migrations for every upstream schema change.

## Notes / Caveats

- Oura does not expose a universal “updated_since” parameter across all endpoints, so this tool
  implements delta sync by re-fetching a small overlapping window based on your last successful
  watermark.
- Withings supports true delta sync using `lastupdate` and `modified` timestamps.
- Hevy supports true delta sync for workouts via `/v1/workouts/events` (updated/deleted).
