// Chunker facade. Routes a file to the tree-sitter chunker when a bundled
// grammar exists for its language, and falls back to the line-window
// chunker for every other language — or when tree-sitter parsing fails.
//
// `chunkFile` is async: the tree-sitter path loads a grammar (memoised
// after first use). The fallback keeps the file fully indexed regardless,
// so a parse failure degrades chunk quality, never coverage.

import type { Chunk, ChunkOptions } from "../types.js";
import { detectLanguage } from "./language.js";
import { isChunkableLanguage } from "./grammars.js";
import { lineFallbackChunks } from "./lineFallback.js";
import { treeSitterChunks } from "./treeSitter.js";

/**
 * Produce chunks for one file.
 *
 * @param filePath - Repo-relative path. Used as the chunk's `filePath`
 *   and to detect language from the extension.
 * @param content - Full UTF-8 source text.
 * @param options - Line-window size / overlap (line-fallback path, and
 *   gap-fill / oversized-node splitting in the tree-sitter path).
 *
 * @sivru
 * schema: 1
 * role: file-chunker
 * responsibility: produce chunks for one file via the best available strategy
 * collaborators: [treeSitterChunks, lineFallbackChunks, detectLanguage]
 * invariants:
 *   - rule: "the file is always fully indexed; tree-sitter failure degrades chunk quality, never coverage"
 *     enforced-by: null
 * decisions:
 *   - chose: tree-sitter where a grammar exists; line-fallback everywhere else
 *     because: code-aware chunks beat fixed line windows for retrieval, but a parse failure must not silently drop a file
 *     valid-while: tree-sitter grammars stay the path of least resistance for language coverage
 *     revisit-if: a chunking model materially out-performs the tree-sitter route
 * maturity: stable
 * @end
 */
export async function chunkFile(
  filePath: string,
  content: string,
  options?: ChunkOptions,
): Promise<Chunk[]> {
  const language = detectLanguage(filePath);
  if (isChunkableLanguage(language)) {
    try {
      return await treeSitterChunks(filePath, content, language, options);
    } catch {
      // Grammar load or parse failure — fall back to line chunks. The file
      // is still fully indexed; only chunk boundaries are coarser.
      return lineFallbackChunks(filePath, content, language, options);
    }
  }
  return lineFallbackChunks(filePath, content, language, options);
}
