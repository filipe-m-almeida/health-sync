---
name: health-sync
description: Set up and operate health-sync in a dedicated health workspace (preflight checks, config/bootstrap, provider auth, sync/status checks) and analyze the SQLite cache for Oura, Withings, Hevy, Strava, and Eight Sleep.
---

# Health Sync Setup + Analysis

## Default Behavior

- If the user asks to set up or initialize `health-sync`, follow **Setup Workflow**.
- If the user asks data questions on an existing DB, follow **Analysis Workflow**.
- Setup sequence is: preflight, `init` once, provider auth/setup one-by-one, then `sync` only on demand.
- Never print secrets or query raw token values from `oauth_tokens`.
- Accept natural user input (plain text, copied URL, screenshot transcription). Ask for strict formats only when technically required.

## Setup Workflow

### 0) Run mandatory preflight before auth/setup

Do this before asking the user for any provider credentials:

1. Verify CLI/runtime:
   - `python -m health_sync --help` (or `python3 -m health_sync --help` when `python` alias is absent)
2. Resolve workspace and expected paths from `pwd`:
   - `<workspace>/health/health-sync.toml`
   - `<workspace>/health/health.sqlite`
3. If CLI or paths are missing:
   - run install/bootstrap flow first
   - do not continue into auth steps until preflight passes

Use exact command snippets from `references/setup.md`.

### 1) Install/bootstrap only if preflight fails

- Install from GitHub:
  - `pip install https://github.com/filipe-m-almeida/health-sync.git`
- Re-run preflight checks.
- If `python -m health_sync` / `python3 -m health_sync` still fails, stop and fix Python environment first.

### 2) Initialize config + DB

1. Create `<workspace>/health/` if missing.
2. Run `init` via `HS_CMD` wrapper from `references/setup.md` with explicit `--config` and `--db`.
3. Confirm both files exist:
   - `<workspace>/health/health-sync.toml`
   - `<workspace>/health/health.sqlite`

### 3) Apply onboarding UX standard (required)

For guided provider setup:

1. One action per message.
2. Fully populated copy/paste command/URL once user provides values (no unresolved placeholders).
3. State the exact expected artifact/output for each step.
4. On errors, ask only for the minimum artifact needed (for OAuth: full callback URL or full terminal error text).

### 4) Provider sequencing pattern

Ask exactly one yes/no question per provider, in this order:

1. `oura`
2. `withings`
3. `strava`
4. `eightsleep`
5. `hevy`

If no: keep/set `enabled = false` and continue.
If yes: complete that provider setup before moving to the next.

### 5) OAuth providers (`oura`, `withings`, `strava`)

For each enabled OAuth provider:

1. Guide user through app setup URL(s) from `references/setup.md`.
2. Collect and confirm credentials as exact text:
   - `client_id`
   - `client_secret`
3. Set exact redirect URI in provider app and config.
4. Run interactive auth command:
   - run `auth <provider>` via `HS_CMD` wrapper from `references/setup.md`
5. Collect final callback URL (or `code`) and send to command stdin.
6. Confirm token persistence success.
7. Validate with one real provider API check from `references/setup.md`.

Important OAuth callout:

- Authorize URL uses `client_id` + exact `redirect_uri` only.
- Token exchange uses `client_id` + `client_secret` + `code`.

If token exchange fails after an endpoint mismatch or `invalid_grant`:

- request a fresh authorization code immediately
- perform one immediate retry at the correct token endpoint

### 6) Oura-specific rules (critical)

- Oura is OAuth2-only in this workflow (no personal token setup path).
- Use Oura app console:
  - `https://developer.ouraring.com/applications`
- Default redirect URI for this setup:
  - `http://localhost:8080/callback`
- Use issuer-era OAuth endpoints/scopes from `references/setup.md`.
- Before user clicks authorize:
  - tell them that an authorize page error can still produce a valid callback URL
  - if that happens, they should still copy and send the full callback URL

### 7) Eight Sleep-specific rules

- Validate credentials first with:
  - `POST https://client-api.8slp.net/v1/login`
- If two password retries fail with the same credential error:
  - switch to a single recovery step:
    - user logs into Eight Sleep app/web
    - set/reset password once
    - paste the new password
    - retry auth flow

### 8) Hevy-specific rules

- Start with source-of-truth link:
  - `https://hevy.com/settings?developer`
- Confirm Hevy Pro requirement before deeper setup.
- Validate key with:
  - `GET /v1/user/info`
  - `GET /v1/workouts/count`
- After routine creation, return:
  - direct web link: `https://hevy.com/routine/<id>`
  - fallback app navigation paths from `references/setup.md`

### 9) Post-setup validation

After provider onboarding:

1. `providers` via `HS_CMD` wrapper from `references/setup.md`
2. `status` via `HS_CMD` wrapper from `references/setup.md`
3. Run `sync` only when user asks.

## Analysis Workflow

When setup is complete and user asks data questions:

1. Read provider schema reference first.
2. Query `records` / `sync_state` / `sync_runs` as needed.
3. Keep SQL provider-aware (resource semantics vary).
4. For Hevy trend/report analysis, apply configured quality cutoff from `references/hevy.md` when present.
5. Avoid printing secrets from `oauth_tokens`.

## References

Load only the file needed for the active task:

- Setup + auth + validation checklist: `references/setup.md`
- Oura schema: `references/oura.md`
- Withings schema: `references/withings.md`
- Hevy schema + quality cutoff/query patterns: `references/hevy.md`
- Strava schema: `references/strava.md`
- Eight Sleep schema: `references/eightsleep.md`
