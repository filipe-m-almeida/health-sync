---
name: health-sync
description: Analyze your health across providers (Oura, Withings, Hevy, Strava, Eight Sleep).
---

# Health Sync Setup + Analysis

## Default Behavior

- If the user asks to set up or initialize `health-sync`, follow **Setup Workflow**.
- If the user asks data questions on an existing DB, follow **Analysis Workflow**.
- Keep all setup actions inside `workspace/health-sync`.
- Prefer `health-sync` CLI flows; avoid direct provider API calls unless debugging.
- Never print secrets or query raw token values.

## Setup Workflow

### 0) Install + preflight

1. Ensure CLI is available:
   - `npm install -g health-sync`
   - `health-sync --help`
2. Ensure directory exists and operate there:
   - `workspace/health-sync`

Use exact command snippets from `references/setup.md`.

### 1) Initialize once

1. Run `health-sync init` in `workspace/health-sync`.
2. Confirm `health-sync.toml` exists.
3. Confirm `health.sqlite` exists.

### 2) Mandatory auth guidance model

When guiding setup, be direct:

1. OAuth2 providers (`oura`, `withings`, `strava`):
   - guide user to create app credentials (`client_id`, `client_secret`)
   - ensure callback URL is configured exactly in provider portal and `health-sync.toml`
   - run `health-sync auth <provider>`
   - if user sees an error page after consent, still ask for full callback URL
   - use that callback URL/code to complete the auth flow
2. Non-OAuth2 providers:
   - Hevy: API key only (`[hevy].api_key`), no `auth` command
   - Eight Sleep: account credentials or access token, then `health-sync auth eightsleep`

### 3) Choose setup flow (important)

After `init`, there are two supported flows:

1. Recommended flow (default):
   - guide user to fill `health-sync.toml`
   - user runs `health-sync auth` for each provider themselves
   - this is safer and reduces token leakage risk
2. Non-recommended assisted flow:
   - only if user explicitly asks
   - guide provider-by-provider and run `health-sync auth` one at a time
   - avoid direct `curl` flows unless debugging

### 4) Provider sequencing pattern for assisted flow

Proceed one provider at a time in this order:

1. `oura`
2. `withings`
3. `strava`
4. `eightsleep`
5. `hevy`

Per provider:

1. collect required config values
2. update `health-sync.toml`
3. run `health-sync auth <provider>` where supported
4. confirm success before moving on

### 5) Post-setup checks

1. `health-sync providers --verbose`
2. `health-sync sync` (only when user asks)
3. `health-sync status`

## Analysis Workflow

When setup is complete and user asks data questions:

1. Read provider schema reference first.
2. Query `records`, `sync_state`, and `sync_runs` as needed.
3. Keep SQL provider-aware (resource semantics vary).
4. For Hevy trend/report analysis, apply configured quality cutoff from `references/hevy.md` when present.

## References

Load only the file needed for the active task:

- Setup/auth behavior: `references/setup.md`
- Oura schema: `references/oura.md`
- Withings schema: `references/withings.md`
- Hevy schema + quality cutoff/query patterns: `references/hevy.md`
- Strava schema: `references/strava.md`
- Eight Sleep schema: `references/eightsleep.md`
