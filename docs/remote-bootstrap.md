# Remote Bootstrap Design And Architecture

This document describes the remote onboarding architecture used by `health-sync` for bot-mediated setup over untrusted transport channels (for example Telegram).

It is written for bot operators and integrators.

## Why This Exists

The normal local onboarding flow assumes setup and runtime happen on the same machine.
Remote bootstrap solves a different problem:

1. The user authorizes providers on their own machine.
2. The user sends a payload back to the bot/operator.
3. The payload is encrypted end-to-end for the bot session.
4. The bot imports the result locally without ever asking the user for raw secrets in chat.

## Roles

1. Bot/operator machine:
   - Creates bootstrap sessions and tokens.
   - Receives encrypted archives.
   - Decrypts and imports config + credentials.
2. User machine:
   - Runs onboarding and provider auth.
   - Encrypts output with a bootstrap token from the bot.
3. Transport:
   - Telegram or any untrusted channel that can carry file attachments.

## Command Contract

Remote bootstrap is the primary onboarding interface:

1. Bot creates a bootstrap session:

```bash
health-sync init remote bootstrap --expires-in 24h
```

2. User runs onboarding with the bootstrap token:

```bash
health-sync init remote run <bootstrap-token>
```

3. Bot imports the encrypted archive received from the user:

```bash
health-sync init remote finish <bootstrap-token-or-key-id-or-session-id-or-public-key> <archive-path>
```

Compatibility aliases are also supported:

1. `health-sync init --remote-bootstrap`
2. `health-sync init --remote <bootstrap-token>`
3. `health-sync init --remote-bootstrap-finish <ref> <archive>`

## End-To-End Flow

### Step 1: Bootstrap (bot side)

`init remote bootstrap` creates:

1. A new X25519 keypair (recipient keypair).
2. A bootstrap session record on disk.
3. A single copy-paste token (`hsr1.<payload>`).

Session storage location:

- default: `~/.health-sync/remote-bootstrap`
- override: `HEALTH_SYNC_REMOTE_BOOTSTRAP_DIR`

Bot output includes:

1. Session fingerprint.
2. Expiry timestamp.
3. The exact command the bot should send to the user.
4. The full bootstrap token.

### Step 2: User onboarding + archive creation (user side)

`init remote run <token>`:

1. Validates the token and expiry.
2. Runs normal `health-sync init` onboarding.
3. Collects:
   - `health-sync.toml`
   - `.health-sync.creds` (or empty credentials structure if missing)
4. Encrypts payload to an archive envelope.
5. Writes archive to disk.
6. Purges local `health-sync.toml` and `.health-sync.creds` by default.

Options:

1. `--output <path>` sets archive path.
2. `--keep-local` disables default purge behavior.

### Step 3: Finish/import (bot side)

`init remote finish <ref> <archive>`:

1. Resolves session by reference (token, key id, session id, or recipient public key).
2. Decrypts and authenticates archive.
3. Verifies payload checksums.
4. Writes imported files atomically:
   - `health-sync.toml`
   - `.health-sync.creds`
5. Creates timestamped backups if target files already exist.
6. Marks session as consumed (one-time use).

Options:

1. `--target-config <path>`
2. `--target-creds <path>`

## Security Model

### Threat model

Designed to protect confidentiality and integrity of setup artifacts over untrusted transport.

### Cryptographic construction

Per session and archive:

1. Key agreement: X25519 ECDH
2. KDF: HKDF-SHA256
3. Encryption: AES-256-GCM
4. Integrity:
   - GCM authentication tag
   - payload SHA-256 check in authenticated metadata

### Token and envelope protections

Bootstrap token includes:

1. Version, session id, key id
2. Recipient public key
3. Creation and expiry timestamps
4. Checksum field for robust parsing/corruption detection

Remote archive envelope includes:

1. Version + schema
2. Session binding (`session_id`, `key_id`)
3. Ephemeral sender public key
4. Salt/nonce/tag
5. Ciphertext
6. Authenticated metadata (`aad_json`)

### One-time consumption

Sessions are single-use at finish time:

1. Successful import marks `consumed_at`.
2. Re-import attempts fail for that session.

### Local file safety

Import/write behavior:

1. Atomic writes to avoid partial files.
2. File mode `0600` for session and imported secret files.
3. Timestamped backups before overwrite.

## Data Formats

### Bootstrap token format

Prefix:

```text
hsr1.
```

Payload contains:

1. `v`
2. `session_id`
3. `key_id`
4. `recipient_pub`
5. `created_at`
6. `expires_at`
7. `checksum`

### Remote payload schema

`health-sync-remote-payload-v1` includes:

1. `health-sync.toml` content + sha256
2. `.health-sync.creds` content + sha256
3. metadata (`created_at`, `source_version`)

### Remote archive schema

`health-sync-remote-archive-v1` includes:

1. encrypted payload fields
2. AAD metadata
3. session/key binding fields

## Bot UX Guidance

When integrating with a bot, use this instruction style:

1. Bootstrap:
   - Run `health-sync init remote bootstrap --expires-in 24h`
2. Send to user:
   - `health-sync init --remote <token>`
3. Ask user to upload produced archive file.
4. Finish:
   - `health-sync init remote finish <token> <archive-path>`

The bot should never ask users to paste raw provider secrets into chat.

## Failure And Recovery

1. Expired token:
   - Generate a new bootstrap token.
2. Session mismatch:
   - Ensure archive corresponds to the same bootstrap token/session.
3. Session already consumed:
   - Start a new bootstrap session and rerun remote onboarding.
4. Missing credentials in payload:
   - User may have skipped provider auth; rerun `init remote run`.

## Operational Notes

1. Keep bootstrap store private and access-controlled.
2. Avoid long token lifetimes; prefer short windows (`12h` or `24h`).
3. Rotate/restart bootstrap sessions rather than reusing stale sessions.
4. Treat imported `health-sync.toml` and `.health-sync.creds` as sensitive.

## Threat Modeling

This section documents key threats, current controls, and remaining risk.

### Assets to protect

1. Provider credentials and tokens in `.health-sync.creds`.
2. Secret values in `health-sync.toml`.
3. Bootstrap private key material on the bot side.
4. Integrity of imported configuration and credential state.

### Trust boundaries

1. Bot machine and its local bootstrap store.
2. User machine running `health-sync init --remote <token>`.
3. Untrusted transport channel (for example Telegram).
4. Token exchange channel from bot to user.

### Primary threats

1. Man-in-the-middle on bootstrap token exchange:
   - If an attacker can alter the token/public-key material before it reaches the user, the user may encrypt to attacker-controlled key material.
   - This is a real residual risk when token exchange itself is not authenticated.

2. Archive interception in transit:
   - Attacker sees archive file while in transit.
   - Expected impact is limited by encryption and authenticated decryption.

3. Replay of old archive:
   - Attacker re-sends an old archive to bot.
   - Without replay protection this could overwrite fresh config with stale state.

4. Local compromise of bot bootstrap store:
   - Theft of bootstrap private keys enables decryption of archives tied to those sessions.

5. Malicious or malformed archive payload:
   - Attempts to exploit parser/writer behavior or force unsafe writes.

### Current mitigations

1. Confidentiality and integrity of archive contents:
   - X25519 + HKDF-SHA256 + AES-256-GCM.
   - Authenticated metadata and payload checksum verification.

2. Session binding and one-time finish:
   - Archive bound to session/key identifiers.
   - Successful finish marks session consumed.

3. Safe local file writes:
   - Atomic writes.
   - Restrictive file mode (`0600`) for secret files.
   - Backup before overwrite.

4. Input validation:
   - Strict token and envelope parsing.
   - Schema/version checks.

### Residual risk and limitations

1. Bootstrap token delivery authenticity:
   - The design does not cryptographically authenticate bot identity to user at token delivery time.
   - Therefore it is vulnerable to token substitution MITM if delivery channel is compromised.

2. Endpoint compromise:
   - Compromise of user or bot endpoint bypasses transport encryption guarantees.

3. Operational misuse:
   - Long-lived tokens or weak handling of archive files increases exposure window.

### Recommended hardening

1. Use an authenticated delivery channel for token transfer.
2. Show and verify bootstrap fingerprint out-of-band before user runs the command.
3. Keep token TTL short and enforce one-time operational use.
4. Consider adding optional signature verification for bootstrap tokens from a bot identity key.
5. Add alerting/audit logs for failed decrypts, mismatches, and replay attempts.
