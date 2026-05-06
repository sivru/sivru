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
    const key: CacheKey = { repoPath, stateId: "abc123" };
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
    const key: CacheKey = { repoPath, stateId: "withvec" };
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
    const loaded = await cache.load({ repoPath, stateId: "nope" });
    expect(loaded).toBeNull();
  });

  it("returns null and deletes the file on corrupt JSON", async () => {
    const cache = createIndexCache({ cacheDir });
    const dir = join(cacheDir, repoSlug(repoPath));
    await mkdir(dir, { recursive: true });
    const target = join(dir, "corrupt.json");
    await writeFile(target, "{not valid json");

    const loaded = await cache.load({ repoPath, stateId: "corrupt" });
    expect(loaded).toBeNull();

    const remaining = await readdir(dir);
    expect(remaining).not.toContain("corrupt.json");
  });

  it("returns null on format_version mismatch", async () => {
    const cache = createIndexCache({ cacheDir });
    const dir = join(cacheDir, repoSlug(repoPath));
    await mkdir(dir, { recursive: true });
    const target = join(dir, "futureversion.json");
    await writeFile(
      target,
      JSON.stringify({
        formatVersion: 9999,
        chunks: [],
        createdAt: new Date().toISOString(),
      }),
    );

    const loaded = await cache.load({ repoPath, stateId: "futureversion" });
    expect(loaded).toBeNull();
  });

  it("handles two parallel save() calls for the same key without corrupting the file", async () => {
    const cache = createIndexCache({ cacheDir });
    const key: CacheKey = { repoPath, stateId: "parallel" };

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
    const key: CacheKey = { repoPath, stateId: "withtmp" };

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
    const key: CacheKey = { repoPath, stateId: "evictme" };

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
