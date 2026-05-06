// Chunker dispatch. Today every file goes through the line-fallback path;
// the W1 follow-up wires `web-tree-sitter` for the 16 grammars listed in
// DESIGN.md §4.1, with this same facade selecting tree-sitter when a grammar
// is available and falling back to line-mode on parse error.

import type { Chunk, ChunkOptions } from "../types.js";
import { detectLanguage } from "./language.js";
import { lineFallbackChunks } from "./lineFallback.js";

/**
 * Produce chunks for one file. Pure function: does no I/O.
 *
 * @param filePath - Repo-relative path. Used both as the chunk's `filePath`
 *   and to detect language from extension.
 * @param content - Full UTF-8 source text.
 * @param options - Override the line-fallback window size / overlap.
 */
export function chunkFile(
  filePath: string,
  content: string,
  options?: ChunkOptions,
): Chunk[] {
  const language = detectLanguage(filePath);
  // TODO(W1 follow-up): when a tree-sitter grammar is loaded for `language`,
  // try `treeSitterChunks(...)` first and fall through to line-fallback only
  // on parse error. Until then, line-mode is the single implementation.
  return lineFallbackChunks(filePath, content, language, options);
}
