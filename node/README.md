# health-sync Node Port

This directory contains a Node.js implementation of `health-sync` with parity-oriented features:

- CLI commands: `init`, `init-db`, `auth`, `sync`, `providers`, `status`
- SQLite storage (`records`, `sync_state`, `oauth_tokens`, `sync_runs`)
- Built-in providers: Oura, Withings, Hevy, Strava, Eight Sleep
- Plugin loading from package metadata (`healthSyncProviders`) and `[plugins.<id>] module=...`

## Install

```bash
cd node
npm install
```

## Run

```bash
npm start -- --config ../health-sync.toml providers --verbose
npm start -- --config ../health-sync.toml status
```

## CLI

```bash
health-sync [--config path] [--db path] <command> [options]
```

Use the same `health-sync.toml` format as the Python implementation.
