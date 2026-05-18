# Auto-Ship Deferred Register

Minor / nit findings recorded during auto-ship runs but not fixed in the
landing PR. Append-only.

## Run: 20260518-151152-per-model-chunk-windowing

Source journal: `.auto-ship/runs/20260518-151152-per-model-chunk-windowing.md`
Date: 2026-05-18

- **[MAJOR→deferred] `packages/search/src/chunker/rewindow.ts:88` — `countTokens`
  non-additivity across newline joins.** The greedy windower sums per-line token
  counts and trusts `countTokens(a + "\n" + b) === countTokens(a) + countTokens(b)`
  (design D6). A BPE/SentencePiece tokenizer can violate this, so an assembled
  window could exceed the budget by a token or two. Deferred: the design (D6 +
  the "Alternatives considered" rejection of per-window re-tokenization) made
  this tradeoff deliberately, and it has ~no impact on the four scoped
  embedders — MiniLM/BGE are WordPiece (additive across `\n`), jina-code's
  8192-token window means the windower almost never fires, potion is windowless.
  A real fix (re-verify each assembled window) would deviate from design D4.

- **[MINOR] `packages/search/src/search.ts:388,852` — `provider.embed("")`
  prime can abort the build/refresh.** If priming throws, `buildIndex` /
  `refreshStale` fail. Unreachable in practice: the build primes and embeds
  successfully before any `refreshStale`, so the provider is warm (in-memory,
  no network) by then. Could wrap in try/catch for resilience.

- **[MINOR] `packages/search/src/embed/transformers.ts` — silent windowing skip
  when `model_max_length` is a sentinel.** `effectiveContextTokens` returns
  `undefined` for a missing/sentinel `model_max_length`, so windowing is skipped
  with no diagnostic. No real embedder hits this; a `BuildIndexProgress` warning
  event would surface it if one ever did.

- **[MINOR] `packages/search/src/chunker/rewindow.ts:201` — `charSplit` shrink
  loop never grows back.** For a pathological single line that is one giant
  low-entropy token (100KB minified blob), an over-shrunk piece size carries
  forward and produces many tiny fragments. Terminates correctly and respects
  the budget; just not optimal. A bounded binary search would fix it.

- **[NIT] `rewindow.ts:25` — `EST_CHARS_PER_TOKEN` reused for two conceptually
  distinct ratios (bytes/token in the heuristic, chars/token in `charSplit`).**
  Coincidentally equal; could be two named constants.

- **[NIT] `rewindow.ts` — `lines[idx] ?? ""` in `emitOversizeLine` is dead
  defensive code (`idx` is always in range).**
