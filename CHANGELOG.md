# Changelog – cachly SDK (openclaw)

**Language:** OpenClaw Agent SDK  
**Package:** `@cachly-dev/openclaw` on **npm**

> Full cross-SDK release notes: [../CHANGELOG.md](../CHANGELOG.md)

---

## [0.3.0] – 2026-06-06

### Added

- **Brain Bridge** (`@cachly-dev/openclaw/brain`) — OpenClaw agents now share the
  same compounding lesson Brain as Claude Code, Cursor, Copilot, and the VS Code /
  IntelliJ plugins, via the canonical `cachly:lesson:best:*` keys on the instance.
  - `createCachlyBrain({ url })` — factory backed by the same Redis/Valkey the other adapters use
  - `recall(query, { topK, threshold })` — keyword-ranked lesson retrieval (embedding-free, every tier); bumps `recall_count`
  - `learn({ topic, outcome, whatWorked, whatFailed, severity, … })` — stores/reinforces lessons with Cachly's confidence calibration (+0.1 reinforce / −0.15 erode, capped 0.05–0.99)
  - `briefingMiddleware()` — LLM middleware that pre-briefs the system prompt with relevant lessons
  - `formatBriefing()`, `size()`, `close()` helpers
  - 11 unit tests covering recall ranking, confidence calibration, briefing, and sizing

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

