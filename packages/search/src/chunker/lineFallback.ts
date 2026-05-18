// Fixed-window line-based chunker.
//
// Two roles (DESIGN-0001):
//   - `lineFallbackChunks` is the whole-file fallback when tree-sitter
//     parsing is unavailable, fails, or the language has no grammar.
//   - `windowLines` is the range-aware core. The tree-sitter chunker
//     reuses it to gap-fill the line ranges no AST node covers and to
//     split oversized nodes. One windowing implementation, not three.

import type { Chunk, ChunkOptions } from "../types.js";

const DEFAULT_MAX_LINES = 50;
const DEFAULT_OVERLAP_LINES = 5;

function assertWindowOpts(maxLines: number, overlap: number): void {
  if (maxLines <= 0) {
    throw new Error(`maxLines must be > 0 (got ${maxLines})`);
  }
  if (overlap < 0 || overlap >= maxLines) {
    throw new Error(
      `overlapLines must be in [0, ${maxLines}) (got ${overlap})`,
    );
  }
}

/**
 * Window an inclusive 1-based line range `[from, to]` of `lines` into
 * fixed-size overlapping chunks with `kind: "line"`.
 *
 * - `lines` is the whole file already split on `\n` (no trailing empty
 *   element). `from`/`to` are absolute 1-based line numbers; emitted
 *   `startLine`/`endLine` are absolute too.
 * - Returns `[]` when `from > to` (empty range).
 * - Window size and overlap are validated; overlap must be `< maxLines`.
 */
export function windowLines(
  lines: readonly string[],
  filePath: string,
  language: string | null,
  from: number,
  to: number,
  maxLines: number,
  overlap: number,
): Chunk[] {
  assertWindowOpts(maxLines, overlap);
  if (from > to) return [];

  const step = maxLines - overlap;
  const startIdx = from - 1; // 0-based, inclusive
  const endIdx = to; // 0-based, exclusive
  const chunks: Chunk[] = [];
  for (let start = startIdx; start < endIdx; start += step) {
    const end = Math.min(start + maxLines, endIdx);
    chunks.push({
      filePath,
      startLine: start + 1,
      endLine: end,
      language,
      content: lines.slice(start, end).join("\n"),
      kind: "line",
    });
    if (end === endIdx) break;
  }
  return chunks;
}

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
  // Validate before the empty-content short-circuit so bad options always
  // throw, regardless of input.
  assertWindowOpts(maxLines, overlap);

  if (content.length === 0) return [];

  const lines = content.split("\n");
  // A trailing newline produces an empty last element; drop it so the chunk
  // doesn't end on a phantom empty line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  // Files that are only newlines collapse to all-empty lines after pop —
  // treat them like empty content rather than emitting an empty chunk.
  if (lines.length === 0 || lines.every((l) => l === "")) return [];

  return windowLines(lines, filePath, language, 1, lines.length, maxLines, overlap);
}
