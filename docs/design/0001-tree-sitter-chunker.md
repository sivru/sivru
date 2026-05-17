# DESIGN-0001: Tree-sitter chunker

**Status:** Accepted
**Class:** Foundation (per [GOALS.md](../../GOALS.md))
**Targets:** v0.2.0
**Issue:** [#11](https://github.com/sivru/sivru/issues/11)
**Created:** 2026-05-07
**Updated:** 2026-05-17 — Problem section reconciled with the
comprehension goal; grammar scope, cache invalidation, execution model,
and API shape resolved through engineering review (decisions D1–D11
below).
**Author:** @pochadri

## Problem

Sivru's goal is to keep a codebase comprehensible — to the agents
writing it and the humans accountable for it (see
[GOALS.md](../../GOALS.md)). The comprehension layer that delivers
that goal — `@sivru` annotation blocks (v0.6,
[DESIGN-0016](0016-sivru-annotation-blocks.md)), serving authored
context (v0.7), the codebase explainer (v0.8) — all need one thing
the engine does not yet have: **a syntax-aware view of the code.**

`@sivru` blocks are authored in doc comments and *extracted via
tree-sitter*: the parser locates the comment that precedes a symbol
and binds the block to that symbol. The explainer's drill-down
(System → Module → Package → Symbol) needs symbol boundaries to
exist as first-class ranges. Without a parser in the engine, every
one of those features falls back to per-language regex hand-parsing.
Tree-sitter is the substrate the entire Spine extracts from. That is
why this is **Foundation**, sequenced first, and why Principle 6
("No skipping foundation") names it explicitly.

The chunker is where that substrate enters the engine. Today's
chunker (`packages/search/src/chunker/lineFallback.ts`) splits files
into 50-line windows with 5-line overlap — the *only* stage of the
engine that does not respect the language. Replacing it with a
tree-sitter chunker both lands the parser sivru needs for v0.6+ and
fixes a real retrieval defect:

- A 60-line function is split across two chunks at line 50 — the
  embedder sees half a function's body as one chunk and the rest
  (no signature, no comments) as another.
- A 200-line file with five 40-line functions becomes four chunks,
  each cutting two functions at arbitrary lines.

On the labeled bench corpus we expect **+0.02 to +0.05 NDCG@10** for
BM25 and **+0.05 to +0.10** for hybrid from function-boundary
chunking, largest for code-tuned embedders (jina-code). The retrieval
win is real but it is no longer the headline: **tree-sitter is the
AST substrate the authored-context layer is built on.** The NDCG gain
is the Supporting bonus that ships in the same release.

## Proposal

Add tree-sitter as the primary chunker, behind the same `chunkFile()`
facade that today routes to line-fallback. Line-fallback survives as
the safety net when the grammar isn't available, the parse fails, or
the file is in a language we don't have a grammar for — and as the
**gap filler** (see "Full line coverage" below).

### Module layout

```
packages/search/src/chunker/
├── chunk.ts            ← async facade: tree-sitter or line-fallback
├── language.ts         ← extension → language-id map (existing)
├── lineFallback.ts     ← existing; gains a range-aware `windowLines` core
├── treeSitter.ts       ← NEW: parse, extract nodes, gap-fill, cap
├── grammars.ts         ← NEW: node-type whitelist + grammar loader
├── grammars/*.wasm     ← NEW: 6 bundled grammar WASM files (committed)
└── __fixtures__/<lang>/ ← NEW: committed source fixtures
```

`packages/search/src/workers/pool.ts` and `workers/worker.ts` are
**deleted** (decision D1). `search.ts` loses its worker-pool branch
in `chunkFiles()`, and `BuildIndexOptions.workers` +
`WORKER_FILE_THRESHOLD` are removed.

### Execution model — main thread, no worker pool (D1, D8)

Tree-sitter parsing runs on the main thread with a single reused
`Parser` instance (`setLanguage()` per file). The `worker_threads`
chunking pool is removed entirely.

- **Why drop the pool:** tree-sitter parse is milliseconds per file;
  the bottleneck is embedding, not chunking. A worker pool cannot
  share loaded grammars (separate thread memory) — keeping it would
  mean N×grammar memory and N×cold-start. One main-thread parser is
  simpler, uses less memory than the pool ever did (one parse tree
  resident at a time, not N), and deletes ~250 lines.
- **Cost accepted:** BM25-only cold-index of a very large repo
  chunks serially. Paid once; the on-disk cache covers reruns.
- **No `prepareChunker` preload step.** `chunkFile()` is async (D4)
  and lazy-loads + memoizes each grammar on first use. The first
  file of a language pays the grammar load; the rest reuse it. Total
  loads = number of distinct languages in the repo. There is no
  "call this first" contract to forget.

### Public API surface (D4, D9)

`chunkFile()` becomes **async** — the operation genuinely gained
grammar loading, and the signature should say so. It awaits grammar
load internally (memoized), so no caller needs a preload step. This
is a breaking change to a public export; CHANGELOG.md states 0.x
minor bumps absorb breaking changes, and v0.2.0 is that release.
Internal `chunkFiles()` already awaits.

```ts
export async function chunkFile(
  filePath: string,
  content: string,
  options?: ChunkOptions,
): Promise<Chunk[]>;
```

The `Chunk` type gains two optional fields:

```ts
export type Chunk = {
  filePath: string;
  startLine: number;       // 1-indexed, inclusive
  endLine: number;         // 1-indexed, inclusive
  language: string | null;
  content: string;
  kind: ChunkKind;         // "tree-sitter" | "line" (existing)
  /** AST node type, e.g. `function_declaration`. Undefined for line chunks. */
  nodeType?: string;
  /**
   * Symbol name extracted from the node's identifier child, e.g.
   * `processPayment`. Undefined for line chunks and anonymous nodes.
   * Captured now so the v0.6 `@sivru`-block layer binds to symbols
   * without re-parsing; also usable by v0.2 ranking signals.
   */
  symbolName?: string;
};
```

Doc-comment node *ranges* are deliberately NOT modeled yet — that
shape is decided when DESIGN-0016 (v0.6) is drafted.

### Grammar scope — v0.2.0 ships 5 languages

v0.2.0 ships **TypeScript, JavaScript, Python, Go, Java**. Language
ids: `typescript`, `tsx`, `javascript`, `jsx`, `python`, `go`,
`java` (`jsx` reuses the JavaScript grammar; `tsx` is its own). Six
WASM grammars total. The remaining 11 languages in `language.ts`
keep line-fallback and are added in v0.x patch releases — each is a
whitelist entry plus a fixture, no architecture change.

### Per-language node-type whitelist (D10)

A flat type list is wrong for one case: tree-sitter's
`lexical_declaration` matches *every* top-level `const`/`let`, not
just arrow functions — `const X = 1` would become its own chunk and
the chunk count would explode. So a whitelist entry is **either** a
node-type string **or** a `{ type, when }` predicate that inspects
the node:

```ts
type NodeRule = string | { type: string; when: (node: SyntaxNode) => boolean };

const NODE_TYPES_TO_CHUNK: Record<string, NodeRule[]> = {
  typescript: [
    "function_declaration",
    "class_declaration",
    "interface_declaration",
    "method_definition",
    { type: "lexical_declaration", when: hasFunctionInitializer },
  ],
  tsx:        [ /* same as typescript */ ],
  javascript: [
    "function_declaration",
    "class_declaration",
    "method_definition",
    { type: "lexical_declaration", when: hasFunctionInitializer },
  ],
  jsx:        [ /* same as javascript */ ],
  python:     ["function_definition", "class_definition"],
  go:         ["function_declaration", "method_declaration", "type_declaration"],
  java:       [
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
  ],
};
```

Top-level definitions and methods are the right grain. Loops and ifs
are excluded — they fragment a function into tiny context-free
chunks.

### Full line coverage — gap-fill (D3)

A node-whitelist chunker only emits chunks for code *inside*
whitelisted nodes. Everything else — imports, module-level constants,
top-level statements, a Python `if __name__` block, blank lines
between functions — would be silently dropped from the index. That
violates the hard rule "never silently exclude files from indexing":
the file would *look* indexed (some chunks exist) while real code is
unsearchable.

The tree-sitter chunker therefore emits **both**:

1. **Node chunks** for whitelisted nodes.
2. **Line-fallback chunks** for every line range no node chunk
   covers.

Every line lands in exactly one chunk. Ordering matters and is fixed:

```
parse
  → collect whitelisted nodes
  → attach leading doc comment to each node  (extends node startLine up)
  → cap oversized nodes (D5)
  → compute line ranges NOT covered by any node chunk
  → line-fallback those gap ranges
  → merge, sort by startLine
```

Doc-comment attachment runs **before** gap-fill so the "exactly once"
invariant is unambiguous: an attached comment belongs to the node
chunk, and gap-fill never re-covers it.

### Oversized-node cap (D5)

A whitelisted node longer than a threshold (a generous fixed line
cap in v0.2; refined per-embedder-window in v0.3) is split with the
range-aware line-fallback core over its own line span. Each sub-chunk
keeps `nodeType` and `symbolName`. This stops v0.2 shipping a
known retrieval regression on large functions/classes, and it reuses
the exact machinery gap-fill already needs.

### Shared windowing core

Gap-fill and the oversized-node cap both need "line-fallback over a
sub-range." `lineFallback.ts` is refactored to expose a
`windowLines(lines, startLine, maxLines, overlap)` core; the existing
whole-file `lineFallbackChunks` and both new callers use it. One
windowing implementation, not three.

### Grammar loading — bundled WASM (D2, plus #2/#7)

The 6 grammar `.wasm` files (built from a pinned `tree-sitter-wasms`
version) and the `web-tree-sitter` runtime wasm are **committed to
`packages/search/src/chunker/grammars/`** and shipped in the npm
package. At ~6MB this is acceptable (sivru already pulls
transformers/onnxruntime). Bundling removes the entire runtime
download / checksum / retry / offline-failure surface, makes builds
reproducible, and works offline, air-gapped, and in CI.

Required for this to actually ship:

- `package.json` `files` array currently `["dist", "README.md"]` —
  it must include the bundled `.wasm` (or they must land under
  `dist/` via the build). Without this they are NOT published.
- `web-tree-sitter` is pinned to an exact version. Grammar `.wasm`
  ABI is tied to the `web-tree-sitter` major; the grammars are
  regenerated whenever `web-tree-sitter` is bumped across a major.
  This is documented next to the bundled files.

### Cache invalidation (D2-cache)

Bump `CACHE_FORMAT_VERSION` in `cache/index.ts` from `1` to `2`. A
cache entry whose `formatVersion` doesn't match is already rejected
on read, so every v0.1 index rebuilds once on upgrade. Chunk-boundary
shifts (and the `refreshStale` signature change that rides along) are
absorbed by this full rebuild — there is no stale cache to refresh
against.

## Alternatives considered

**Native tree-sitter bindings (not WASM).** Faster parse, but
per-platform prebuilds for every node × OS × arch. WASM is universal;
parse speed is fine — chunking is not the bottleneck.

**Manual heuristic chunkers per language.** Regex "find functions."
Breaks on Python (off-side rule), Go (multi-line bodies), Java
(nested classes) — and is exactly the trap v0.6 block extraction
would fall into without a parser. Solve it once, here.

**Keep the worker pool, async-init grammars per worker.** N×grammar
memory, N×cold-start, init/parse races. Rejected (D1).

**Lazy-download grammars to `~/.cache`.** The design's original
answer, made when scope was 16 grammars (~16MB). At 6 grammars the
size argument is weak, and download adds an offline-failure surface
that silently degrades chunks. Rejected (D2).

**Whole-file fallback if node coverage is low / widen the whitelist
instead of gap-filling.** The first throws away function boundaries
on mixed files; the second can never enumerate every node type and
still drops inter-node lines. Rejected (D3).

## Open questions

- **Oversized-node threshold value.** A concrete line cap is picked
  during implementation and pinned by a fixture; v0.3 retunes it
  per-embedder-window.
- **`nodeType` in ranking signals.** Whether `definition_boost` keys
  off `nodeType`/`symbolName` — defer to v0.3 unless signals are
  touched in v0.2.

## Acceptance criteria

- 5 languages covered (TS, JS, Python, Go, Java; 7 language ids),
  each with a node-type whitelist tested against a committed fixture.
- `chunkFile()` is async; grammar loading is internal and memoized;
  there is no separate preload step.
- Every line of every covered-language file lands in exactly one
  chunk (node chunks + gap-fill line chunks).
- No chunk exceeds the oversized-node cap.
- Tree-sitter chunks set `kind: "tree-sitter"`, `nodeType`, and
  `symbolName` (where the node is named); line/gap chunks leave them
  undefined. Existing consumers handle `undefined`.
- A leading doc comment is included in the chunk of the symbol it
  documents; gap-fill never re-covers it.
- `lexical_declaration` chunks only when its initializer is a
  function/arrow.
- `workers/pool.ts`, `workers/worker.ts`, `BuildIndexOptions.workers`,
  and `WORKER_FILE_THRESHOLD` are removed.
- 6 grammar WASM + the runtime wasm are bundled and present in the
  published tarball (`package.json` `files` updated).
- `CACHE_FORMAT_VERSION` bumped to `2`; v0.1 caches rebuilt once.
- The PR records the NDCG delta measured against the frozen v0.1
  baseline *before* `benchmarks/baseline*.json` is overwritten with
  the new baseline.
- Perf gate (`pnpm bench:perf:gate`) re-baselined.

## Test plan

- **Per-grammar unit tests** against committed fixtures in
  `__fixtures__/<lang>/` — chunk count, line ranges, `nodeType`,
  `symbolName`, doc-comment attachment (incl. a license-header-not-
  attached edge case).
- **Property test — full coverage:** a mostly-top-level-code fixture
  → assert every source line is in exactly one chunk.
- **Property test — cap:** a big-function fixture → assert split,
  every sub-chunk under the cap, `nodeType`/`symbolName` preserved.
- **`lexical_declaration` predicate:** a file with top-level
  `const X = 1` and `const f = () => {}` → only the arrow chunks.
- **Facade fallback:** malformed file → graceful line chunks;
  uncovered language (`.rs`) → `kind: "line"`; empty file → `[]`.
- **Async + memoization:** `chunkFile` returns a Promise; the second
  call for a language does not re-init the grammar.
- **Cache regression (CRITICAL):** a `formatVersion: 1` cache fixture
  → treated as a miss.
- **Integration:** `buildIndex` over a mixed-language fixture repo →
  chunks carry correct `kind` / `nodeType` / `symbolName`; existing
  `buildIndex` tests stay green after the worker-pool removal.
- **Bench:** measure NDCG delta vs the frozen v0.1 baseline, record
  it in the PR, then re-baseline `benchmarks/baseline*.json` and
  `perf-baseline.json`.

## Customization shape

The chunker is not user-customizable in v0.2, but the three-layer
rule (Principle 4) applies for the future:

1. **Built-in defaults.** Node-type whitelists in `grammars.ts` —
   v0.2.0 ships these only.
2. **Declarative override.** `~/.config/sivru/chunker.json` /
   `.sivru/chunker.json` accepting `additionalNodeTypes`. Punted to
   a v0.x patch.
3. **Code-level extension.** A `Chunker` interface to swap the whole
   chunker. Punted to a v0.x patch.
