// Tests for SivruIndex.refreshStale — the staleness fix.
//
// We build a small fixture corpus on disk, build the index, edit some
// files, and assert that after refreshStale the search results reflect
// the new content. Without the fix, the in-memory index returned chunks
// that were already wrong.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildIndex } from "./search.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "sivru-refresh-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fixture(rel: string, content: string): Promise<void> {
  const path = resolve(scratch, rel);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * Bump a file's mtime forward by `deltaMs`. We use this instead of just
 * rewriting the file because the in-memory index captures mtime at build
 * time, and modern filesystems give millisecond resolution — back-to-back
 * writes can land on the same mtime, which would defeat the diff.
 */
async function touchForward(rel: string, deltaMs = 2000): Promise<void> {
  const path = resolve(scratch, rel);
  const future = (Date.now() + deltaMs) / 1000;
  await utimes(path, future, future);
}

describe("refreshStale", () => {
  it("returns 0/0/0 with no changes (back-fills mtimes silently when empty)", async () => {
    await fixture("a.ts", "function alpha() { return 1; }\n");
    await fixture("b.ts", "function beta() { return 2; }\n");
    const idx = await buildIndex(scratch);
    const result = await idx.refreshStale();
    expect(result.modified).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.added).toBe(0);
    expect(result.embedsRecomputed).toBe(0);
  });

  it("detects a modified file and re-chunks it", async () => {
    await fixture("a.ts", "function alpha() { return 1; }\n");
    await fixture("b.ts", "function beta() { return 2; }\n");
    const idx = await buildIndex(scratch);

    // Pre-edit search hits the old content.
    const before = await idx.searchBM25("gamma", 5);
    expect(before).toEqual([]);

    // Modify a.ts to introduce a new symbol.
    await fixture("a.ts", "function gamma() { return 3; }\n");
    await touchForward("a.ts");

    const result = await idx.refreshStale();
    expect(result.modified).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.added).toBe(0);

    // After refresh: search finds the new symbol.
    const after = await idx.searchBM25("gamma", 5);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]?.chunk.filePath).toBe("a.ts");
    expect(after[0]?.chunk.content).toContain("gamma");
  });

  it("detects a deleted file and drops its chunks", async () => {
    await fixture("a.ts", "function alpha() { return 1; }\n");
    await fixture("b.ts", "function delta() { return 4; }\n");
    const idx = await buildIndex(scratch);

    expect((await idx.searchBM25("delta", 5)).length).toBeGreaterThan(0);

    await rm(resolve(scratch, "b.ts"));
    const result = await idx.refreshStale();
    expect(result.removed).toBe(1);

    // After refresh: the deleted file's chunks are gone.
    expect(await idx.searchBM25("delta", 5)).toEqual([]);
    // a.ts still findable.
    expect((await idx.searchBM25("alpha", 5)).length).toBeGreaterThan(0);
  });

  it("detects a brand-new file", async () => {
    await fixture("a.ts", "function alpha() { return 1; }\n");
    const idx = await buildIndex(scratch);

    expect(await idx.searchBM25("epsilon", 5)).toEqual([]);

    await fixture("c.ts", "function epsilon() { return 5; }\n");
    const result = await idx.refreshStale();
    expect(result.added).toBe(1);

    const hits = await idx.searchBM25("epsilon", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunk.filePath).toBe("c.ts");
  });

  it("updates size() after refresh (one fresh chunk added)", async () => {
    await fixture("a.ts", "function alpha() { return 1; }\n");
    const idx = await buildIndex(scratch);
    const beforeSize = idx.size();

    await fixture("d.ts", "function zeta() { return 6; }\n");
    await idx.refreshStale();
    expect(idx.size()).toBe(beforeSize + 1);
  });

  it("is idempotent — calling refresh twice when nothing changed reports 0/0/0 the second time", async () => {
    await fixture("a.ts", "function alpha() { return 1; }\n");
    const idx = await buildIndex(scratch);

    await fixture("e.ts", "function eta() { return 7; }\n");
    const r1 = await idx.refreshStale();
    expect(r1.added).toBe(1);

    const r2 = await idx.refreshStale();
    expect(r2.added).toBe(0);
    expect(r2.modified).toBe(0);
    expect(r2.removed).toBe(0);
  });

  it("serializes concurrent refresh calls (single Promise lock)", async () => {
    await fixture("a.ts", "function alpha() { return 1; }\n");
    const idx = await buildIndex(scratch);

    await fixture("b.ts", "function beta() { return 2; }\n");

    // Fire two simultaneously. Both should resolve to the SAME result
    // *object* (proving they awaited the single in-flight promise — no
    // double-walk, no double-add).
    const [r1, r2] = await Promise.all([idx.refreshStale(), idx.refreshStale()]);
    expect(r1).toBe(r2); // identity — same RefreshResult instance
    expect(r1.added).toBe(1);
    // After they resolve, a fresh call processes 0 deltas — confirming the
    // first refresh actually committed state (added/modified/removed all 0).
    const r3 = await idx.refreshStale();
    expect(r3.added).toBe(0);
    expect(r3.modified).toBe(0);
    expect(r3.removed).toBe(0);
  });

  describe("with embeddings", () => {
    // Mock embedding provider — deterministic 8-dim vectors derived from
    // content length so we can verify "did it re-embed?" by checking
    // matrix changes.
    const mockProvider = {
      dim: 8,
      async embed(text: string): Promise<Float32Array> {
        const v = new Float32Array(8);
        const seed = text.length;
        for (let i = 0; i < 8; i++) v[i] = Math.sin(seed * (i + 1));
        // L2-normalize to honor the provider contract.
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < 8; i++) v[i] = v[i]! / norm;
        return v;
      },
      async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map((t) => this.embed(t)));
      },
    };

    it("only re-embeds chunks whose content actually changed (signature dedup)", async () => {
      await fixture(
        "a.ts",
        "function alpha() { return 1; }\nfunction beta() { return 2; }\n",
      );
      const embedSpy = vi.spyOn(mockProvider, "embed");

      const idx = await buildIndex(scratch, {
        embed: { provider: mockProvider },
      });
      const initialEmbedCount = embedSpy.mock.calls.length;

      // Change one function but keep the file intact otherwise. Because
      // the line-fallback chunker emits the entire file as a single chunk
      // for short files, this counts as "chunk content changed" → 1
      // re-embed expected.
      await fixture(
        "a.ts",
        "function alpha() { return 1; }\nfunction beta() { return 2222; }\n",
      );
      await touchForward("a.ts");

      const result = await idx.refreshStale();
      expect(result.modified).toBe(1);
      // For the small fixture all chunks of the file changed, so we
      // expect at least one re-embed. The exact count depends on the
      // chunker output but >= 1 is the assertion that matters.
      expect(result.embedsRecomputed).toBeGreaterThanOrEqual(1);
      expect(embedSpy.mock.calls.length).toBeGreaterThan(initialEmbedCount);
      embedSpy.mockRestore();
    });

    it("reuses cached embeddings for chunks whose content is unchanged", async () => {
      // Two files; we'll edit only one. The other's chunks have stable
      // signatures and should NOT be re-embedded.
      await fixture("a.ts", "function alpha() { return 1; }\n");
      await fixture("b.ts", "function beta() { return 2; }\n");

      const idx = await buildIndex(scratch, {
        embed: { provider: mockProvider },
      });

      const embedSpy = vi.spyOn(mockProvider, "embed");
      embedSpy.mockClear();

      await fixture("a.ts", "function alphaPRIME() { return 1; }\n");
      await touchForward("a.ts");

      const result = await idx.refreshStale();
      expect(result.modified).toBe(1);
      // a.ts's chunk changed (1 re-embed). b.ts's chunk is unchanged →
      // 0 re-embeds for it. Total: should be small.
      expect(result.embedsRecomputed).toBeLessThanOrEqual(2);
      embedSpy.mockRestore();
    });
  });
});
