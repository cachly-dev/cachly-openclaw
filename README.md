# @cachly-dev/openclaw

> **You paid $0.08 for that answer. The next 1,000 identical asks: $0.00.**  
> Semantic LLM cache + persistent sessions + AI memory. 3 lines. No embeddings required.

[![npm](https://img.shields.io/npm/v/@cachly-dev/openclaw?color=red&logo=npm)](https://www.npmjs.com/package/@cachly-dev/openclaw)
[![npm downloads](https://img.shields.io/npm/dm/@cachly-dev/openclaw?color=blue)](https://www.npmjs.com/package/@cachly-dev/openclaw)
[![Free tier](https://img.shields.io/badge/Free%20tier-€0%2Fmo-brightgreen)](https://cachly.dev)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](../../LICENSE)

---

## Before / After

```typescript
// ❌ Before: Every user message calls OpenAI. Every time. No exceptions.
const reply = await openai.chat.completions.create({ model: 'gpt-4o', messages })

// ✅ After: Same questions = zero API calls = zero cost
const cache = createSemanticLLMCache({ url: process.env.CACHLY_URL })
const reply = await cache.getOrSet(userMessage, () =>
  openai.chat.completions.create({ model: 'gpt-4o', messages })
)
```

"How do I reset my password?" → "How can I reset my pw?" → **cache hit**. $0.00.

---

## Setup — 60 seconds

```bash
npm install @cachly-dev/openclaw
```

```bash
# Get a free Redis instance at cachly.dev (no credit card):
CACHLY_URL=redis://:password@your-instance.cachly.dev:6379
```

---

## ⚡ Semantic LLM Cache — 3 lines

Every time a user asks the same question in different words, you pay OpenAI again. This stops that.

```typescript
import { createSemanticLLMCache } from '@cachly-dev/openclaw'

const cache = createSemanticLLMCache({ url: process.env.CACHLY_URL! })

// Wrap any LLM call — that's it
const answer = await cache.getOrSet(
  userPrompt,
  () => openai.chat.completions.create({ model: 'gpt-4o', messages: [...] })
)
```

**Without an embed function + no vectorUrl:** exact-match caching + **local BM25+ fuzzy search** kick in immediately (20–50% savings). No API calls. "how do I reset password?" matches "password reset help" — pure in-process.

**Without an embed function + vectorUrl:** BM25 + hosted pgvector index, higher hit rates across large caches.

**Add semantic matching** for 60–90% savings (10 more lines):

```typescript
const cache = createSemanticLLMCache({
  url:       process.env.CACHLY_URL!,
  vectorUrl: process.env.CACHLY_VECTOR_URL,   // from cachly.dev dashboard
  embedFn:   (text) =>
    openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
      .then(r => r.data[0].embedding),
  threshold: 0.92,   // cosine similarity (default)
  ttl:       3600,   // seconds
})
```

"How do I reset my password?" → "How can I reset my pw?" → **same cache hit**. 💰

---

## 📊 What you save

| Questions/day | Cache hit rate | Monthly saving (GPT-4o) |
|---------------|---------------|------------------------|
| 100           | 40% exact     | ~$8                    |
| 100           | 70% semantic  | ~$22                   |
| 1 000         | 70% semantic  | ~$220                  |
| 10 000        | 70% semantic  | ~$2 200                |

After 10 cache hits, the console logs:
```
🎯 cachly: 12,340 tokens saved this session (10 hits)
   Full stats → cachly.dev/dashboard
```
(Cost breakdown available in the dashboard.)

---

## 🗄️ Session Store

Persist conversation history in Redis — no cold starts, no lost context:

```typescript
import { createCachlySessionStore } from '@cachly-dev/openclaw'

const sessions = createCachlySessionStore({
  url: process.env.CACHLY_URL!,
  ttl: 604800,  // 7 days
})

const history = await sessions.get(userId)
await sessions.set(userId, [...history, { role: 'user', content: message }])
```

Works with any LLM framework — OpenAI, LangChain, Vercel AI SDK, etc.

---

## 🧠 Memory Adapter

Long-term semantic memory — store facts, recall by meaning:

```typescript
import { createCachlyMemoryAdapter } from '@cachly-dev/openclaw'

const memory = createCachlyMemoryAdapter({
  url:       process.env.CACHLY_URL!,
  vectorUrl: process.env.CACHLY_VECTOR_URL!,
  embedFn:   myEmbedFn,
  ttl:       7776000,  // 90 days
})

await memory.store({ id: 'pref-1', text: 'User prefers TypeScript over Python' })
const results = await memory.search('programming language preference', { topK: 5 })
// → [{ text: 'User prefers TypeScript over Python', score: 0.97 }]
```

---

## 🔍 Brain Search (BM25+)

Full-text search over cached data — no embeddings needed:

```typescript
import { brainSearch } from '@cachly-dev/openclaw'

const results = await brainSearch(process.env.CACHLY_VECTOR_URL!, 'deploy authentication error')
// → [{ key: 'lesson:fix:auth', score: 4.2, preview: '...' }]
```

---

## 🧩 Standalone — works with any LLM stack

No OpenClaw needed. Drop into LangChain, Vercel AI SDK, plain `fetch`, or any custom pipeline:

### LangChain
```typescript
import { createSemanticLLMCache } from '@cachly-dev/openclaw'
import { ChatOpenAI } from '@langchain/openai'

const cache = createSemanticLLMCache({ url: process.env.CACHLY_URL! })
const llm = new ChatOpenAI()

async function cachedInvoke(prompt: string) {
  return cache.getOrSet(
    prompt,
    () => llm.invoke(prompt).then(r => ({ content: r.content as string, model: 'gpt-4o' }))
  )
}
```

### Vercel AI SDK
```typescript
import { createSemanticLLMCache } from '@cachly-dev/openclaw'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

const cache = createSemanticLLMCache({ url: process.env.CACHLY_URL! })

export async function POST(req: Request) {
  const { prompt } = await req.json()
  const result = await cache.getOrSet(
    prompt,
    () => generateText({ model: openai('gpt-4o'), prompt }).then(r => ({ content: r.text, model: 'gpt-4o' }))
  )
  return Response.json(result)
}
```

### Plain fetch / any provider
```typescript
import { createSemanticLLMCache } from '@cachly-dev/openclaw'

const cache = createSemanticLLMCache({ url: process.env.CACHLY_URL! })

const answer = await cache.getOrSet(
  userMessage,
  async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 1024, messages: [{ role: 'user', content: userMessage }] }),
    })
    const json = await res.json()
    return { content: json.content[0].text, model: 'claude-opus-4-5', inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens }
  }
)
```

---

## 🦾 OpenClaw adapter (bonus)

OpenClaw exposes a library bridge subset of the Cachly Brain surface. The generated
parity view is kept in [`../../docs/generated/surface-parity.md`](../../docs/generated/surface-parity.md),
so this SDK does not need to manually mirror every MCP tool.

If you use [OpenClaw](https://openclaw.dev) (22-channel AI assistant), one function wires everything:

```typescript
import { createCachlyOpenClawConfig } from '@cachly-dev/openclaw'
import OpenAI from 'openai'

const openai = new OpenAI()

const cachlyConfig = await createCachlyOpenClawConfig({
  url:       process.env.CACHLY_URL!,
  vectorUrl: process.env.CACHLY_VECTOR_URL,
  embedFn:   (t) =>
    openai.embeddings.create({ model: 'text-embedding-3-small', input: t })
      .then(r => r.data[0].embedding),
})

const app = new OpenClawApp({
  ...cachlyConfig,
  // ... rest of your config
})
```

This gives you: semantic cache + persistent sessions + Redis memory — all across WhatsApp, Telegram, Slack, Discord at once.

---

## 👥 Team Brain

One shared cachly instance → every team member gets smarter from each other's work:

```typescript
// Alice fixes a deploy issue:
await brain.learnFromAttempts({ topic: 'deploy:k8s', outcome: 'success', whatWorked: '...' })

// Bob starts a session the next day:
await brain.sessionStart()
// → "💡 alice solved deploy:k8s 1d ago: ..."
```

Team plans from €99/mo (10 seats) at [cachly.dev/teams](https://cachly.dev/teams).

---

## 🚀 Upgrade path

| Level | What you get | Setup |
|-------|-------------|-------|
| **Free — Exact + BM25** | 20–50% reduction, in-process BM25+ fuzzy, zero config | `CACHLY_URL` only |
| **Free — Semantic cache** | 60–90% cost reduction | + `embedFn` |
| **Speed tier** | Hosted pgvector, higher hit rates at scale | Speed plan at cachly.dev |
| **Team Brain** | Shared knowledge, team lessons, analytics | cachly.dev/teams |

---

## 🤖 Use with Python AI Agents

OpenClaw has a TypeScript SDK, but Python AI agents can use Cachly's REST API directly for persistent memory and semantic caching. Here are patterns for the most popular frameworks.

### LangChain — Persistent Agent Memory

```python
import os, requests
from langchain.memory import ConversationBufferMemory
from langchain.schema import BaseMemory
from typing import Any

CACHLY_URL = os.environ["CACHLY_URL"]
CACHLY_JWT = os.environ["CACHLY_JWT"]
INSTANCE_ID = os.environ["CACHLY_BRAIN_INSTANCE_ID"]
HEADERS = {"Authorization": f"Bearer {CACHLY_JWT}", "Content-Type": "application/json"}

class CachlyBrainMemory(BaseMemory):
    """LangChain memory backed by Cachly Brain — survives restarts."""

    @property
    def memory_variables(self):
        return ["brain_context"]

    def load_memory_variables(self, inputs: dict) -> dict:
        query = inputs.get("input", "")
        r = requests.post(
            f"{CACHLY_URL}/api/v1/instances/{INSTANCE_ID}/recall",
            headers=HEADERS,
            json={"focus": query, "source": "langchain"},
        )
        lessons = r.json().get("top_lessons", [])
        context = "\n".join(f"- {l['what_worked']}" for l in lessons if l.get("what_worked"))
        return {"brain_context": context or "No relevant memory found."}

    def save_context(self, inputs: dict, outputs: dict) -> None:
        # Learn from what the agent discovered
        output = outputs.get("output", "")
        if output:
            requests.post(
                f"{CACHLY_URL}/api/v1/instances/{INSTANCE_ID}/learn",
                headers=HEADERS,
                json={"topic": "agent:langchain", "outcome": "success", "what_worked": output[:500]},
            )

    def clear(self):
        pass  # Brain is persistent — clear not supported by design


# Usage:
from langchain.agents import initialize_agent, AgentType
from langchain.chat_models import ChatOpenAI

memory = CachlyBrainMemory()
agent = initialize_agent(
    tools=[...],
    llm=ChatOpenAI(model="gpt-4o"),
    agent=AgentType.CONVERSATIONAL_REACT_DESCRIPTION,
    memory=memory,
    system_message="You have access to a persistent Brain. brain_context = {brain_context}",
)
```

### CrewAI — Shared Team Brain Tool

```python
import os, requests
from crewai_tools import BaseTool
from pydantic import BaseModel, Field

CACHLY_URL = os.environ["CACHLY_URL"]
CACHLY_JWT = os.environ["CACHLY_JWT"]
INSTANCE_ID = os.environ["CACHLY_BRAIN_INSTANCE_ID"]
HEADERS = {"Authorization": f"Bearer {CACHLY_JWT}"}

class RecallInput(BaseModel):
    query: str = Field(description="What to search for in the Brain")

class CachlyRecallTool(BaseTool):
    name: str = "cachly_brain_recall"
    description: str = "Search persistent memory for lessons, solutions, and context from past work"
    args_schema: type[BaseModel] = RecallInput

    def _run(self, query: str) -> str:
        r = requests.post(
            f"{CACHLY_URL}/api/v1/instances/{INSTANCE_ID}/recall",
            headers={**HEADERS, "Content-Type": "application/json"},
            json={"focus": query, "source": "crewai"},
        )
        results = r.json().get("top_lessons", [])
        if not results:
            return "No relevant memory found."
        return "\n".join(f"[{l['topic']}] {l['what_worked']}" for l in results)

class LearnInput(BaseModel):
    topic: str = Field(description="Category slug like 'deploy:api' or 'fix:auth'")
    what_worked: str = Field(description="What solution worked")
    outcome: str = Field(default="success", description="success | failure | partial")

class CachlyLearnTool(BaseTool):
    name: str = "cachly_brain_learn"
    description: str = "Store a lesson in persistent memory so future agents can benefit from it"
    args_schema: type[BaseModel] = LearnInput

    def _run(self, topic: str, what_worked: str, outcome: str = "success") -> str:
        requests.post(
            f"{CACHLY_URL}/api/v1/instances/{INSTANCE_ID}/learn",
            headers={**HEADERS, "Content-Type": "application/json"},
            json={"topic": topic, "outcome": outcome, "what_worked": what_worked},
        )
        return f"✅ Stored lesson: {topic}"


# Usage with CrewAI:
from crewai import Agent, Task, Crew

researcher = Agent(
    role="Research Analyst",
    goal="Research topics and store findings for the team",
    tools=[CachlyRecallTool(), CachlyLearnTool()],
    backstory="You have a persistent memory that survives across sessions.",
)
```

### AutoGen / Microsoft AutoGen

```python
import os, requests
from autogen import AssistantAgent, UserProxyAgent

CACHLY_URL = os.environ["CACHLY_URL"]
CACHLY_JWT = os.environ["CACHLY_JWT"]
INSTANCE_ID = os.environ["CACHLY_BRAIN_INSTANCE_ID"]
HEADERS = {"Authorization": f"Bearer {CACHLY_JWT}", "Content-Type": "application/json"}

def recall_brain(query: str) -> str:
    """Search Cachly Brain for relevant memory."""
    r = requests.post(
        f"{CACHLY_URL}/api/v1/instances/{INSTANCE_ID}/recall",
        headers=HEADERS, json={"focus": query, "source": "autogen"},
    )
    results = r.json().get("top_lessons", [])
    return "\n".join(f"• [{l['topic']}] {l['what_worked']}" for l in results) or "No memory found."

def store_lesson(topic: str, what_worked: str, outcome: str = "success") -> str:
    """Store a lesson in Cachly Brain."""
    requests.post(
        f"{CACHLY_URL}/api/v1/instances/{INSTANCE_ID}/learn",
        headers=HEADERS, json={"topic": topic, "outcome": outcome, "what_worked": what_worked},
    )
    return f"Stored: {topic}"

assistant = AssistantAgent(
    name="CachlyAssistant",
    system_message="""You are a helpful AI with persistent memory via Cachly Brain.
ALWAYS start by calling recall_brain() with the user's query.
ALWAYS end by calling store_lesson() with what you discovered.""",
    llm_config={
        "functions": [
            {"name": "recall_brain", "description": "Search persistent memory", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
            {"name": "store_lesson", "description": "Store a lesson", "parameters": {"type": "object", "properties": {"topic": {"type": "string"}, "what_worked": {"type": "string"}, "outcome": {"type": "string"}}, "required": ["topic", "what_worked"]}},
        ],
    },
)
```

### LlamaIndex — QueryEngine with Cachly Memory

```python
import os, requests
from llama_index.core.memory import BaseMemory
from llama_index.core.schema import TextNode

CACHLY_URL = os.environ["CACHLY_URL"]
CACHLY_JWT = os.environ["CACHLY_JWT"]
INSTANCE_ID = os.environ["CACHLY_BRAIN_INSTANCE_ID"]
HEADERS = {"Authorization": f"Bearer {CACHLY_JWT}", "Content-Type": "application/json"}

class CachlyMemory(BaseMemory):
    """LlamaIndex memory backed by Cachly Brain."""

    def get(self, input: str, **kwargs) -> list[TextNode]:
        r = requests.post(
            f"{CACHLY_URL}/api/v1/instances/{INSTANCE_ID}/recall",
            headers=HEADERS, json={"focus": input, "source": "llamaindex"},
        )
        return [
            TextNode(text=f"[{l['topic']}] {l.get('what_worked', '')}")
            for l in r.json().get("top_lessons", [])
        ]

    def put(self, messages) -> None:
        for msg in messages:
            if hasattr(msg, "content") and msg.content:
                requests.post(
                    f"{CACHLY_URL}/api/v1/instances/{INSTANCE_ID}/learn",
                    headers=HEADERS,
                    json={"topic": "agent:llamaindex", "outcome": "success", "what_worked": str(msg.content)[:500]},
                )

    def reset(self) -> None:
        pass  # Persistent by design


# Usage:
from llama_index.core.chat_engine import CondensePlusContextChatEngine

chat_engine = CondensePlusContextChatEngine.from_defaults(
    index.as_retriever(),
    memory=CachlyMemory(),
    verbose=True,
)
response = chat_engine.chat("How did we fix the last deployment issue?")
```

### Semantic Cache for LLM API Calls (Python)

Skip expensive LLM calls for semantically similar prompts — no embeddings needed on your side:

```python
import os, uuid, requests

CACHLY_URL = os.environ["CACHLY_URL"]
CACHLY_JWT = os.environ["CACHLY_JWT"]
INSTANCE_ID = os.environ["CACHLY_BRAIN_INSTANCE_ID"]
CACHLY_VECTOR_URL = os.environ["CACHLY_VECTOR_URL"].rstrip("/")
HEADERS = {"Authorization": f"Bearer {CACHLY_JWT}", "Content-Type": "application/json"}

def cached_llm_call(prompt: str, llm_fn, namespace: str = "cachly:sem:qa") -> str:
    """Call LLM with semantic caching via Cachly."""
    # 1. Check semantic cache
    r = requests.post(
        f"{CACHLY_VECTOR_URL}/search",
        headers={"Content-Type": "application/json"},
        json={"prompt": prompt, "hybrid": True, "namespace": namespace, "threshold": 0.85},
    )
    hit = r.json()
    if hit.get("found"):
        entries = requests.get(
            f"{CACHLY_VECTOR_URL}/entries",
            params={"namespace": namespace, "limit": 1000},
        ).json().get("data", [])
        cached = next((entry for entry in entries if entry.get("id") == hit.get("id")), None)
        if cached:
            return cached["prompt"]  # Cache hit — no LLM call needed

    # 2. Cache miss — call LLM
    response = llm_fn(prompt)

    # 3. Store in semantic cache
    key = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{namespace}:{prompt}"))
    requests.post(
        f"{CACHLY_VECTOR_URL}/entries",
        headers={"Content-Type": "application/json"},
        json={"id": key, "prompt": response, "namespace": namespace},
    )
    return response


# Usage with any LLM:
import openai
client = openai.OpenAI()

def call_gpt(prompt: str) -> str:
    return client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": prompt}]
    ).choices[0].message.content

answer = cached_llm_call("What is the capital of France?", call_gpt)
```

### Environment Setup for Python Agents

```bash
pip install requests python-dotenv

# .env
CACHLY_URL=https://api.cachly.dev
CACHLY_JWT=cky_live_...          # from cachly.dev → Dashboard → API Keys
CACHLY_BRAIN_INSTANCE_ID=...     # from cachly.dev → Dashboard → Brain
```

Get your free instance at **[cachly.dev/setup-ai](https://cachly.dev/setup-ai)** — no credit card required.

---

## Links

- 📖 [cachly.dev docs](https://cachly.dev/docs)
- 🧠 [AI Memory / MCP Server](https://cachly.dev/docs/ai-memory)
- 📦 [`@cachly-dev/mcp-server`](https://www.npmjs.com/package/@cachly-dev/mcp-server) — give your AI editor persistent memory (122 MCP tools)
- 🤖 [OpenClaw](https://openclaw.dev)
- 📦 [npm](https://www.npmjs.com/package/@cachly-dev/openclaw)
- 🐛 [Issues](https://github.com/cachly-dev/cachly/issues)

---

Apache-2.0 © [cachly.dev](https://cachly.dev)
