# Health Sync Setup Reference

Use this file when the user asks to set up `health-sync` in OpenClaw.

## 0) Install `health-sync` first

Run this before init/auth/sync:

```bash
pip install https://github.com/filipe-m-almeida/health-sync.git
```

Verify:

```bash
python -m health_sync --help
```

If `python -m health_sync` fails, stop and fix the Python environment first.

## 1) Paths and command wrapper

```bash
WORKSPACE_ROOT="$(pwd)"
HEALTH_DIR="$WORKSPACE_ROOT/health"
CONFIG="$HEALTH_DIR/health-sync.toml"
DB="$HEALTH_DIR/health.sqlite"

# Primary command.
HS_CMD=(python -m health_sync)

# Fallback only when intentionally running from a local repo checkout.
# HS_CMD=(uv run python -m health_sync)
```

## 2) Bootstrap config + DB

```bash
mkdir -p "$HEALTH_DIR"
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" init
```

This command initializes both:

- `health-sync.toml` with an `[app]` block (DB path set to `$DB`)
- SQLite tables in `$DB`

## 3) Provider prompt sequence

Ask one provider at a time, in this order:

1. `oura`
2. `withings`
3. `strava`
4. `eightsleep`
5. `hevy`

Ask exactly one yes/no question per provider:

- "Initialize `<provider>` now?"

If `no`:

- Keep or set `enabled = false` under that provider block.

If `yes`:

- Run `auth <provider>` and complete its setup before moving to the next provider.
- `auth` scaffolds provider config blocks and sets `enabled = true`.

## 4) OAuth provider checklist

Applies to `oura`, `withings`, `strava`.

### Teach users where to get OAuth app credentials

For each OAuth provider, send these URLs and guide the user through app setup before running `auth`.

#### Oura (official pages)

1. Open Oura OAuth applications page:
   - `https://cloud.ouraring.com/oauth/applications`
2. Sign in and create/select an application.
3. Add redirect URI:
   - `http://localhost:8484/callback`
4. Copy `client_id` and `client_secret`.
5. Confirm they are pasted into `[oura]` in config.

References:

- Oura auth docs: `https://cloud.ouraring.com/docs/authentication`
- Oura app list (“My Applications”): `https://cloud.ouraring.com/oauth/applications`

#### Withings (official pages)

1. Open Withings setup guide:
   - `https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/developer-account/create-your-accesses-no-medical-cloud/`
2. Open the Developer Dashboard / Partner Hub:
   - `https://developer.withings.com/dashboard/`
3. Create/select an application in the dashboard.
4. Copy `client_id`.
5. Generate/copy `client_secret`.
6. Set callback/redirect URI to match config exactly:
   - default: `http://127.0.0.1:8485/callback`
7. Confirm values are pasted into `[withings]` in config.

References:

- Withings auth URL flow: `https://developer.withings.com/developer-guide/v3/get-access/oauth-authorization-url/`
- Withings app setup guide: `https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/developer-account/create-your-accesses-no-medical-cloud/`

#### Strava (official pages)

1. Open Strava API settings page:
   - `https://www.strava.com/settings/api`
2. Create/select your API application.
3. Copy `Client ID` and `Client Secret`.
4. Set **Authorization Callback Domain** to host used by redirect URI:
   - `127.0.0.1` (or `localhost`)
5. Confirm `[strava].redirect_uri` matches host/domain choice exactly:
   - default: `http://127.0.0.1:8486/callback`
6. Confirm values are pasted into `[strava]` in config.

References:

- Strava getting started (app creation): `https://developers.strava.com/docs/getting-started/`
- Strava authentication docs: `https://developers.strava.com/docs/authentication`

### Required config keys

For each enabled OAuth provider, set:

- `enabled = true`
- `client_id = "..."`
- `client_secret = "..."`
- `redirect_uri = "..."` (use defaults from example config unless user needs custom)

### How to run auth

Run this in an interactive terminal session:

```bash
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" auth <provider>
```

The command prints an auth URL and waits for callback URL/code input.

Interactive sequence:

1. Tell user to open the printed URL and approve access.
2. Ask user to paste final callback URL (or `code`) in chat.
3. Send that pasted value to the running command stdin.
4. Wait for success message (`Stored ... token in DB.`).

If auth fails:

- Re-check client id/secret
- Re-check redirect URI exact match with provider app settings
- Re-run auth command

## 5) Provider specifics

### Oura

Config block: `[oura]`

- Supported auth styles:
  - OAuth (`client_id` + `client_secret`)
  - PAT (`access_token`)
- OAuth redirect default: `http://localhost:8484/callback`

### Withings

Config block: `[withings]`

- OAuth required (`client_id` + `client_secret`)
- Redirect default: `http://127.0.0.1:8485/callback`
- Default scopes: `user.metrics,user.activity`

### Strava

Config block: `[strava]`

- OAuth recommended (`client_id` + `client_secret`)
- Redirect default: `http://127.0.0.1:8486/callback`
- Static `access_token` is also supported for advanced/manual use

### Eight Sleep

Config block: `[eightsleep]`

- Set `enabled = true`
- Use these client values before running auth:

```toml
client_id = "0894c7f33bb94800a03f1f4df13a4f38"
client_secret = "f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76"
```

- Collect either:
  - `email` + `password` (recommended), or
  - `access_token`

Run:

```bash
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" auth eightsleep
```

### Hevy

Config block: `[hevy]`

- No auth command. Set:

```toml
enabled = true
api_key = "..."
```

## 6) Post-setup validation

Run:

```bash
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" providers
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" status
```

Optional first sync for enabled providers:

```bash
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" sync --providers <provider ...>
```

Success criteria:

- Config and DB are under `<openclaw-workspace>/health`
- Enabled providers are visible in `providers`
- Auth-enabled providers complete auth without manual code edits
- `status` runs without config/path errors
