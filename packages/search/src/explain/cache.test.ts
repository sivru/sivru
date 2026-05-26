import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createSymbolIndexCache,
  loadOrBuildSymbolIndex,
  SYMBOL_INDEX_CACHE_FORMAT_VERSION,
} from "./cache.js";
import type { SymbolIndexEntry } from "./types.js";

let cacheDir: string;
let repoDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "sivru-explain-cache-"));
  repoDir = await mkdtemp(join(tmpdir(), "sivru-explain-cache-repo-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(repoDir, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

const sample: SymbolIndexEntry = {
  filePath: "src/foo.ts",
  language: "typescript",
  exports: [
    {
      name: "foo",
      kind: "function",
      startLine: 1,
      endLine: 1,
      signature: "export function foo()",
    },
  ],
  imports: [],
  commitCount: 0,
  mtimeMs: 1,
};

describe("createSymbolIndexCache", () => {
  it("returns null on miss", async () => {
    const cache = createSymbolIndexCache({ cacheDir });
    const out = await cache.load({ repoPath: repoDir, stateId: "abc" });
    expect(out).toBeNull();
  });

  it("round-trips save → load", async () => {
    const cache = createSymbolIndexCache({ cacheDir });
    await cache.save({ repoPath: repoDir, stateId: "abc" }, [sample]);
    const out = await cache.load({ repoPath: repoDir, stateId: "abc" });
    expect(out).toEqual([sample]);
  });

  it("DESIGN-0019 §2/D3: round-trips an entry that carries blocks[]", async () => {
    const cache = createSymbolIndexCache({ cacheDir });
    const withBlocks: SymbolIndexEntry = {
      ...sample,
      blocks: [
        {
          startLine: 1,
          endLine: 5,
          contentHash: "abc123def456abcd",
          symbolName: "foo",
        },
        {
          startLine: 10,
          endLine: 15,
          contentHash: null,
          symbolName: "(module)",
        },
      ],
    };
    await cache.save({ repoPath: repoDir, stateId: "v3" }, [withBlocks]);
    const out = await cache.load({ repoPath: repoDir, stateId: "v3" });
    expect(out).toEqual([withBlocks]);
    expect(out?.[0]?.blocks).toHaveLength(2);
    expect(out?.[0]?.blocks?.[0]?.contentHash).toBe("abc123def456abcd");
    expect(out?.[0]?.blocks?.[1]?.contentHash).toBeNull();
  });

  it("evicts every entry for a repo", async () => {
    const cache = createSymbolIndexCache({ cacheDir });
    await cache.save({ repoPath: repoDir, stateId: "abc" }, [sample]);
    await cache.save({ repoPath: repoDir, stateId: "def" }, [sample]);
    await cache.evict(repoDir);
    expect(await cache.load({ repoPath: repoDir, stateId: "abc" })).toBeNull();
    expect(await cache.load({ repoPath: repoDir, stateId: "def" })).toBeNull();
  });

  it("rejects entries with a mismatched format version", async () => {
    const cache = createSymbolIndexCache({ cacheDir });
    await cache.save({ repoPath: repoDir, stateId: "abc" }, [sample]);
    const dirs = await readdir(cacheDir);
    const realPath = join(cacheDir, dirs[0]!, "abc.json");
    const parsed = JSON.parse(await readFile(realPath, "utf8"));
    parsed.formatVersion = SYMBOL_INDEX_CACHE_FORMAT_VERSION + 1;
    await writeFile(realPath, JSON.stringify(parsed));
    const out = await cache.load({ repoPath: repoDir, stateId: "abc" });
    expect(out).toBeNull();
  });

  it("returns null when JSON is corrupt", async () => {
    const cache = createSymbolIndexCache({ cacheDir });
    await cache.save({ repoPath: repoDir, stateId: "abc" }, [sample]);
    const dirs = await readdir(cacheDir);
    const realPath = join(cacheDir, dirs[0]!, "abc.json");
    await writeFile(realPath, "not-json");
    const out = await cache.load({ repoPath: repoDir, stateId: "abc" });
    expect(out).toBeNull();
  });
});

describe("loadOrBuildSymbolIndex", () => {
  it("builds and saves on first call, then serves from cache on the second", async () => {
    await write("src/a.ts", "export function alpha() { return 1; }\n");
    const cache = createSymbolIndexCache({ cacheDir });

    const first = await loadOrBuildSymbolIndex(repoDir, "state-1", {}, cache);
    expect(first.fromCache).toBe(false);
    expect(first.index.size()).toBe(1);
    expect(first.index.get("src/a.ts")!.exports.map((e) => e.name)).toContain(
      "alpha",
    );

    // Even if we change the file, the cached entry is what comes back —
    // stateId is the cache key, so callers signal "use the cached version"
    // by passing the same stateId.
    await write("src/a.ts", "export function alphaTwo() { return 2; }\n");
    const second = await loadOrBuildSymbolIndex(repoDir, "state-1", {}, cache);
    expect(second.fromCache).toBe(true);
    expect(second.index.get("src/a.ts")!.exports.map((e) => e.name)).toContain(
      "alpha",
    );
  });

  it("does not consult the cache when stateId is undefined", async () => {
    await write("src/a.ts", "export function alpha() { return 1; }\n");
    const cache = createSymbolIndexCache({ cacheDir });
    const out = await loadOrBuildSymbolIndex(repoDir, undefined, {}, cache);
    expect(out.fromCache).toBe(false);
    expect(out.index.stateId).toBe("unknown");
  });

  it("rebuilds when the cached stateId differs", async () => {
    await write("src/a.ts", "export function alpha() { return 1; }\n");
    const cache = createSymbolIndexCache({ cacheDir });
    await loadOrBuildSymbolIndex(repoDir, "state-1", {}, cache);
    await write("src/a.ts", "export function alphaTwo() { return 2; }\n");
    const second = await loadOrBuildSymbolIndex(repoDir, "state-2", {}, cache);
    expect(second.fromCache).toBe(false);
    expect(second.index.get("src/a.ts")!.exports.map((e) => e.name)).toContain(
      "alphaTwo",
    );
  });
});
