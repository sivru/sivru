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

/** Divisor for the byte-heuristic token estimate: `ceil(utf8Bytes / N)`. */
const HEURISTIC_BYTES_PER_TOKEN = 3.5;

/** Rough chars-per-token ratio used only to seed the char-split length guess. */
const CHARSPLIT_CHARS_PER_TOKEN = 3.5;

/**
 * Byte-heuristic token count: `ceil(utf8Bytes / 3.5)`. The `countTokens`
 * fallback for an embedder that declares a `contextTokens` budget but no
 * real tokenizer-backed counter (DESIGN-0002 D1). Callers pair it with a
 * reduced budget (`0.85 × contextTokens`) to absorb the imprecision.
 */
export function byteHeuristicTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / HEURISTIC_BYTES_PER_TOKEN);
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
 *
 * @sivru
 * schema: 1
 * role: budget-rewindow
 * responsibility: split any chunk that overflows the embedder's token budget so no stored embedding is ever computed from a truncated chunk
 * collaborators: [buildIndex, chunkFile, byteHeuristicTokenCount]
 * invariants:
 *   - rule: "one shared chunk set: BM25 and embedding index the same ids so RRF alignment holds"
 *     enforced-by: null
 *   - rule: "full line coverage is preserved across splits"
 *     enforced-by: null
 * decisions:
 *   - chose: post-pass over the chunker output instead of teaching the chunker about tokens
 *     because: chunker stays embedder-agnostic; token-awareness lives in exactly one place
 *     valid-while: token budgets remain a property of the embedder, not the language
 *     revisit-if: a chunker variant needs token-aware splitting at its own layer
 * maturity: stable
 * @end
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

  const windowContent = (startIdx: number, endIdx: number): string =>
    lines.slice(startIdx, endIdx + 1).join("\n");

  const emitWindow = (startIdx: number, endIdx: number): void => {
    out.push({
      filePath: chunk.filePath,
      startLine: chunk.startLine + startIdx,
      endLine: chunk.startLine + endIdx,
      language: chunk.language,
      content: windowContent(startIdx, endIdx),
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
    let windowEnd = j - 1;
    // The greedy sum trusts token additivity across the newline join
    // (DESIGN-0002 D6). A BPE / SentencePiece tokenizer can break that —
    // a token spanning the join, or whitespace merging — so confirm the
    // assembled window against its real joined content and shrink until it
    // fits by `countTokens`'s own measure. `[i, i]` is always valid: line
    // `i` was checked `<= budget` above.
    while (windowEnd > i && countTokens(windowContent(i, windowEnd)) > budget) {
      windowEnd -= 1;
    }
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
 * unconditionally (D7).
 *
 * The piece-length `guess` adapts both ways: it halves on a budget
 * overshoot and doubles after a full-width piece fits with room to spare,
 * so a bad initial estimate (e.g. a low-entropy blob) does not strand the
 * rest of the line in tiny fragments. Terminates: every piece advances
 * `pos` by at least one character.
 */
function charSplit(
  line: string,
  budget: number,
  countTokens: (text: string) => number,
): string[] {
  if (line.length <= 1 || countTokens(line) <= budget) return [line];
  const pieces: string[] = [];
  let pos = 0;
  let guess = Math.max(1, Math.floor(budget * CHARSPLIT_CHARS_PER_TOKEN));
  while (pos < line.length) {
    let piece = line.slice(pos, Math.min(line.length, pos + guess));
    if (countTokens(piece) > budget) {
      // Overshoot — halve until within budget, or down to a single char
      // (a one-char token over budget is not real code).
      while (piece.length > 1 && countTokens(piece) > budget) {
        piece = piece.slice(0, Math.max(1, Math.floor(piece.length / 2)));
      }
      guess = Math.max(1, piece.length);
    } else if (piece.length === guess) {
      // A full-width piece fit with headroom — grow toward the budget.
      guess = guess * 2;
    }
    pieces.push(piece);
    pos += piece.length;
  }
  return pieces;
}
