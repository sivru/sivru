// Standard reranking signals for sivru. DESIGN.md §4 / W3.
//
// Each signal is independently togglable. Inputs: a ranked hit list (e.g. from
// RRF or BM25), the chunk array those ids index into, and the original query
// string. Output: re-sorted hits with adjusted scores. The adjusted numbers are
// not probabilities — they're a relative ordering signal stack.

import type { Chunk } from "../types.js";
import { tokenize } from "../bm25/tokenizer.js";
import type { RankedHit } from "./rrf.js";

export type SignalConfig = {
  /** Default: true. Boost chunks containing definition keywords when the query looks symbol-like. */
  definitionBoost?: boolean;
  /** Default: true. Files contributing multiple chunks to the result get an additional boost on each contributing chunk. */
  multiChunkFileBoost?: boolean;
  /** Default: true. Penalize matches under test/legacy/compat/examples paths and on `*.d.ts` files. */
  pathPenalty?: boolean;
  /** Default: true. Match query token stems against chunk identifier stems. */
  identifierStemMatching?: boolean;
};

const DEFINITION_KEYWORDS = ["def ", "class ", "function ", "func ", "fn ", "type "] as const;

const TEST_PATH_PATTERNS = [
  "/test/",
  "/tests/",
  "/__tests__/",
  "_test.",
  ".test.",
  ".spec.",
] as const;
const LEGACY_PATH_PATTERNS = ["/legacy/", "/compat/", "/deprecated/"] as const;
const EXAMPLE_PATH_PATTERNS = ["/examples/", "/samples/", "/demo/", "/demos/"] as const;

const TEST_PENALTY = 0.5;
const LEGACY_PENALTY = 0.6;
const EXAMPLE_PENALTY = 0.7;
const DTS_PENALTY = 0.6;

const DEFINITION_BOOST = 1.25;

const MULTI_CHUNK_PER_EXTRA = 0.05;
const MULTI_CHUNK_CAP = 1.25;

const STEM_PER_MATCH = 0.03;
const STEM_CAP = 1.3;

/**
 * Returns true when the query looks like an identifier / symbol — used to gate
 * the definition boost.
 *
 * Rule: query has no spaces, OR has fewer than 3 word tokens AND at least one
 * token contains an underscore, hyphen, or camelCase boundary.
 */
export function isSymbolLikeQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return false;

  // No whitespace at all → identifier-shaped.
  if (!/\s/.test(trimmed)) return true;

  const wordTokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (wordTokens.length >= 3) return false;

  for (const tok of wordTokens) {
    if (hasIdentifierBoundary(tok)) return true;
  }
  return false;
}

function hasIdentifierBoundary(token: string): boolean {
  if (token.includes("_")) return true;
  if (token.includes("-")) return true;
  // camelCase / PascalCase boundary: a lower→upper or digit→upper transition.
  if (/[a-z0-9][A-Z]/.test(token)) return true;
  // PascalCase + acronym boundary: UPPER followed by Upper+lower.
  if (/[A-Z]+[A-Z][a-z]/.test(token)) return true;
  return false;
}

/**
 * Re-score `hits` using the configured signals. Output is sorted by adjusted
 * score descending; ties broken by lower id first (same as RRF).
 *
 * Each enabled signal multiplies the original score by its contribution.
 */
export function applySignals(
  hits: readonly RankedHit[],
  chunks: readonly Chunk[],
  query: string,
  config?: SignalConfig,
): RankedHit[] {
  if (hits.length === 0) return [];

  const definitionBoost = config?.definitionBoost ?? true;
  const multiChunkFileBoost = config?.multiChunkFileBoost ?? true;
  const pathPenalty = config?.pathPenalty ?? true;
  const identifierStemMatching = config?.identifierStemMatching ?? true;

  // Validate hits and pre-resolve chunks.
  type Working = { id: number; score: number; originalIndex: number; chunk: Chunk };
  const working: Working[] = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (hit === undefined) continue;
    const chunk = chunks[hit.id];
    if (chunk === undefined) continue;
    working.push({ id: hit.id, score: hit.score, originalIndex: i, chunk });
  }
  if (working.length === 0) return [];

  // Pre-compute query tokens once (used by both definition boost and stem match).
  const queryTokens = tokenize(query, { preserveDotted: false });
  const querySymbolLike = isSymbolLikeQuery(query);

  // multiChunkFileBoost: count contributing chunks per file across the working set.
  const filePathCounts = new Map<string, number>();
  if (multiChunkFileBoost) {
    for (const w of working) {
      filePathCounts.set(w.chunk.filePath, (filePathCounts.get(w.chunk.filePath) ?? 0) + 1);
    }
  }

  for (const w of working) {
    let factor = 1;

    if (definitionBoost && querySymbolLike && queryTokens.length > 0) {
      if (chunkHasDefinitionForQuery(w.chunk.content, queryTokens)) {
        factor *= DEFINITION_BOOST;
      }
    }

    if (multiChunkFileBoost) {
      const count = filePathCounts.get(w.chunk.filePath) ?? 1;
      if (count >= 2) {
        const raw = 1 + MULTI_CHUNK_PER_EXTRA * (count - 1);
        factor *= Math.min(raw, MULTI_CHUNK_CAP);
      }
    }

    if (pathPenalty) {
      factor *= computePathPenalty(w.chunk.filePath);
    }

    if (identifierStemMatching && queryTokens.length > 0) {
      const matched = countStemMatches(w.chunk.content, queryTokens);
      const raw = 1 + STEM_PER_MATCH * matched;
      factor *= Math.min(raw, STEM_CAP);
    }

    w.score = w.score * factor;
  }

  // Sort: descending score, then tie-break. For genuinely zero scores
  // (multiplications of 0 by any factor) we preserve the original input order
  // so the signals don't introduce noise. For non-zero ties we break by lower
  // id first (same contract as RRF).
  working.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.score === 0 && b.score === 0) return a.originalIndex - b.originalIndex;
    if (a.id !== b.id) return a.id - b.id;
    return a.originalIndex - b.originalIndex;
  });

  return working.map((w) => ({ id: w.id, score: w.score }));
}

function chunkHasDefinitionForQuery(content: string, queryTokens: readonly string[]): boolean {
  const lower = content.toLowerCase();
  let hasKeyword = false;
  for (const kw of DEFINITION_KEYWORDS) {
    if (lower.includes(kw)) {
      hasKeyword = true;
      break;
    }
  }
  if (!hasKeyword) return false;

  // Build a token set from the chunk and check overlap with the query.
  const chunkTokens = new Set(tokenize(content, { preserveDotted: false }));
  for (const qt of queryTokens) {
    if (chunkTokens.has(qt)) return true;
  }
  return false;
}

function computePathPenalty(filePath: string): number {
  const lower = filePath.toLowerCase();
  let factor = 1;

  for (const p of TEST_PATH_PATTERNS) {
    if (lower.includes(p)) {
      factor *= TEST_PENALTY;
      break;
    }
  }
  for (const p of LEGACY_PATH_PATTERNS) {
    if (lower.includes(p)) {
      factor *= LEGACY_PENALTY;
      break;
    }
  }
  for (const p of EXAMPLE_PATH_PATTERNS) {
    if (lower.includes(p)) {
      factor *= EXAMPLE_PENALTY;
      break;
    }
  }
  if (lower.endsWith(".d.ts")) {
    factor *= DTS_PENALTY;
  }
  return factor;
}

function countStemMatches(content: string, queryTokens: readonly string[]): number {
  const chunkTokens = new Set(tokenize(content, { preserveDotted: false }));
  let matched = 0;
  for (const qt of queryTokens) {
    if (chunkTokens.has(qt)) matched++;
  }
  return matched;
}
