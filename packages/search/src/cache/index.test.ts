import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CACHE_FORMAT_VERSION,
  createIndexCache,
  type CacheKey,
} from "./index.js";
import type { Chunk } from "../types.js";

let cacheDir: string;
let repoPath: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "sivru-cache-"));
  // The cache only hashes `repoPath`; it never reads from it. Use a fixed
  // pseudo-path so tests don't have to spin up a real source tree.
  repoPath = "/sivru-test-repo/example";
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function repoSlug(p: string): string {
  return createHash("sha256").update(resolve(p)).digest("hex");
}

// Mirror of `sanitizeForFilename` (not exported) so tests that drop a
// literal file on disk can name it the way the cache expects to find it.
function sanitize(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, "__");
}

/** On-disk entry filename for (stateId, embedderId) — see `entryStem`. */
function entryFile(stateId: string, embedderId: string): string {
  return `${sanitize(stateId)}__${sanitize(embedderId)}.json`;
}

/** A cache key. `embedderId` defaults to `"bm25"` (BM25-only build). */
function keyOf(stateId: string, embedderId = "bm25"): CacheKey {
  return { repoPath, stateId, embedderId };
}

function makeChunks(): Chunk[] {
  return [
    {
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 10,
      language: "typescript",
      content: "const x = 1;\n",
      kind: "tree-sitter",
    },
    {
      filePath: "src/b.ts",
      startLine: 11,
      endLine: 20,
      language: "typescript",
      content: "const y = 2;\n",
      kind: "line",
    },
  ];
}

describe("createIndexCache", () => {
  it("round-trips chunks through save -> load", async () => {
    const cache = createIndexCache({ cacheDir });
    const key = keyOf("abc123");
    const chunks = makeChunks();

    await cache.save(key, { chunks });
    const loaded = await cache.load(key);

    expect(loaded).not.toBeNull();
    expect(loaded?.formatVersion).toBe(CACHE_FORMAT_VERSION);
    expect(loaded?.chunks).toEqual(chunks);
    expect(loaded?.embeddings).toBeUndefined();
    expect(typeof loaded?.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(loaded?.createdAt ?? ""))).toBe(false);
  });

  it("round-trips embeddings: same dim and Float32 values within 1e-7", async () => {
    const cache = createIndexCache({ cacheDir });
    const key = keyOf("withvec");
    const dim = 4;
    const original = new Float32Array([
      0.1, -0.2, 0.3, 0.4,
      1e-6, -1.5, 2.25, -3.125,
    ]);

    await cache.save(key, {
      chunks: makeChunks(),
      embeddings: { dim, data: original },
    });

    const loaded = await cache.load(key);
    expect(loaded?.embeddings).toBeDefined();
    expect(loaded?.embeddings?.dim).toBe(dim);
    expect(loaded?.embeddings?.data).toBeInstanceOf(Float32Array);
    expect(loaded?.embeddings?.data.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      const got = loaded?.embeddings?.data[i] ?? Number.NaN;
      const want = original[i] ?? Number.NaN;
      expect(Math.abs(got - want)).toBeLessThan(1e-7);
    }
  });

  it("returns null on a missing key", async () => {
    const cache = createIndexCache({ cacheDir });
    const loaded = await cache.load(keyOf("nope"));
    expect(loaded).toBeNull();
  });

  it("returns null and deletes the file on corrupt JSON", async () => {
    const cache = createIndexCache({ cacheDir });
    const dir = join(cacheDir, repoSlug(repoPath));
    await mkdir(dir, { recursive: true });
    const fileName = entryFile("corrupt", "bm25");
    await writeFile(join(dir, fileName), "{not valid json");

    const loaded = await cache.load(keyOf("corrupt"));
    expect(loaded).toBeNull();

    const remaining = await readdir(dir);
    expect(remaining).not.toContain(fileName);
  });

  it("returns null on format_version mismatch", async () => {
    const cache = createIndexCache({ cacheDir });
    const dir = join(cacheDir, repoSlug(repoPath));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, entryFile("futureversion", "bm25")),
      JSON.stringify({
        formatVersion: 9999,
        chunks: [],
        createdAt: new Date().toISOString(),
      }),
    );

    const loaded = await cache.load(keyOf("futureversion"));
    expect(loaded).toBeNull();
  });

  it("rejects a formatVersion: 2 (pre-windowing) cache after the v3 bump", async () => {
    // DESIGN-0002: per-model chunk-windowing makes chunk boundaries depend
    // on the embedder's token budget, so a v2 (pre-windowing) index must
    // never be reused. CACHE_FORMAT_VERSION moved 2 -> 3 to force a
    // one-time cold rebuild on upgrade.
    expect(CACHE_FORMAT_VERSION).toBe(3);
    const cache = createIndexCache({ cacheDir });
    const dir = join(cacheDir, repoSlug(repoPath));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, entryFile("v2cache", "bm25")),
      JSON.stringify({
        formatVersion: 2,
        chunks: makeChunks(),
        createdAt: new Date().toISOString(),
      }),
    );

    const loaded = await cache.load(keyOf("v2cache"));
    expect(loaded).toBeNull();
  });

  it("keys entries by embedderId: two embedders, same state, distinct entries", async () => {
    // DESIGN-0002 §4: chunk boundaries depend on the embedder, so the same
    // corpus state under two embedders must produce two distinct cache
    // entries that never collide.
    const cache = createIndexCache({ cacheDir });
    const stateId = "shared-state";
    const minilmKey = keyOf(stateId, "Xenova/all-MiniLM-L6-v2");
    const potionKey = keyOf(stateId, "minishlab/potion-retrieval-32M");

    const minilmChunks: Chunk[] = [
      {
        filePath: "m.ts",
        startLine: 1,
        endLine: 1,
        language: "typescript",
        content: "minilm-windowed\n",
        kind: "line",
      },
    ];
    const potionChunks: Chunk[] = [
      {
        filePath: "p.ts",
        startLine: 1,
        endLine: 1,
        language: "typescript",
        content: "potion-windowed\n",
        kind: "line",
      },
    ];

    await cache.save(minilmKey, { chunks: minilmChunks });
    await cache.save(potionKey, { chunks: potionChunks });

    const loadedMinilm = await cache.load(minilmKey);
    const loadedPotion = await cache.load(potionKey);

    expect(loadedMinilm?.chunks).toEqual(minilmChunks);
    expect(loadedPotion?.chunks).toEqual(potionChunks);

    // Two separate files on disk — neither embedder overwrote the other.
    const dir = join(cacheDir, repoSlug(repoPath));
    const files = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(2);
  });

  it("handles two parallel save() calls for the same key without corrupting the file", async () => {
    const cache = createIndexCache({ cacheDir });
    const key = keyOf("parallel");

    const a: Chunk[] = [
      {
        filePath: "a.ts",
        startLine: 1,
        endLine: 1,
        language: "typescript",
        content: "a\n",
        kind: "line",
      },
    ];
    const b: Chunk[] = [
      {
        filePath: "b.ts",
        startLine: 1,
        endLine: 1,
        language: "typescript",
        content: "b\n",
        kind: "line",
      },
    ];

    await Promise.all([
      cache.save(key, { chunks: a }),
      cache.save(key, { chunks: b }),
    ]);

    const loaded = await cache.load(key);
    expect(loaded).not.toBeNull();
    // Whichever rename hit last wins; we just need a valid one of the two.
    expect([a, b]).toContainEqual(loaded?.chunks);

    // No leftover tmp files in the dir.
    const dir = join(cacheDir, repoSlug(repoPath));
    const remaining = await readdir(dir);
    expect(remaining.some((n) => n.includes(".tmp."))).toBe(false);
  });

  it("ignores `*.tmp.*` files when loading", async () => {
    const cache = createIndexCache({ cacheDir });
    const key = keyOf("withtmp");

    // Drop a sibling tmp file in the per-repo dir; it must not influence load.
    const dir = join(cacheDir, repoSlug(repoPath));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "withtmp.tmp.99999"), "garbage");

    // No real entry yet -> miss.
    expect(await cache.load(key)).toBeNull();

    // Save the real entry; load must still succeed and return it.
    await cache.save(key, { chunks: makeChunks() });
    const loaded = await cache.load(key);
    expect(loaded?.chunks).toEqual(makeChunks());
  });

  it("evict(repoPath) removes the per-repo subdir; load returns null", async () => {
    const cache = createIndexCache({ cacheDir });
    const key = keyOf("evictme");

    await cache.save(key, { chunks: makeChunks() });
    expect(await cache.load(key)).not.toBeNull();

    await cache.evict(repoPath);
    expect(await cache.load(key)).toBeNull();

    // The per-repo subdir should be gone.
    const dir = join(cacheDir, repoSlug(repoPath));
    await expect(readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes the configured cacheDir", () => {
    const cache = createIndexCache({ cacheDir });
    expect(cache.cacheDir).toBe(cacheDir);
  });
});
