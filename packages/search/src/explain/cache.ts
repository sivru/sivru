// On-disk cache for the symbol index (DESIGN-0004 §4 / T6).
//
// Mirrors the layout of `packages/search/src/cache/` but lives in a separate
// directory so the symbol-index format can evolve independently of the
// search-chunk cache. One file per `(repoPath, stateId)`:
//
//   <cacheDir>/<sha256(repoPath)>/<stateId>.json
//
// Atomic writes via tmp → fsync → rename, same recipe as the chunk cache.
// `formatVersion` is bumped whenever `SymbolIndexEntry` changes shape.

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import {
  bestEffortUnlink,
  isMissing,
  repoDir,
  repoSlug,
  sanitizeForFilename,
} from "../cache-utils.js";
import {
  buildSymbolIndex,
  type BuildSymbolIndexOptions,
} from "./symbol-index.js";
import {
  type SymbolIndex,
  type SymbolIndexEntry,
  SivruExplainError,
} from "./types.js";

/**
 * Bumped when `SymbolIndexEntry` changes shape on disk.
 *
 * - v1: initial format (filePath, language, exports, imports, commitCount, mtimeMs)
 */
export const SYMBOL_INDEX_CACHE_FORMAT_VERSION = 1;

export type SymbolIndexCacheKey = {
  /** Absolute path to the repo root; cache is keyed by sha256(repoPath). */
  repoPath: string;
  /** Output of `computeStateId(repoPath)`. */
  stateId: string;
};

export type SymbolIndexCacheOptions = {
  /** Default: ~/.cache/sivru/symbol-indexes/ */
  cacheDir?: string;
};

export type SymbolIndexCache = {
  readonly cacheDir: string;
  load(key: SymbolIndexCacheKey): Promise<readonly SymbolIndexEntry[] | null>;
  save(
    key: SymbolIndexCacheKey,
    entries: readonly SymbolIndexEntry[],
  ): Promise<void>;
  evict(repoPath: string): Promise<void>;
};

type DiskShape = {
  formatVersion: number;
  entries: SymbolIndexEntry[];
  createdAt: string;
};

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "sivru", "symbol-indexes");
}

function entryPath(cacheDir: string, key: SymbolIndexCacheKey): string {
  return join(repoDir(cacheDir, key.repoPath), `${sanitizeForFilename(key.stateId)}.json`);
}

function tmpPath(cacheDir: string, key: SymbolIndexCacheKey): string {
  return join(
    repoDir(cacheDir, key.repoPath),
    `${sanitizeForFilename(key.stateId)}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`,
  );
}

export function createSymbolIndexCache(
  options?: SymbolIndexCacheOptions,
): SymbolIndexCache {
  const cacheDir = options?.cacheDir ?? defaultCacheDir();

  async function load(
    key: SymbolIndexCacheKey,
  ): Promise<readonly SymbolIndexEntry[] | null> {
    const target = entryPath(cacheDir, key);
    let raw: string;
    try {
      raw = await fsp.readFile(target, "utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      return null;
    }
    let parsed: DiskShape;
    try {
      parsed = JSON.parse(raw) as DiskShape;
    } catch {
      await bestEffortUnlink(target);
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.formatVersion !== "number" ||
      !Array.isArray(parsed.entries)
    ) {
      await bestEffortUnlink(target);
      return null;
    }
    if (parsed.formatVersion !== SYMBOL_INDEX_CACHE_FORMAT_VERSION) {
      // Bump-driven rebuild; leave the old entry in place in case a different
      // build version still wants it.
      return null;
    }
    return parsed.entries;
  }

  async function save(
    key: SymbolIndexCacheKey,
    entries: readonly SymbolIndexEntry[],
  ): Promise<void> {
    const dir = repoDir(cacheDir, key.repoPath);
    await fsp.mkdir(dir, { recursive: true });
    const target = entryPath(cacheDir, key);
    const tmp = tmpPath(cacheDir, key);
    const disk: DiskShape = {
      formatVersion: SYMBOL_INDEX_CACHE_FORMAT_VERSION,
      entries: entries.slice(),
      createdAt: new Date().toISOString(),
    };
    const payload = JSON.stringify(disk);
    let handle: fsp.FileHandle | null = null;
    let renamed = false;
    try {
      handle = await fsp.open(tmp, "wx");
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(tmp, target);
      renamed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SivruExplainError(
        "SIVRU-E2005",
        `failed to save symbol index for ${key.repoPath}@${key.stateId}: ${message}`,
      );
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
      if (!renamed) {
        await bestEffortUnlink(tmp);
      }
    }
  }

  async function evict(repoPath: string): Promise<void> {
    const dir = repoDir(cacheDir, repoPath);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  return { cacheDir, load, save, evict };
}

/**
 * Try the on-disk cache first; on miss, build from scratch and write back.
 * `stateId` is the cache key — when omitted no cache is consulted (callers
 * that don't have a state id yet just want a fresh in-process index).
 *
 * Returns the resulting `SymbolIndex` plus a flag indicating whether the
 * build was served from cache.
 */
export async function loadOrBuildSymbolIndex(
  repoPath: string,
  stateId: string | undefined,
  opts: BuildSymbolIndexOptions = {},
  cache?: SymbolIndexCache,
): Promise<{ index: SymbolIndex; fromCache: boolean }> {
  const absRepo = resolvePath(repoPath);
  const c = cache ?? createSymbolIndexCache();
  if (stateId !== undefined) {
    const hit = await c.load({ repoPath: absRepo, stateId });
    if (hit !== null) {
      const byPath = new Map<string, SymbolIndexEntry>();
      for (const entry of hit) byPath.set(entry.filePath, entry);
      const cachedIndex = createSymbolIndexFromEntries(absRepo, stateId, byPath);
      return { index: cachedIndex, fromCache: true };
    }
  }
  const buildOpts: BuildSymbolIndexOptions = { ...opts };
  if (stateId !== undefined) buildOpts.stateId = stateId;
  const built = await buildSymbolIndex(absRepo, buildOpts);
  if (stateId !== undefined) {
    await c.save({ repoPath: absRepo, stateId }, built.entries());
  }
  return { index: built, fromCache: false };
}

/**
 * Build a `SymbolIndex` view over a pre-populated entry map. Used by
 * `loadOrBuildSymbolIndex` on cache-hit; exported for completeness so
 * downstream callers (T8 artifact assembly) can construct an index from
 * any source without re-running the walker.
 */
export function createSymbolIndexFromEntries(
  repoPath: string,
  stateId: string,
  byPath: Map<string, SymbolIndexEntry>,
): SymbolIndex {
  return {
    repoPath,
    stateId,
    size() {
      return byPath.size;
    },
    get(filePath) {
      return byPath.get(filePath);
    },
    entries() {
      return Array.from(byPath.values());
    },
  };
}
