# @cachly-dev/openclaw

> Official **cachly.dev** adapter for [OpenClaw](https://openclaw.dev) – the personal AI assistant.  
> Persistent sessions · Semantic LLM cache · Redis memory storage

[![npm](https://img.shields.io/npm/v/@cachly-dev/openclaw?color=red)](https://www.npmjs.com/package/@cachly-dev/openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

---

## What it provides

| Feature | Description | Savings |
|---------|-------------|---------|
| 🗄️ **Session Store** | Persistent Redis-backed conversation sessions | No cold starts |
| 🧠 **Semantic LLM Cache** | Cache LLM responses by meaning (pgvector HNSW) | 50–70% cost reduction |
| 💾 **Memory Adapter** | Redis + pgvector replaces LanceDB for long-term memory | EU data residency |

---

## Installation

```bash
npm install @cachly-dev/openclaw
```

> **Peer dependency:** `openclaw >= 2026.1.0`  
> **Requires:** A cachly.dev instance – free tier at [cachly.dev](https://cachly.dev)

---

## Quick start

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

// Use in your OpenClaw app:
const app = new OpenClawApp({
  ...cachlyConfig,
  // ... your other config
})
```

---

## Individual adapters

### Session Store

Persists OpenClaw conversation history in Redis:

```typescript
import { createCachlySessionStore } from '@cachly-dev/openclaw'

const sessionStore = createCachlySessionStore({
  url: process.env.CACHLY_URL!,
  ttl: 604800, // 7 days
})

// Used automatically by OpenClaw – no manual calls needed.
```

### Semantic LLM Cache

Intercepts LLM calls and returns cached responses for semantically identical prompts:

```typescript
import { createSemanticLLMCache } from '@cachly-dev/openclaw'

const llmCache = createSemanticLLMCache({
  url:       process.env.CACHLY_URL!,
  vectorUrl: process.env.CACHLY_VECTOR_URL!,
  embedFn:   myEmbedFn,
  threshold: 0.92,     // similarity threshold (default: 0.92)
  ttl:       3600,     // cache TTL in seconds
  skipPatterns: [      // never cache these
    'generate image',
    'draw',
    'real-time',
  ],
})

// Wrap your LLM calls:
const response = await llmCache.getOrSet(
  'What is semantic caching?',
  () => openai.chat.completions.create({ model: 'gpt-4o', messages: [...] })
)
```

### Memory Adapter

Replaces LanceDB with Redis + pgvector for EU-compliant, Redis-native memory:

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

## Auth & Security

cachly uses **Keycloak** (self-hosted OIDC) for authentication.  
Your Redis password and vector token are scoped per-instance and never shared.

```bash
# Get your instance URL from the cachly.dev dashboard:
CACHLY_URL=redis://:your-password@your-instance.cachly.dev:6379
CACHLY_VECTOR_URL=https://api.cachly.dev/v1/sem/your-vector-token
```

---

## Development

```bash
npm install
npm run build        # tsc
npm test             # vitest
npm run typecheck    # tsc --noEmit
```

---

## Real-World Use Cases

### 1. WhatsApp Customer Support Bot with Memory

**Problem:** Your customers message you on WhatsApp, but every conversation starts from scratch. No context, no history.

**Solution:** OpenClaw + cachly = WhatsApp bot with persistent semantic memory.

```typescript
import { OpenClaw } from '@cachly-dev/openclaw'

const bot = new OpenClaw({
  channels: ['whatsapp'],
  cachlyUrl: process.env.CACHLY_URL,
  vectorUrl: process.env.CACHLY_VECTOR_URL,
  embedFn: openaiEmbed,
})

bot.on('message', async (msg) => {
  // Check semantic cache: has a similar question been answered before?
  const cached = await bot.memory.recall(msg.text, { threshold: 0.85 })
  if (cached) {
    return msg.reply(cached.response)  // instant, free
  }

  // Generate fresh response
  const response = await llm.complete(msg.text, {
    context: await bot.memory.getHistory(msg.userId, { limit: 10 }),
  })

  // Cache for future similar questions
  await bot.memory.store(msg.text, response)
  return msg.reply(response)
})
```

**Impact:** A support bot handling 500 messages/day with 65% cache hit rate saves ~€200/month in LLM costs.

---

### 2. Slack AI Assistant for Engineering Teams

**Problem:** Your engineering team asks the same DevOps/infrastructure questions repeatedly in Slack. "How do I deploy to staging?" gets asked every week.

**Solution:** OpenClaw bot in Slack with semantic cache for tribal knowledge.

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

// Now when someone asks "how do I push to staging?"
// → Semantic match (0.91 similarity) → instant answer from cache
```

---

### 3. Multi-Channel FAQ Bot (WhatsApp + Telegram + Discord)

**Problem:** You have customers on 3 different platforms asking the same questions. Maintaining 3 separate bots is painful.

**Solution:** One OpenClaw bot, 3 channels, one shared semantic cache.

```typescript
const bot = new OpenClaw({
  channels: ['whatsapp', 'telegram', 'discord'],
  cachlyUrl: process.env.CACHLY_URL,
  vectorUrl: process.env.CACHLY_VECTOR_URL,
  embedFn: openaiEmbed,
})

// A question answered on WhatsApp instantly benefits Telegram + Discord users
// Same semantic cache, same knowledge, zero duplication
```

**Result:** Consistent answers across all channels. One LLM call serves all platforms.

---

### 4. Personal AI Journal / Diary Bot (Telegram)

**Problem:** You want an AI companion that remembers your conversations, goals, and moods across months — not just one session.

**Solution:** OpenClaw Telegram bot with long-term semantic memory.

```typescript
const journal = new OpenClaw({
  channels: ['telegram'],
  cachlyUrl: process.env.CACHLY_URL,
  vectorUrl: process.env.CACHLY_VECTOR_URL,
  embedFn: openaiEmbed,
  namespace: 'personal-journal',
})

journal.on('message', async (msg) => {
  // Store every entry with semantic embedding
  await journal.memory.store(msg.text, msg.text, {
    namespace: `journal:${msg.userId}`,
    ttl: 0,  // never expire
  })

  // "What was I stressed about last month?"
  // → Semantic search across all journal entries → relevant context
  const related = await journal.memory.recall(msg.text, {
    namespace: `journal:${msg.userId}`,
    threshold: 0.75,
  })

  return msg.reply(await llm.complete(msg.text, { context: related }))
})
```

---

### 5. E-Commerce Order Tracking Bot (iMessage + Teams)

**Problem:** Customers ask "Where's my order?" on different channels. Each lookup requires a database query + LLM formatting.

**Solution:** Cache order status responses by similarity. "Where's order #42?" and "Track my order forty-two" both hit the same cache.

```typescript
const orderBot = new OpenClaw({
  channels: ['imessage', 'teams'],
  cachlyUrl: process.env.CACHLY_URL,
  vectorUrl: process.env.CACHLY_VECTOR_URL,
  embedFn: openaiEmbed,
  namespace: 'order-tracking',
})

// Cache order responses with short TTL (status changes)
// "Where's my order #42?" → DB lookup + format → cache (TTL: 300s)
// "What's the status of order 42?" → cache HIT (similarity: 0.94)
// After 5 minutes → cache expires → fresh DB lookup
```

---

## Links

- 📖 [cachly.dev docs](https://cachly.dev/docs/openclaw)
- 🔧 [OpenClaw](https://openclaw.dev)
- 🐛 [Issues](https://github.com/cachly-dev/sdk-js/issues)

