# TODOS

Deferred work that doesn't need a full version slot. Each item has
enough context that someone picking it up months later understands
the motivation and where to start.

## Bench corpus representativeness audit

**What:** Audit whether the bench corpus (3 repos — zod, requests,
gson — 60 hand-labeled queries) contains large functions and mixed
top-level/function files representative of real codebases. Add
labeled queries that exercise function-boundary chunking and
oversized-node behavior.

**Why:** DESIGN-0001 (tree-sitter chunker) claims a +0.05–0.10
hybrid NDCG gain from function-boundary chunking. That gain is only
measurable if the corpus actually contains functions that
line-fallback was splitting. If the 3 repos are mostly small
functions, the bench shows a flat number and the release's headline
claim — plus any future chunker change — can't be validated. The
oversized-node cap has the same blind spot.

**Pros:** the bench becomes a trustworthy gate for chunker work.
**Cons:** adding a corpus repo + hand-labeling queries is real work
and shifts every baseline.

**Context:** Corpus + baselines live in `benchmarks/`. Surfaced in
the v0.2.0 engineering review (decision D6, D10).

**Depends on:** v0.2.0 landing first, so the audit baseline is the
tree-sitter baseline, not the line-fallback one.

## Streaming buildIndex — bound peak memory

**What:** `buildIndex`'s cold path (`packages/search/src/search.ts`,
~lines 360–385) walks the repo and pushes every file's full text into
a `files[]` array, then chunks the whole array. The entire repo's
source is resident in RAM at once. Refactor toward a streaming shape:
walk → read → chunk → discard each file's content before the next.

**Why:** latent memory ceiling on very large monorepos — the
large-repo users the roadmap cares about. Not introduced by any
recent change; pre-existing.

**Pros:** lower peak memory on big repos.
**Cons:** touches the `buildIndex` cold path and the cache-save path,
which currently consume the full chunk array.

**Context:** Surfaced in the v0.2.0 engineering review, Section 4
(decision D11). Explicitly kept out of v0.2.0 scope — unrelated to
chunking.

**Depends on:** nothing.
