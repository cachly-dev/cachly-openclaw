/**
 * @cachly-dev/openclaw – Memory Storage Adapter
 *
 * Implements OpenClaw's memory-core-host-engine-storage interface backed by
 * Redis + optional pgvector (Cachly Speed/Business tier).
 *
 * OpenClaw's memory system lets the AI "remember" facts across conversations.
 * This adapter persists those memories in Cachly so they survive restarts,
 * are accessible from all channels, and benefit from semantic similarity search.
 *
 * Usage in openclaw.config.ts:
 *
 *   import { createCachlyMemoryAdapter } from '@cachly-dev/openclaw/memory-adapter'
 *   import OpenAI from 'openai'
 *
 *   const openai = new OpenAI()
 *   export default {
 *     memoryEngine: createCachlyMemoryAdapter({
 *       url:       process.env.CACHLY_URL!,
 *       vectorUrl: process.env.CACHLY_VECTOR_URL,
 *       embedFn:   t => openai.embeddings.create({
 *                         model: 'text-embedding-3-small', input: t
 *                       }).then(r => r.data[0].embedding),
 *       ttl:       90 * 24 * 3600,  // memories live 90 days
 *     }),
 *   }
 */

import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

export type EmbedFn = (text: string) => Promise<number[]>;

// ── Types matching openclaw/plugin-sdk/memory-core-host-engine-storage ────────

export interface MemoryEntry {
  id: string;
  agentId: string;
  userId?: string;
  content: string;
  type: 'fact' | 'preference' | 'context' | 'skill' | 'entity';
  importance: number;         // 0–1
  embedding?: number[];
  tags?: string[];
  source?: string;            // channel or skill that created this memory
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  similarity: number;
}

/** Mirrors openclaw/plugin-sdk/memory-core-host-engine-storage interface */
export interface IMemoryStorage {
  store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>): Promise<MemoryEntry>;
  get(id: string): Promise<MemoryEntry | null>;
  search(query: string, agentId: string, opts?: { topK?: number; threshold?: number; type?: MemoryEntry['type'] }): Promise<MemorySearchResult[]>;
  update(id: string, patch: Partial<Pick<MemoryEntry, 'content' | 'importance' | 'tags'>>): Promise<void>;
  delete(id: string): Promise<void>;
  listByAgent(agentId: string, limit?: number): Promise<MemoryEntry[]>;
  forget(agentId: string, olderThanDays?: number): Promise<number>;
  size(agentId?: string): Promise<number>;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface CachlyMemoryAdapterOptions {
  url: string;
  vectorUrl?: string;
  embedFn: EmbedFn;
  /** Memory TTL in seconds (default: 90 days) */
  ttl?: number;
  /** Key namespace (default: 'oc:mem') */
  namespace?: string;
  /** Similarity threshold for semantic search (default: 0.80) */
  threshold?: number;
}

// ── Cosine similarity (inline fallback) ──────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Implementation ────────────────────────────────────────────────────────────

class CachlyMemoryAdapter implements IMemoryStorage {
  private readonly redis: Redis;
  private readonly embedFn: EmbedFn;
  private readonly ttl: number;
  private readonly ns: string;
  private readonly threshold: number;
  private readonly vectorUrl?: string;

  constructor(opts: CachlyMemoryAdapterOptions) {
    this.redis = new Redis(opts.url);
    this.embedFn = opts.embedFn;
    this.ttl = opts.ttl ?? 90 * 24 * 3600;
    this.ns = opts.namespace ?? 'oc:mem';
    this.threshold = opts.threshold ?? 0.80;
    this.vectorUrl = opts.vectorUrl;
  }

  private key(id: string): string { return `${this.ns}:e:${id}`; }
  private agentKey(agentId: string): string { return `${this.ns}:a:${agentId}`; }
  private vecKey(agentId: string): string { return `${this.ns}:v:${agentId}`; }

  async store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>): Promise<MemoryEntry> {
    const id = randomUUID();
    const now = Date.now();
    const embedding = entry.embedding ?? await this.embedFn(entry.content);

    const full: MemoryEntry = {
      ...entry,
      id,
      embedding,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    };

    // Store entry
    await this.redis.set(this.key(id), JSON.stringify(full), 'EX', this.ttl);

    // Agent index (sorted set by importance × recency score)
    const score = entry.importance * (now / 1_000_000);
    await this.redis.zadd(this.agentKey(entry.agentId), score, id);
    await this.redis.expire(this.agentKey(entry.agentId), this.ttl);

    // Vector index (pgvector or inline hash)
    if (this.vectorUrl) {
      await fetch(`${this.vectorUrl}/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          namespace: `${this.ns}:${entry.agentId}`,
          embedding,
          prompt: entry.content,
          expires_at: new Date(now + this.ttl * 1000).toISOString(),
        }),
      }).catch(() => undefined);
    } else {
      await this.redis.hset(
        this.vecKey(entry.agentId),
        id,
        JSON.stringify({ embedding, expiresAt: now + this.ttl * 1000 }),
      );
      await this.redis.expire(this.vecKey(entry.agentId), this.ttl * 2);
    }

    return full;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const raw = await this.redis.get(this.key(id));
    if (!raw) return null;
    const entry = JSON.parse(raw) as MemoryEntry;
    // Touch: update access metadata
    entry.lastAccessedAt = Date.now();
    entry.accessCount++;
    await this.redis.set(this.key(id), JSON.stringify(entry), 'EX', this.ttl);
    return entry;
  }

  async search(
    query: string,
    agentId: string,
    opts?: { topK?: number; threshold?: number; type?: MemoryEntry['type'] },
  ): Promise<MemorySearchResult[]> {
    const topK = opts?.topK ?? 5;
    const threshold = opts?.threshold ?? this.threshold;
    const embedding = await this.embedFn(query);
    const results: MemorySearchResult[] = [];

    if (this.vectorUrl) {
      const res = await fetch(`${this.vectorUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embedding,
          namespace: `${this.ns}:${agentId}`,
          threshold,
          top_k: topK,
        }),
      }).catch(() => null);

      if (res?.ok) {
        const hits = await res.json() as Array<{ found: boolean; id: string; similarity: number }>;
        for (const hit of hits) {
          if (!hit.found) continue;
          const entry = await this.get(hit.id);
          if (entry && (!opts?.type || entry.type === opts.type)) {
            results.push({ entry, similarity: hit.similarity });
          }
        }
        return results;
      }
    }

    // Inline fallback
    const vecEntries = await this.redis.hgetall(this.vecKey(agentId));
    const scored: { id: string; similarity: number }[] = [];
    for (const [id, raw] of Object.entries(vecEntries)) {
      const vec = JSON.parse(raw) as { embedding: number[]; expiresAt: number };
      if (vec.expiresAt < Date.now()) { await this.redis.hdel(this.vecKey(agentId), id); continue; }
      const sim = cosine(embedding, vec.embedding);
      if (sim >= threshold) scored.push({ id, similarity: sim });
    }
    scored.sort((a, b) => b.similarity - a.similarity);

    for (const { id, similarity } of scored.slice(0, topK)) {
      const entry = await this.get(id);
      if (entry && (!opts?.type || entry.type === opts.type)) {
        results.push({ entry, similarity });
      }
    }
    return results;
  }

  async update(id: string, patch: Partial<Pick<MemoryEntry, 'content' | 'importance' | 'tags'>>): Promise<void> {
    const entry = await this.get(id);
    if (!entry) return;
    const updated = { ...entry, ...patch };
    if (patch.content) {
      updated.embedding = await this.embedFn(patch.content);
    }
    await this.redis.set(this.key(id), JSON.stringify(updated), 'EX', this.ttl);
  }

  async delete(id: string): Promise<void> {
    const entry = await this.get(id);
    if (!entry) return;
    await Promise.all([
      this.redis.del(this.key(id)),
      this.redis.zrem(this.agentKey(entry.agentId), id),
      this.redis.hdel(this.vecKey(entry.agentId), id),
    ]);
  }

  async listByAgent(agentId: string, limit = 50): Promise<MemoryEntry[]> {
    const ids = await this.redis.zrevrange(this.agentKey(agentId), 0, limit - 1);
    const entries = await Promise.all(ids.map((id) => this.get(id)));
    return entries.filter((e): e is MemoryEntry => e !== null);
  }

  async forget(agentId: string, olderThanDays = 30): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const entries = await this.listByAgent(agentId, 10_000);
    let deleted = 0;
    for (const e of entries) {
      if (e.lastAccessedAt < cutoff && e.importance < 0.5) {
        await this.delete(e.id);
        deleted++;
      }
    }
    return deleted;
  }

  async size(agentId?: string): Promise<number> {
    if (agentId) return this.redis.zcard(this.agentKey(agentId));
    const keys = await this.redis.keys(`${this.ns}:a:*`);
    let total = 0;
    for (const k of keys) total += await this.redis.zcard(k);
    return total;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a Cachly-backed memory adapter for OpenClaw.
 * Replaces OpenClaw's default LanceDB memory with Redis + pgvector.
 *
 * @example
 * ```ts
 * // openclaw.config.ts
 * import { createCachlyMemoryAdapter } from '@cachly-dev/openclaw/memory-adapter'
 *
 * export default {
 *   memoryEngine: createCachlyMemoryAdapter({
 *     url:     process.env.CACHLY_URL!,
 *     embedFn: (t) => openai.embeddings.create(...).then(r => r.data[0].embedding),
 *   }),
 * }
 * ```
 */
export function createCachlyMemoryAdapter(opts: CachlyMemoryAdapterOptions): IMemoryStorage {
  return new CachlyMemoryAdapter(opts);
}

