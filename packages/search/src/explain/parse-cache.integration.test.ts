// In-session parse cache wiring test (DESIGN-0004 §5 #11 / T16).
//
// The parse cache from T2 is process-local and keyed by (absPath, mtimeMs).
// When the diff path or a refresh re-touches a file that hasn't changed,
// the cached parse hits — that's what keeps a 50-file diff fast.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildSymbolIndex } from "./symbol-index.js";
import { createParseCache } from "./parse-cache.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-explain-parsecache-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(root, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe("parse cache shared across symbol-index builds", () => {
  it("buildSymbolIndex populates the parse cache, second build serves from it", async () => {
    await write("src/a.ts", "export function alpha() { return 1; }\n");
    await write("src/b.ts", "export function beta() { return 1; }\n");
    const cache = createParseCache();
    await buildSymbolIndex(root, { parseCache: cache });
    const firstMisses = cache.misses();
    const firstSize = cache.size();
    expect(firstMisses).toBe(2);
    expect(firstSize).toBeGreaterThanOrEqual(2);

    // Re-build with the SAME cache — no new misses, all hits (mtimes match).
    await buildSymbolIndex(root, { parseCache: cache });
    expect(cache.misses()).toBe(firstMisses);
    expect(cache.hits()).toBeGreaterThanOrEqual(2);
  });

  it("an mtime bump invalidates the cached entry", async () => {
    await write("src/a.ts", "export function alpha() { return 1; }\n");
    const cache = createParseCache();
    await buildSymbolIndex(root, { parseCache: cache });
    const beforeMisses = cache.misses();

    // Rewrite (advances mtime) → cache key differs → miss.
    // Wait one ms to ensure mtimeMs advances on filesystems with coarse
    // resolution.
    await new Promise((r) => setTimeout(r, 10));
    await write("src/a.ts", "export function alphaTwo() { return 2; }\n");

    await buildSymbolIndex(root, { parseCache: cache });
    expect(cache.misses()).toBeGreaterThan(beforeMisses);
  });
});
