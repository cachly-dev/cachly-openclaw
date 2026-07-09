/**
 * Ambient Recall middleware for OpenClaw — push-based memory (Phase 4 parity).
 *
 * OpenClaw has no Claude-Code-style hooks, but it has an LLM middleware chain —
 * which is the same interception point: this middleware runs BEFORE every model
 * call, recalls relevant memories through the cachly relevance gate, and
 * prepends the gated hits to the system prompt. Memory that is just there,
 * without the agent having to remember to search it.
 *
 * Gate semantics are kept in sync with sdk/mcp/src/ambient-recall.ts in
 * cachly-dev/cachly (trivial-skip, similarity+importance floor, top-K, hard
 * per-turn token budget) — the economics only work with a sharp gate: an
 * irrelevant injection costs tokens on EVERY message (§6.2/§6.3 of the cachly
 * roadmap).
 *
 * Fail-safe by construction: any error (memory backend down, bad data) falls
 * through to `next(req)` unchanged — recall can never break a conversation.
 */

import type { LLMMiddleware, LLMRequest, LLMResponse } from './llm-cache.js';
import type { IMemoryStorage, MemorySearchResult } from './memory-adapter.js';

export interface AmbientRecallOptions {
  /** The memory storage to recall from (createCachlyMemoryAdapter result). */
  memory: IMemoryStorage;
  /** Agent to scope recall to; falls back to req.agentId, then 'default'. */
  agentId?: string;
  /** Minimum semantic similarity to the prompt. Default 0.72. */
  minScore?: number;
  /** Minimum stored importance [0,1]. Default 0.6. */
  minImportance?: number;
  /** Max memories injected per turn. Default 3. */
  topK?: number;
  /** Hard per-turn injection budget in estimated tokens. Default 240. */
  maxTokens?: number;
  debug?: boolean;
}

export interface AmbientRecallStats {
  turns: number;
  skippedTrivial: number;
  injections: number;
  injectedTokens: number;
}

export type AmbientRecallMiddleware = LLMMiddleware & { stats(): AmbientRecallStats };

/** Rough token estimate (~4 chars/token) — good enough for a per-turn budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

// Pure conversational openers with no engineering payload — kept in sync with
// the MCP gate so both surfaces skip the same turns.
const TRIVIAL_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|yep|nope|ty|lol|danke|hallo|servus)\b/i;
const CODEY_RE =
  /[/\\._{}()<>;=]|\b(fix|bug|error|deploy|migrat|test|build|refactor|auth|api|db|schema|race|crash|fail|revert|rollback|why|how|debug|config|hook|token|cache|remember|remind|book|plan|schedule)\b/i;

/**
 * A trivial prompt has ~zero expected wrong-path savings: too short to carry
 * risk, a pure greeting, or chit-chat with no task signal. Injecting there is
 * pure waste, so recall is skipped entirely.
 */
export function isTrivialPrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (p.length < 12) return true;
  if (TRIVIAL_RE.test(p) && p.length < 40) return true;
  if (!CODEY_RE.test(p) && p.length < 60) return true;
  return false;
}

/** The relevance gate: strongest candidates first, capped by K and budget. */
export function selectMemories(
  results: MemorySearchResult[],
  opts: { minScore: number; minImportance: number; topK: number; maxTokens: number },
): { selected: MemorySearchResult[]; tokens: number } {
  const passed = results
    .filter((r) => r.similarity >= opts.minScore && r.entry.importance >= opts.minImportance)
    .sort((a, b) => b.similarity - a.similarity || b.entry.importance - a.entry.importance);

  const selected: MemorySearchResult[] = [];
  let tokens = 0;
  for (const r of passed) {
    if (selected.length >= opts.topK) break;
    const t = estimateTokens(r.entry.content);
    if (tokens + t > opts.maxTokens) break; // hard per-turn cap — never overshoot
    selected.push(r);
    tokens += t;
  }
  return { selected, tokens };
}

/** Render gated memories as a compact system-prompt block. */
export function formatMemoryBlock(selected: MemorySearchResult[]): string {
  if (selected.length === 0) return '';
  const bullets = selected.map((r) => `- ${r.entry.content.trim()}`).join('\n');
  return `🧠 Relevant memory (auto-recalled):\n${bullets}`;
}

/**
 * Create the Ambient Recall middleware. Compose it BEFORE the semantic LLM
 * cache so cache keys include the injected context:
 *
 * ```ts
 * const ambient = createAmbientRecall({ memory });
 * const cache = await createSemanticLLMCache({ url });
 * const llm = (req) => ambient(req, (r) => cache(r, callModel));
 * ```
 */
export function createAmbientRecall(opts: AmbientRecallOptions): AmbientRecallMiddleware {
  const gate = {
    minScore: opts.minScore ?? 0.72,
    minImportance: opts.minImportance ?? 0.6,
    topK: opts.topK ?? 3,
    maxTokens: opts.maxTokens ?? 240,
  };
  const stats: AmbientRecallStats = { turns: 0, skippedTrivial: 0, injections: 0, injectedTokens: 0 };

  const mw: LLMMiddleware = async (req: LLMRequest, next): Promise<LLMResponse> => {
    stats.turns += 1;
    try {
      if (isTrivialPrompt(req.prompt)) {
        stats.skippedTrivial += 1;
        return next(req);
      }
      const agentId = opts.agentId ?? req.agentId ?? 'default';
      // Over-fetch a little so the gate has candidates to rank.
      const results = await opts.memory.search(req.prompt, agentId, {
        topK: gate.topK * 2,
        threshold: gate.minScore,
      });
      const { selected, tokens } = selectMemories(results ?? [], gate);
      if (selected.length === 0) return next(req);

      const block = formatMemoryBlock(selected);
      stats.injections += 1;
      stats.injectedTokens += estimateTokens(block);
      if (opts.debug) {
        console.log(`[cachly-ambient] injected ${selected.length} memories (~${tokens} tokens)`);
      }
      return next({
        ...req,
        systemPrompt: req.systemPrompt ? `${req.systemPrompt}\n\n${block}` : block,
      });
    } catch (err) {
      if (opts.debug) console.warn(`[cachly-ambient] recall failed, passing through: ${String(err)}`);
      return next(req); // fail-safe: never block the conversation
    }
  };

  return Object.assign(mw, { stats: () => ({ ...stats }) });
}
