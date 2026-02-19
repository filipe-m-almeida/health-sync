# Health Sync Setup Reference (Bot View)

This is the authoritative setup flow for ClawHub bots.

Only one onboarding flow is supported:

1. Bot creates bootstrap token.
2. Bot tells user to run remote onboarding locally.
3. User sends encrypted archive.
4. Bot imports archive locally.

Legacy setup flows are out of scope for bot guidance.

## Command Summary

Bot-side commands:

1. `health-sync init remote bootstrap --expires-in 24h`
2. `health-sync init remote finish <bootstrap-ref> <archive-path>`
3. `health-sync providers --verbose`
4. `health-sync sync`
5. `health-sync status`

User-side command:

1. `health-sync init --remote <bootstrap-token>`

## Bot Responsibilities

The bot must:

1. Run bootstrap on bot infrastructure.
2. Share only the single remote command with the user.
3. Never ask user for provider secrets in chat.
4. Receive user archive file.
5. Run finish locally and confirm import.
6. Run verification sync and status.

## Detailed Bot Runbook

### Phase 1: Bootstrap locally (bot machine)

Run:

```bash
health-sync init remote bootstrap --expires-in 24h
```

Capture from output:

1. bootstrap token (`hsr1...`)
2. session fingerprint
3. expiry timestamp

### Phase 2: Tell user exactly what to run

Send this instruction pattern:

```text
I created a secure one-time setup token for your Health Sync onboarding.

Please run this on your own machine:
health-sync init --remote <TOKEN>

This will walk you through provider setup and generate an encrypted archive.
Send that archive file back here when done.
```

Important guidance to include:

1. User should run command in a local terminal with browser access.
2. User should complete provider auth inside the interactive wizard.
3. User should upload the generated `.enc` archive file to the bot.

### Phase 3: Import archive locally (bot machine)

After receiving the archive:

```bash
health-sync init remote finish <TOKEN_OR_KEY_ID_OR_SESSION_ID> /path/to/archive.enc
```

Optional target paths:

```bash
health-sync init remote finish <REF> /path/to/archive.enc \
  --target-config /path/to/health-sync.toml \
  --target-creds /path/to/.health-sync.creds
```

Expected finish behavior:

1. decrypts archive
2. validates checksums
3. writes config + creds
4. creates backups if files already existed
5. marks bootstrap session as consumed

### Phase 4: Verify ingestion

Run:

```bash
health-sync providers --verbose
health-sync sync
health-sync status
```

Report:

1. providers discovered/enabled
2. sync success or provider-specific failures
3. current data freshness

## What The Bot Should Never Do

Do not ask users to:

1. paste `client_secret`, `api_key`, OAuth callback URLs, access tokens, or passwords into chat
2. run `health-sync auth <provider>` as onboarding
3. do manual same-machine setup (`health-sync init`) as the primary flow

Do not instruct mixed flows. Remote bootstrap is the only setup workflow for ClawHub bot guidance.

## User Experience Copy (Recommended)

### Bootstrap response

```text
Secure setup is ready.
Run this command on your own machine:

health-sync init --remote <TOKEN>

The wizard will guide you provider-by-provider and then output an encrypted archive.
Please upload that archive file here when complete.
```

### Archive received response

```text
Archive received. I am now importing your encrypted setup on my side.
```

### Import success response

```text
Setup import complete. I will now run a sync and verify your provider status.
```

## Failure Handling

1. Token expired:
   - Generate a new bootstrap token.
2. Session already consumed:
   - Start a fresh bootstrap and rerun user command.
3. Archive does not match token/session:
   - Confirm user used the latest token.
4. User reports no archive generated:
   - Ask them to rerun `health-sync init --remote <TOKEN>` and complete provider auth steps.

## Security Notes

1. Treat bootstrap tokens as sensitive and short-lived.
2. Keep bot bootstrap storage private.
3. Treat imported `health-sync.toml` and `.health-sync.creds` as secrets.
4. Do not commit secret files to version control.

## Additional Architecture Reference

For full crypto/session/archive architecture:

- `../../../../docs/remote-bootstrap.md`
