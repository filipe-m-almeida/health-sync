# Health Sync Setup Reference

Use this file when the user asks to set up `health-sync` in ClawHub.

## 0) Mandatory preflight (run first)

Run preflight before asking for provider credentials.

```bash
WORKSPACE_ROOT="$(pwd)"
HEALTH_DIR="$WORKSPACE_ROOT/health"
CONFIG="$HEALTH_DIR/health-sync.toml"
DB="$HEALTH_DIR/health.sqlite"

if ! command -v health-sync >/dev/null 2>&1; then
  echo "health-sync CLI not found on PATH."
  echo "Install it with: npm install -g health-sync"
  exit 1
fi

HS_CMD=("health-sync")

echo "workspace: $WORKSPACE_ROOT"
echo "health dir: $HEALTH_DIR"
echo "config: $CONFIG"
echo "db: $DB"

"${HS_CMD[@]}" --help
```

Required checks:

1. CLI is runnable (`health-sync --help` exits 0).
2. Workspace path is resolved from current `pwd`.
3. Expected setup paths are known (`$HEALTH_DIR`, `$CONFIG`, `$DB`).

If preflight fails, run install/bootstrap first and re-check.

## 1) Install/bootstrap fallback

Install from npm:

```bash
npm install -g health-sync
"${HS_CMD[@]}" --help
```

If CLI still fails, stop and fix Node/npm environment before provider auth.

## 2) Initialize config + DB

```bash
mkdir -p "$HEALTH_DIR"
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" init
```

Confirm files exist:

```bash
test -f "$CONFIG" && echo "ok config"
test -f "$DB" && echo "ok db"
```

## 3) Onboarding UX standard (required)

When guiding a user:

1. One action per message.
2. Once user provides concrete values, return fully populated copy/paste URLs/commands.
3. Say what artifact is expected next (for example, "paste full callback URL").
4. If error occurs, ask only for the minimal diagnostic artifact.
5. Accept natural/plain input; do not force rigid input templates unless technically required.

## 4) Provider prompt sequence

Ask one provider at a time, in this order:

1. `oura`
2. `withings`
3. `strava`
4. `eightsleep`
5. `hevy`

Ask exactly one yes/no per provider:

- "Initialize `<provider>` now?"

If `no`, keep/set `enabled = false`.
If `yes`, complete that provider before moving to the next.

## 5) OAuth providers (`oura`, `withings`, `strava`)

Use this explicit flow:

1. Create/select provider app.
2. Set redirect URI(s) exactly.
3. Generate authorize URL.
4. Capture callback URL / auth code.
5. Exchange code for token.
6. Store credentials in config/DB.
7. Validate with one real provider API call.

Parameter separation callout:

- `/authorize` uses `client_id` + exact `redirect_uri` (not `client_secret`).
- `/token` uses `client_id` + `client_secret` + `code`.

If token exchange fails after endpoint mismatch or failed attempts, request a fresh code and exchange once at the corrected token endpoint.

## 6) Oura setup (critical path)

### Source-of-truth and required values

- Oura auth model for this workflow: OAuth2 only.
- App console URL: `https://developer.ouraring.com/applications`
- Required values to collect as exact text:
  - `client_id`
  - `client_secret`
- If values were first shared via screenshot, ask user to copy/paste exact text before building commands.

### Redirect, endpoints, scopes

- Default redirect URI for this setup:
  - `http://localhost:8080/callback`
- Working authorize endpoint:
  - `https://moi.ouraring.com/oauth/v2/ext/oauth-authorize`
- Working token endpoint:
  - `https://moi.ouraring.com/oauth/v2/ext/oauth-token`
- Working scope set:
  - `extapi:daily extapi:heartrate extapi:personal extapi:workout extapi:session extapi:tag extapi:spo2`

### Preferred flow via health-sync CLI

Set these in `[oura]` first:

```toml
enabled = true
client_id = "..."
client_secret = "..."
redirect_uri = "http://localhost:8080/callback"
authorize_url = "https://moi.ouraring.com/oauth/v2/ext/oauth-authorize"
token_url = "https://moi.ouraring.com/oauth/v2/ext/oauth-token"
scopes = "extapi:daily extapi:heartrate extapi:personal extapi:workout extapi:session extapi:tag extapi:spo2"
```

Run:

```bash
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" auth oura
```

Before user clicks authorize, tell them:

- "If Oura shows an error page, copy the full callback URL anyway and send it."

### Manual troubleshooting flow (if CLI auth fails)

Build a fully populated authorize URL (replace shell variables before sending to user):

```bash
export OURA_CLIENT_ID="replace-with-real-client-id"
export OURA_REDIRECT_URI="http://localhost:8080/callback"
export OURA_SCOPES="extapi:daily extapi:heartrate extapi:personal extapi:workout extapi:session extapi:tag extapi:spo2"
export OURA_STATE="$("${PY_BIN:-python3}" - <<'PY'
import secrets
print(secrets.token_urlsafe(16))
PY
)"

"${PY_BIN:-python3}" - <<'PY'
import os
import urllib.parse

base = "https://moi.ouraring.com/oauth/v2/ext/oauth-authorize"
params = {
    "response_type": "code",
    "client_id": os.environ["OURA_CLIENT_ID"],
    "redirect_uri": os.environ["OURA_REDIRECT_URI"],
    "scope": os.environ["OURA_SCOPES"],
    "state": os.environ["OURA_STATE"],
}
print(base + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote))
PY
```

If callback includes `iss=...`, discover endpoints from OIDC:

```bash
ISS="paste-iss-from-callback"
curl -sS "${ISS%/}/.well-known/openid-configuration"
```

Exchange code once at the correct token endpoint:

```bash
OURA_TOKEN_ENDPOINT="https://moi.ouraring.com/oauth/v2/ext/oauth-token"
OURA_CLIENT_SECRET="replace-with-real-client-secret"
OURA_CODE="paste-code"

curl -sS -X POST "$OURA_TOKEN_ENDPOINT" \
  -u "$OURA_CLIENT_ID:$OURA_CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$OURA_CODE" \
  --data-urlencode "redirect_uri=$OURA_REDIRECT_URI"
```

Validate token with one real API call:

```bash
OURA_ACCESS_TOKEN="paste-access-token"
curl -sS -H "Authorization: Bearer $OURA_ACCESS_TOKEN" \
  "https://api.ouraring.com/v2/usercollection/personal_info"
```

## 7) Withings setup

Official pages:

1. Integration guide:
   - `https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/developer-account/create-your-accesses-no-medical-cloud/`
2. Developer dashboard:
   - `https://developer.withings.com/dashboard/`

Redirect default:

- `http://127.0.0.1:8485/callback`

Run:

```bash
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" auth withings
```

## 8) Strava setup

Official pages:

1. App settings:
   - `https://www.strava.com/settings/api`
2. Auth docs:
   - `https://developers.strava.com/docs/authentication`

Redirect default:

- `http://127.0.0.1:8486/callback`

Run:

```bash
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" auth strava
```

## 9) Eight Sleep setup

### Credential validation endpoint

Use this first for lightweight credential sanity check:

- `POST https://client-api.8slp.net/v1/login`

Example:

```bash
export EIGHT_EMAIL="you@example.com"
export EIGHT_PASSWORD="replace-with-password"
EIGHT_LOGIN_JSON="$("${PY_BIN:-python3}" - <<'PY'
import json
import os

print(json.dumps({"email": os.environ["EIGHT_EMAIL"], "password": os.environ["EIGHT_PASSWORD"]}))
PY
)"

curl -sS -X POST "https://client-api.8slp.net/v1/login" \
  -H "Content-Type: application/json" \
  -d "$EIGHT_LOGIN_JSON"
```

Tell user the response class clearly (success vs auth error) without echoing secrets.

If two retries fail with the same password error:

1. Ask user to log into Eight Sleep app/web.
2. Set/reset password once.
3. Retry with the new password only once.

### health-sync auth

Set required fields:

```toml
[eightsleep]
enabled = true
client_id = "0894c7f33bb94800a03f1f4df13a4f38"
client_secret = "f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76"
email = "..."
password = "..."
```

Run:

```bash
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" auth eightsleep
```

## 10) Hevy setup

### Source of truth + key retrieval

- Hevy API docs: `https://api.hevyapp.com/docs/`
- API key page: `https://hevy.com/settings?developer`
- Hevy Pro is required.

Set config:

```toml
[hevy]
enabled = true
api_key = "..."
```

### Key validation calls

```bash
HEVY_API_KEY="replace-with-real-key"
curl -sS "https://api.hevyapp.com/v1/user/info" -H "api-key: $HEVY_API_KEY"
curl -sS "https://api.hevyapp.com/v1/workouts/count" -H "api-key: $HEVY_API_KEY"
```

### Historical data-quality cutoff

When user reports a known correction point, set a provider cutoff for analysis scripts.

Example baseline:

- `HEVY_DATA_VALID_FROM_DATE=2026-02-12`

Use this cutoff by default in trend/report SQL:

```sql
where provider = 'hevy'
  and resource = 'workouts'
  and start_time >= '2026-02-12'
```

### Routine create/update gotchas

After creating a routine, always return:

1. direct web link: `https://hevy.com/routine/<id>`
2. fallback app paths (UI can vary by app version): Plans tab, Routines tab

For `PUT /v1/routines/{id}` payloads:

- strip response-only fields (`index`, ids/timestamps not accepted by PUT schema)
- ensure top-level routine notes are non-empty

Sanitize payload example:

```bash
jq '
  del(
    .id,
    .created_at,
    .updated_at,
    .index,
    .exercises[]?.index,
    .exercises[]?.sets[]?.index
  )
  | .notes = ((.notes // "") | if length == 0 then "Routine updated via API" else . end)
' routine-response.json > routine-put.json
```

## 11) Post-setup validation

Run:

```bash
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" providers
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" status
```

Optional first sync (only on request):

```bash
"${HS_CMD[@]}" --config "$CONFIG" --db "$DB" sync --providers <provider ...>
```

Success criteria:

- Config and DB live under `<workspace>/health`.
- Enabled providers appear in `providers`.
- Provider auth succeeds without manual DB edits.
- `status` runs without path/config errors.
