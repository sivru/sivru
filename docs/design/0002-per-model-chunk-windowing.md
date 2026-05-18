# DESIGN-0002: Per-model chunk-windowing

**Status:** Draft
**Class:** Foundation (per [GOALS.md](../../GOALS.md))
**Targets:** v0.3.0
**Issue:** [#12](https://github.com/sivru/sivru/issues/12)
**Created:** 2026-05-08
**Updated:** 2026-05-18 — promoted Stub → Draft after v0.2.0 shipped;
Proposal / Alternatives / Test plan added, informed by the v0.2 bench
results.
**Author:** @pochadri

## Problem

The chunker sizes chunks the same way for every embedder. v0.2 sizes
the tree-sitter chunker by **lines** — a node up to `MAX_NODE_LINES`
(200) is one chunk, larger nodes are line-windowed. Lines are a proxy
for what the embedder actually consumes: **tokens**. Each embedder has
a hard context window:

| Embedder    | Context | Notes |
|-------------|---------|-------|
| MiniLM      | 256 tok | the v0.1/v0.2 Transformers.js default |
| BGE-small   | 512 tok | instruction-prefixed |
| jina-code   | 8192 tok | code-tuned, long context |
| potion      | n/a     | Model2Vec — mean-pooled, no hard window |

A dense 40-line code chunk can exceed 256 tokens. MiniLM then
**silently truncates**: the stored embedding represents only the first
~256 tokens of the chunk; the rest of the function is invisible to
semantic retrieval. The user believes they are benchmarking MiniLM;
they are benchmarking "MiniLM on the head of every chunk." Every
multi-embedder comparison sivru publishes is unfair until this lands —
and silent truncation is exactly the kind of quiet quality loss the
project's honesty principle exists to prevent.

This is **Foundation**, like v0.2: the coach-loop and skill-bench
releases compare embedders and chunk strategies, and those comparisons
must be measuring what they claim to measure.

### What v0.2 left for this release

DESIGN-0001 deliberately deferred chunk *sizing* here. Its
`MAX_NODE_LINES = 200` is "a generous fixed cap for v0.2; v0.3
refines it to the embedder's context window." That refinement is the
core of this design.

### Honest scope note

Per-model windowing fixes *truncation correctness*. It does **not**
shrink the index — for a short-context embedder it produces *more,
smaller* chunks. The v0.2-flagged index-size growth (one chunk per
function; many whitespace-only gap chunks) is a separate concern; see
Open Questions.

## Proposal

Make chunk size a function of the embedder's token budget. Three
pieces: embedders declare a budget, the chunker windows to it, and the
cache key learns about the embedder.

### 1. Embedders declare a token budget

`EmbeddingProvider` gains two optional members:

```ts
export type EmbeddingProvider = {
  // ... existing ...
  /** Hard context window in tokens. Omit for windowless embedders
   *  (Model2Vec / potion) — no token cap is applied. */
  readonly contextTokens?: number;
  /** Tokenizer-accurate token count for `text`. Omit to fall back to
   *  a byte heuristic. */
  countTokens?(text: string): number;
};
```

Transformers.js providers already load the model's tokenizer, so
`countTokens` is a thin wrapper over it — accurate, no extra model
load. potion declares neither (mean-pooling has no hard window).
The model catalog records `contextTokens` per model so
`sivru bench models` can show it.

### 2. The chunker windows to a token budget

`ChunkOptions` gains:

```ts
export type ChunkOptions = {
  maxLines?: number;       // existing — line-fallback / no-budget path
  overlapLines?: number;   // existing
  /** Token budget per chunk. When set, supersedes the line cap:
   *  no emitted chunk exceeds it. */
  maxTokens?: number;
  /** Token counter; required when `maxTokens` is set. */
  countTokens?: (text: string) => number;
};
```

`buildIndex` derives `maxTokens` from the embedder
(`~0.8 × contextTokens` — headroom for instruction prefixes and
tokenizer overhead) and `countTokens` from the provider, and passes
both into chunking.

The tree-sitter chunker's oversized rule (DESIGN-0001 D5) becomes
token-aware:

- **No budget** (BM25-only build, or a windowless embedder): unchanged
  — `MAX_NODE_LINES` is the cap, line-windowing splits larger nodes.
- **With a budget**: a node *or* gap chunk whose `countTokens(content)`
  exceeds `maxTokens` is split by a new **token-greedy line windower**
  — pack whole lines into a window until the next line would exceed
  the budget, then start the next window (with line overlap). Splitting
  on line boundaries keeps chunks readable and keeps `startLine`/
  `endLine` honest; the budget is the token count, lines are the unit.

Sub-chunks of a split node keep `nodeType` / `symbolName`, exactly as
the v0.2 line-split does.

### 3. Cache key includes the embedder

Chunk boundaries now depend on `(corpus state, embedder)`. The cache
key — today `(repoPath, stateId)` — gains the embedder model id:

```
cacheKey = (repoPath, stateId, embedderId)
```

`embedderId` is `"bm25"` for a BM25-only build and the model id
otherwise. `CACHE_FORMAT_VERSION` bumps `2 → 3`. A v0.2 cache is
rejected on read and rebuilt once.

### BM25 is unchanged

BM25 indexes whatever chunk set exists — it has no token window and
needs no code change. In a hybrid build the single chunk set is
token-windowed for the embedder and BM25 indexes that same set; in a
BM25-only build chunks use the line cap. This keeps one chunk set per
build, so RRF still fuses two rankings over identical chunk ids.

## Alternatives considered

**Byte heuristic instead of the real tokenizer.** `tokens ≈ bytes/3.5`
is cheap and needs no tokenizer call. But code tokenizes very
unevenly — `}` and identifiers and operators differ 3× in
bytes-per-token — so a heuristic budget is wrong by enough to either
still truncate or waste a third of the window. Use the real
tokenizer; keep the heuristic only as the fallback when a provider
gives no `countTokens`.

**Truncate-and-warn instead of windowing.** Keep 200-line chunks, emit
a diagnostic when one exceeds the budget. Rejected — it tells the user
retrieval is degraded without fixing it; the whole point is to stop
the silent loss.

**Token-exact splitting (split mid-line at the token boundary).**
Maximum window utilisation, but chunks would start/end mid-line,
`startLine`/`endLine` become fractional, and `sivru search` output
gets unreadable. Line-granular windowing under a token budget wastes
at most one line of budget per window — worth it.

**Re-window only the embedding copy, leave BM25 on big chunks.**
Two chunk sets — breaks RRF id alignment and doubles cache state.
Rejected; one chunk set per build.

## Open questions

- **Token overlap.** Line-windowing overlaps by `overlapLines`. Under
  a token budget, overlap should be a fraction of the budget — settle
  the exact rule (fixed lines vs `~10%` of tokens) in eng-review.
- **Whitespace-only gap chunks.** v0.2 emits a chunk for every blank
  line between methods, inflating the index. Folding a "drop
  whitespace-only gap chunks" cleanup into v0.3 is in scope-range
  (both are chunk hygiene) but it touches DESIGN-0001's "every line
  covered" invariant. Decide in eng-review: fold in, or keep as its
  own v0.x patch.
- **`bench personal` over user repos.** Per-model windowing changes
  every embedder's numbers. Confirm the bench-history format carries
  `embedderId` so old runs aren't compared against new ones.

## Acceptance criteria

- `EmbeddingProvider` carries optional `contextTokens` + `countTokens`;
  Transformers.js providers implement both, potion neither.
- With an embedder budget, no emitted chunk exceeds `maxTokens` by the
  provider's own token count.
- BM25-only builds and windowless embedders are unchanged from v0.2.
- The cache key includes the embedder id; `CACHE_FORMAT_VERSION` is
  `3`; v0.2 caches are rejected and rebuilt.
- Bench re-published; MiniLM / BGE numbers reflect untruncated chunks.
- `sivru bench models` shows each model's `contextTokens`.

## Test plan

- **Unit — token windower.** A dense fixture whose chunk exceeds a
  small test budget → assert every sub-chunk is under budget by the
  test `countTokens`, sub-chunks keep `nodeType`/`symbolName`, and
  line coverage still holds.
- **Unit — no budget.** `maxTokens` unset → output identical to v0.2
  (line cap path untouched).
- **Unit — windowless embedder.** potion (`contextTokens` absent) →
  no token cap applied.
- **Regression — cache.** A v0.2 (`formatVersion: 2`) cache entry is
  rejected; two builds of the same repo with *different* embedders
  produce distinct cache entries.
- **Integration.** `buildIndex` with a 256-token mock embedder over a
  fixture repo → every embedded chunk fits; with potion → unchanged.
- **Bench.** Re-run BM25 + hybrid; additionally run a short-context
  embedder (MiniLM) and confirm its NDCG moves now that chunks are
  not truncated. Record deltas before overwriting `baseline*.json`.

## Customization shape

Per the three-layer rule:

1. **Built-in default** — each embedder declares `contextTokens`;
   chunks sized to `0.8 ×` it.
2. **Declarative override** — `ChunkOptions.maxTokens` forces a budget
   regardless of embedder.
3. **Code-level extension** — N/A for v0.3; the chunker is not yet a
   public extension point (a `Chunker` interface is punted, per
   DESIGN-0001's customization section).
