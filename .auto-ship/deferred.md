# Auto-Ship Deferred Register

Minor / nit findings recorded during auto-ship runs but not fixed in the
landing PR. Append-only.

## Run: 20260518-151152-per-model-chunk-windowing

Source journal: `.auto-ship/runs/20260518-151152-per-model-chunk-windowing.md`
Date: 2026-05-18

### Resolved (post-review "fix all" pass)

The following were deferred at code-review time and then fixed on this
branch after the user asked to address all review findings:

- ~~countTokens non-additivity across newline joins~~ — `splitChunk` now
  re-verifies each assembled window against its real joined content and
  shrinks until it fits by `countTokens`'s own measure.
- ~~`provider.embed("")` prime can abort the build/refresh~~ —
  `primeAndResolveWindowParams` wraps the prime in try/catch.
- ~~`charSplit` shrink loop never grows back~~ — the piece-length guess
  now adapts both ways (halve on overshoot, double after headroom).
- ~~`EST_CHARS_PER_TOKEN` reused for two distinct ratios~~ — split into
  `HEURISTIC_BYTES_PER_TOKEN` and `CHARSPLIT_CHARS_PER_TOKEN`.

### Still open

- **[MINOR] `packages/search/src/embed/transformers.ts` — silent windowing
  skip when `model_max_length` is a sentinel.** `effectiveContextTokens`
  returns `undefined` for a missing/sentinel `model_max_length`, so
  windowing is skipped with no diagnostic. No real embedder hits this; a
  `BuildIndexProgress` warning event would surface it if one ever did.
  Not fixed: it needs a new progress-event type, which is beyond the
  windowing change.

- **[NIT] `packages/search/src/chunker/rewindow.ts` — `lines[idx] ?? ""`
  in `emitOversizeLine`.** `idx` is always in range, so the `?? ""` is
  never exercised at runtime — but it is required to satisfy
  `noUncheckedIndexedAccess`, so it is not removable dead code. Left as-is.
