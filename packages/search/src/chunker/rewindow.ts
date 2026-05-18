// Per-model chunk-windowing post-pass. DESIGN-0002.
//
// The tree-sitter / line chunkers (chunker/chunk.ts) are embedder-agnostic:
// they size chunks by lines. A short-context embedder (MiniLM, BGE) measures
// its input in TOKENS and silently truncates anything past its window — the
// stored embedding then represents only a prefix of the chunk. This post-pass
// re-splits any chunk whose token count exceeds the embedder's budget so no
// stored embedding is ever computed from a truncated chunk.
//
// `rewindowForBudget` is pure: chunk set + token budget + token counter in,
// new chunk set out. `chunkFile` / `treeSitterChunks` / `ChunkOptions` are
// untouched (DESIGN-0002 D2) — token-awareness lives only here.

import type { Chunk } from "../types.js";

/**
 * Leading overlap between adjacent windows, as a fraction of the budget
 * (DESIGN-0002 D8). A new window is seeded with the trailing whole lines of
 * the previous window whose token sum is closest to this fraction without
 * exceeding it. The overlap counts against the budget.
 */
const OVERLAP_FRACTION = 0.12;

/** Rough chars-per-token ratio used only to seed the char-split guess. */
const EST_CHARS_PER_TOKEN = 3.5;

/**
 * Byte-heuristic token count: `ceil(utf8Bytes / 3.5)`. The `countTokens`
 * fallback for an embedder that declares a `contextTokens` budget but no
 * real tokenizer-backed counter (DESIGN-0002 D1). Callers pair it with a
 * reduced budget (`0.85 × contextTokens`) to absorb the imprecision.
 */
export function byteHeuristicTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / EST_CHARS_PER_TOKEN);
}

/**
 * Re-window `chunks` so no emitted chunk exceeds `contextTokens` by
 * `countTokens`'s own measure.
 *
 * Each input chunk is passed through unchanged when it already fits;
 * otherwise it is split into token-budget-sized line windows (§3). Split
 * sub-chunks keep the original chunk's `kind`, `nodeType`, and `symbolName`
 * and full line coverage holds. Output is one chunk set — BM25 and embedding
 * both index it, so RRF id-alignment is preserved (§2, §5).
 *
 * Pure and embedder-agnostic at the type level: the caller supplies the
 * budget and counter. For a windowless embedder the caller simply does not
 * invoke this pass.
 */
export function rewindowForBudget(
  chunks: readonly Chunk[],
  contextTokens: number,
  countTokens: (text: string) => number,
): Chunk[] {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    throw new Error(
      `SIVRU-E1004: rewindowForBudget needs a positive token budget (got ${String(contextTokens)})`,
    );
  }
  const out: Chunk[] = [];
  for (const chunk of chunks) {
    if (countTokens(chunk.content) <= contextTokens) {
      out.push(chunk);
      continue;
    }
    for (const piece of splitChunk(chunk, contextTokens, countTokens)) {
      out.push(piece);
    }
  }
  return out;
}

/**
 * Split one over-budget chunk into token-greedy line windows. Walks the
 * chunk's lines keeping a running token sum; a new window starts when the
 * next whole line would push the sum past `budget`. A single line that
 * alone exceeds the budget is char-split as a last resort (D7).
 */
function splitChunk(
  chunk: Chunk,
  budget: number,
  countTokens: (text: string) => number,
): Chunk[] {
  // Chunk content carries no trailing newline (see chunker/lineFallback +
  // treeSitter), so `lines.length === endLine - startLine + 1`.
  const lines = chunk.content.split("\n");
  const lineTokens = lines.map((line) => countTokens(line));
  const overlapBudget = Math.floor(budget * OVERLAP_FRACTION);
  // Node identity is carried onto every sub-chunk, exactly as v0.2's
  // oversized-node line-split does.
  const extra = {
    ...(chunk.nodeType !== undefined ? { nodeType: chunk.nodeType } : {}),
    ...(chunk.symbolName !== undefined ? { symbolName: chunk.symbolName } : {}),
  };
  const out: Chunk[] = [];

  const emitWindow = (startIdx: number, endIdx: number): void => {
    out.push({
      filePath: chunk.filePath,
      startLine: chunk.startLine + startIdx,
      endLine: chunk.startLine + endIdx,
      language: chunk.language,
      content: lines.slice(startIdx, endIdx + 1).join("\n"),
      kind: chunk.kind,
      ...extra,
    });
  };

  // D7: a single line over budget cannot be line-split. As a last resort
  // THAT line only is char-split into budget-sized pieces; each sub-chunk
  // has `startLine === endLine` and a fragment for `content`.
  const emitOversizeLine = (idx: number): void => {
    const sourceLine = chunk.startLine + idx;
    for (const fragment of charSplit(lines[idx] ?? "", budget, countTokens)) {
      out.push({
        filePath: chunk.filePath,
        startLine: sourceLine,
        endLine: sourceLine,
        language: chunk.language,
        content: fragment,
        kind: chunk.kind,
        ...extra,
      });
    }
  };

  let i = 0;
  while (i < lines.length) {
    if ((lineTokens[i] ?? 0) > budget) {
      emitOversizeLine(i);
      i += 1;
      continue;
    }
    // Greedy: extend the window while the next whole line still fits.
    // Line `i` is known to fit, so the window always covers at least it.
    let sum = 0;
    let j = i;
    while (
      j < lines.length &&
      (lineTokens[j] ?? 0) <= budget &&
      sum + (lineTokens[j] ?? 0) <= budget
    ) {
      sum += lineTokens[j] ?? 0;
      j += 1;
    }
    const windowEnd = j - 1;
    emitWindow(i, windowEnd);
    if (windowEnd >= lines.length - 1) break;
    // Seed the next window with trailing lines summing to <= overlapBudget.
    // `nextWindowStart` always returns an index > i, so the loop advances.
    i = nextWindowStart(i, windowEnd, lineTokens, overlapBudget);
  }
  return out;
}

/**
 * Index at which the next window starts: the earliest line `> windowStart`
 * such that lines `[result, windowEnd]` sum to `<= overlapBudget`. Always
 * `> windowStart` (so the windower makes forward progress) and
 * `<= windowEnd + 1` (zero overlap when even the last line is too big).
 */
function nextWindowStart(
  windowStart: number,
  windowEnd: number,
  lineTokens: readonly number[],
  overlapBudget: number,
): number {
  let sum = 0;
  let start = windowEnd + 1;
  for (let idx = windowEnd; idx > windowStart; idx -= 1) {
    const t = lineTokens[idx] ?? 0;
    if (sum + t > overlapBudget) break;
    sum += t;
    start = idx;
  }
  return start;
}

/**
 * Split a single over-budget line on character boundaries into pieces each
 * within `budget`. Mid-line splitting is banned for all normal code; this
 * exists solely so the "no chunk exceeds budget" guarantee holds
 * unconditionally (D7). Terminates: every piece advances `pos` by at least
 * one character.
 */
function charSplit(
  line: string,
  budget: number,
  countTokens: (text: string) => number,
): string[] {
  if (line.length === 0) return [""];
  if (countTokens(line) <= budget) return [line];
  const pieces: string[] = [];
  let pos = 0;
  let guess = Math.max(1, Math.floor(budget * EST_CHARS_PER_TOKEN));
  while (pos < line.length) {
    let piece = line.slice(pos, Math.min(line.length, pos + guess));
    // Shrink until within budget — or down to a single char, which cannot
    // be split further (a one-char token over budget is not real code).
    while (piece.length > 1 && countTokens(piece) > budget) {
      piece = piece.slice(0, Math.max(1, Math.floor(piece.length / 2)));
    }
    pieces.push(piece);
    pos += piece.length;
    guess = Math.max(1, piece.length);
  }
  return pieces;
}
