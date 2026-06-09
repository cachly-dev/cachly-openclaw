import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Redis mock supporting the subset the Brain bridge uses:
// get/set/mget/scan(MATCH/COUNT)/quit. A module-level store lets each test
// seed and inspect lessons directly.

const store = new Map<string, string>();

vi.mock("ioredis", () => {
  function match(pattern: string, key: string): boolean {
    // Only '*' wildcard is used by the bridge.
    const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(key);
  }
  function Redis() {
    return {
      get: (k: string) => Promise.resolve(store.has(k) ? store.get(k)! : null),
      set: (k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve("OK");
      },
      mget: (keys: string[]) =>
        Promise.resolve(keys.map((k) => (store.has(k) ? store.get(k)! : null))),
      scan: (_cursor: string, _m: string, pattern: string) => {
        const keys = [...store.keys()].filter((k) => match(pattern, k));
        return Promise.resolve(["0", keys]);
      },
      quit: () => Promise.resolve("OK"),
    };
  }
  return { Redis, default: Redis };
});

const { createCachlyBrain } = await import("../brain.js");

const URL = "redis://localhost:6379";

function seed(topic: string, payload: Record<string, unknown>): void {
  store.set(`cachly:lesson:best:${topic}`, JSON.stringify({ topic, ...payload }));
}

describe("CachlyBrain.recall", () => {
  beforeEach(() => store.clear());

  it("returns lessons ranked by keyword relevance", async () => {
    seed("deploy:fly-io", {
      outcome: "success",
      what_worked: "set min_machines_running to avoid cold-start 502s on fly",
      tags: ["deploy", "fly"],
    });
    seed("auth:jwt-refresh", {
      outcome: "failure",
      what_failed: "httpOnly cookie missing broke Safari refresh",
      tags: ["auth"],
    });

    const brain = createCachlyBrain({ url: URL });
    const results = await brain.recall("how do I deploy to fly.io");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].lesson.topic).toBe("deploy:fly-io");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("filters out lessons below the threshold", async () => {
    seed("auth:jwt-refresh", {
      outcome: "failure",
      what_failed: "cookie issue",
      tags: ["auth"],
    });
    const brain = createCachlyBrain({ url: URL });
    const results = await brain.recall("kubernetes pod scheduling", { threshold: 0.5 });
    expect(results).toHaveLength(0);
  });

  it("bumps recall_count on surfaced lessons", async () => {
    seed("deploy:fly-io", {
      outcome: "success",
      what_worked: "deploy fly tip",
      recall_count: 2,
    });
    const brain = createCachlyBrain({ url: URL });
    await brain.recall("deploy fly");
    const raw = JSON.parse(store.get("cachly:lesson:best:deploy:fly-io")!);
    expect(raw.recall_count).toBe(3);
  });

  it("respects topK", async () => {
    for (let i = 0; i < 8; i++) {
      seed(`cache:tip-${i}`, { outcome: "success", what_worked: `cache tip number ${i}` });
    }
    const brain = createCachlyBrain({ url: URL });
    const results = await brain.recall("cache tip", { topK: 3 });
    expect(results).toHaveLength(3);
  });

  it("ranks a proven lesson above an eroded one at equal keyword overlap", async () => {
    // Identical searchable text → identical keyword relevance. Confidence breaks
    // the tie: the discredited lesson (0.05) must sink below the proven one.
    seed("deploy:proven", {
      outcome: "success",
      what_worked: "redis cache warmup fixes cold start",
      tags: ["redis", "cache"],
      confidence: 0.97,
    });
    seed("deploy:eroded", {
      outcome: "success",
      what_worked: "redis cache warmup fixes cold start",
      tags: ["redis", "cache"],
      confidence: 0.05,
    });
    const brain = createCachlyBrain({ url: URL });
    const results = await brain.recall("redis cache warmup cold start");
    expect(results[0].lesson.topic).toBe("deploy:proven");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("boosts proven-ness via recall_count", async () => {
    seed("cache:fresh", {
      outcome: "success",
      what_worked: "valkey ttl tuning",
      tags: ["valkey"],
      confidence: 0.6,
      recall_count: 0,
    });
    seed("cache:battle-tested", {
      outcome: "success",
      what_worked: "valkey ttl tuning",
      tags: ["valkey"],
      confidence: 0.6,
      recall_count: 50,
    });
    const brain = createCachlyBrain({ url: URL });
    const results = await brain.recall("valkey ttl tuning");
    expect(results[0].lesson.topic).toBe("cache:battle-tested");
  });
});

describe("CachlyBrain.formatBriefing", () => {
  beforeEach(() => store.clear());

  it("frames failure lessons as anti-patterns to avoid", () => {
    const brain = createCachlyBrain({ url: URL });
    const briefing = brain.formatBriefing([
      { lesson: { topic: "auth:safari", outcome: "failure", whatFailed: "missing httpOnly broke refresh" }, score: 0.5 },
      { lesson: { topic: "deploy:fly", outcome: "success", whatWorked: "min_machines_running=1" }, score: 0.5 },
    ]);
    expect(briefing).toContain("AVOID — missing httpOnly broke refresh");
    expect(briefing).not.toContain("AVOID — min_machines_running=1");
    expect(briefing).toContain("avoid the ⚠️");
  });
});

describe("CachlyBrain.learn", () => {
  beforeEach(() => store.clear());

  it("stores a new lesson with default confidence", async () => {
    const brain = createCachlyBrain({ url: URL });
    const lesson = await brain.learn({
      topic: "deploy:fly-io",
      outcome: "success",
      whatWorked: "min_machines_running=1",
      severity: "major",
    });
    expect(lesson.confidence).toBe(0.6);
    expect(lesson.recallCount).toBe(0);
    const raw = JSON.parse(store.get("cachly:lesson:best:deploy:fly-io")!);
    expect(raw.what_worked).toBe("min_machines_running=1");
    expect(raw.outcome).toBe("success");
  });

  it("reinforces confidence on matching outcome", async () => {
    seed("deploy:fly-io", { outcome: "success", what_worked: "tip", confidence: 0.6, recall_count: 4 });
    const brain = createCachlyBrain({ url: URL });
    const lesson = await brain.learn({ topic: "deploy:fly-io", outcome: "success" });
    expect(lesson.confidence).toBeCloseTo(0.7, 5);
    expect(lesson.recallCount).toBe(4); // preserved
  });

  it("erodes confidence and overwrites guidance on flipped outcome", async () => {
    seed("deploy:fly-io", { outcome: "success", what_worked: "old tip", confidence: 0.6 });
    const brain = createCachlyBrain({ url: URL });
    const lesson = await brain.learn({
      topic: "deploy:fly-io",
      outcome: "failure",
      whatFailed: "that approach now 502s",
    });
    expect(lesson.confidence).toBeCloseTo(0.45, 5);
    expect(lesson.outcome).toBe("failure");
    expect(lesson.whatFailed).toBe("that approach now 502s");
  });

  it("caps confidence at 0.99", async () => {
    seed("x:y", { outcome: "success", confidence: 0.97 });
    const brain = createCachlyBrain({ url: URL });
    const lesson = await brain.learn({ topic: "x:y", outcome: "success" });
    expect(lesson.confidence).toBe(0.99);
  });
});

describe("CachlyBrain.briefingMiddleware", () => {
  beforeEach(() => store.clear());

  it("prepends a briefing block to the system prompt", async () => {
    seed("deploy:fly-io", {
      outcome: "success",
      what_worked: "set min_machines_running to avoid cold-start",
    });
    const brain = createCachlyBrain({ url: URL });
    const mw = brain.briefingMiddleware();

    let receivedSystem = "";
    await mw(
      { prompt: "deploy to fly", systemPrompt: "You are helpful." },
      async (req) => {
        receivedSystem = req.systemPrompt ?? "";
        return { content: "ok" };
      },
    );

    expect(receivedSystem).toContain("You are helpful.");
    expect(receivedSystem).toContain("Relevant lessons");
    expect(receivedSystem).toContain("deploy:fly-io");
  });

  it("passes through untouched when no lessons match", async () => {
    const brain = createCachlyBrain({ url: URL });
    const mw = brain.briefingMiddleware();
    let received: { systemPrompt?: string } = {};
    await mw({ prompt: "totally unrelated xyzzy", systemPrompt: "base" }, async (req) => {
      received = req;
      return { content: "ok" };
    });
    expect(received.systemPrompt).toBe("base");
  });
});

describe("CachlyBrain.size", () => {
  beforeEach(() => store.clear());

  it("counts stored lessons", async () => {
    seed("a:1", { outcome: "success" });
    seed("b:2", { outcome: "failure" });
    const brain = createCachlyBrain({ url: URL });
    expect(await brain.size()).toBe(2);
  });
});
