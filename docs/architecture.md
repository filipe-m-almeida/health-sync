# health-sync Architecture

## Flow Overview

1. CLI loads config (`health_sync/config.py`).
2. Provider registry is resolved (`health_sync/plugins/loader.py`).
3. Enabled providers execute sync/auth logic (`health_sync/providers/*`).
4. Providers write raw payloads and watermarks (`health_sync/db.py`).
5. Each sync resource records run stats in `sync_runs`.

## Provider Runtime Helpers

`health_sync/providers/runtime.py` centralizes common provider mechanics:

- OAuth redirect URI parsing and validation
- OAuth authorization URL construction
- Token expiry checks and token-extra filtering
- `sync_resource(...)` context manager (`sync_run + transaction`)
- Common item upsert shaping helpers

Provider modules should keep API-specific details local (endpoints, pagination strategy, resource mapping) and delegate shared mechanics to runtime helpers.

## Data Model

`records` stores raw payloads keyed by `(provider, resource, record_id)`.

`sync_state` stores incremental checkpoints:

- `watermark`: provider-specific progress marker (normalized to UTC ISO when possible)
- `cursor`: optional opaque paging cursor
- `extra_json`: provider metadata

`oauth_tokens` stores auth state for providers that need refresh.

`sync_runs` tracks status and per-sync counters.

## Plugin Model

Built-in providers are always registered first.

External providers can be loaded via:

- Entry points (`health_sync.providers`)
- Config module mapping (`[plugins.<id>].module = "pkg.mod:provider"`)

Built-ins cannot be overridden by config module specs.

## Testing Strategy

- Unit tests for utility parsing and HTTP retry behavior
- Provider-specific tests for watermark/overlap/token-refresh contracts
- Plugin and CLI orchestration tests for resilience and error handling
- Runtime helper tests for shared abstractions

Run:

```bash
uv run --with pytest pytest -q
```
