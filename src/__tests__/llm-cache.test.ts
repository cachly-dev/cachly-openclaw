import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── detectNamespaceType ────────────────────────────────────────────────────

describe("detectNamespaceType", () => {
  describe("code detection", () => {
    it.each([
      ["python def", "def process(data): return data * 2"],
      ["js const", "const handler = () => res.send(200)"],
      ["ts class", "class UserService { constructor(private r: Repo) {} }"],
      ["import", 'import { useState } from "react"'],
      ["shebang", "#!/usr/bin/env python3"],
      ["go func", 'func main() { fmt.Println("hi") }'],
      ["cpp include", "#include <iostream>"],
      ["interface", "interface ICache { get(k: string): void }"],
      ["struct", "struct Config { host string }"],
      ["async def", "async def fetch(url: str) -> dict:"],
      ["lambda", "transform = lambda x: x * 2"],
      ["package", "package com.example.service;"],
    ])("code: %s", (_, prompt) => {
      expect(detectNamespaceType(prompt)).toBe("code");
    });
  });

  describe("translation detection", () => {
    it.each([
      ["translate", "translate this to Spanish"],
      ["übersetze", "übersetze diesen Text"],
      ["auf deutsch", "Schreib das auf deutsch"],
      ["in english", "write this in english"],
      ["ins deutsche", "bitte ins Deutsche"],
      ["traduce", "traduce este texto"],
      ["traduis", "traduis en anglais"],
      ["vertaal", "vertaal naar Nederlands"],
    ])("translation: %s", (_, prompt) => {
      expect(detectNamespaceType(prompt)).toBe("translation");
    });
  });

  describe("summary detection", () => {
    it.each([
      ["summarize", "summarize this article"],
      ["summarise", "summarise the key points"],
      ["tl;dr", "tl;dr of this post:"],
      ["tldr", "tldr please"],
      ["key points", "list the key points"],
      ["zusammenfass", "fasse zusammen worum es geht"],
      ["give me a brief", "give me a brief overview"],
      ["in a nutshell", "explain in a nutshell"],
    ])("summary: %s", (_, prompt) => {
      expect(detectNamespaceType(prompt)).toBe("summary");
    });
  });

  describe("qa detection", () => {
    it.each([
      ["what is", "what is Redis?"],
      ["how does", "how does HNSW indexing work?"],
      ["why is", "why is the sky blue?"],
      ["who invented", "who invented the web?"],
      ["can you", "can you explain JWT?"],
      ["is postgres", "is postgres ACID-compliant?"],
      ["wer ist", "wer ist der Bundeskanzler?"],
      ["wie funktioniert", "wie funktioniert pgvector?"],
      ["trailing ?", "Redis vs Memcached?"],
    ])("qa: %s", (_, prompt) => {
      expect(detectNamespaceType(prompt)).toBe("qa");
    });
  });

  describe("creative fallback", () => {
    it.each([
      ["poem", "Write a short poem about autumn"],
      ["story", "Tell me a story about dragons"],
      ["product copy", "Generate a product description for shoes"],
      ["general", "Help me brainstorm startup names"],
      ["empty", ""],
    ])("creative: %s", (_, prompt) => {
      expect(detectNamespaceType(prompt)).toBe("creative");
    });
  });

  describe("edge cases", () => {
    it("is case-insensitive", () => {
      expect(detectNamespaceType("CONST x = 1")).toBe("code");
      expect(detectNamespaceType("TRANSLATE THIS")).toBe("translation");
      expect(detectNamespaceType("SUMMARIZE THIS")).toBe("summary");
      expect(detectNamespaceType("WHAT IS x?")).toBe("qa");
    });

    it("trims whitespace before classifying", () => {
      expect(detectNamespaceType("   what is Redis?   ")).toBe("qa");
    });

    it("code takes priority over translation", () => {
      expect(
        detectNamespaceType("translate this function def foo(): pass"),
      ).toBe("code");
    });

    it("code takes priority over summary", () => {
      expect(detectNamespaceType("summarize this class MyService {}")).toBe(
        "code",
      );
    });
  });
});

// ── SemanticLLMCache.warmup ────────────────────────────────────────────────
//
// We mock ioredis so no actual Redis connection is required.
// Warmup tests use the vectorUrl path (consistent with pgvector API) which
// allows us to control search/index behaviour cleanly via fetch mocks.

vi.mock("ioredis", () => {
  // Use plain constructor (no vi.fn inside) to avoid ESM hoisting issues
  function Redis() {
    return {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve("OK"),
      hgetall: () => Promise.resolve({}),
      hset: () => Promise.resolve(1),
      expire: () => Promise.resolve(1),
      incr: () => Promise.resolve(1),
      incrbyfloat: () => Promise.resolve("1"),
      quit: () => Promise.resolve("OK"),
    };
  }
  return { Redis, default: Redis };
});

const { SemanticLLMCache, detectNamespaceType } = await import("../llm-cache.js");

const VECTOR_URL = "https://api.cachly.dev/v1/sem/test-token";

describe("SemanticLLMCache.warmup", () => {
  const embed = vi.fn((_text: string) =>
    Promise.resolve([1, 0, 0] as number[]),
  );
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    embed.mockClear();
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  /** Build a fetch mock that cycles through the given response payloads. */
  function mockFetch(...responsePayloads: unknown[]): ReturnType<typeof vi.fn> {
    let i = 0;
    const fn = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(responsePayloads[i++] ?? [{ found: false }]),
      }),
    );
    globalThis.fetch = fn as typeof fetch;
    return fn;
  }

  // ── warms new entries ──────────────────────────────────────────────────────

  it("warms all entries when cache is empty", async () => {
    // Per entry: 1× /search (→ not found) + 1× /entries POST (fire-and-forget)
    mockFetch(
      [{ found: false }],
      {}, // entry 1
      [{ found: false }],
      {}, // entry 2
    );

    const cache = new SemanticLLMCache({
      url: "redis://localhost:6379",
      vectorUrl: VECTOR_URL,
      embedFn: embed,
    });

    const result = await cache.warmup([
      { prompt: "What is Redis?", value: "Redis is an in-memory store." },
      { prompt: "What is caching?", value: "Caching stores repeated results." },
    ]);

    expect(result.warmed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("skips entries already cached at high similarity", async () => {
    mockFetch([{ found: true, id: "existing-uuid", similarity: 0.99 }]);

    const cache = new SemanticLLMCache({
      url: "redis://localhost:6379",
      vectorUrl: VECTOR_URL,
      embedFn: embed,
    });

    const result = await cache.warmup([
      { prompt: "What is Redis?", value: "Redis is an in-memory store." },
    ]);

    expect(result.warmed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("warms some and skips others in a mixed batch", async () => {
    mockFetch(
      [{ found: true, id: "cached", similarity: 0.99 }], // entry 1 → already cached
      [{ found: false }],
      {}, // entry 2 → warmed
    );

    const cache = new SemanticLLMCache({
      url: "redis://localhost:6379",
      vectorUrl: VECTOR_URL,
      embedFn: embed,
    });

    const result = await cache.warmup([
      { prompt: "What is Redis?", value: "answer 1" },
      { prompt: "What is caching?", value: "answer 2" },
    ]);

    expect(result.warmed).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("returns { warmed: 0, skipped: 0 } for empty entries array", async () => {
    const cache = new SemanticLLMCache({
      url: "redis://localhost:6379",
      vectorUrl: VECTOR_URL,
      embedFn: embed,
    });

    const result = await cache.warmup([]);
    expect(result).toEqual({ warmed: 0, skipped: 0 });
    expect(embed).not.toHaveBeenCalled();
  });

  it("counts as skipped when embedFn throws", async () => {
    const failEmbed = vi.fn(() => Promise.reject(new Error("rate limit")));
    const cache = new SemanticLLMCache({
      url: "redis://localhost:6379",
      vectorUrl: VECTOR_URL,
      embedFn: failEmbed,
    });

    const result = await cache.warmup([
      { prompt: "What is Redis?", value: "answer 1" },
      { prompt: "What is caching?", value: "answer 2" },
    ]);

    expect(result.warmed).toBe(0);
    expect(result.skipped).toBe(2);
  });

  // ── autoNamespace integration ──────────────────────────────────────────

  it("uses auto-detected namespace per prompt when autoNamespace=true", async () => {
    const capturedBodies: Record<string, unknown>[] = [];

    globalThis.fetch = vi
      .fn()
      .mockImplementation((_url: string, opts: RequestInit) => {
        try {
          capturedBodies.push(JSON.parse(opts.body as string));
        } catch {
          /* ignore */
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ found: false }]),
        });
      }) as typeof fetch;

    const cache = new SemanticLLMCache({
      url: "redis://localhost:6379",
      vectorUrl: VECTOR_URL,
      embedFn: embed,
      autoNamespace: true,
    });

    const result = await cache.warmup([
      { prompt: "def fibonacci(n): return n", value: "Python recursion." },
    ]);

    expect(result.warmed).toBe(1);

    // The /entries POST body must contain a namespace with ':code:' segment
    const indexBody = capturedBodies.find(
      (b) =>
        typeof b["namespace"] === "string" &&
        (b["namespace"] as string).includes(":code:"),
    );
    expect(
      indexBody,
      "Expected a request with a :code: namespace",
    ).toBeDefined();
  });

  it("auto-detects different namespaces for different prompt types", async () => {
    const capturedNamespaces: string[] = [];

    globalThis.fetch = vi
      .fn()
      .mockImplementation((_url: string, opts: RequestInit) => {
        try {
          const body = JSON.parse(opts.body as string);
          if (body["namespace"])
            capturedNamespaces.push(body["namespace"] as string);
        } catch {
          /* ignore */
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ found: false }]),
        });
      }) as typeof fetch;

    const cache = new SemanticLLMCache({
      url: "redis://localhost:6379",
      vectorUrl: VECTOR_URL,
      embedFn: embed,
      autoNamespace: true,
    });

    await cache.warmup([
      { prompt: "def sort(arr): return sorted(arr)", value: "Python sort." },
      { prompt: "translate this to French", value: "Traduction." },
      { prompt: "summarize this article", value: "Summary." },
      { prompt: "what is a hash map?", value: "A hash map is..." },
      { prompt: "write a haiku about redis", value: "Fast, persistent, ..." },
    ]);

    const nsSet = new Set(capturedNamespaces.map((n) => n.split(":")[2]));
    expect(nsSet).toContain("code");
    expect(nsSet).toContain("translation");
    expect(nsSet).toContain("summary");
    expect(nsSet).toContain("qa");
    expect(nsSet).toContain("creative");
  });

  // ── debug logging ──────────────────────────────────────────────────────────

  it("logs debug output when debug=true", async () => {
    mockFetch([{ found: false }], {});
    const consoleSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const cache = new SemanticLLMCache({
      url: "redis://localhost:6379",
      vectorUrl: VECTOR_URL,
      embedFn: embed,
      debug: true,
    });

    await cache.warmup([{ prompt: "What is Redis?", value: "answer" }]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("warmup"));
    consoleSpy.mockRestore();
  });
});
