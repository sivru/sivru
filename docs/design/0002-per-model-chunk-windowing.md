# DESIGN-0002: Per-model chunk-windowing

**Status:** Stub
**Targets:** v0.3.0
**Issue:** [#12](https://github.com/sivru/sivru/issues/12)
**Created:** 2026-05-08

## Problem

Today's chunker uses one chunk size (~50 lines) for every embedder.
That breaks on short-context embedders:

- MiniLM: 256-token context
- BGE-small: 512-token context
- jina-code: 8192-token context

A 50-line code chunk often exceeds 256 tokens. MiniLM silently
truncates mid-chunk, and the embedding represents only the first
~200 tokens. The user thinks they're benchmarking MiniLM at full
strength; they're actually benchmarking "MiniLM on the first half
of every chunk." Multi-embedder comparisons are unfair until this
lands.

## Acceptance (from ROADMAP.md v0.3)

- Chunks resize per embedder context window
- BM25 path unchanged (BM25 doesn't care about token windows)
- Bench re-published; instruct embedders show their real numbers
- Cache key bumps so old caches don't get reused with new windowing

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** each embedder declares its `contextTokens`
   in the model catalog; chunker reads it; chunks are sized to
   `0.8 * contextTokens` (leaves headroom for tokenizer overhead).
2. **Declarative override:** `BuildIndexOptions.chunker.maxTokensPerChunk`
   forces a specific size regardless of embedder.
3. **Code-level extension:** N/A for v0.3 — the chunker pipeline is
   not currently a public extension point.

## Open questions

- Token count is approximate before tokenizer-specific encoding.
  Use a tokenizer-aware probe (call `provider.embed(probe)` on a
  representative chunk and measure)? Or use a heuristic
  (`bytes / 3.5` for English-heavy code)?
- Cache implication: chunk size now varies per (corpus, embedder)
  pair. Cache key needs the embedder model id, not just the
  state_id.
- Does this interact with v0.10 (hierarchical retrieval)? File-level
  summaries don't have the same constraint; they're shorter than any
  context window. Should be independent — confirm during design
  phase.

## Status note

This is a Stub. Full design (Proposal, Alternatives, Test plan)
lands when v0.3 becomes the next release. Until then, this
captures intent so the strategic context isn't lost.
