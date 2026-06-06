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

export { createCachlyBrain, CachlyBrain } from './brain.js';
export type {
  CachlyBrainOptions,
  BrainLesson,
  BrainRecallResult,
  LearnInput,
  LessonOutcome,
  LessonSeverity,
} from './brain.js';

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
  /** Embedding function – any provider */
  embedFn: EmbedFn;
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
    memoryEngine:  createCachlyMemoryAdapter({
      url:       opts.url,
      vectorUrl: opts.vectorUrl,
      embedFn:   opts.embedFn,
      ttl:       opts.ttl?.memory,
    }),
  };
}

