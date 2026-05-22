// In-session parse cache (DESIGN-0004 §5 #11 / T16).
//
// Keyed by `(absPath, mtimeMs)`. Process-scoped, in-memory only — no disk
// footprint, dies with the process. Used by --diff to avoid re-parsing the
// same file twice within one CLI/MCP invocation when a 50-file diff
// references the same module repeatedly. The mtime in the key means a
// concurrent edit during the same process invalidates cleanly.

import type { Chunk } from "../types.js";

export type ParseCacheKey = `${string}@${number}`;

export interface ParseCache {
  get(absPath: string, mtimeMs: number): readonly Chunk[] | undefined;
  set(absPath: string, mtimeMs: number, chunks: readonly Chunk[]): void;
  size(): number;
  /** Number of cache hits since creation. Test hook. */
  hits(): number;
  /** Number of cache misses since creation. Test hook. */
  misses(): number;
}

/**
 * @sivru
 * schema: 1
 * role: explain-parse-cache
 * responsibility: avoid re-parsing the same file twice within one explain --diff invocation
 * collaborators: [assembleArtifact, buildSymbolIndex]
 * invariants:
 *   - keyed by (absPath, mtimeMs); a concurrent edit invalidates cleanly because the mtime changes
 *   - process-scoped; nothing is persisted to disk
 * decisions:
 *   - chose: bounded in-memory LRU rather than an on-disk cache
 *     because: the cache is only useful within one invocation; persistence buys nothing and adds invalidation surface
 *     valid-while: a single invocation does not parse more files than the LRU bound
 *     revisit-if: a multi-process explain workflow needs to share parse work
 * maturity: stable
 * @end
 */
export function createParseCache(maxEntries = 256): ParseCache {
  const order: ParseCacheKey[] = [];
  const data = new Map<ParseCacheKey, readonly Chunk[]>();
  let hits = 0;
  let misses = 0;

  function makeKey(absPath: string, mtimeMs: number): ParseCacheKey {
    return `${absPath}@${mtimeMs}` as ParseCacheKey;
  }

  return {
    get(absPath, mtimeMs) {
      const key = makeKey(absPath, mtimeMs);
      const v = data.get(key);
      if (v === undefined) {
        misses++;
        return undefined;
      }
      hits++;
      // Promote on hit so LRU eviction works.
      const idx = order.indexOf(key);
      if (idx >= 0) {
        order.splice(idx, 1);
        order.push(key);
      }
      return v;
    },
    set(absPath, mtimeMs, chunks) {
      const key = makeKey(absPath, mtimeMs);
      if (data.has(key)) {
        const idx = order.indexOf(key);
        if (idx >= 0) order.splice(idx, 1);
      }
      data.set(key, chunks);
      order.push(key);
      while (order.length > maxEntries) {
        const evicted = order.shift();
        if (evicted !== undefined) data.delete(evicted);
      }
    },
    size() {
      return data.size;
    },
    hits() {
      return hits;
    },
    misses() {
      return misses;
    },
  };
}
