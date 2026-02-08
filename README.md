# health-sync

Sync your health data from:

- Oura Cloud API (v2)
- Withings Advanced Health Data API
- Hevy public API (Pro-only, `api-key` header)

into a local SQLite database.

This repo was scaffolded as a pragmatic “local cache” tool:

- First run: backfills history (bounded by optional start-date env vars).
- Subsequent runs: fetch deltas (Withings `lastupdate`, Hevy workout events, Oura date windows with overlap).

## Quick Start

1. Pick a DB path:

```bash
export HEALTH_SYNC_DB="$PWD/health.sqlite"
```

2. Install deps (only `requests` is required; it’s often already installed):

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements.txt
```

3. Initialize DB:

```bash
python3 -m health_sync init-db
```

4. Authenticate providers (choose what you use):

### Oura

Option A (simplest): Personal Access Token

```bash
export OURA_ACCESS_TOKEN="..."
```

Option B: OAuth2 (Authorization Code)

```bash
export OURA_CLIENT_ID="..."
export OURA_CLIENT_SECRET="..."
export OURA_REDIRECT_URI="http://localhost:8484/callback"
python3 -m health_sync auth oura
```

### Withings (OAuth2)

```bash
export WITHINGS_CLIENT_ID="..."
export WITHINGS_CLIENT_SECRET="..."
export WITHINGS_REDIRECT_URI="http://localhost:8485/callback"
python3 -m health_sync auth withings
```

Withings token exchange uses their `nonce` + HMAC signature protocol (implemented in this repo).

### Hevy

Hevy’s API is Pro-only; you get your API key at `https://hevy.com/settings?developer`.

```bash
export HEVY_API_KEY="00000000-0000-0000-0000-000000000000"
```

5. Sync:

```bash
python3 -m health_sync sync
```

## Environment Variables

Common:

- `HEALTH_SYNC_DB`: Path to SQLite DB (default: `./health.sqlite`)

Optional “initial backfill” bounds:

- `OURA_START_DATE`: YYYY-MM-DD (default: `2010-01-01`)

Provider tuning:

- `OURA_OVERLAP_DAYS`: Re-fetch overlap window on each sync (default: `7`)
- `WITHINGS_OVERLAP_SECONDS`: Re-fetch overlap window on each sync (default: `300`)
- `WITHINGS_MEASTYPES`: Comma-separated integer measure type ids to sync (defaults include weight/body-comp/vitals)
- `HEVY_OVERLAP_SECONDS`: Re-fetch overlap for events (default: `300`)
- `HEVY_PAGE_SIZE`: 1-10 (default: `10`)
- `HEVY_BASE_URL`: Override API base (default: `https://api.hevyapp.com`)

Auth:

- `OURA_ACCESS_TOKEN`: Oura PAT
- `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_REDIRECT_URI`
- `WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET`, `WITHINGS_REDIRECT_URI`
- `HEVY_API_KEY`

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
