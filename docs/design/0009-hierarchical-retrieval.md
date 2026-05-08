# DESIGN-0009: Hierarchical retrieval

**Status:** Stub
**Targets:** v0.10.0
**Issue:** filed when v0.10 becomes next release
**Created:** 2026-05-08

## Problem

Today every chunk in the corpus is in the embedding matrix. For a
16,000-chunk repo with 768-dim embeddings, that's a ~49 MB
Float32Array, ~30 seconds of cold-start with potion (default), 12+
minutes with MiniLM cold. The cold-start friction is real; users who
hit it once may not come back.

There's a structural shortcut: most queries can be answered by
embedding **file-level summaries first**, finding the top-K
candidate files, then doing chunk-level retrieval only inside those
candidates. ~10× faster cold-start, ~5× less RAM, often *better*
recall on natural-language queries because file-level signal is
denser than chunk-level.

This is the PageIndex idea (a hierarchical tree of summaries the LLM
navigates) adapted for code retrieval. We don't go fully tree-based
because identifier queries still need exact-match (BM25 wins), but
the file-summary layer is a real performance + quality improvement.

## Acceptance (from ROADMAP.md v0.10)

- `buildIndex` produces both file-summary embeddings and chunk-level
  embeddings
- `searchHybrid` runs two-stage retrieval: file-summary cosine →
  top-K candidate files → chunk-level retrieval inside those files
  → final hits
- BM25 path unchanged (BM25 still operates over chunks for exact
  identifier match)
- Cold-start time on a 16k-chunk repo drops by at least 5× (target
  10×)
- Recall@5 doesn't regress on the W2 NDCG@10 corpus (and ideally
  improves on natural-language queries)
- Backwards-compatible: existing API callers get faster retrieval
  transparently

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** file summaries auto-generated from
   tree-sitter (v0.2) function/class names + leading doc comments.
   Two-stage retrieval enabled by default.
2. **Declarative override:** `BuildIndexOptions.hierarchical`
   accepts `{ enabled: false }` to fall back to single-stage,
   `{ candidateFileCount: 10 }` to tune top-K, etc.
3. **Code-level extension:** custom file-summary generator via
   the `FileSummarizer` interface (probably introduced in this
   design).

## Open questions

- File-summary generation: pure tree-sitter aggregation (function
  signatures + class names) or LLM-generated (call the agent's
  model to summarize)? LLM is better quality, but costs tokens
  per indexed file. Default: tree-sitter aggregation; LLM as
  opt-in extension.
- How to handle large files (10k+ lines)? File summary may not fit
  in any embedder's context. Truncate? Chunk the summary itself?
  Use the largest-context embedder for summaries?
- Cache implications: file summaries change less often than file
  contents; consider caching them separately.
- Does this break the perf gate? File-summary computation is new
  work added to indexing time. Re-baseline the perf gate.

## Status note

This is a Stub. Full design lands when v0.10 becomes the next
release.
