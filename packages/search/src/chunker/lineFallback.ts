// Fixed-window line-based chunker.
//
// DESIGN.md §4.1 specifies 50-line windows with 5-line overlap as the
// fallback when tree-sitter parsing is unavailable or fails. This module is
// also the only chunker shipped in the W1 starter — tree-sitter integration
// lands behind the same `chunkFile()` facade in a follow-up.

import type { Chunk, ChunkOptions } from "../types.js";

const DEFAULT_MAX_LINES = 50;
const DEFAULT_OVERLAP_LINES = 5;

/**
 * Split `content` into overlapping fixed-size line windows.
 *
 * - 1-based inclusive `startLine`/`endLine` per chunk.
 * - Returns `[]` for empty content (no lines, nothing to index).
 * - Window size and overlap are configurable; overlap must be < window.
 */
export function lineFallbackChunks(
  filePath: string,
  content: string,
  language: string | null,
  options: ChunkOptions = {},
): Chunk[] {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const overlap = options.overlapLines ?? DEFAULT_OVERLAP_LINES;
  if (maxLines <= 0) {
    throw new Error(`maxLines must be > 0 (got ${maxLines})`);
  }
  if (overlap < 0 || overlap >= maxLines) {
    throw new Error(
      `overlapLines must be in [0, ${maxLines}) (got ${overlap})`,
    );
  }

  if (content.length === 0) return [];

  const lines = content.split("\n");
  // A trailing newline produces an empty last element; drop it so the chunk
  // doesn't end on a phantom empty line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  // Files that are only newlines collapse to all-empty lines after pop —
  // treat them like empty content rather than emitting an empty chunk.
  if (lines.length === 0 || lines.every((l) => l === "")) return [];

  const step = maxLines - overlap;
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + maxLines, lines.length);
    chunks.push({
      filePath,
      startLine: start + 1,
      endLine: end,
      language,
      content: lines.slice(start, end).join("\n"),
      kind: "line",
    });
    if (end === lines.length) break;
  }
  return chunks;
}
