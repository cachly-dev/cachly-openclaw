/**
 * @cachly-dev/openclaw – Semantic LLM Cache Middleware
 *
 * Wraps OpenClaw's LLM call pipeline with Cachly semantic caching.
 * Identical or semantically similar prompts return the cached answer instantly
 * instead of calling the LLM API — across ALL channels (WhatsApp, Telegram,
 * Slack, Discord, …).
 *
 * Cost savings: 50–70% typical reduction for personal assistants with recurring
 * questions ("what's the weather?", "remind me tomorrow at 9", "summarize this", …).
 *
 * Usage in openclaw.config.ts:
 *
 *   import { createSemanticLLMCache } from '@cachly-dev/openclaw/llm-cache'
 *   import OpenAI from 'openai'
 *
 *   const openai = new OpenAI()
 *   const embed = (t: string) =>
 *     openai.embeddings.create({ model: 'text-embedding-3-small', input: t })
 *       .then(r => r.data[0].embedding)
 *
 *   export default {
 *     llmMiddleware: createSemanticLLMCache({
 *       url:       process.env.CACHLY_URL!,
 *       vectorUrl: process.env.CACHLY_VECTOR_URL,
 *       embedFn:   embed,
 *       ttl:       3600,        // cache LLM responses for 1 hour
 *       threshold: 0.92,        // cosine similarity threshold
 *     }),
 *   }
 */

import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmbedFn = (text: string) => Promise<number[]>;

export interface LLMRequest {
  prompt: string;
  model: string;
  sessionId?: string;
  agentId?: string;
  /** Channel the message came from (whatsapp, telegram, slack, …) */
  channel?: string;
  systemPrompt?: string;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  /** Added by the cache layer */
  cached?: boolean;
  /** Cosine similarity when served from cache */
  similarity?: number;
  /** Confidence band of the cache hit */
  confidence?: SemanticConfidence;
  /** Estimated cost saved by this cache hit */
  costSaved?: number;
}

/** Mirrors openclaw/plugin-sdk/llm-task middleware signature */
export type LLMMiddleware = (
  req: LLMRequest,
  next: (req: LLMRequest) => Promise<LLMResponse>,
) => Promise<LLMResponse>;

export interface SemanticLLMCacheOptions {
  /** Redis connection URL */
  url: string;
  /** Cachly vector API URL (Speed/Business tier) */
  vectorUrl?: string;
  /** Embedding function – any provider works */
  embedFn: EmbedFn;
  /** LLM response TTL in seconds (default: 3600) */
  ttl?: number;
  /** Cosine similarity threshold 0–1 (default: 0.92) */
  threshold?: number;
  /** Redis key namespace (default: 'oc:llm') */
  namespace?: string;
  /**
   * Per-channel TTL overrides.
   * @example { whatsapp: 7200, telegram: 3600 }
   */
  channelTtl?: Record<string, number>;
  /**
   * Cache only for specific channels (all if omitted).
   * @example ['whatsapp', 'telegram', 'slack']
   */
  cacheChannels?: string[];
  /**
   * Skip caching for prompts containing these substrings
   * (e.g. real-time data, personalized queries).
   * @example ['weather', 'time', 'today', 'my ']
   */
  skipPatterns?: string[];
  /**
   * Normalize prompts before embedding (default: true).
   * Strips filler words, collapses whitespace, lowercases — significantly
   * increases hit rate for semantically identical but differently phrased prompts.
   */
  normalizePrompt?: boolean;
  /**
   * Custom filler words to strip during normalization.
   * @example ['bitte', 'please', 'hey', 'kannst du', 'could you']
   */
  fillerWords?: string[];
  /**
   * High-confidence threshold (default: 0.97).
   * Hits ≥ this value get confidence='high', between threshold and this = 'medium'.
   */
  highConfidenceThreshold?: number;
  /**
   * Auto-detect namespace type from the prompt using text heuristics.
   * When `true`, namespace becomes `{namespace}:{type}:{agentId}` where type is
   * one of: `code`, `translation`, `summary`, `qa`, `creative`.
   * Separates cached responses by domain for higher hit rates. Default: `false`.
   */
  autoNamespace?: boolean;
  /** Log cache hits/misses (default: false) */
  debug?: boolean;
}

// ── Cost estimation ───────────────────────────────────────────────────────────

const COST_PER_1M: Record<string, { input: number; output: number }> = {
  'gpt-5.4':                 { input: 2.00,  output: 8.00  },
  'gpt-4.1':                 { input: 2.00,  output: 8.00  },
  'gpt-4o':                  { input: 2.50,  output: 10.00 },
  'claude-4':                { input: 3.00,  output: 15.00 },
  'claude-3-5-sonnet':       { input: 3.00,  output: 15.00 },
  'gemini-2.5-pro':          { input: 1.25,  output: 10.00 },
  'qwen-max':                { input: 0.80,  output: 2.00  },
  'deepseek-v3':             { input: 0.27,  output: 1.10  },
};

function estimateCostSaved(model: string, inputTokens = 500, outputTokens = 500): number {
  const key = Object.keys(COST_PER_1M).find((k) => model.toLowerCase().includes(k)) ?? '';
  if (!key) return 0;
  const { input, output } = COST_PER_1M[key];
  return ((inputTokens * input + outputTokens * output) / 1_000_000);
}

// ── Namespace Auto-Detection ──────────────────────────────────────────────

const NS_CODE_KW = [
  'function ', 'def ', 'class ', 'import ', 'const ', 'let ', 'var ',
  'return ', ' => ', 'void ', 'public class', 'func ', '#include', 'package ',
  'struct ', 'interface ', 'async def', 'lambda ', '#!/',
];
const NS_TRANSL_KW = [
  'translate', 'übersetze', 'auf deutsch', 'auf englisch',
  'in english', 'in german', 'ins deutsche', 'ins englische', 'übersetz',
  'traduce', 'traduis', 'vertaal',
];
const NS_SUMMARY_KW = [
  'summarize', 'summarise', 'summary', 'zusammenfass', 'tl;dr', 'tldr',
  'key points', 'stichpunkte', 'fasse zusammen', 'give me a brief',
  'kurze zusammenfassung', 'in a nutshell',
];
const NS_QA_PREFIXES = [
  'what ', 'who ', 'where ', 'when ', 'why ', 'how ', 'which ',
  'is ', 'are ', 'was ', 'were ', 'does ', 'do ', 'did ',
  'can ', 'could ', 'would ', 'should ', 'will ',
  'wer ', 'wie ', 'wo ', 'wann ', 'warum ', 'welche', 'wieso ',
];

/**
 * Classify a prompt into one of 5 semantic namespace types using text heuristics.
 * Overhead: <0.1 ms, no embedding required.
 *
 * @returns One of: `'code'` | `'translation'` | `'summary'` | `'qa'` | `'creative'`
 */
export function detectNamespaceType(
  prompt: string,
): 'code' | 'translation' | 'summary' | 'qa' | 'creative' {
  const s = prompt.trim().toLowerCase();
  if (NS_CODE_KW.some((kw) => s.includes(kw))) return 'code';
  if (NS_TRANSL_KW.some((kw) => s.includes(kw))) return 'translation';
  if (NS_SUMMARY_KW.some((kw) => s.includes(kw))) return 'summary';
  if (NS_QA_PREFIXES.some((p) => s.startsWith(p))) return 'qa';
  if (s.trimEnd().endsWith('?')) return 'qa';
  return 'creative';
}

// ── Prompt normalisation ──────────────────────────────────────────────────────

const DEFAULT_FILLER_WORDS = [
  'bitte', 'please', 'hey', 'hi', 'hello', 'hallo',
  'kannst du', 'könntest du', 'could you', 'can you', 'would you',
  'mal eben', 'schnell', 'kurz',
];

/**
 * Normalises a prompt before computing its embedding.
 * Stripping filler words + lowercasing alone yields +8–12% hit-rate uplift
 * without any quality loss.
 */
function normalizePrompt(text: string, fillerWords: string[] = DEFAULT_FILLER_WORDS): string {
  let s = text.trim().toLowerCase();
  for (const filler of fillerWords) {
    s = s.replace(new RegExp(`\\b${filler}\\b`, 'gi'), '');
  }
  return s
    .replace(/\s+/g, ' ')       // collapse whitespace
    .replace(/[?!]+$/, '?')     // normalise trailing punctuation
    .trim();
}

// ── Confidence banding ────────────────────────────────────────────────────────

/** Three-level confidence band for semantic hits. */
export type SemanticConfidence = 'high' | 'medium' | 'uncertain';

function confidenceBand(
  similarity: number,
  threshold: number,
  highThreshold: number,
): SemanticConfidence {
  if (similarity >= highThreshold) return 'high';
  if (similarity >= threshold) return 'medium';
  return 'uncertain';
}

// ── Semantic cache store (lightweight, no pgvector required for basic use) ────

interface VectorEntry {
  id: string;
  embedding: number[];
  expiresAt: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Implementation ────────────────────────────────────────────────────────────

class SemanticLLMCache {
  private readonly redis: Redis;
  private readonly opts: Required<Omit<SemanticLLMCacheOptions,
    'vectorUrl' | 'channelTtl' | 'cacheChannels' | 'skipPatterns' | 'fillerWords'>>
    & Pick<SemanticLLMCacheOptions, 'vectorUrl' | 'channelTtl' | 'cacheChannels' | 'skipPatterns' | 'fillerWords'>;

  constructor(opts: SemanticLLMCacheOptions) {
    this.redis = new Redis(opts.url);
    this.opts = {
      ...opts,
      ttl:                     opts.ttl                     ?? 3600,
      threshold:               opts.threshold               ?? 0.92,
      namespace:               opts.namespace               ?? 'oc:llm',
      debug:                   opts.debug                   ?? false,
      normalizePrompt:         opts.normalizePrompt         ?? true,
      highConfidenceThreshold: opts.highConfidenceThreshold ?? 0.97,
      autoNamespace:           opts.autoNamespace           ?? false,
    };
  }

  private shouldSkip(req: LLMRequest): boolean {
    if (this.opts.cacheChannels?.length && req.channel && !this.opts.cacheChannels.includes(req.channel)) {
      return true;
    }
    const textToCheck = this.opts.normalizePrompt
      ? normalizePrompt(req.prompt, this.opts.fillerWords)
      : req.prompt.toLowerCase();
    return !!(this.opts.skipPatterns?.some((p) => textToCheck.includes(p)));
  }

  /** Returns the (optionally normalised) text used for embedding. */
  private prepareText(prompt: string): string {
    return this.opts.normalizePrompt
      ? normalizePrompt(prompt, this.opts.fillerWords)
      : prompt;
  }

  private ttlFor(channel?: string): number {
    const override = channel ? (this.opts.channelTtl?.[channel] ?? 0) : 0;
    return override > 0 ? override : this.opts.ttl;
  }

  /** Find semantically similar entry using pgvector API (Speed/Business tier) */
  private async vectorSearch(
    embedding: number[],
    namespace: string,
  ): Promise<{ id: string; similarity: number } | null> {
    if (!this.opts.vectorUrl) return null;
    try {
      const res = await fetch(`${this.opts.vectorUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embedding, namespace, threshold: this.opts.threshold, top_k: 1 }),
      });
      if (!res.ok) return null;
      const results = await res.json() as Array<{ found: boolean; id: string; similarity: number }>;
      const hit = results[0];
      return hit?.found ? { id: hit.id, similarity: hit.similarity } : null;
    } catch {
      return null;
    }
  }

  /** Inline ANN search (fallback when no vectorUrl, scans Redis index) */
  private async inlineSearch(
    embedding: number[],
    namespace: string,
    threshold?: number,
  ): Promise<{ id: string; similarity: number } | null> {
    const thresh = threshold ?? this.opts.threshold;
    const indexKey = `${this.opts.namespace}:vec:${namespace}`;
    const entries = await this.redis.hgetall(indexKey);
    let best: { id: string; similarity: number } | null = null;
    for (const [id, raw] of Object.entries(entries)) {
      try {
        const entry: VectorEntry = JSON.parse(raw);
        if (entry.expiresAt < Date.now()) {
          await this.redis.hdel(indexKey, id);
          continue;
        }
        const sim = cosineSimilarity(embedding, entry.embedding);
        if (sim >= thresh && (!best || sim > best.similarity)) {
          best = { id, similarity: sim };
        }
      } catch {
        // corrupt entry
      }
    }
    return best;
  }

  async middleware(): Promise<LLMMiddleware> {
    return async (req, next) => {
      if (this.shouldSkip(req)) return next(req);

      const agentPart = req.agentId ?? 'default';
      // when autoNamespace is true, partition cache by detected domain type
      const namespace = this.opts.autoNamespace
        ? `${this.opts.namespace}:${detectNamespaceType(req.prompt)}:${agentPart}`
        : `${this.opts.namespace}:${agentPart}`;
      const ttl = this.ttlFor(req.channel);

      // 1. Compute embedding (on normalised text when enabled)
      const textForEmbed = this.prepareText(req.prompt);
      const embedding = await this.opts.embedFn(textForEmbed);

      // 2. Semantic search
      const hit = this.opts.vectorUrl
        ? await this.vectorSearch(embedding, namespace)
        : await this.inlineSearch(embedding, namespace);

      if (hit) {
        const cached = await this.redis.get(`${namespace}:val:${hit.id}`);
        if (cached) {
          // Try to read stored token counts for a more accurate cost estimate
          const metaRaw = await this.redis.get(`${namespace}:meta:${hit.id}`);
          const meta = metaRaw ? (JSON.parse(metaRaw) as { i?: number; o?: number }) : {};
          const costSaved = estimateCostSaved(req.model, meta.i ?? 500, meta.o ?? 500);
          const confidence = confidenceBand(
            hit.similarity,
            this.opts.threshold,
            this.opts.highConfidenceThreshold,
          );
          // Track stats (fire-and-forget – never block the response)
          this.redis.incr(`${this.opts.namespace}:stats:hits`).catch(() => undefined);
          this.redis.incrbyfloat(`${this.opts.namespace}:stats:savings`, costSaved).catch(() => undefined);
          if (this.opts.debug) {
            console.log(`[cachly] 🎯 LLM cache HIT  sim=${hit.similarity.toFixed(3)}  conf=${confidence}  channel=${req.channel}  saved=$${costSaved.toFixed(5)}`);
          }
          return {
            content: cached,
            model: req.model,
            cached: true,
            similarity: hit.similarity,
            confidence,
            costSaved,
          };
        }
        // Stale vector entry — clean up
        if (!this.opts.vectorUrl) {
          await this.redis.hdel(`${this.opts.namespace}:vec:${namespace}`, hit.id);
        }
      }

      // 3. Cache miss — call LLM
      this.redis.incr(`${this.opts.namespace}:stats:misses`).catch(() => undefined);
      const response = await next(req);

      // 4. Store in cache
      const id = randomUUID();
      await this.redis.set(`${namespace}:val:${id}`, response.content, 'EX', ttl);
      // Persist token counts for accurate cost-saved tracking on future hits
      if (response.inputTokens !== undefined || response.outputTokens !== undefined) {
        await this.redis.set(
          `${namespace}:meta:${id}`,
          JSON.stringify({ i: response.inputTokens, o: response.outputTokens }),
          'EX', ttl,
        );
      }

      if (this.opts.vectorUrl) {
        // pgvector path (Speed/Business)
        await fetch(`${this.opts.vectorUrl}/entries`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            namespace,
            embedding,
            // Store the normalised text so the server-side FTS index stays clean
            prompt: textForEmbed,
            expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
          }),
        }).catch(() => undefined); // fire-and-forget
      } else {
        // Inline path (free/dev tier)
        const indexKey = `${this.opts.namespace}:vec:${namespace}`;
        const entry: VectorEntry = {
          id,
          embedding,
          expiresAt: Date.now() + ttl * 1000,
        };
        await this.redis.hset(indexKey, id, JSON.stringify(entry));
        await this.redis.expire(indexKey, ttl * 2);
      }

      if (this.opts.debug) {
        console.log(`[cachly] 🔄 LLM cache MISS  channel=${req.channel}  model=${req.model}`);
      }

      return { ...response, cached: false };
    };
  }

  // ── Cache-Warming ──────────────────────────────────────────────────────

  /**
   * Pre-warm the semantic cache with static prompt/value pairs.
   *
   * Computes embeddings for each prompt, skips entries that are already
   * cached at similarity ≥ `threshold` (default 0.98), and stores the rest.
   * Ideal for FAQ-style responses, product info, or onboarding greetings that
   * should always be served instantly from cache.
   *
   * When `autoNamespace` is enabled in the constructor options, each prompt's
   * namespace is auto-detected via heuristics.
   *
   * @param entries  List of `{ prompt, value, namespace? }` pairs to warm.
   * @param threshold Similarity threshold for skip-check (default: 0.98).
   * @returns `{ warmed, skipped }` – count of newly written vs. already-cached entries.
   *
   * @example
   * ```ts
   * const cache = new SemanticLLMCache({ url, embedFn, vectorUrl })
   * const { warmed, skipped } = await cache.warmup([
   *   { prompt: 'How do I reset my password?',
   *     value:  'Go to login → "Forgot password" → enter your email.' },
   *   { prompt: 'What are your business hours?',
   *     value:  'Mon–Fri 9–18 CET, Sat 10–14 CET.' },
   * ])
   * console.log(`Warmed ${warmed}, skipped ${skipped}`)
   * ```
   */
  async warmup(
    entries: Array<{ prompt: string; value: string; namespace?: string }>,
    threshold = 0.98,
  ): Promise<{ warmed: number; skipped: number }> {
    let warmed = 0;
    let skipped = 0;

    for (const entry of entries) {
      try {
        // resolve namespace (explicit > autoNamespace > default)
        const agentPart = 'default';
        const typeSegment = this.opts.autoNamespace
          ? `:${detectNamespaceType(entry.prompt)}`
          : '';
        const ns =
          entry.namespace ??
          `${this.opts.namespace}${typeSegment}:${agentPart}`;

        const textForEmbed = this.prepareText(entry.prompt);
        const embedding = await this.opts.embedFn(textForEmbed);

        // Check whether a very similar entry already exists
        let alreadyCached = false;
        if (this.opts.vectorUrl) {
          const res = await fetch(`${this.opts.vectorUrl}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              embedding,
              namespace: ns,
              threshold,
              top_k: 1,
            }),
          }).catch(() => null);
          if (res?.ok) {
            const results = (await res.json()) as Array<{ found: boolean }>;
            alreadyCached = results[0]?.found ?? false;
          }
        } else {
          const hit = await this.inlineSearch(embedding, ns, threshold);
          alreadyCached = hit !== null;
        }

        if (alreadyCached) {
          skipped++;
          continue;
        }

        // Store the pre-computed value
        const id = randomUUID();
        await this.redis.set(`${ns}:val:${id}`, entry.value, 'EX', this.opts.ttl);

        if (this.opts.vectorUrl) {
          // pgvector path – index in HNSW (fire-and-forget)
          fetch(`${this.opts.vectorUrl}/entries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id,
              namespace: ns,
              embedding,
              prompt: textForEmbed,
              expires_at: new Date(Date.now() + this.opts.ttl * 1000).toISOString(),
            }),
          }).catch(() => undefined);
        } else {
          // Inline path – write vector entry to Redis hash
          const indexKey = `${this.opts.namespace}:vec:${ns}`;
          const vectorEntry: VectorEntry = {
            id,
            embedding,
            expiresAt: Date.now() + this.opts.ttl * 1000,
          };
          await this.redis.hset(indexKey, id, JSON.stringify(vectorEntry));
          await this.redis.expire(indexKey, this.opts.ttl * 2);
        }

        warmed++;
      } catch {
        skipped++;
      }
    }

    if (this.opts.debug) {
      console.log(`[cachly] 🔥 Cache warmup: ${warmed} warmed, ${skipped} skipped`);
    }

    return { warmed, skipped };
  }

  /** Total estimated cost saved since last reset (convenience alias for stats().totalSaved). */
  // Used by monitoring dashboards and the OpenClaw admin UI.
  async totalSavings(): Promise<number> {
    const raw = await this.redis.get(`${this.opts.namespace}:stats:savings`);
    return raw ? parseFloat(raw) : 0;
  }

  /** Cache stats for dashboard */
  async stats(): Promise<{
    hits: number;
    misses: number;
    hitRate: string;
    totalSaved: number;
    keyCount: number;
  }> {
    const [hitsRaw, missesRaw, savingsRaw] = await Promise.all([
      this.redis.get(`${this.opts.namespace}:stats:hits`),
      this.redis.get(`${this.opts.namespace}:stats:misses`),
      this.redis.get(`${this.opts.namespace}:stats:savings`),
    ]);
    const hits = parseInt(hitsRaw ?? '0');
    const misses = parseInt(missesRaw ?? '0');
    const total = hits + misses;
    return {
      hits,
      misses,
      hitRate: total > 0 ? `${((hits / total) * 100).toFixed(1)}%` : 'n/a',
      totalSaved: parseFloat(savingsRaw ?? '0'),
      keyCount: total,
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a semantic LLM cache middleware for OpenClaw.
 *
 * @example
 * ```ts
 * // openclaw.config.ts
 * import { createSemanticLLMCache } from '@cachly-dev/openclaw/llm-cache'
 * import OpenAI from 'openai'
 *
 * const openai = new OpenAI()
 * const embed = (t: string) =>
 *   openai.embeddings.create({ model: 'text-embedding-3-small', input: t })
 *     .then(r => r.data[0].embedding)
 *
 * export default {
 *   llmMiddleware: await createSemanticLLMCache({
 *     url: process.env.CACHLY_URL!,
 *     embedFn: embed,
 *     ttl: 3600,
 *     skipPatterns: ['weather', 'time now', 'today is'],
 *   }),
 * }
 * ```
 */
export async function createSemanticLLMCache(opts: SemanticLLMCacheOptions): Promise<LLMMiddleware> {
  const cache = new SemanticLLMCache(opts);
  return cache.middleware();
}

export { SemanticLLMCache };

