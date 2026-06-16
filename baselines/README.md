# `map` baselines — reliable regression testing for DESIGN-0024

The `map` MCP tool / `sivru map` CLI is exercised against **public** repositories
so the baselines are shareable and reproducible by anyone. Re-run the harness and
diff the JSON against the committed baseline.

## Corpora (all public)

| Repo | Lang | Why |
|------|------|-----|
| [`vuejs/core`](https://github.com/vuejs/core) | TypeScript (pnpm monorepo) | blast-radius (`dependsOn`/`dependedOnBy`), module cycles, module roles |
| [`google/gson`](https://github.com/google/gson) | Java (Maven) | Java symbol extraction, hot/collaborators, and the F1 limitation |
| this repo (`sivru`) | TypeScript | self-check: dep edges, cycles, real `@sivru` drift |

Clone once (full clone — churn drives the `hot` signal, so don't shallow-clone):

```bash
git clone https://github.com/vuejs/core.git   ~/dev/10xdelta/_qa-corpora/vue-core
git clone https://github.com/google/gson.git  ~/dev/10xdelta/_qa-corpora/gson
```

## Run

```bash
pnpm --filter @sivru/cli build      # build dist first

node packages/cli/scripts/map-baseline.mjs --cold --repo ~/dev/10xdelta/_qa-corpora/vue-core --out baselines/map-baseline.vue-core.json
node packages/cli/scripts/map-baseline.mjs --cold --repo ~/dev/10xdelta/_qa-corpora/gson     --out baselines/map-baseline.gson.json
node packages/cli/scripts/map-baseline.mjs --cold --repo .                                    --out baselines/map-baseline.sivru.json
```

`--cold` clears the model + health caches first (true model-projection cold).

## Baseline numbers (captured 2026-06-14, build 6680abb, repos at their `main`)

| Repo | files / symbols / modules | cold load | warm slice p50/p95 | hot / cycle / drift / unguardable |
|------|---------------------------|-----------|--------------------|-----------------------------------|
| vue-core | 701 / 829 / 16 | ~3.9 s | 0.2 / 1.3 ms | 25 / 31 / 0 / 0 |
| gson | 310 / 2395 / **1** | ~1.1 s | 0.7 / 2.9 ms | 25 / 0 / 0 / 0 |
| sivru | 480 / 532 / 5 | ~3.9 s | 0.2 / 1.0 ms | 25 / 19 / 1 / 28 |

All three: every entry shape returns the right `kind`; errors carry `SIVRU-E249`;
warm slice lookup is well under the design's sub-10 ms target. (A separate run on
a 5.7k-file repo measured cold ~7.8 s / warm slice p95 7.2 ms — the perf envelope
the design referenced.)

## What `map` delivers per language

`map` projects the `ExplainerModel`, whose **module graph is package.json-based**
and whose **import resolution is JS/TS-path-based**:

| Signal | vue-core (TS) | gson (Java) |
|--------|:---:|:---:|
| `hot` rank, `collaborators`, task, did-you-mean, authoring-gap | ✅ | ✅ |
| `dependsOn` / `dependedOnBy` (blast radius) | ✅ 7 / 5 | ❌ empty |
| `inCycle` (module cycles) | ✅ 31 | ❌ none |
| authored `role` / `responsibility` / `driftBroken` / `unguardable` | ✅ (when `@sivru` blocks exist) | ✅ (same) |

**F1 (limitation, not a regression):** on a Java/Maven repo the whole backend
collapses into one edgeless module `"."` (gson: `modules: 1`), so blast-radius and
module cycles are empty. Consistent with the design's "parsed-import graph"
caveat, but it means blast-radius is a JS/TS-only signal today. Java symbol
extraction, hot, collaborators, authored intent, and drift all work. Candidate
follow-up: Maven/Gradle module detection + a Java import resolver.

## Fork-and-annotate demo (how the AUTHORED half works)

Vanilla public repos carry no `@sivru` blocks, so `role` / `driftBroken` /
`unguardable` are dark. Forking and adding one annotated symbol lights them up —
this is what sivru is *for*. Reproduced on both languages (branch `sivru-demo`):

**TypeScript (vue-core):** added `packages/shared/src/sivruDemo.ts` with an
`@sivru` block (one `enforced-by` test linkage + one `enforced-by: null`) and the
enforcing test. `sivru map …::normalizeTag`:
- surfaced `role: demo-normaliser`, the responsibility, both invariants;
- **blast radius**: `@vue/shared` is *depended on by 11 modules* (the real "who
  breaks if you change this");
- `unguardable: "never mutates a caller-owned object"`; `authoring` gone;
- then **deleting the enforcing test** flipped it to
  `driftBroken: "normalizeTag lowercases and trims its input" → …spec.ts (file not found)`.

**Java (gson):** added an annotated `SivruDemo` class + `SivruDemoTest`.
`sivru map …::SivruDemo` surfaced `role: demo-slugger`, responsibility, the
`unguardable` invariant; deleting the test produced
`driftBroken: "slug trims and lowercases its input" → …SivruDemoTest.java (file not found)`.

Note: `map` serves-stale, so after editing a tracked file you either get a
`freshAsOf … [STALE]` slice (lagging by one build) or, for a fresh slice, clear
the cache (`rm -rf ~/.cache/sivru/explainer-{models,health}`). The demo cleared
the cache to show the new annotation immediately.

## Regression gate (what to assert on re-run)

1. **Contract**: each shape returns its expected `kind` (symbol/file → `slice`,
   task → `candidates`, typo/miss → `error` + a `SIVRU-E` code).
2. **Latency envelope**: warm slice p95 < 50 ms; cold within ~1.5× baseline.
3. **Signal liveness**: vue-core `nodesInCycle > 0` and a sampled symbol with
   `dependsOn > 0`; all repos `nodesWithHot == HOT_RANK_LIMIT (25)`.
4. **No crash on any shape**: all 5 snapshots emitted.

Compare *shape and envelope*, not exact content (file counts / candidate names
drift as the upstream repos move).
