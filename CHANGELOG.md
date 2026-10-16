# Changelog – cachly SDK (openclaw)

**Language:** OpenClaw Agent SDK  
**Package:** `@cachly-dev/openclaw` on **npm**

> Full cross-SDK release notes: [../CHANGELOG.md](../CHANGELOG.md)

---

## [0.5.0] – 2026-10-16

The Brain adapter now reads and writes lessons the way the cachly MCP server
does. Both share the record `cachly:lesson:best:<topic>`; the contract is
`docs/spec/lesson-record.json` in the monorepo.

### Fixed

- **`learn()` no longer drops fields it does not manage.** Reinforcing a lesson
  the MCP server had created wrote back only the adapter's own fields, so
  `context`, `author`, `source`, `visibility`, `audit_trail` and `version` were
  gone. The stored record is now kept, and an existing `audit_trail` gets an
  entry `{ ts, action: 'updated', via: '@cachly-dev/openclaw' }`.
- **`recall()` no longer shows private or group-scoped lessons.** A lesson with
  `visibility: 'private'` or a `group` is skipped, as in the MCP server's
  `smart_recall` (the adapter knows no requester).
- **Replaced lessons give way.** A lesson with `ersetzt_durch` drops out when its
  successor is among the hits. Without the successor it stays, and
  `formatBriefing()` marks it `(outdated since <date>, replaced by <topic>)`.

---

## [0.4.0] – 2026-07-08

### Added

- **Ambient Recall middleware** (`createAmbientRecall`) — push-based memory,
  Phase-4 parity with Claude Code: runs before every model call, recalls
  relevant memories through the cachly relevance gate (trivial-skip,
  similarity + importance floor, top-K, hard per-turn token budget) and
  prepends the gated hits to the system prompt. No more "the agent forgot to
  search its memory". Fail-safe: any backend error falls through to the
  unmodified request. Exposes `stats()` (turns, trivial skips, injections,
  injected tokens) for honest cost accounting.

## [0.3.1] – 2026-06-09

### Fixed

- **`recall()` confidence-aware ranking** — lessons are now ranked by
  `relevance × confidence + recall_count_boost + severity_boost`.
  Previously a discredited lesson (confidence 0.05 after a flipped outcome)
  ranked identically to a proven one (0.99) on keyword overlap alone, so
  `briefingMiddleware` could instruct the assistant to "apply, do not relearn"
  a fix that had already been reversed.
- **Failure framing in `formatBriefing`** — failure lessons are now prefixed
  `AVOID —` in the briefing block so the assistant treats them as anti-patterns
  rather than instructions to follow.

## [0.3.0] – 2026-06-06

### Added

- **Brain Bridge** (`@cachly-dev/openclaw/brain`) — OpenClaw agents share the
  same compounding lesson Brain as Claude Code, Cursor, Copilot, and the IDE
  plugins. `createCachlyBrain()` provides `recall()`, `learn()`,
  `formatBriefing()`, and `briefingMiddleware()`.

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

