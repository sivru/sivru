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

import { extractBlocksFromFiles } from "./extract.js";
import { hashBlockContent, MODULE_SYMBOL_NAME } from "./hash.js";
import type { BlockCacheEntry } from "../explain/types.js";

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
      contentHash: eb.block === null ? null : hashBlockContent(eb.block),
      symbolName: eb.symbolName ?? MODULE_SYMBOL_NAME,
    });
  }
  return out;
}
