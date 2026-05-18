# Auto-Ship Run: DESIGN-0002 Per-model chunk-windowing

**Design:** `docs/design/0002-per-model-chunk-windowing.md`
**Started:** 2026-05-18T09:41:52Z
**Branch:** `feat/per-model-chunk-windowing`
**Starting commit:** `6d5a02805229be7d5fa21db9c03d6c57e8f18b3b`
**Git revision:** `6d5a02805229be7d5fa21db9c03d6c57e8f18b3b`
**Mode:** normal

---
## Phase 3: Readiness Gate

### 3.1 Deliverable Enumeration

| # | Deliverable (design) | Maps to | Status |
|---|----------------------|---------|--------|
| 1 | `EmbeddingProvider` gains optional `contextTokens` + `countTokens` | `packages/search/src/embed/provider.ts` (MODIFY) | OK |
| 2 | Transformers.js providers implement both | `packages/search/src/embed/transformers.ts` (MODIFY) | OK |
| 3 | potion declares neither (windowless) | `packages/search/src/embed/potion.ts` (verify/comment) | OK |
| 4 | `rewindowForBudget` pure post-pass | `packages/search/src/chunker/rewindow.ts` (NEW) | OK |
| 5 | Token-greedy line windower (greedy split, ~12% overlap, un-splittable-line char-split, heuristic fallback) | `rewindow.ts` (NEW) | OK |
| 6 | `buildIndex` calls rewindow after `chunkFiles` | `packages/search/src/search.ts` (MODIFY) | OK |
| 7 | `refreshStale` re-windows freshly re-chunked files | `packages/search/src/search.ts` (MODIFY) | OK |
| 8 | Cache key gains `embedderId`; `CacheKey` type | `packages/search/src/cache/index.ts` (MODIFY) | OK |
| 9 | `CACHE_FORMAT_VERSION` 2 -> 3; v2 caches rejected | `packages/search/src/cache/index.ts` (MODIFY) | OK |
| 10 | buildIndex builds cache key with embedderId | `packages/search/src/search.ts` (MODIFY) | AMBIGUOUS (A1) |
| 11 | `chunkFile`/`treeSitterChunks`/`ChunkOptions` byte-for-byte unchanged | verify — no change | OK |
| 12 | `sivru bench models` shows raw context window | `packages/cli/src/commands/bench-models.ts` | ALREADY SATISFIED (line 39 prints `ctx`) |
| 13 | Bench re-published (MiniLM/BGE untruncated; BM25-only + hybrid separate) | operational | OUT OF AUTONOMOUS SCOPE (A2) |
| 14 | Perf gate re-baselined | operational | OUT OF AUTONOMOUS SCOPE (A2) |
| 15 | Tests per test plan (10 unit/integration scenarios) | `*.test.ts` (NEW) | OK |

- Total deliverables: 15
- Mapped: 15
- Ambiguous: 1 (A1)
- Already satisfied: 1 (#12)
- Out of autonomous scope: 2 (#13, #14 — operational)
- Blocked: 0

#### Ambiguities

- **A1 — embedderId plumbing.** Design §4 mandates `cacheKey = (repoPath, stateId, embedderId)` and says embedderId is `"bm25"` or "the model id", but does not specify how `buildIndex` obtains a model id from an opaque `EmbeddingProvider` (which today has no id). **Resolution (implementation decision, not drift):** add optional `readonly id?: string` to `EmbeddingProvider`; transformers/potion/http set it to their model id, mock to `mock-<dim>`. `buildIndex` uses `embed ? (provider.id ?? "embed") : "bm25"`.
- **A2 — bench/perf re-baseline are operational.** Acceptance criteria #13/#14 require downloading MiniLM/BGE models and re-running benchmarks, then a human accepting the new baseline numbers. Not autonomously shippable in a code PR. Flagged for human follow-up; excluded from this run's scope.
- **A3 — `countTokens` is sync but the tokenizer loads async.** Design declares `countTokens?(text): number` (sync). The transformers provider loads its pipeline lazily/async. The provider must pre-load a standalone tokenizer; `countTokens`/`contextTokens` are only valid after an async priming step. buildIndex will prime the provider before calling `rewindowForBudget`. Handled in implementation; no design change.
- **A4 — `model_max_length` sentinel.** Some HF tokenizers report a sentinel-huge `model_max_length`. `contextTokens` derivation clamps to a sane ceiling; omits `contextTokens` if absent/sentinel. Minor.

### 3.2 Completeness
- Red-flag grep: 1 hit (line 235, "Open questions" — non-load-bearing, an acknowledged open question). 0 in load-bearing sections.
- Required sections: Problem (present), Proposal/Design (present), Acceptance criteria (present), Test plan (present). Migration: cache format bump covered in §4. No DB schema. PASS.

### 3.3 Codebase Readiness
- Existing paths verified: 7/7 (provider.ts, transformers.ts, potion.ts, search.ts, cache/index.ts, types.ts, treeSitter.ts).
- New file parent dir `packages/search/src/chunker/` exists.
- No DB migrations in repo. Cache "migration" = `CACHE_FORMAT_VERSION` 2 -> 3 (v2 caches rejected on read, rebuilt once — by design).
- Branch: `feat/per-model-chunk-windowing` (dedicated feature branch).
- Uncommitted: `pnpm-lock.yaml` only — trivial pre-existing specifier pin (`^0.24.7` -> `0.24.7`), not authored by this run; will NOT be staged.
- Base build: PASS — `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` all green.

### 3.4 Sensitivity
- HIGH: none.
- MEDIUM: `packages/search/src/embed/*` (provider contract), `packages/search/src/chunker/rewindow.ts` (new core logic), `packages/search/src/search.ts` (buildIndex/refreshStale), `packages/search/src/cache/index.ts` (cache format).
- LOW: `packages/cli/src/commands/bench-*`.
- UNKNOWN: none.

### 3.5 Trust Boundaries
- Hard-stops: none. No auth/RBAC/tenant/credential/secret/IAM paths. Privacy boundary (`packages/observe/`) untouched — no network imports added anywhere.
- Acknowledgments needed: cache format bump 2 -> 3 invalidates all existing v0.2 on-disk caches (one-time cold rebuild). This is by design (§4) and low-risk.

### Decision
**Status:** READY (with acknowledged risks: cache invalidation 2->3; A1 resolved as implementation decision; A2 operational deliverables excluded.)

### Blockers
- None.

### 3.7 Human Approval
- Answer: **yes** (2026-05-18). Proceed autonomously; #13/#14 excluded as operational.

---

## Phase 4: Planning

### 4.2 File-Level Plan

#### Files to create
- `packages/search/src/chunker/rewindow.ts` — `rewindowForBudget` post-pass + token-greedy line windower
- `packages/search/src/chunker/rewindow.test.ts` — windower unit tests

#### Files to modify
- `packages/search/src/embed/provider.ts` — add optional `id`, `contextTokens`, `countTokens` to `EmbeddingProvider`
- `packages/search/src/embed/transformers.ts` — load standalone tokenizer; implement `id`/`contextTokens`/`countTokens`; add `prime()`-able tokenizer
- `packages/search/src/embed/potion.ts` — add `id` (model id); `contextTokens`/`countTokens` omitted (windowless)
- `packages/search/src/embed/mock.ts` — add `id`; optional `contextTokens`/`countTokens` for tests
- `packages/search/src/embed/http.ts` — add `id` (= model)
- `packages/search/src/cache/index.ts` — `CacheKey` gains `embedderId`; `CACHE_FORMAT_VERSION` 2->3; entry filename includes embedderId
- `packages/search/src/search.ts` — call `rewindowForBudget` in buildIndex + refreshStale; thread `embedderId` into cache key; prime provider tokenizer
- `packages/search/src/index.ts` — export `rewindowForBudget`
- `packages/search/src/embed/transformers.test.ts` — countTokens accuracy test
- `packages/search/src/cache/index.test.ts` — embedderId-keyed cache + v2-reject regression
- `packages/search/src/search.test.ts` — buildIndex integration (256-tok mock embedder)
- `packages/search/src/refresh.test.ts` — refreshStale re-window integration

#### Files to delete
- none

#### Migrations
- Cache: `CACHE_FORMAT_VERSION` 2 -> 3. v2 entries rejected on read (existing `formatVersion !== CACHE_FORMAT_VERSION` path), cold rebuilt.

### 4.3 Coverage Matrix

| # | Deliverable | Plan item | Covered? |
|---|-------------|-----------|----------|
| 1 | provider `contextTokens`+`countTokens` | provider.ts | yes |
| 2 | transformers implements both | transformers.ts | yes |
| 3 | potion windowless | potion.ts (id only) | yes |
| 4 | `rewindowForBudget` post-pass | rewindow.ts | yes |
| 5 | token-greedy windower | rewindow.ts | yes |
| 6 | buildIndex calls rewindow | search.ts | yes |
| 7 | refreshStale re-windows | search.ts | yes |
| 8 | cache key + `embedderId` | cache/index.ts | yes |
| 9 | `CACHE_FORMAT_VERSION` 3 | cache/index.ts | yes |
| 10 | buildIndex builds keyed cache | search.ts (+ provider.id) | yes |
| 11 | chunkFile/treeSitter/ChunkOptions unchanged | (no edit) | yes |
| 12 | bench models shows ctx | already satisfied | yes |
| 15 | tests | 5 test files | yes |

All rows covered. #13/#14 excluded by approval.

Budget: 0/30 iterations, ~3/360 min, 0/100 commits, 0/25000 lines

---

## Phase 5: Bounded Loop

### STEP 1: IMPLEMENT — iter 1
- Commit `adabcf4` — core: provider contract (`id`/`contextTokens`/`countTokens`),
  `rewindowForBudget` + windower, cache v3 + embedderId key, buildIndex/refreshStale wiring.
- Commit `d6298d8` — tests: rewindow.test.ts, windowing.test.ts, refresh.test.ts, transformers.test.ts.
- Implementation decisions: A1 → optional `id` on `EmbeddingProvider`. A3 → cold path
  primes the provider (`embed("")`) before windowing; `countTokens` throws SIVRU-E1004
  if used unprimed. A4 → `effectiveContextTokens` clamps a sentinel `model_max_length`
  to windowless. `exactOptionalPropertyTypes` → `contextTokens?: number | undefined`.
- Claimed error code: SIVRU-E1004 (rewindowForBudget bad budget; transformers countTokens unprimed).
Status: complete

### STEP 2: LAYERED BUILD & TEST — iter 1
- Layer A (search typecheck): PASS (after `exactOptionalPropertyTypes` fix).
- Layer B/C (search test): PASS — 277 passed, 7 skipped (network), 22 files.
- Layer E (full repo): `pnpm -r build` PASS, `pnpm -r typecheck` PASS (6 pkgs),
  `pnpm -r test` PASS — cli 168, benchmarks 57, observe/observe-ui green.
- Lint: stub (`echo TODO`) — nothing to gate.
Status: complete

Budget: 1/30 iterations, ~25/360 min, 2/100 commits, ~880/25000 lines

### STEP 3: PLAN VERIFY — iter 1
- /plan-verify docs/design/0002-per-model-chunk-windowing.md
- 34 contract items: 32 IMPLEMENTED, 2 DEFERRED (#24 bench re-publish, #25 perf
  re-baseline — operational, excluded by approval). 0 MISSING, 0 ORPHANED.
- Finding F1 (MINOR robustness): refreshStale windowing relied on build-time
  tokenizer priming; an unprimed provider would skip windowing silently.
  Fixed `f...` — defensive `provider.embed("")` before re-window.
- Re-ran STEP 2 Layer B (search typecheck + refresh/search/windowing tests): PASS, 31/31.
Status: complete

Budget: 1/30 iterations, ~30/360 min, 3/100 commits, ~900/25000 lines

### STEP 4: CODE REVIEW — iter 1
- gstack /review checklist not vendored in this repo; ran STEP 4 as two
  independent fresh-context reviewers (adversarial + six-dimension).
- Findings: 1 CRITICAL, 1 MAJOR (+ 1 MAJOR deferred), 1 MINOR fixed, 5 MINOR/NIT deferred.
- Fixed (commit c1df64e):
  - C1 CRITICAL — document instruction prefix not subtracted from the token
    budget; asymmetric models could still silently truncate. `effectiveContextTokens`
    now subtracts the document-prefix token count.
  - E1004 collision MAJOR — transformers countTokens-unprimed error reused
    SIVRU-E1004; reassigned to SIVRU-E1005.
  - M4 MINOR — `EmbeddingProvider.id` doc now states it must uniquely identify
    windowing behaviour (cache-collision guard).
- Deferred to .auto-ship/deferred.md: M1 (countTokens non-additivity — design
  D6 tradeoff, ~nil impact on scoped embedders), m1/m2/m3 + 2 nits.
- Re-ran STEP 2: search typecheck PASS, search test 277 PASS; full repo
  build/typecheck/test PASS (search 277, cli 168, benchmarks 57, observe 93,
  observe-ui 114).
- Claimed error code: SIVRU-E1005.
Status: complete

### STEP 5: QA — SKIPPED
- Design touches no UI (packages/observe-ui unchanged). Per the loop, QA is
  skipped with this note. No dev server needed.
Status: skipped (no UI changes)

Budget: 1/30 iterations, ~60/360 min, 4/100 commits, ~920/25000 lines

### STEP 6: SHIP — iter 1
- Sentinel: absent. Preflight: on feature branch `feat/per-model-chunk-windowing`, not main.
- gstack /ship is interactive and does release-framing (VERSION/CHANGELOG/gates);
  STEP 6 executed directly and deterministically instead: CHANGELOG [Unreleased]
  updated, branch pushed, PR opened. No merge, no push to main.
- Postflight: main unchanged at 6d5a028 (local + origin).

---

## Final Report

### Budget consumption
- Loop iterations: 1 / 30
- Wall clock: ~70 min / 360 min
- Commits on branch: 5 / 100
- Lines added: ~907 / 25000

### Steps
| Step | Attempts | Status |
|------|----------|--------|
| Implement | 1 | complete |
| Build & Test | 2 (initial + post-review) | complete |
| Plan Verify | 1 | complete (1 finding fixed) |
| Code Review | 1 | complete (2 fixed, 6 deferred) |
| QA | 0 | skipped — no UI changes |
| Ship | 1 | complete |

### git diff --stat main...HEAD
14 files changed, 907 insertions(+), 32 deletions(-)

### Commits (main..HEAD)
- adabcf4 auto-ship: per-model chunk-windowing core [step:1 iter:1]
- d6298d8 auto-ship: tests for per-model chunk-windowing [step:1 iter:1]
- 32ff48d auto-ship: prime provider before refresh windowing [step:3 iter:1]
- c1df64e auto-ship: address code-review findings [step:4 iter:1]
- (+ CHANGELOG / journal commit)

### Error codes claimed
- SIVRU-E1004 — rewindowForBudget: non-positive token budget
- SIVRU-E1005 — transformers provider: countTokens() before tokenizer load

- PR: https://github.com/sivru/sivru/pull/20
- Postflight: main unchanged at 6d5a028 (verified local + origin).
