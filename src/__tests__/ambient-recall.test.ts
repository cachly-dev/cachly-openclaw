import { describe, it, expect } from 'vitest';
import {
  createAmbientRecall,
  isTrivialPrompt,
  selectMemories,
  formatMemoryBlock,
} from '../ambient-recall.js';
import type { IMemoryStorage, MemoryEntry, MemorySearchResult } from '../memory-adapter.js';
import type { LLMRequest, LLMResponse } from '../llm-cache.js';

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'm1',
  agentId: 'agent-1',
  content: 'User prefers trains over flights for trips under 5 hours.',
  type: 'preference',
  importance: 0.9,
  createdAt: 0,
  lastAccessedAt: 0,
  accessCount: 0,
  ...over,
});

const hit = (similarity = 0.9, over: Partial<MemoryEntry> = {}): MemorySearchResult => ({
  entry: entry(over),
  similarity,
});

function fakeMemory(results: MemorySearchResult[] | (() => never)): IMemoryStorage {
  return {
    store: async () => entry(),
    search: async () => {
      if (typeof results === 'function') results();
      return results as MemorySearchResult[];
    },
    get: async () => null,
    delete: async () => false,
    listByAgent: async () => [],
  } as unknown as IMemoryStorage;
}

const req = (prompt: string, over: Partial<LLMRequest> = {}): LLMRequest => ({
  prompt,
  model: 'claude-opus-4-8',
  agentId: 'agent-1',
  ...over,
});

const respond = (r: LLMRequest): Promise<LLMResponse> =>
  Promise.resolve({ content: 'ok', model: r.model });

describe('isTrivialPrompt', () => {
  it('skips greetings and short chit-chat, keeps task prompts', () => {
    expect(isTrivialPrompt('hi')).toBe(true);
    expect(isTrivialPrompt('thanks!')).toBe(true);
    expect(isTrivialPrompt('book me a train to Berlin next Friday morning')).toBe(false);
    expect(isTrivialPrompt('why does the deploy fail after the migration step?')).toBe(false);
  });
});

describe('selectMemories (gate)', () => {
  it('applies similarity + importance floors and ranks by similarity', () => {
    const { selected } = selectMemories(
      [hit(0.5), hit(0.95, { id: 'best' }), hit(0.8, { importance: 0.2 }), hit(0.75, { id: 'ok' })],
      { minScore: 0.72, minImportance: 0.6, topK: 3, maxTokens: 240 },
    );
    expect(selected.map((s) => s.entry.id)).toEqual(['best', 'ok']);
  });

  it('enforces topK and the hard token budget', () => {
    const long = 'x'.repeat(1200); // ~300 tokens — alone busts a 240 budget
    const many = [hit(0.99, { content: long }), hit(0.98), hit(0.97), hit(0.96), hit(0.95)];
    const { selected, tokens } = selectMemories(many, { minScore: 0.72, minImportance: 0.6, topK: 3, maxTokens: 240 });
    expect(selected.length).toBe(0); // budget hit on the very first (oversized) candidate
    expect(tokens).toBe(0);
    const { selected: sel2 } = selectMemories(many.slice(1), { minScore: 0.72, minImportance: 0.6, topK: 3, maxTokens: 240 });
    expect(sel2.length).toBeLessThanOrEqual(3);
  });
});

describe('createAmbientRecall middleware', () => {
  it('prepends gated memory to the system prompt', async () => {
    const mw = createAmbientRecall({ memory: fakeMemory([hit()]) });
    let seen: LLMRequest | undefined;
    await mw(req('plan my trip: berlin to munich, avoid flights if reasonable'), (r) => {
      seen = r;
      return respond(r);
    });
    expect(seen!.systemPrompt).toContain('Relevant memory');
    expect(seen!.systemPrompt).toContain('trains over flights');
    expect(mw.stats().injections).toBe(1);
  });

  it('appends to an existing system prompt instead of replacing it', async () => {
    const mw = createAmbientRecall({ memory: fakeMemory([hit()]) });
    let seen: LLMRequest | undefined;
    await mw(
      req('plan my trip: berlin to munich, avoid flights if reasonable', { systemPrompt: 'You are a travel assistant.' }),
      (r) => { seen = r; return respond(r); },
    );
    expect(seen!.systemPrompt!.startsWith('You are a travel assistant.')).toBe(true);
    expect(seen!.systemPrompt).toContain('Relevant memory');
  });

  it('skips trivial prompts without touching the memory backend', async () => {
    const mw = createAmbientRecall({
      memory: fakeMemory(() => { throw new Error('memory must not be called'); }),
    });
    let seen: LLMRequest | undefined;
    await mw(req('thanks!'), (r) => { seen = r; return respond(r); });
    expect(seen!.systemPrompt).toBeUndefined();
    expect(mw.stats().skippedTrivial).toBe(1);
  });

  it('passes through unchanged when nothing survives the gate', async () => {
    const mw = createAmbientRecall({ memory: fakeMemory([hit(0.3), hit(0.5, { importance: 0.1 })]) });
    let seen: LLMRequest | undefined;
    await mw(req('debug the failing session store integration test'), (r) => { seen = r; return respond(r); });
    expect(seen!.systemPrompt).toBeUndefined();
    expect(mw.stats().injections).toBe(0);
  });

  it('fails safe: a crashing memory backend never blocks the conversation', async () => {
    const mw = createAmbientRecall({
      memory: fakeMemory(() => { throw new Error('redis down'); }),
    });
    const res = await mw(req('book the hotel in munich for the conference dates'), respond);
    expect(res.content).toBe('ok');
  });
});

describe('formatMemoryBlock', () => {
  it('renders bullets and stays empty for no hits', () => {
    expect(formatMemoryBlock([])).toBe('');
    expect(formatMemoryBlock([hit()])).toContain('- User prefers trains');
  });
});
