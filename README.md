# @cachly-dev/openclaw

> Official **cachly.dev** adapter for [OpenClaw](https://openclaw.dev) — the 22-channel AI assistant.  
> Persistent sessions · Semantic LLM cache · Redis-native memory · EU data residency

[![npm](https://img.shields.io/npm/v/@cachly-dev/openclaw?color=red&logo=npm)](https://www.npmjs.com/package/@cachly-dev/openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![GDPR: EU-only](https://img.shields.io/badge/GDPR-EU%20only-green)](https://cachly.dev/legal)

---

## What it provides

| Feature | Description | Impact |
|---------|-------------|--------|
| 🗄️ **Session Store** | Persistent Redis-backed conversation sessions | No cold starts, no lost history |
| 🧠 **Semantic LLM Cache** | Cache LLM responses by meaning (pgvector HNSW) | 50–70 % cost reduction |
| 💾 **Memory Adapter** | Redis + pgvector replaces LanceDB for long-term memory | EU data residency, Redis-native |

---

## Installation

```bash
npm install @cachly-dev/openclaw
```

> **Peer dependency:** `openclaw >= 2026.1.0`  
> **Requires:** A cachly.dev instance — free tier at [cachly.dev](https://cachly.dev)

---

## Quick Start

```typescript
import { createCachlyOpenClawConfig } from '@cachly-dev/openclaw'
import OpenAI from 'openai'

const openai = new OpenAI()

const cachlyConfig = createCachlyOpenClawConfig({
  url:       process.env.CACHLY_URL!,        // redis://:password@host:port
  vectorUrl: process.env.CACHLY_VECTOR_URL,  // https://api.cachly.dev/v1/sem/{token}
  embedFn:   async (text) => {
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
    return res.data[0].embedding
  },
  ttl: {
    session: 604800,   // 7 days
    llm:     3600,     // 1 hour
    memory:  7776000,  // 90 days
  },
})

const app = new OpenClawApp({
  ...cachlyConfig,
  // ... your other config
})
```

---

## Individual Adapters

### Session Store

Persists OpenClaw conversation history in Redis:

```typescript
import { createCachlySessionStore } from '@cachly-dev/openclaw'

const sessionStore = createCachlySessionStore({
  url: process.env.CACHLY_URL!,
  ttl: 604800, // 7 days
})

// Used automatically by OpenClaw — no manual calls needed.
```

### Semantic LLM Cache

Intercepts LLM calls and returns cached responses for semantically identical prompts:

```typescript
import { createSemanticLLMCache } from '@cachly-dev/openclaw'

const llmCache = createSemanticLLMCache({
  url:       process.env.CACHLY_URL!,
  vectorUrl: process.env.CACHLY_VECTOR_URL!,
  embedFn:   myEmbedFn,
  threshold: 0.92,    // similarity threshold (default: 0.92)
  ttl:       3600,    // cache TTL in seconds
  skipPatterns: [     // never cache these
    'generate image',
    'draw',
    'real-time',
  ],
})

const response = await llmCache.getOrSet(
  'What is semantic caching?',
  () => openai.chat.completions.create({ model: 'gpt-4o', messages: [...] })
)
```

### Memory Adapter

Replaces LanceDB with Redis + pgvector for EU-compliant, Redis-native long-term memory:

```typescript
import { createCachlyMemoryAdapter } from '@cachly-dev/openclaw'

const memory = createCachlyMemoryAdapter({
  url:       process.env.CACHLY_URL!,
  vectorUrl: process.env.CACHLY_VECTOR_URL!,
  embedFn:   myEmbedFn,
  namespace: 'openclaw:mem',
  ttl:       7776000, // 90 days
})

await memory.store({ id: 'fact-1', text: 'User prefers TypeScript', metadata: {} })
const results = await memory.search('programming language preference', { topK: 5 })
```

---

## AI Dev Brain — Persistent Memory for Your Coding Assistant

cachly ships a **30-tool MCP server** that gives Claude Code, Cursor, GitHub Copilot, and Windsurf a persistent memory across sessions — so they never forget your architecture, lessons learned, or last session context.

```bash
# One-time setup
npx @cachly-dev/init
```

Or configure manually in your editor (`~/.vscode/mcp.json` / `.cursor/mcp.json`):

```json
{
  "servers": {
    "cachly": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cachly-dev/mcp-server"],
      "env": { "CACHLY_JWT": "your-jwt-token" }
    }
  }
}
```

Add to your AI assistant instructions (e.g. `.github/copilot-instructions.md`):

```markdown
## cachly AI Brain

At the START of every session:
session_start(instance_id = "your-instance-id", focus = "what you're working on today")

At the END of every session:
session_end(instance_id = "your-instance-id", summary = "...", files_changed = [...])

After any bug fix or deploy:
learn_from_attempts(instance_id = "your-instance-id", topic = "category:keyword",
  outcome = "success", what_worked = "...", what_failed = "...", severity = "major")
```

`session_start` returns a full briefing in **one call**: last session summary, relevant lessons, open failures, brain health. 60 % fewer file reads, instant context, zero re-discovery.

→ Full docs: [cachly.dev/docs/ai-memory](https://cachly.dev/docs/ai-memory)

---

## Real-World Use Cases

### 1. WhatsApp Customer Support Bot with Memory

Every conversation starts from scratch — no context, no history. OpenClaw + cachly = a bot that remembers.

```typescript
import { OpenClaw } from '@cachly-dev/openclaw'

const bot = new OpenClaw({
  channels: ['whatsapp'],
  cachlyUrl: process.env.CACHLY_URL,
  vectorUrl: process.env.CACHLY_VECTOR_URL,
  embedFn: openaiEmbed,
})

bot.on('message', async (msg) => {
  // Check semantic cache — has a similar question been answered before?
  const cached = await bot.memory.recall(msg.text, { threshold: 0.85 })
  if (cached) return msg.reply(cached.response)  // instant, free

  const response = await llm.complete(msg.text, {
    context: await bot.memory.getHistory(msg.userId, { limit: 10 }),
  })

  await bot.memory.store(msg.text, response)
  return msg.reply(response)
})
```

**Impact:** 500 messages/day at 65 % cache hit rate → ~€200/month saved in LLM costs.

---

### 2. Slack Knowledge Bot for Engineering Teams

"How do I deploy to staging?" gets asked every week. Cache the answers — instant tribal knowledge.

```typescript
const bot = new OpenClaw({
  channels: ['slack'],
  cachlyUrl: process.env.CACHLY_URL,
  vectorUrl: process.env.CACHLY_VECTOR_URL,
  embedFn: openaiEmbed,
  namespace: 'engineering-kb',
})

// Pre-warm with your runbooks and documentation
await bot.memory.batchIndex([
  { prompt: 'How to deploy to staging', response: 'Run `make deploy-staging`...' },
  { prompt: 'Database migration steps', response: 'See runbook at...' },
  { prompt: 'How to access production logs', response: 'Use `kubectl logs`...' },
])

// "how do I push to staging?" → semantic match (0.91 similarity) → instant answer
```

---

### 3. Multi-Channel FAQ Bot (WhatsApp + Telegram + Discord)

One OpenClaw bot, three channels, one shared semantic cache. A question answered on WhatsApp instantly benefits Telegram and Discord users.

```typescript
const bot = new OpenClaw({
  channels: ['whatsapp', 'telegram', 'discord'],
  cachlyUrl: process.env.CACHLY_URL,
  vectorUrl: process.env.CACHLY_VECTOR_URL,
  embedFn: openaiEmbed,
})

// Same semantic cache, same knowledge, zero duplication across channels
```

---

### 4. Personal AI Journal (Telegram)

An AI companion that remembers your conversations, goals, and moods across months — not just one session.

```typescript
const journal = new OpenClaw({
  channels: ['telegram'],
  cachlyUrl: process.env.CACHLY_URL,
  vectorUrl: process.env.CACHLY_VECTOR_URL,
  embedFn: openaiEmbed,
  namespace: 'personal-journal',
})

journal.on('message', async (msg) => {
  await journal.memory.store(msg.text, msg.text, {
    namespace: `journal:${msg.userId}`,
    ttl: 0,  // never expire
  })

  const related = await journal.memory.recall(msg.text, {
    namespace: `journal:${msg.userId}`,
    threshold: 0.75,
  })

  return msg.reply(await llm.complete(msg.text, { context: related }))
})
```

---

## Auth & Security

cachly uses **Keycloak** (self-hosted OIDC) for authentication. Your Redis password and vector token are scoped per instance and never shared.

```bash
CACHLY_URL=redis://:your-password@your-instance.cachly.dev:6379
CACHLY_VECTOR_URL=https://api.cachly.dev/v1/sem/your-vector-token
```

Get your credentials at [cachly.dev/instances](https://cachly.dev/instances).

---

## Development

```bash
npm install
npm run build     # tsc
npm test          # vitest
npm run typecheck # tsc --noEmit
```

---

## Links

- 📖 [cachly.dev docs](https://cachly.dev/docs/openclaw)
- 🧠 [AI Memory / MCP Server](https://cachly.dev/docs/ai-memory)
- 🔧 [OpenClaw](https://openclaw.dev)
- 🐛 [Issues](https://github.com/cachly-dev/sdk-js/issues)
- 📦 [npm](https://www.npmjs.com/package/@cachly-dev/openclaw)

---

MIT © [cachly.dev](https://cachly.dev)
