# health-sync

`health-sync` is an open-source CLI that pulls health and fitness data from multiple providers and stores it in a local SQLite database.

It is designed as a personal data cache: first sync backfills history, then future syncs fetch incremental updates.

## Purpose

- Keep your health data in one local database you control.
- Build your own dashboards, analysis scripts, or exports on top of raw provider data.
- Avoid building one-off sync scripts for each provider.

## Supported Providers

- Oura (Cloud API v2, OAuth2)
- Withings (Advanced Health Data API, OAuth2)
- Hevy (public API, API key, Pro account required)
- Strava (OAuth2 or static access token)
- Eight Sleep (unofficial API)

## Requirements

- Node.js 20+
- SQLite (bundled through `better-sqlite3`)
- Provider credentials (API key and/or OAuth client settings depending on provider)

## Installation

Install globally from npm:

```bash
npm install -g health-sync
```

Or run from this repository:

```bash
npm install
npm link
```

## Quick Start

1. Initialize config and DB:

```bash
health-sync init
```

2. Edit `health-sync.toml`:
- Set `[app].db` if you do not want `./health.sqlite`

3. Run provider auth one provider at a time:

```bash
health-sync auth oura
health-sync auth withings
health-sync auth strava
health-sync auth eightsleep
```

4. Sync data:

```bash
health-sync sync
```

5. Inspect sync state and counts:

```bash
health-sync status
```

## Basic Configuration

By default, `health-sync` reads `./health-sync.toml`.

Use a custom config file with:

```bash
health-sync --config /path/to/health-sync.toml sync
```

Minimal example:

```toml
[app]
db = "./health.sqlite"

[hevy]
enabled = true
api_key = "YOUR_HEVY_API_KEY"

[strava]
enabled = true
client_id = "YOUR_CLIENT_ID"
client_secret = "YOUR_CLIENT_SECRET"
redirect_uri = "http://127.0.0.1:8486/callback"
```

See `health-sync.example.toml` for all provider options.

## CLI Commands

- `health-sync init`: create a scaffolded config (from `health-sync.example.toml`) and create DB tables
- `health-sync init-db`: create DB tables only (legacy)
- `health-sync auth <provider>`: run auth flow for one provider/plugin
- `health-sync sync`: run sync for all enabled providers
- `health-sync sync --providers oura strava`: sync only selected providers
- `health-sync providers`: list discovered providers and whether they are enabled
- `health-sync status`: print watermarks, record counts, and recent runs

`auth` notes:

- Oura, Withings, and Strava: OAuth flow (CLI prints auth URL and waits for callback URL/code).
- Eight Sleep: username/password grant (or static token).
- Hevy: no `auth` command; configure `[hevy].api_key` directly.

`auth` also scaffolds the provider section in `health-sync.toml` (enables it and, for Eight Sleep, writes default client id/secret if missing).

Global flags:

- `--config`: config file path
- `--db`: override SQLite DB path

## Data Storage

The database keeps raw JSON payloads and sync metadata in generic tables:

- `records`: provider/resource records
- `sync_state`: per-resource watermarks/cursors
- `.health-sync.creds`: stored provider credentials and OAuth tokens
- `sync_runs`: run history and per-sync counters

This schema is intentionally generic so upstream API changes are less likely to require migrations.

## Optional Plugin System

You can add external providers as in-process plugins.

- Discover installed plugins with `health-sync providers`
- Configure plugin blocks under `[plugins.<id>]`
- Enable them with `[plugins.<id>].enabled = true`

## Notes

- Eight Sleep integration uses unofficial endpoints and may break if the upstream API changes.
- Some providers use overlap windows to ensure incremental sync correctness.

## Development

Run checks and tests:

```bash
npm run check
npm test
```

## License

MIT. See `LICENSE`.
