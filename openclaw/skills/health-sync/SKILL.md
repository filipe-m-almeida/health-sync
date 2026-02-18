---
name: health-sync
description: Set up and operate health-sync in a dedicated health workspace (config/bootstrap, provider-by-provider auth, sync/status checks) and analyze the SQLite cache for Oura, Withings, Hevy, Strava, and Eight Sleep.
---

# Health Sync Setup + Analysis

Use this skill when the user needs help with `health-sync` setup, provider onboarding/auth, sync execution, or SQL/data debugging.

## Default Behavior

- If the user asks to set up or initialize `health-sync`, follow **Setup Workflow**.
- If the user asks data questions on an existing DB, follow **Analysis Workflow**.
- Setup sequence is: `init` once, `auth` providers one-by-one, then `sync` only on demand (or heartbeat automation).
- Never print secrets or query raw token values from `oauth_tokens`.

## Setup Workflow

Use this workflow for first-time setup in OpenClaw.

### 0) Install `health-sync` first (required)

Before any init/auth/sync steps, install from GitHub:

- `pip install https://github.com/filipe-m-almeida/health-sync.git`
- `python -m health_sync --help`

If `python -m health_sync` fails after install, stop and fix the Python environment before continuing.

### 1) Resolve workspace paths and CLI command

- Treat the agent's current working directory (`pwd`) as the active workspace root.
- Create and use a `health/` directory under that workspace root.
- Config path: `<workspace-root>/health/health-sync.toml`
- DB path: `<workspace-root>/health/health.sqlite`
- Repo root: use `git rev-parse --show-toplevel` when available.

Command preference:

1. Use `python -m health_sync`.
2. Use `uv run python -m health_sync` only if explicitly working from a local checkout.

### 2) Initialize workspace files

Perform these steps in order:

1. Create the health workspace directory if missing.
2. Run `python -m health_sync init` with explicit config and DB path.
3. Confirm `<health-dir>/health-sync.toml` and `<health-dir>/health.sqlite` now exist.

Reference commands and file-edit checklist are in `references/setup.md`.

### 3) Provider-by-provider initialization (required interaction pattern)

Ask the user one provider at a time, in this order:

1. `oura`
2. `withings`
3. `strava`
4. `eightsleep`
5. `hevy`

For each provider:

- Ask a direct yes/no question: "Initialize `<provider>` now?"
- If user declines: keep/set `enabled = false` and continue to the next provider.
- If user accepts: run that provider's setup/auth flow before moving on (`auth` scaffolds provider config and enables it).

Provider-specific details are in `references/setup.md`.

### 4) OAuth providers (interactive auth flow)

OAuth-style providers here are `oura`, `withings`, and `strava`.

For each OAuth provider the user enables:

1. Use `references/setup.md` to guide user with official provider URLs and exact click flow to create/find OAuth credentials.
2. Save `client_id`, `client_secret`, and redirect URI in config.
3. Start auth command in an interactive terminal session:
   - `python -m health_sync --config <config> --db <db> auth <provider>`
4. CLI prints an auth URL. Ask user to open/click it and complete consent.
5. Ask user to paste the final callback URL (or just `code`) back in chat.
6. Send pasted callback URL/code to the running auth command stdin.
7. Confirm token was stored successfully.

Important: `health-sync` auth commands accept either browser redirect or manual pasted callback URL/code.

### 5) Eight Sleep special handling

Eight Sleep uses password-grant auth flow. Always prefill these client credentials before auth if user did not override them:

- `client_id = "0894c7f33bb94800a03f1f4df13a4f38"`
- `client_secret = "f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76"`

Then collect `email` + `password` (or `access_token`) and run:

- `python -m health_sync --config <config> --db <db> auth eightsleep`

No provider developer-console app creation is required for Eight Sleep in this flow.

### 6) Validate unattended CLI setup

After provider onboarding:

1. Run `python -m health_sync --config <config> --db <db> providers`.
2. Run `python -m health_sync --config <config> --db <db> status`.
3. Optionally run `python -m health_sync --config <config> --db <db> sync --providers <enabled providers...>`.
4. Report any provider errors with concrete remediation steps (missing credentials, disabled provider, callback mismatch).

Run sync only on user request (or periodic heartbeat workflows).

## Analysis Workflow

When setup is done and user needs data help:

1. Read provider reference file first.
2. Query `records` / `sync_state` / `sync_runs` as needed.
3. Keep SQL provider-aware (resource semantics vary).
4. Avoid printing secrets from `oauth_tokens`.

## References

Read only what is needed for the task:

- Setup + auth checklist: `references/setup.md`
- Oura schema: `references/oura.md`
- Withings schema: `references/withings.md`
- Hevy schema: `references/hevy.md`
- Strava schema: `references/strava.md`
- Eight Sleep schema: `references/eightsleep.md`
