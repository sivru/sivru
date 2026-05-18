// Integration tests for per-model chunk-windowing inside `buildIndex`
// (DESIGN-0002). A cold build with a budgeted embedder must re-window every
// chunk so neither BM25 nor the embedder ever indexes a truncated chunk; a
// windowless embedder must leave the chunk set exactly as v0.2 produced it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildIndex } from "./search.js";
import { createMockEmbeddingProvider } from "./embed/mock.js";
import type { Chunk } from "./types.js";

let scratch: string;
let cacheDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "sivru-window-"));
  cacheDir = await mkdtemp(join(tmpdir(), "sivru-window-cache-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

/** Additive test token counter: whitespace-delimited word count. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

async function fixture(rel: string, content: string): Promise<void> {
  const path = resolve(scratch, rel);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

/** A long, dense function — far more tokens than a small embedder budget. */
function denseSource(): string {
  const body = Array.from(
    { length: 60 },
    (_, i) => `  const value${String(i)} = alpha plus beta plus gamma;`,
  ).join("\n");
  return `function computeEverything() {\n${body}\n}\n`;
}

/** Read the single chunk set `buildIndex` persisted to the on-disk cache. */
async function readCachedChunks(): Promise<Chunk[]> {
  const slug = createHash("sha256").update(resolve(scratch)).digest("hex");
  const dir = join(cacheDir, slug);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  const raw = await readFile(join(dir, files[0] ?? ""), "utf8");
  return (JSON.parse(raw) as { chunks: Chunk[] }).chunks;
}

describe("buildIndex per-model chunk-windowing", () => {
  it("windows every chunk to the embedder's token budget", async () => {
    await fixture("dense.ts", denseSource());
    const budget = 40;
    const provider = createMockEmbeddingProvider({
      dim: 16,
      id: "mock-budgeted",
      contextTokens: budget,
      countTokens: wordCount,
    });

    await buildIndex(scratch, {
      embed: { provider },
      cache: { dir: cacheDir },
    });

    const chunks = await readCachedChunks();
    // The dense function alone exceeds the budget, so it must have split.
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(wordCount(chunk.content)).toBeLessThanOrEqual(budget);
    }
  });

  it("windows via the byte heuristic when the embedder has no countTokens", async () => {
    await fixture("dense.ts", denseSource());
    // contextTokens set, countTokens omitted -> heuristic fallback path.
    const provider = createMockEmbeddingProvider({
      dim: 16,
      id: "mock-heuristic",
      contextTokens: 64,
    });

    await buildIndex(scratch, {
      embed: { provider },
      cache: { dir: cacheDir },
    });

    const chunks = await readCachedChunks();
    expect(chunks.length).toBeGreaterThan(1);
    // The heuristic windows against 0.85 x 64; assert against the raw 64 so
    // a passing build is unambiguous regardless of the margin.
    for (const chunk of chunks) {
      expect(Math.ceil(Buffer.byteLength(chunk.content, "utf8") / 3.5)).toBeLessThanOrEqual(64);
    }
  });

  it("leaves the chunk set untouched for a windowless embedder", async () => {
    await fixture("dense.ts", denseSource());

    // BM25-only build — no embedder, no windowing.
    const bm25Index = await buildIndex(scratch);
    // Windowless embedder (no contextTokens) — windowing is skipped.
    const windowless = createMockEmbeddingProvider({ dim: 16, id: "mock-windowless" });
    const windowlessIndex = await buildIndex(scratch, {
      embed: { provider: windowless },
    });

    expect(windowlessIndex.size()).toBe(bm25Index.size());
  });
});
