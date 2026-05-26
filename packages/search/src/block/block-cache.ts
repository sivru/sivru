// Per-file @sivru block cache (DESIGN-0019 §2 / D3).
//
// `buildBlockCache(filePaths)` runs the block extractor once per file
// and returns a `Map<filePath, BlockCacheEntry[]>` that staleness and
// graph consumers can read from without re-parsing. The cache is
// keyed by ABSOLUTE filePath so callers can shape-shift across the
// symbol-index API or stand-alone.
//
// The cache deliberately stays in this module (not on `SymbolIndex`)
// because:
//   1. Block extraction reads the FILE BODY, not just chunks; it
//      doesn't share state with the symbol-index pipeline.
//   2. Slot 2 ships the cache structure but not the index-population
//      hook yet (`buildSymbolIndex` does not call this — opt-in only).
//      A separate cache lets adopters wire it where they want.

import { createHash } from "node:crypto";

import { extractBlocksFromFiles } from "./extract.js";
import type { BlockCacheEntry } from "../explain/types.js";

/**
 * Stable content hash for a block. JSON.stringify on the parsed
 * SivruBlock is deterministic for our shapes (no Maps, no Sets, no
 * cyclic refs) and survives whitespace-only edits — which is the
 * specific behavior staleness detection cares about (`body identical
 * vs surroundings changed`).
 */
function hashBlock(block: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(block))
    .digest("hex")
    .slice(0, 16);
}

export type BlockCache = ReadonlyMap<string, BlockCacheEntry[]>;

/**
 * Walk a file list with the block extractor and produce the cache map.
 * Files with no blocks land in the map with an empty array — distinct
 * from "not visited" (the file simply isn't a key).
 */
export async function buildBlockCache(
  filePaths: readonly string[],
): Promise<BlockCache> {
  const blocks = await extractBlocksFromFiles(filePaths);
  const out = new Map<string, BlockCacheEntry[]>();
  for (const f of filePaths) out.set(f, []);
  for (const eb of blocks) {
    const arr = out.get(eb.filePath);
    if (arr === undefined) continue;
    arr.push({
      startLine: eb.range.startLine,
      endLine: eb.range.endLine,
      contentHash: eb.block === null ? null : hashBlock(eb.block),
      symbolName: eb.symbolName ?? "(module)",
    });
  }
  return out;
}
