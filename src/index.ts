/**
 * @cachly-dev/openclaw
 *
 * Official Cachly adapter for OpenClaw – the personal AI assistant.
 *
 * Provides:
 *  – Persistent Redis-backed session store
 *  – Semantic LLM cache middleware (50–70% cost reduction)
 *  – Memory storage adapter (replaces LanceDB with Redis + pgvector)
 *
 * Quick start:
 * ```ts
 * import {
 *   createCachlySessionStore,
 *   createSemanticLLMCache,
 *   createCachlyMemoryAdapter,
 * } from '@cachly-dev/openclaw'
 * ```
 */

export { createCachlySessionStore } from './session-store.js';
export type { ISessionStore, SessionData, SessionMessage, CachlySessionStoreOptions } from './session-store.js';

export { createSemanticLLMCache, SemanticLLMCache, detectNamespaceType } from './llm-cache.js';
export type { LLMMiddleware, LLMRequest, LLMResponse, SemanticLLMCacheOptions, EmbedFn } from './llm-cache.js';

export { createCachlyMemoryAdapter } from './memory-adapter.js';
export type { IMemoryStorage, MemoryEntry, MemorySearchResult, CachlyMemoryAdapterOptions } from './memory-adapter.js';

export { createAmbientRecall, isTrivialPrompt, selectMemories, formatMemoryBlock } from './ambient-recall.js';
export type { AmbientRecallOptions, AmbientRecallStats, AmbientRecallMiddleware } from './ambient-recall.js';

// ── Brain Search (BM25+) ─────────────────────────────────────────────────────

/**
 * BM25+ keyword search over brain data. Works without embeddings.
 *
 * @param batchUrl - Cachly batch API URL
 * @param query    - Natural-language search query
 * @param topK     - Max results (default 10)
 */
export async function brainSearch(
  batchUrl: string,
  query: string,
  topK = 10,
): Promise<{ results: Array<{ key: string; score: number; matched_words: string[]; preview: string }>; total_docs: number; duration_ms: number }> {
  const resp = await fetch(`${batchUrl.replace(/\/$/, '')}/brain-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: topK }),
  });
  if (!resp.ok) throw new Error(`brainSearch failed: ${resp.status}`);
  return resp.json();
}

// ── Convenience: createCachlyOpenClawConfig ───────────────────────────────────

import { createCachlySessionStore } from './session-store.js';
import { createSemanticLLMCache } from './llm-cache.js';
import { createCachlyMemoryAdapter } from './memory-adapter.js';
import type { EmbedFn } from './llm-cache.js';

export interface CachlyOpenClawConfig {
  /** Redis connection URL from cachly.dev dashboard */
  url: string;
  /** Cachly vector API URL (Speed/Business tier) */
  vectorUrl?: string;
  /**
   * Embedding function for semantic matching.
   * Optional — omit to start with exact-match caching (zero extra dependencies).
   * Add to unlock semantic matching and increase hit rates by ~30%.
   */
  embedFn?: EmbedFn;
  ttl?: {
    session?: number;   // default: 604800 (7d)
    llm?: number;       // default: 3600 (1h)
    memory?: number;    // default: 7776000 (90d)
  };
  /** Prompts containing these strings skip LLM caching */
  skipPatterns?: string[];
  debug?: boolean;
}

/**
 * One-shot helper that creates all three adapters and returns a config object
 * ready to spread into your OpenClaw workspace config.
 *
 * @example
 * ```ts
 * // openclaw.config.ts
 * import { createCachlyOpenClawConfig } from '@cachly-dev/openclaw'
 * import OpenAI from 'openai'
 *
 * const openai = new OpenAI()
 * const embed = (t: string) =>
 *   openai.embeddings.create({ model: 'text-embedding-3-small', input: t })
 *         .then(r => r.data[0].embedding)
 *
 * export default {
 *   ...(await createCachlyOpenClawConfig({
 *     url:       process.env.CACHLY_URL!,
 *     vectorUrl: process.env.CACHLY_VECTOR_URL,
 *     embedFn:   embed,
 *     skipPatterns: ['weather', 'time now', 'today'],
 *   })),
 * }
 * ```
 */
export async function createCachlyOpenClawConfig(opts: CachlyOpenClawConfig) {
  const [llmMiddleware] = await Promise.all([
    createSemanticLLMCache({
      url:          opts.url,
      vectorUrl:    opts.vectorUrl,
      embedFn:      opts.embedFn,
      ttl:          opts.ttl?.llm,
      skipPatterns: opts.skipPatterns,
      debug:        opts.debug,
    }),
  ]);

  return {
    sessionStore:  createCachlySessionStore({
      url: opts.url,
      ttl: opts.ttl?.session,
    }),
    llmMiddleware,
    memoryEngine:  opts.embedFn ? createCachlyMemoryAdapter({
      url:       opts.url,
      vectorUrl: opts.vectorUrl,
      embedFn:   opts.embedFn,
      ttl:       opts.ttl?.memory,
    }) : undefined,
  };
}

