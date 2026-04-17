# Changelog – cachly SDK (openclaw)

**Language:** OpenClaw Agent SDK  
**Package:** `@cachly-dev/openclaw` on **npm**

> Full cross-SDK release notes: [../CHANGELOG.md](../CHANGELOG.md)

---

## [0.2.0] – 2026-04-07

### Added

- **Distributed lock** (`lock(key, options)`) – shared cache locking for multi-agent coordination
  - `LockOptions`: configurable `ttlMs`, `retries`, `retryDelayMs`
  - `LockHandle.release()` for early, token-fenced unlock
  - Auto-expires after TTL to prevent deadlocks
- **`mset(items)` / `mget(keys)`** – bulk cache operations for agent state sharing with per-key TTL
- **Streaming cache** (`streamSet(key, stream)` / `streamGet(key)`) – cache and replay LLM token streams

### Fixed

- `Known limitations` section updated – multi-agent shared cache locks now implemented

---

## [0.1.0] – 2026-04-07

Initial release.

### Added

- `CachlyOpenClaw` agent integration for AI-native caching
- Automatic semantic deduplication of LLM prompts/responses
- `set(key, value, ttl?)` / `get(key)` / `delete(key)`
- Namespace isolation for multi-tenant agent deployments
- API-key-based authentication
- EU data residency (German servers, DSGVO compliant)

### Known limitations

- ~~Multi-agent coordination (shared cache locks) planned for v0.2~~ ✅ resolved in v0.2.0
- ~~Streaming cache not yet supported~~ ✅ resolved in v0.2.0

---

## [Unreleased]

See [../CHANGELOG.md](../CHANGELOG.md) for upcoming features.

