/**
 * @cachly-dev/openclaw – Session Store Adapter
 *
 * Implements OpenClaw's session-store-runtime interface backed by Redis/Valkey.
 * Enables:
 *   – Persistent sessions across restarts
 *   – Multi-device continuity (same session on WhatsApp + Telegram + Slack)
 *   – Automatic TTL-based session cleanup
 *   – Memory-efficient storage vs. in-process Maps
 *
 * Usage in openclaw.config.ts / workspace config:
 *
 *   import { createCachlySessionStore } from '@cachly-dev/openclaw/session-store'
 *
 *   export default {
 *     sessionStore: createCachlySessionStore({
 *       url: process.env.CACHLY_URL!,
 *       ttl: 7 * 24 * 3600,     // sessions live 7 days
 *       namespace: 'oc:session',
 *     }),
 *   }
 */

import { Redis } from 'ioredis';

// ── Types matching openclaw/plugin-sdk/session-store-runtime ─────────────────

export interface SessionData {
  id: string;
  agentId?: string;
  channelId?: string;
  model?: string;
  messages: SessionMessage[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  tokenCount?: number;
  cost?: number;
}

/** Mirrors openclaw/plugin-sdk/session-store-runtime ISessionStore */
export interface ISessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(sessionId: string, data: SessionData): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(agentId?: string): Promise<string[]>;
  exists(sessionId: string): Promise<boolean>;
  touch(sessionId: string): Promise<void>;  // reset TTL
  prune(olderThanMs: number): Promise<number>; // delete old sessions
  stats(): Promise<{ count: number; memoryBytes: number }>;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface CachlySessionStoreOptions {
  /** Redis connection URL (redis://:password@host:port) */
  url: string;
  /** Session TTL in seconds (default: 604800 = 7 days) */
  ttl?: number;
  /** Key namespace prefix (default: 'oc:session') */
  namespace?: string;
}

// ── Implementation ────────────────────────────────────────────────────────────

class CachlySessionStore implements ISessionStore {
  private readonly redis: Redis;
  private readonly ttl: number;
  private readonly ns: string;

  constructor(opts: CachlySessionStoreOptions) {
    this.redis = new Redis(opts.url);
    this.ttl = opts.ttl ?? 7 * 24 * 3600;
    this.ns = opts.namespace ?? 'oc:session';
  }

  private key(sessionId: string): string {
    return `${this.ns}:${sessionId}`;
  }

  private indexKey(agentId: string): string {
    return `${this.ns}:idx:agent:${agentId}`;
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const raw = await this.redis.get(this.key(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as SessionData;
  }

  async set(sessionId: string, data: SessionData): Promise<void> {
    const serialized = JSON.stringify({ ...data, updatedAt: Date.now() });
    await this.redis.set(this.key(sessionId), serialized, 'EX', this.ttl);
    // Maintain per-agent index for listing
    if (data.agentId) {
      await this.redis.sadd(this.indexKey(data.agentId), sessionId);
      await this.redis.expire(this.indexKey(data.agentId), this.ttl);
    }
  }

  async delete(sessionId: string): Promise<void> {
    const raw = await this.redis.get(this.key(sessionId));
    if (raw) {
      const data = JSON.parse(raw) as SessionData;
      if (data.agentId) {
        await this.redis.srem(this.indexKey(data.agentId), sessionId);
      }
    }
    await this.redis.del(this.key(sessionId));
  }

  async list(agentId?: string): Promise<string[]> {
    if (agentId) {
      return this.redis.smembers(this.indexKey(agentId));
    }
    // Global list via SCAN (capped at 1000 for safety)
    const keys: string[] = [];
    const stream = this.redis.scanStream({ match: `${this.ns}:*`, count: 100 });
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (batch: string[]) => {
        const ids = batch
          .filter((k) => !k.includes(':idx:'))
          .map((k) => k.slice(this.ns.length + 1));
        keys.push(...ids);
        if (keys.length >= 1000) {
          stream.destroy();
          resolve();
        }
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return keys.slice(0, 1000);
  }

  async exists(sessionId: string): Promise<boolean> {
    return (await this.redis.exists(this.key(sessionId))) === 1;
  }

  async touch(sessionId: string): Promise<void> {
    await this.redis.expire(this.key(sessionId), this.ttl);
  }

  async prune(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    const ids = await this.list();
    let pruned = 0;
    for (const id of ids) {
      const data = await this.get(id);
      if (data && data.updatedAt < cutoff) {
        await this.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  async stats(): Promise<{ count: number; memoryBytes: number }> {
    const ids = await this.list();
    const info = await this.redis.info('memory');
    const memMatch = info.match(/used_memory:(\d+)/);
    return {
      count: ids.length,
      memoryBytes: memMatch ? parseInt(memMatch[1]) : 0,
    };
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a Cachly-backed session store for OpenClaw.
 *
 * @example
 * ```ts
 * // openclaw.config.ts
 * import { createCachlySessionStore } from '@cachly-dev/openclaw/session-store'
 *
 * export default {
 *   sessionStore: createCachlySessionStore({
 *     url: process.env.CACHLY_URL!,
 *   }),
 * }
 * ```
 */
export function createCachlySessionStore(opts: CachlySessionStoreOptions): ISessionStore {
  return new CachlySessionStore(opts);
}

