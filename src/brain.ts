/**
 * @cachly-dev/openclaw – Brain Bridge
 *
 * The session store, LLM cache, and memory adapter are commodity infrastructure.
 * The Brain is what makes Cachly different: a persistent, compounding store of
 * *lessons* — "this fix worked", "that approach failed" — that the same instance
 * already collects from Claude Code, Cursor, Copilot, and the VS Code / IntelliJ
 * plugins.
 *
 * This bridge lets your OpenClaw agents read from and write to that *same* Brain.
 * Your assistant arrives pre-briefed with what every other tool on the instance
 * has already learned, and anything it discovers flows back so the next session —
 * in any tool — benefits. One Brain, every channel.
 *
 * It talks to the same Valkey/Redis your other Cachly adapters use, reading and
 * writing the canonical `cachly:lesson:best:<topic>` keys, so no extra service or
 * auth is required.
 *
 * Usage in openclaw.config.ts:
 *
 *   import { createCachlyBrain } from '@cachly-dev/openclaw/brain'
 *
 *   const brain = createCachlyBrain({ url: process.env.CACHLY_URL! })
 *
 *   // Pre-brief every LLM call with relevant lessons:
 *   export default {
 *     llmMiddleware: brain.briefingMiddleware(),
 *   }
 *
 *   // …or call it directly from a skill:
 *   const lessons = await brain.recall('deploy to fly.io')
 *   await brain.learn({
 *     topic: 'deploy:fly-io',
 *     outcome: 'success',
 *     whatWorked: 'set min_machines_running=1 to avoid cold-start 502s',
 *     severity: 'major',
 *   })
 */

import { Redis } from 'ioredis';

// ── Types (mirror the canonical cachly:lesson:best:<topic> schema) ────────────

export type LessonOutcome = 'success' | 'failure';
export type LessonSeverity = 'critical' | 'major' | 'minor';

export interface BrainLesson {
  topic: string;
  outcome: LessonOutcome;
  whatWorked?: string;
  whatFailed?: string;
  severity?: LessonSeverity;
  filePaths?: string[];
  commands?: string[];
  tags?: string[];
  recallCount?: number;
  confidence?: number;     // 0–1
  storedAt?: string;       // ISO timestamp
}

export interface BrainRecallResult {
  lesson: BrainLesson;
  score: number;           // keyword-overlap relevance, 0–1
}

export interface LearnInput {
  topic: string;
  outcome: LessonOutcome;
  whatWorked?: string;
  whatFailed?: string;
  severity?: LessonSeverity;
  filePaths?: string[];
  commands?: string[];
  tags?: string[];
}

export interface CachlyBrainOptions {
  /** Redis connection URL from the cachly.dev dashboard (redis://…) */
  url: string;
  /** Key prefix — must match the instance (default: 'cachly') */
  prefix?: string;
  /** Max lessons returned by recall (default: 5) */
  topK?: number;
  /** Minimum relevance score to include a lesson (0–1, default: 0.12) */
  threshold?: number;
  debug?: boolean;
}

// ── On-disk JSON shape (snake_case, matches the Go/MCP writers) ───────────────

interface LessonJSON {
  topic: string;
  outcome: LessonOutcome;
  what_worked?: string;
  what_failed?: string;
  severity?: LessonSeverity;
  file_paths?: string[];
  commands?: string[];
  tags?: string[];
  recall_count?: number;
  confidence?: number;
  ts?: string;
}

function toLesson(j: LessonJSON): BrainLesson {
  return {
    topic: j.topic,
    outcome: j.outcome,
    whatWorked: j.what_worked,
    whatFailed: j.what_failed,
    severity: j.severity,
    filePaths: j.file_paths,
    commands: j.commands,
    tags: j.tags,
    recallCount: j.recall_count,
    confidence: j.confidence,
    storedAt: j.ts,
  };
}

function toJSON(l: BrainLesson): LessonJSON {
  return {
    topic: l.topic,
    outcome: l.outcome,
    what_worked: l.whatWorked,
    what_failed: l.whatFailed,
    severity: l.severity,
    file_paths: l.filePaths,
    commands: l.commands,
    tags: l.tags,
    recall_count: l.recallCount,
    confidence: l.confidence,
    ts: l.storedAt,
  };
}

// ── Keyword relevance (cheap, embedding-free) ────────────────────────────────

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'it',
  'with', 'how', 'do', 'i', 'my', 'we', 'this', 'that', 'be', 'as', 'at',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ') // split on every non-alphanumeric (`:` `-` `_` `/` `.` …)
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Jaccard-ish overlap between query tokens and a lesson's searchable text. */
function relevance(queryTokens: string[], lesson: BrainLesson): number {
  if (queryTokens.length === 0) return 0;
  const hay = new Set(
    tokenize(
      [lesson.topic, lesson.whatWorked, lesson.whatFailed, (lesson.tags ?? []).join(' ')]
        .filter(Boolean)
        .join(' '),
    ),
  );
  if (hay.size === 0) return 0;
  let hits = 0;
  for (const t of queryTokens) if (hay.has(t)) hits++;
  return hits / queryTokens.length;
}

// ── Implementation ────────────────────────────────────────────────────────────

class CachlyBrain {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly topK: number;
  private readonly threshold: number;
  private readonly debug: boolean;

  constructor(opts: CachlyBrainOptions) {
    this.redis = new Redis(opts.url);
    this.prefix = opts.prefix ?? 'cachly';
    this.topK = opts.topK ?? 5;
    this.threshold = opts.threshold ?? 0.12;
    this.debug = opts.debug ?? false;
  }

  private bestKey(topic: string): string {
    return `${this.prefix}:lesson:best:${topic}`;
  }
  private pattern(): string {
    return `${this.prefix}:lesson:best:*`;
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.error('[cachly:brain]', ...args);
  }

  /** Scan every stored lesson (cursor-based, non-blocking). */
  private async scanAll(): Promise<BrainLesson[]> {
    const out: BrainLesson[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', this.pattern(), 'COUNT', 200);
      cursor = next;
      if (keys.length) {
        const raws = await this.redis.mget(keys);
        for (const raw of raws) {
          if (!raw) continue;
          try {
            out.push(toLesson(JSON.parse(raw) as LessonJSON));
          } catch {
            /* skip malformed */
          }
        }
      }
    } while (cursor !== '0');
    return out;
  }

  /**
   * Recall the most relevant lessons for a query and bump their recall_count
   * (so cross-tool recall telemetry stays accurate). Returns ranked matches.
   */
  async recall(
    query: string,
    opts?: { topK?: number; threshold?: number },
  ): Promise<BrainRecallResult[]> {
    const topK = opts?.topK ?? this.topK;
    const threshold = opts?.threshold ?? this.threshold;
    const qTokens = tokenize(query);

    const lessons = await this.scanAll();
    const scored: BrainRecallResult[] = [];
    for (const lesson of lessons) {
      const score = relevance(qTokens, lesson);
      if (score >= threshold) scored.push({ lesson, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);

    // Bump recall_count on the lessons we surfaced.
    await Promise.all(
      top.map(async ({ lesson }) => {
        const key = this.bestKey(lesson.topic);
        const raw = await this.redis.get(key);
        if (!raw) return;
        try {
          const j = JSON.parse(raw) as LessonJSON;
          j.recall_count = (j.recall_count ?? 0) + 1;
          await this.redis.set(key, JSON.stringify(j));
        } catch {
          /* leave as-is */
        }
      }),
    );

    this.log(`recall "${query}" → ${top.length}/${lessons.length} lessons`);
    return top;
  }

  /**
   * Store (or reinforce) a lesson under its topic. If a lesson for the topic
   * already exists, confidence is calibrated the same way the rest of Cachly
   * does it: matching outcome reinforces (+0.1, capped 0.99), a flipped outcome
   * erodes confidence (−0.15, floored 0.05) and overwrites the guidance.
   */
  async learn(input: LearnInput): Promise<BrainLesson> {
    const key = this.bestKey(input.topic);
    const now = new Date().toISOString();
    const existingRaw = await this.redis.get(key);

    let lesson: BrainLesson;
    if (existingRaw) {
      let prev: BrainLesson;
      try {
        prev = toLesson(JSON.parse(existingRaw) as LessonJSON);
      } catch {
        prev = { topic: input.topic, outcome: input.outcome };
      }
      const sameOutcome = prev.outcome === input.outcome;
      const prevConf = prev.confidence ?? 0.5;
      const confidence = sameOutcome
        ? Math.min(0.99, prevConf + 0.1)
        : Math.max(0.05, prevConf - 0.15);

      lesson = {
        ...prev,
        topic: input.topic,
        outcome: input.outcome,
        // On a flipped or fresh outcome, prefer the new guidance.
        whatWorked: input.whatWorked ?? (sameOutcome ? prev.whatWorked : undefined),
        whatFailed: input.whatFailed ?? (sameOutcome ? prev.whatFailed : undefined),
        severity: input.severity ?? prev.severity,
        filePaths: input.filePaths ?? prev.filePaths,
        commands: input.commands ?? prev.commands,
        tags: input.tags ?? prev.tags,
        confidence,
        recallCount: prev.recallCount ?? 0,
        storedAt: now,
      };
    } else {
      lesson = {
        topic: input.topic,
        outcome: input.outcome,
        whatWorked: input.whatWorked,
        whatFailed: input.whatFailed,
        severity: input.severity ?? 'minor',
        filePaths: input.filePaths,
        commands: input.commands,
        tags: input.tags,
        confidence: 0.6,
        recallCount: 0,
        storedAt: now,
      };
    }

    await this.redis.set(key, JSON.stringify(toJSON(lesson)));
    this.log(`learn "${input.topic}" (${input.outcome}) → conf ${lesson.confidence?.toFixed(2)}`);
    return lesson;
  }

  /** Render recalled lessons as a compact system-prompt briefing block. */
  formatBriefing(results: BrainRecallResult[]): string {
    if (results.length === 0) return '';
    const lines = results.map(({ lesson }) => {
      const mark = lesson.outcome === 'success' ? '✅' : '⚠️';
      const body = lesson.outcome === 'success' ? lesson.whatWorked : lesson.whatFailed;
      return `- ${mark} ${lesson.topic}: ${body ?? lesson.outcome}`;
    });
    return [
      'Relevant lessons your Brain has already learned (apply them, do not relearn):',
      ...lines,
    ].join('\n');
  }

  /**
   * LLM middleware that recalls relevant lessons for each prompt and prepends a
   * briefing block to the system prompt — so the assistant arrives pre-briefed.
   * Drop it into `llmMiddleware` (chain it before the semantic cache).
   */
  briefingMiddleware(opts?: { topK?: number; threshold?: number }) {
    return async (
      req: { prompt: string; systemPrompt?: string; [k: string]: unknown },
      next: (req: { prompt: string; systemPrompt?: string; [k: string]: unknown }) => Promise<unknown>,
    ) => {
      let briefing = '';
      try {
        const results = await this.recall(req.prompt, opts);
        briefing = this.formatBriefing(results);
      } catch (err) {
        this.log('briefing recall failed (continuing):', err);
      }
      if (!briefing) return next(req);
      const systemPrompt = req.systemPrompt ? `${req.systemPrompt}\n\n${briefing}` : briefing;
      return next({ ...req, systemPrompt });
    };
  }

  /** Total number of lessons stored on the instance. */
  async size(): Promise<number> {
    let count = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', this.pattern(), 'COUNT', 500);
      cursor = next;
      count += keys.length;
    } while (cursor !== '0');
    return count;
  }

  /** Close the underlying Redis connection. */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a Brain bridge so OpenClaw agents share the same compounding lesson
 * store as every other Cachly-connected tool on the instance.
 *
 * @example
 * ```ts
 * import { createCachlyBrain } from '@cachly-dev/openclaw/brain'
 * const brain = createCachlyBrain({ url: process.env.CACHLY_URL! })
 * export default { llmMiddleware: brain.briefingMiddleware() }
 * ```
 */
export function createCachlyBrain(opts: CachlyBrainOptions): CachlyBrain {
  return new CachlyBrain(opts);
}

export { CachlyBrain };
