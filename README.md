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
- WHOOP (OAuth2)
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

1. Initialize config and DB, then follow the interactive provider onboarding wizard:

```bash
health-sync init
```

The wizard lets you:
- see all discovered providers in a checklist
- pick which providers to set up now
- get provider-specific setup URLs and callback values
- enter credentials directly into `health-sync.toml`
- run auth flows and save tokens in `.health-sync.creds`

Remote onboarding (for bot/operator handoff) is also available:

```bash
health-sync init remote bootstrap
```

2. (Optional) re-run auth for a single provider later:

```bash
health-sync auth oura
```

3. Sync data:

```bash
health-sync sync
```

4. Inspect sync state and counts:

```bash
health-sync status
```

## Remote Bootstrap Setup

This mode is designed for cross-device onboarding where the user runs setup locally and sends an encrypted bundle back to an operator/bot over untrusted transport (for example, Telegram).

### 1) Operator creates bootstrap token

```bash
health-sync init remote bootstrap --expires-in 24h
```

This command:
- generates one bootstrap key/session
- prints a bootstrap token to share with the user
- stores private key material locally under `~/.health-sync/remote-bootstrap`

### 2) User runs onboarding with the shared token

```bash
health-sync init remote run <bootstrap-token>
```

This command:
- runs normal guided `init` onboarding
- encrypts `health-sync.toml` + `.health-sync.creds` into an archive
- prints the archive path to send back to the operator
- purges local config/creds by default after archive creation

Options:
- `--output <path>`: choose archive output path
- `--keep-local`: keep local config/creds instead of purging

### 3) Operator imports encrypted archive

```bash
health-sync init remote finish <bootstrap-token-or-key-id> <archive-path>
```

This command:
- decrypts archive using stored bootstrap private key
- safely imports config/creds with timestamped backups
- marks bootstrap session as consumed (one-time use)

Options:
- `--target-config <path>`
- `--target-creds <path>`

Compatibility aliases:
- `health-sync init --remote-bootstrap`
- `health-sync init --remote <token>`
- `health-sync init --remote-bootstrap-finish <ref> <archive>`

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
redirect_uri = "http://localhost:8486/callback"
```

See `health-sync.example.toml` for all provider options.

## CLI Commands

- `health-sync init`: create a scaffolded config (from `health-sync.example.toml`), create DB tables, and launch interactive provider setup when running in a TTY
- `health-sync init remote bootstrap`: generate a remote bootstrap token/session
- `health-sync init remote run <token>`: run onboarding and emit encrypted remote archive
- `health-sync init remote finish <ref> <archive>`: decrypt and import remote archive
- `health-sync init-db`: create DB tables only (legacy)
- `health-sync auth <provider>`: run auth flow for one provider/plugin
- `health-sync auth <provider> --local`: enable manual callback/code paste mode
- `health-sync sync`: run sync for all enabled providers
- `health-sync sync --providers oura strava`: sync only selected providers
- `health-sync providers`: list discovered providers and whether they are enabled
- `health-sync status`: print watermarks, record counts, and recent runs

`auth` notes:

- Oura, Withings, Strava, and WHOOP: OAuth flow (CLI prints auth URL and waits for browser redirect callback by default).
- Use `health-sync auth <provider> --local` if you want manual callback/code paste mode.
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
- `~/.health-sync/remote-bootstrap`: private bootstrap sessions/keys for remote onboarding

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
