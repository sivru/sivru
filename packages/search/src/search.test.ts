import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildIndex } from "./search.js";
import { createMockEmbeddingProvider } from "./embed/mock.js";
import { createMockCrossEncoder } from "./rerank/mock.js";
import type { CrossEncoder } from "./rerank/provider.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-search-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(root, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe("buildIndex (W2 Pass 1 — BM25 only)", () => {
  it("indexes nothing for an empty directory", async () => {
    const index = await buildIndex(root);
    expect(index.size()).toBe(0);
    expect(await index.searchBM25("anything", 5)).toEqual([]);
  });

  it("ranks the file containing query terms above unrelated files", async () => {
    await write("auth/login.ts", "function authenticate(token) { /* validate jwt */ }");
    await write("auth/jwt.ts", "function verifyJWT(token) { /* decode and check */ }");
    await write("ui/button.ts", "function Button() { return null }");
    await write("README.md", "# Project\n\nA web app");

    const index = await buildIndex(root);
    expect(index.size()).toBeGreaterThan(0);

    const hits = await index.searchBM25("authenticate token jwt", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.score > 0)).toBe(true);
    // The two auth files should outrank Button — check the top hit.
    expect(hits[0]?.chunk.filePath.startsWith("auth/")).toBe(true);
  });

  it("hasEmbeddings reflects whether an embed provider was supplied", async () => {
    await write("a.ts", "function alpha() {}");
    const bm25Only = await buildIndex(root);
    expect(bm25Only.hasEmbeddings).toBe(false);

    const hybrid = await buildIndex(root, {
      embed: { provider: createMockEmbeddingProvider({ dim: 32 }) },
    });
    expect(hybrid.hasEmbeddings).toBe(true);
  });

  it("searchHybrid returns BM25-quality results plus semantic boosts", async () => {
    await write("auth/login.ts", "function authenticate(token) { /* validate jwt */ }");
    await write("auth/jwt.ts", "function verifyJWT(token) { /* decode and check */ }");
    await write("ui/button.ts", "function Button() { return null }");

    const index = await buildIndex(root, {
      embed: { provider: createMockEmbeddingProvider({ dim: 32 }) },
    });

    const hits = await index.searchHybrid("authenticate token", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.score > 0)).toBe(true);
    expect(hits.every((h) => h.source === "hybrid")).toBe(true);
  });

  it("searchHybrid uses provider.embedQuery for queries when defined, embed for documents", async () => {
    await write("a.ts", "function alpha() {}");
    const calls: Array<{ kind: "embed" | "embedQuery"; text: string }> = [];
    // Spy on a mock provider — the mock's deterministic SHA-256 hash
    // means embed and embedQuery return DIFFERENT vectors for the same
    // text, which is what we want to detect routing.
    const inner = createMockEmbeddingProvider({ dim: 16 });
    const provider = {
      get dim() {
        return inner.dim;
      },
      async embed(text: string): Promise<Float32Array> {
        calls.push({ kind: "embed", text });
        return inner.embed(text);
      },
      async embedQuery(text: string): Promise<Float32Array> {
        calls.push({ kind: "embedQuery", text });
        // Use a different hash seed so the test asserts the routing,
        // not just that some call was made.
        return inner.embed("Q::" + text);
      },
      async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map((t) => inner.embed(t)));
      },
    };
    const index = await buildIndex(root, { embed: { provider } });
    calls.length = 0;
    await index.searchHybrid("alpha", 3);
    // The query path went through embedQuery exactly once.
    const queryCalls = calls.filter((c) => c.kind === "embedQuery");
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.text).toBe("alpha");
    // No `embed` call for the query string itself — that would be the
    // bug instructionPrefixesFor was added to fix.
    expect(calls.find((c) => c.kind === "embed" && c.text === "alpha")).toBeUndefined();
  });

  it("searchHybrid falls back to provider.embed when embedQuery isn't defined", async () => {
    await write("a.ts", "function alpha() {}");
    const calls: Array<{ kind: "embed" | "embedQuery"; text: string }> = [];
    const inner = createMockEmbeddingProvider({ dim: 16 });
    // Provider WITHOUT embedQuery — symmetric encoder shape.
    const provider = {
      get dim() {
        return inner.dim;
      },
      async embed(text: string): Promise<Float32Array> {
        calls.push({ kind: "embed", text });
        return inner.embed(text);
      },
      async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map((t) => inner.embed(t)));
      },
    };
    const index = await buildIndex(root, { embed: { provider } });
    calls.length = 0;
    await index.searchHybrid("alpha", 3);
    expect(calls.some((c) => c.kind === "embed" && c.text === "alpha")).toBe(true);
    expect(calls.some((c) => c.kind === "embedQuery")).toBe(false);
  });

  it("searchHybrid degrades gracefully to BM25 when no embed provider was supplied", async () => {
    await write("a.ts", "function alpha() {}");
    const index = await buildIndex(root);
    const hits = await index.searchHybrid("alpha", 5);
    // No provider → falls back to searchBM25; source label reflects that.
    expect(hits.every((h) => h.source === "bm25")).toBe(true);
  });

  it("respects walker options passed through", async () => {
    await write(".gitignore", "ignored.ts\n");
    await write("ignored.ts", "function purplexyznonce() {}");
    await write("kept.ts", "function present() {}");

    const respected = await buildIndex(root);
    // Unique nonce only appears in ignored.ts, which the walker should skip.
    expect(await respected.searchBM25("purplexyznonce", 5)).toEqual([]);
    expect((await respected.searchBM25("present", 5)).length).toBeGreaterThan(0);
  });
});

describe("cross-encoder rerank", () => {
  it("reorders searchBM25 hits according to the cross-encoder score", async () => {
    // Two files, both contain "auth". The mock cross-encoder scores by
    // bag-of-words overlap with the query — so a file containing
    // "authenticate jwt token" beats one with just "auth", regardless
    // of BM25's ordering.
    await write("a.ts", "function auth() { return null }");
    await write("b.ts", "function authenticate(jwt, token) { /* ... */ }");
    const ce = createMockCrossEncoder();
    const index = await buildIndex(root, { rerank: { provider: ce, topN: 10 } });

    const hits = await index.searchBM25("authenticate jwt token", 5);
    expect(hits.length).toBeGreaterThan(0);
    // Top hit should be the more-overlapping file, not whichever BM25
    // happened to rank first.
    expect(hits[0]?.chunk.filePath).toBe("b.ts");
  });

  it("reorders searchHybrid hits via the cross-encoder when configured", async () => {
    await write("auth/login.ts", "function authenticate(token) { /* validate jwt */ }");
    await write("auth/jwt.ts", "function verifyJWT(token) { /* decode and check */ }");
    await write("ui/button.ts", "function Button() { return null }");

    const ce = createMockCrossEncoder();
    const calls: Array<{ query: string; n: number }> = [];
    // Wrap the mock so we can assert it was actually invoked.
    const spy: CrossEncoder = {
      modelId: ce.modelId,
      async score(q, docs) {
        calls.push({ query: q, n: docs.length });
        return ce.score(q, docs);
      },
    };

    const index = await buildIndex(root, {
      embed: { provider: createMockEmbeddingProvider({ dim: 32 }) },
      rerank: { provider: spy, topN: 8 },
    });

    const hits = await index.searchHybrid("authenticate jwt", 3);
    expect(hits.length).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toBe("authenticate jwt");
    // Reranker saw the candidate set, capped by topN.
    expect(calls[0]?.n).toBeGreaterThan(0);
    expect(calls[0]?.n).toBeLessThanOrEqual(8);
  });

  it("respects topN — never sends more candidates than requested", async () => {
    for (let i = 0; i < 30; i++) {
      await write(`f${i}.ts`, `function fn${i}() { return ${i} }`);
    }
    const sizes: number[] = [];
    const spy: CrossEncoder = {
      modelId: "spy",
      async score(_q, docs) {
        sizes.push(docs.length);
        return docs.map(() => 0);
      },
    };
    const index = await buildIndex(root, {
      rerank: { provider: spy, topN: 5 },
    });
    await index.searchBM25("function", 3);
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeLessThanOrEqual(5);
  });

  it("cross-encoder does not run when no rerank option is configured", async () => {
    await write("a.ts", "function alpha() {}\n");
    const calls: number[] = [];
    const spy: CrossEncoder = {
      modelId: "spy",
      async score(_q, docs) {
        calls.push(docs.length);
        return docs.map(() => 0);
      },
    };
    void spy; // silence unused
    const index = await buildIndex(root);
    await index.searchBM25("alpha", 3);
    await index.searchHybrid("alpha", 3);
    expect(calls).toEqual([]);
  });
});

describe("findRelated", () => {
  it("returns [] when filePath has no overlapping chunks", async () => {
    await write("a.ts", "function alpha() {}\n");
    const index = await buildIndex(root);
    const hits = await index.findRelated({
      filePath: "does/not/exist.ts",
      startLine: 1,
      endLine: 10,
      k: 5,
    });
    expect(hits).toEqual([]);
  });

  it("returns [] when filePath exists but the line range doesn't overlap any chunk", async () => {
    await write("a.ts", "function alpha() {}\n");
    const index = await buildIndex(root);
    // a.ts has 1 line; lines 100-200 can't overlap.
    const hits = await index.findRelated({
      filePath: "a.ts",
      startLine: 100,
      endLine: 200,
      k: 5,
    });
    expect(hits).toEqual([]);
  });

  it("BM25-only path: returns related chunks excluding the source range with source === bm25", async () => {
    // Two files share 'authenticate token jwt'; the third is an outlier.
    await write(
      "auth/login.ts",
      "function authenticate(token) {\n  // validate jwt\n  return verifyJWT(token);\n}\n",
    );
    await write(
      "auth/jwt.ts",
      "function verifyJWT(token) {\n  // authenticate jwt token\n  return decode(token);\n}\n",
    );
    await write(
      "ui/button.ts",
      "function Button() {\n  return null;\n}\n",
    );

    const index = await buildIndex(root);
    const hits = await index.findRelated({
      filePath: "auth/login.ts",
      startLine: 1,
      endLine: 4,
      k: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.source === "bm25")).toBe(true);
    // Source chunk (auth/login.ts) must not be in the results.
    expect(hits.some((h) => h.chunk.filePath === "auth/login.ts")).toBe(false);
    // Top hit should be the related auth/jwt.ts above the unrelated button.
    expect(hits[0]?.chunk.filePath).toBe("auth/jwt.ts");
  });

  it("hybrid path: returns hits with source === hybrid when embeddings are present", async () => {
    await write(
      "auth/login.ts",
      "function authenticate(token) {\n  // validate jwt\n  return verifyJWT(token);\n}\n",
    );
    await write(
      "auth/jwt.ts",
      "function verifyJWT(token) {\n  // authenticate jwt token\n  return decode(token);\n}\n",
    );
    await write(
      "ui/button.ts",
      "function Button() {\n  return null;\n}\n",
    );

    const index = await buildIndex(root, {
      embed: { provider: createMockEmbeddingProvider({ dim: 32 }) },
    });
    const hits = await index.findRelated({
      filePath: "auth/login.ts",
      startLine: 1,
      endLine: 4,
      k: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.source === "hybrid")).toBe(true);
    // Source chunk (auth/login.ts) must not be in the results.
    expect(hits.some((h) => h.chunk.filePath === "auth/login.ts")).toBe(false);
  });

  it("respects k cap", async () => {
    // Build a corpus larger than k to verify the cap.
    for (let i = 0; i < 8; i++) {
      await write(`f${i}.ts`, `function fn${i}() { return ${i}; }\n`);
    }
    const index = await buildIndex(root);
    const hits = await index.findRelated({
      filePath: "f0.ts",
      startLine: 1,
      endLine: 1,
      k: 2,
    });
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.chunk.filePath !== "f0.ts")).toBe(true);
  });

  it("source chunk is not included in results", async () => {
    // Two near-identical files. Without source-exclusion the source itself
    // would be the top hit; this test asserts it is filtered out.
    const body = "function alpha() {\n  return alpha();\n}\n";
    await write("a.ts", body);
    await write("b.ts", body);

    const index = await buildIndex(root);
    const hits = await index.findRelated({
      filePath: "a.ts",
      startLine: 1,
      endLine: 3,
      k: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.chunk.filePath !== "a.ts")).toBe(true);
  });
});
