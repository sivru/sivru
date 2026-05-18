# DESIGN-0002: Per-model chunk-windowing

**Status:** Accepted
**Class:** Foundation (per [GOALS.md](../../GOALS.md))
**Targets:** v0.3.0
**Issue:** [#12](https://github.com/sivru/sivru/issues/12)
**Created:** 2026-05-08
**Updated:** 2026-05-18 — promoted Stub → Draft → Accepted through
engineering review (decisions D1–D8 below).
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
semantic retrieval. Every multi-embedder comparison sivru publishes is
unfair until this lands — and silent truncation is exactly the kind of
quiet quality loss the project's honesty principle exists to prevent.

This is **Foundation**, like v0.2: the coach-loop and skill-bench
releases compare embedders and chunk strategies, and those comparisons
must measure what they claim to measure.

### What v0.2 left for this release

DESIGN-0001 deferred chunk *sizing* here. Its `MAX_NODE_LINES = 200`
is "a generous fixed cap for v0.2; v0.3 refines it to the embedder's
context window."

### Honest scope note

Per-model windowing fixes *truncation correctness*. It does **not**
shrink the index — for a short-context embedder it produces *more,
smaller* chunks. Two further consequences are documented, not hidden:

- **BM25 numbers move per embedder.** One chunk set, sized for the
  configured embedder, is what BM25 indexes (see §5). A 256-token
  corpus has ~2× the documents of a 512-token one, so BM25's IDF,
  average document length, and length-normalisation all shift.
  `searchBM25` rankings therefore depend on the configured embedder.
  The bench reports BM25-only and hybrid-BM25 separately and the
  writeup states this.
- **`findRelated` keys off a smaller unit.** With heavy windowing an
  80-line function becomes several chunks; `findRelated` (and the MCP
  `find_related` tool) seed from the first overlapping chunk, i.e. the
  function's head rather than the whole function. See Open Questions.

## Proposal

Chunk size becomes a function of the embedder's token budget. The
chunker stays embedder-agnostic; a post-pass owns the resizing.

```
buildIndex (embed path) / refreshStale
  walk + chunkFile            ← v0.2, UNCHANGED, embedder-agnostic
        │  Chunk[]  (tree-sitter + gap chunks, line-sized)
        ▼
  rewindowForBudget(chunks, contextTokens, countTokens)   ← NEW
        │  splits any chunk over the token budget
        ▼
  one chunk set → BM25 index AND embedding both consume it
```

### 1. Embedders declare a token budget (D1, D6, finding #9)

`EmbeddingProvider` gains two optional members:

```ts
export type EmbeddingProvider = {
  // ... existing ...
  /**
   * Effective per-chunk content-token budget: the model's real context
   * window minus its fixed special-token overhead ([CLS]/[SEP] etc.).
   * Read by the provider from the loaded tokenizer config — NOT a
   * hand-maintained catalog number, so it stays correct for fine-tunes.
   * Omit for windowless embedders (Model2Vec / potion).
   */
  readonly contextTokens?: number;
  /**
   * Count of CONTENT tokens in `text` — tokenized with
   * `add_special_tokens: false`. Content tokens are additive across a
   * newline join, so the windower can sum per-line counts (D4/D6).
   * Omit to fall back to a byte heuristic.
   */
  countTokens?(text: string): number;
};
```

Transformers.js providers already load the model's tokenizer, so
`countTokens` is a thin wrapper; `contextTokens` is derived once from
`tokenizer.model_max_length` minus the special-token count. potion
declares neither. The model catalog records the *raw* window for
`sivru bench models` display only — never for the budget.

**Why content tokens, not special-token-inclusive (D6).** If
`countTokens` included `[CLS]/[SEP]`, per-line counts would each carry
their own pair and a running sum would over-count by `2×(lines−1)`.
Counting content tokens only keeps the sum additive *and* exact: the
special-token overhead is subtracted once, up front, into
`contextTokens`. The windower check is then simply
`sum(perLineContentTokens) ≤ contextTokens`.

### 2. `rewindowForBudget` — a post-pass, not a chunker change (D2)

`chunkFile` / `treeSitterChunks` / `ChunkOptions` are **unchanged from
v0.2** — the chunker stays a pure, embedder-agnostic primitive (the QA
harness and other callers depend on that). Token-awareness lives in
one place:

```ts
function rewindowForBudget(
  chunks: readonly Chunk[],
  contextTokens: number,
  countTokens: (text: string) => number,
): Chunk[];
```

For each input chunk: if `countTokens(content) ≤ contextTokens`, pass
it through unchanged; otherwise split it (§3). Split sub-chunks keep
the original chunk's `kind`, `nodeType`, and `symbolName`. Output is
one chunk set; BM25 and embedding both index it, so RRF id-alignment
holds.

`buildIndex` (embed path) and `refreshStale` both call it, right after
`chunkFiles`. When the embedder is windowless (`contextTokens`
undefined) or the build is BM25-only, the pass is skipped entirely —
behaviour is identical to v0.2.

**`refreshStale` invariant.** The embedder is fixed for the lifetime of
a `SivruIndex`. `refreshStale` re-windows only the freshly re-chunked
files; kept chunks were already windowed for the same embedder at build
time. `chunkSignature` comparison stays valid because every chunk in a
given index went through the same `(embedder, window)` regime.

**`MAX_NODE_LINES` interaction (finding #7).** v0.2's 200-line node cap
still runs inside `chunkFile`. When a token budget is active it is a
pathological guard only — the post-pass owns real sizing. A >200-line
function is therefore line-split once then token-windowed; the two
passes' overlaps stack slightly on that rare input. Accepted for v0.3.

### 3. The token-greedy line windower (D4, D6, D7, D8)

Splitting an over-budget chunk:

- **Line-granular, greedy.** Walk the chunk's lines; keep a running sum
  of `countTokens(line)` (each line tokenized exactly once — O(n), per
  D4). Start a new window when the next line would push the sum past
  `contextTokens`.
- **Overlap — token-proportional (D8).** A new window is seeded with
  the trailing whole lines of the previous window whose token sum is
  closest to ~12% of `contextTokens` without exceeding it. Predictable
  proportion regardless of code density; the overlap counts against the
  budget.
- **Un-splittable line (D7).** A single line whose `countTokens`
  exceeds `contextTokens` cannot be line-split. As a last resort *that
  line only* is split on a character boundary into budget-sized pieces.
  Mid-line splitting is banned for all normal code; it exists solely so
  the "no chunk exceeds budget" guarantee holds unconditionally. Such
  sub-chunks have `startLine === endLine` and a fragment for `content`.
- **Heuristic fallback (D1).** When a provider has `contextTokens` but
  no `countTokens`, per-line counts use `Math.ceil(bytes / 3.5)` and
  the budget is taken at `0.85 × contextTokens` — a margin only this
  imprecise path needs.

Sub-chunks keep `nodeType` / `symbolName`, exactly as v0.2's
oversized-node line-split does.

### 4. Cache key includes the embedder

Chunk boundaries now depend on `(corpus state, embedder)`. The cache
key — today `(repoPath, stateId)` — gains the embedder id:

```
cacheKey = (repoPath, stateId, embedderId)
```

`embedderId` is `"bm25"` for a BM25-only build and the model id
otherwise. `CACHE_FORMAT_VERSION` bumps `2 → 3`; a v0.2 cache is
rejected on read and rebuilt once.

### 5. BM25 is unchanged in code, not in numbers

BM25 indexes whatever chunk set exists — no code change. But the chunk
set is sized for the configured embedder, so BM25's corpus statistics
(document count, average length, IDF) shift with the embedder, and
`searchBM25` rankings move accordingly. This is a real, documented
consequence (see Honest scope note), not a bug. One chunk set per
build is kept deliberately — two chunk sets would break RRF
id-alignment and double the cache state.

## Alternatives considered

**Byte heuristic instead of the real tokenizer.** `tokens ≈ bytes/3.5`
needs no tokenizer call, but code tokenizes unevenly enough that the
budget is wrong by ~30% — chunks still truncate or waste a third of the
window. Real tokenizer; heuristic only as the no-`countTokens` fallback.

**Thread `maxTokens` through `chunkFile`.** Couples the pure, public
chunker to embedder concerns and grows `ChunkOptions` and
`treeSitterChunks`' signature. Rejected for the post-pass (D2).

**Special-token-inclusive `countTokens` + per-window re-tokenize.**
Avoids special-token bookkeeping but costs an extra full-window
tokenization per window and a fiddlier estimate-then-confirm loop.
Rejected for content-token counting (D6).

**Truncate-and-warn / emit over-budget lines as-is.** Surfaces the
problem without fixing it; reintroduces the silent truncation v0.3
exists to kill. Rejected (D7).

**Two chunk sets (re-window only the embedding copy).** Breaks RRF id
alignment, doubles cache state. Rejected — one chunk set (§2, §5).

## Open questions

- **`findRelated` under heavy windowing.** With small windows
  `findRelated` seeds from a function's head, not the whole function.
  Measure the retrieval-quality impact during the bench; if material,
  a fix (seed from the union of a symbol's chunks) is its own v0.x
  item — not v0.3 scope.
- **Bench corpus representativeness.** Already tracked in `TODOS.md`;
  v0.3's re-bench is a good moment to act on it.

## Acceptance criteria

- `EmbeddingProvider` carries optional `contextTokens` (effective
  content budget, from the loaded tokenizer config) + `countTokens`
  (content tokens, no special tokens). Transformers.js implements
  both; potion neither.
- `rewindowForBudget` is a pure post-pass; `chunkFile`,
  `treeSitterChunks`, and `ChunkOptions` are byte-for-byte unchanged
  from v0.2.
- With an embedder budget, no emitted chunk exceeds `contextTokens` by
  the provider's own token count — including files with a single
  over-budget line.
- `rewindowForBudget` runs in both `buildIndex` and `refreshStale`;
  BM25-only builds and windowless embedders are unchanged from v0.2.
- Split sub-chunks preserve `kind` / `nodeType` / `symbolName`; full
  line coverage holds.
- The cache key includes the embedder id; `CACHE_FORMAT_VERSION` is
  `3`; v0.2 caches are rejected and rebuilt.
- Bench re-published; MiniLM / BGE numbers reflect untruncated chunks;
  BM25-only and hybrid-BM25 reported separately with a note that BM25
  numbers move with the configured embedder.
- **Perf gate (`pnpm bench:perf:gate`) re-baselined** — v0.3 produces
  more, smaller chunks for short-context embedders; the new cold-index
  time / memory / cache size is recorded as the accepted baseline.
- `sivru bench models` shows each model's raw context window.

## Test plan

- **Unit — `countTokens` accuracy.** `countTokens(s)` for a known
  string equals the model tokenizer's content-token count
  (`add_special_tokens: false`).
- **Unit — token windower.** A dense fixture chunk over a small test
  budget → every sub-chunk under budget by the test `countTokens`,
  sub-chunks keep `nodeType`/`symbolName`, full line coverage holds.
- **Unit — over-budget single line (CRITICAL).** A chunk whose one
  line alone exceeds the budget → the line is char-split into
  budget-sized pieces; the windower makes forward progress (no stall,
  no infinite loop, no empty chunk).
- **Unit — overlap.** Adjacent windows share trailing lines summing to
  ≤ ~12% of the budget; overlap never pushes a window over budget.
- **Unit — heuristic fallback.** A provider with `contextTokens` but
  no `countTokens` is still windowed (via the byte heuristic).
- **Unit — no budget / windowless.** `rewindowForBudget` skipped (or a
  no-op) for a BM25-only build and for potion → output identical to
  v0.2.
- **Regression — cache.** A `formatVersion: 2` cache entry is
  rejected; two builds of the same repo with *different* embedders
  produce distinct cache entries.
- **Integration — `refreshStale`.** A changed file with an
  over-budget chunk → the refreshed chunk is windowed to fit.
- **Integration — `buildIndex`.** With a 256-token mock embedder over
  a fixture repo, every embedded chunk fits; with potion, unchanged.
- **Bench.** Re-run BM25 + hybrid; additionally run MiniLM and confirm
  its NDCG moves now that chunks are not truncated. Record deltas
  against the frozen v0.2 baselines before overwriting them.

## Customization shape

1. **Built-in default** — each embedder declares its effective
   `contextTokens`; the windower sizes to it.
2. **Declarative override** — a future `BuildIndexEmbedOptions`
   field could force a budget regardless of embedder; not v0.3 scope.
3. **Code-level extension** — N/A for v0.3; the chunker is not yet a
   public extension point (per DESIGN-0001's customization section).
