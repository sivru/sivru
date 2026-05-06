# Sivru benchmarks

Two benchmark suites live here, per DESIGN.md §20.3 and §13.10.

## Retrieval quality (NDCG@10)

**Goal:** measure search-result quality. CI gates PRs at `baseline − 0.02` once
the W2 sivru engine lands.

**W0 corpus:**

Three OSS repos pinned by SHA in `repos.json`: `colinhacks/zod` (TS),
`psf/requests` (Python), `google/gson` (Java). Each has 20 hand-labeled
queries spanning architecture / behavior / error-path / api / data-flow
categories — 60 queries total. v0.2 grows the corpus from real sivru
user search patterns.

The metric (`metrics.ts`) and runner (`runner.ts`) score any
`(filePath, score)` adapter against this corpus. The W2 sivru engine
adapter lands here; it becomes the CI quality gate per DESIGN.md §13.10.

**Layout:**
```
benchmarks/
├── repos.json                   # 3 pinned repos (zod, requests, gson)
├── annotations/                 # 20 labeled queries per repo (60 total)
│   ├── zod.json
│   ├── requests.json
│   └── gson.json
├── src/
│   ├── metrics.ts               # NDCG@k (textbook DCG/NDCG)
│   ├── metrics.test.ts          # unit tests
│   ├── runner.ts                # adapter-driven NDCG@10 runner
│   └── types.ts
├── tsconfig.json
└── README.md                    # this file
```

**Annotation format** (per query, file-level grade):
```json
{
  "query": "how HTTP requests are dispatched through the configured adapter",
  "relevant": ["lib/core/dispatchRequest.js"],
  "secondary": ["lib/adapters/adapters.js"],
  "category": "architecture"
}
```

`relevant` files are graded 1; `secondary` are graded 0 in v0 (used for
per-category breakdown reports only). `category` is for slicing reports;
not part of scoring.

**Runner contract:** `RetrievalAdapter = (repo, query, topK) → Promise<RetrievalResult[]>`.
Adapters are pluggable so we can score the sivru engine (W2+ continuously) and
any other retrieval method on the same data.

**Run:**
```bash
# One-time: clone the 3 corpus repos at their pinned SHAs (~130 MB).
pnpm --filter @sivru/benchmarks fetch-corpus

# BM25-only mode — fast, no model required.
pnpm --filter @sivru/benchmarks bench

# Hybrid mode (BM25 ⊕ semantic cosine, RRF-merged) — downloads the
# default Transformers.js model on first run (~25 MB to ~/.cache/sivru/models/).
pnpm --filter @sivru/benchmarks bench --hybrid
```

**Current baselines** (captured 2026-05-04, all with the on-disk index
cache enabled — second runs of the same mode are sub-second):

| Mode                                       | zod (TS) | requests (Py) | gson (Java) | overall (60q) |
|--------------------------------------------|---------:|--------------:|------------:|--------------:|
| `sivru-bm25` (W2 Pass 1, no signals)       |   0.4700 |        0.6003 |      0.5001 |        0.5235 |
| `sivru-hybrid` (W2 Pass 2, no signals)     |   0.6660 |        0.7531 |      0.5613 |        0.6601 |
| `sivru-bm25` + W3 signals **(default)**    |   0.6590 |        0.5922 |      0.5288 |    **0.5933** |
| `sivru-hybrid` + W3 signals (opt-in)       |   0.6834 |        0.6639 |      0.5333 |        0.6269 |

**Default modes** are the bold rows: BM25 ships with reranking signals on
(definition boost / multi-chunk file boost / path penalties / identifier-stem
matching, +13% over no-signal BM25). Hybrid ships with signals **off** — RRF
already merges BM25 and cosine, and stacking signals on top over-double-counts
on this corpus. Override per-call by passing `signals: true` / `false` to
`buildIndex`.

`baseline.json` is BM25 + signals; `baseline-hybrid.json` is hybrid.
The W3 invariant (`NDCG@10 ≥ baseline − 0.02`) is enforced against
`baseline.json` until W8 promotes it.

## Agent-task benchmark (Layer 3)

**Goal:** measure end-to-end token / turn / wall-time savings of `with-sivru`
vs `without-sivru` on realistic engineering tasks.

**W0 scope:**
- Harness scaffold (1 day): `runner.ts` that runs Claude Code headless with
  + without sivru in MCP, captures both sessions, diffs metrics.
- 5 starter tasks (one per OSS repo).

**W8 scope:**
- Extend to 20 tasks across fix-bug / add-feature / refactor / debug / docs.
- Run baseline + publish to README.
- Hard-fail CI on any release that drops below 50% median token savings.

## Status

W0: corpus + metric + runner shipped (60 labeled queries, stub adapter).
W2: sivru-engine adapter + first NDCG@10 baseline.
W8: agent-task suite + token-savings publish.
