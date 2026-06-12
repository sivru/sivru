# DESIGN-0023: Architectural diff + drift gate (the PR surface)

**Status:** Draft <!-- Stub → Draft → Accepted → Implemented → Superseded -->
**Targets:** v0.14.0 (Slice 1); M-A signals fold into v0.15.0 (Slices 2–3).
**Implements:** [DESIGN-0022](0022-explainer-reasoning-surface.md) **Move 1**
(M-A core ∪ M-B) — the differentiated 10x the CEO review named: *"where did
the code diverge from intent, and block the PR that breaks an invariant."*
**Builds on:** [DESIGN-0018](0018-codebase-explainer.md) (the `ExplainerModel`),
[DESIGN-0019](0019-block-reliability.md) (invariant→test linkage), the coach
loop ([DESIGN-0005](0005-coach-loop-skill-drift.md)).

## Problem

The static explainer ([DESIGN-0018](0018-codebase-explainer.md)) is opened at
onboarding — a quarterly artifact. But architecture doesn't erode at
onboarding; it erodes **one PR at a time**: a new import quietly creates a
dependency cycle, a refactor violates an `@sivru` invariant nobody re-read, a
hot file gets hotter. Code review looks at the *line* diff, never the
*architectural* diff. Sivru already builds a structural model of the repo
(System → Module → Package → Symbol, with dep edges, churn, and authored
`@sivru` intent). It should diff that model across a change and **block the
regressions** — that is the move that turns the explainer from a thing you
read once into a daily gate.

Nobody else gates a PR on authored-intent drift. This is the moat.

## Proposal

```
sivru explain --project --diff [<base>] [--gate] [--json]
```

Build the `ExplainerModel` at `base` and at `HEAD`, diff the two, and emit the
**architectural delta** of the change. `--gate` exits non-zero on a structural
regression or a violated authored invariant. Three deterministic capabilities,
all computed on the existing model — no network, no LLM:

1. **The diff (M-B).** Added / removed / changed nodes; new and removed
   dependency edges; **a dependency cycle that did not exist on base**; `@sivru`
   blocks added / removed / field-changed.
2. **Hot spots (M-A).** A `churn × coupling` score per symbol/module, surfaced
   as a ranked "Attention" panel on the static System page and as context in
   the diff ("this change lands in a top-5 hot spot").
3. **Drift (M-A).** `@sivru` invariants whose linked test/code no longer holds,
   detected by reusing the DESIGN-0019 invariant→test linkage. The change that
   breaks an authored invariant is the one the gate exists to stop.

The static explainer is opened at onboarding; **the diff explainer runs on
every PR.** That is the habit change.

## Architecture

### Base model via a temporary git worktree

The model builder reads the working tree, so "the repo as it was at `base`"
is materialized by checking it out — reusing `buildExplainerModel` verbatim,
correct by construction, zero new plumbing in `packages/search`.

```
resolve baseRef          # default: merge-base(HEAD, origin/<default>); override via <base>
git worktree add <tmp> <baseRef>
modelBase = projectModel(<tmp>)     # DESIGN-0018 builder; stateId-keyed cache → cheap on re-run
modelHead = projectModel(.)         # already cached at HEAD
delta     = diffModels(modelBase, modelHead)
git worktree remove <tmp>           # always, even on error (finally)
```

The model cache (keyed by `stateId`, DESIGN-0018) means the base model is built
once per base commit and reused across re-runs — a CI gate on a stable base is
near-free after the first run.

### `diffModels(base, head) → ArchDelta`

Index both models by node `id` (`module:…`, `package:…`, `symbol:path#name`).
All of these read fields the model **already carries** (`derived.depEdges`,
`derived.churn`, `block`, `blockHash`):

- **nodes** — `added` (in head, not base), `removed` (in base, not head),
  `changed` (same id, different `derived`/`block`). Grouped by level.
- **edges** — `head.depEdges − base.depEdges` = **new coupling**;
  `base − head` = removed. Module/package granularity (the model's edge
  granularity).
- **cycles** — build the module dependency graph at base and head; find
  strongly-connected components (Tarjan) of size > 1 plus self-loops;
  `cyclesHead − cyclesBase` = **new cycles**. The headline gate signal: a
  back-edge that made the layering circular.
- **blocks** — `@sivru` blocks `added` / `removed` / `changed` (compare
  `blockHash`, already on each node). The authored-intent delta of the PR.
- **drift** — for each changed symbol carrying an `@sivru` block, run the
  DESIGN-0019 invariant→test check: a block claims `enforced-by: X.test.ts`
  and this diff removed that test, or the linked invariant's test now fails →
  `violatedInvariants`.
- **hotspots** — changed symbols ranked by `hotScore` (below); flag those in
  the repo's top-N.

### Hot-spot score (M-A) — a model field, not a new input

Add to `ExplainerNode.derived`:

```
hotScore = churn × (inDegree + outDegree)     // coupling = dep-graph degree
```

Pure computation over the existing model (`churn` is already there; degree is
counted from `depEdges`). The static System page renders a ranked **Attention**
panel; the diff reuses the score for "you touched a hot spot" context. No new
data, deterministic, on-thesis.

### `--gate`

Exit non-zero (a distinct code) when the delta contains **either**:

- **(a)** a new dependency cycle, **or**
- **(b)** a new invariant violation (a block whose invariant→test linkage broke
  in this diff).

Both mean "the change made the structure or the authored intent worse." The
text/JSON output names exactly what failed and where. v1 gates on these two;
the set is configurable later (e.g. a new cross-layer edge) once we have field
evidence on false-positive rates.

### Outputs

- **Text** (default; the CI log) — a compact, scannable summary:
  ```
  Architectural delta vs <base> (3 files):
    edges     +2  -0
    CYCLE     NEW: auth → session → auth            ← gate
    blocks    1 changed (rankResults: responsibility), 1 added
    invariant VIOLATED: ChurnAgg — enforced-by churn.test.ts was deleted  ← gate
    hot spot  touched model.ts (rank #2 by churn×coupling)
  GATE: FAIL (1 new cycle, 1 violated invariant)
  ```
- **`--json`** — the full `ArchDelta` for PR bots / tooling.
- **HTML diff view** (`--diff --html`) — the changed slice of the map,
  highlighted. **Deferred** to a follow-up slice; v1 is text + JSON, because
  the gate lives in CI and CI consumes text/JSON.

## Slicing (build order)

The doc covers all of Move 1, but the build ships in three releases so the
deterministic structural core lands first:

| Slice | Ships | Scope |
|------:|-------|-------|
| 1 | v0.14.0 | The diff + structural gate: `--diff` model diff (nodes/edges/cycles/blocks) + `--gate` on new cycles. Text + JSON. The deterministic M-B core. |
| 2 | v0.15.0 | Hot spots: `hotScore` on the model + the ranked **Attention** panel on the static System page + hot-spot context in the diff. (M-A hot-spots.) |
| 3 | v0.15.0 | Drift gate: the `@sivru` invariant-drift check wired into the diff; `--gate` also fails on a violated invariant. (M-A drift, reuses the coach loop.) |

Deferred: the HTML diff view; gating on new cross-layer edges (needs FP data).

## Reuses (no new machinery for the core)

- `buildExplainerModel` / `projectModel` / the stateId model cache
  (DESIGN-0018) — verbatim, just pointed at the base worktree.
- The model's `depEdges`, `blockHash`, `churn` — already computed in Slice 1
  of DESIGN-0018.
- DESIGN-0019 invariant→test linkage (E230/E231/E232) for the drift check.
- `git worktree` — already part of the project's own workflow.

## Open questions

- **Gate home.** `explain --project --diff --gate` vs the coach `checkup`
  surface, or both? (DESIGN-0022 open Q.) Lean: the gate is `--diff --gate`
  (it is about a *change*); `checkup` stays about the static repo state.
- **Cycle granularity.** Module-level (clean; matches the model's edge
  granularity) vs symbol-level (finer, noisier). v1: module-level.
- **Base ref default.** `merge-base(HEAD, origin/<default>)` is the correct PR
  base; allow `<base>` override and a `--base=<ref>` flag.
- **Worktree cost on huge repos.** A base build on a 3k-file repo is seconds +
  one index; acceptable for a per-PR gate, and cached. If it proves too slow,
  revisit the git-read strategy (rejected here as invasive — see below).

## Alternatives considered

- **Build the base model from git refs without a checkout** — lighter at
  runtime but re-points the walker/chunker/symbol-index at a git object store,
  invasive plumbing across `packages/search` with its own bugs. Rejected: the
  worktree reuses everything and a per-PR gate doesn't need the runtime saving.
- **Diff-scoped recompute (changed files only)** — lightest, but a changed
  file can add/remove edges and cycles that touch *unchanged* modules; chasing
  transitive effects by hand risks missing exactly the cross-module
  regressions the gate exists to catch. Rejected on correctness.
- **LLM-summarized "what this PR changes architecturally"** — off-thesis
  (sivru never invents an explanation it can't trace), and the deterministic
  delta is more trustworthy in a gate. Not considered.

## Acceptance criteria

- **Slice 1:** `sivru explain --project --diff <base>` emits the architectural
  delta (added/removed/changed nodes, new/removed edges, new cycles, block
  changes) as text and `--json`; `--gate` exits non-zero on a new dependency
  cycle and names it. Base model built via a temporary worktree, cleaned up on
  every path. Deterministic; no network.
- **Slice 2:** the model carries `hotScore`; the static System page ranks an
  Attention panel; the diff flags changes touching top-N hot spots.
- **Slice 3:** the diff detects `@sivru` invariant violations via the
  DESIGN-0019 linkage; `--gate` also fails on one, naming the block + the
  broken linkage.

## Error codes

- New `SIVRU-E2013` — base ref not found / worktree setup failed.
- The gate failure is a process exit code (non-zero) + a named-reason message,
  not a thrown error (it is an expected CI outcome, not a fault).

## Relationship to existing designs

- **DESIGN-0022** — the spine; this is its Move 1.
- **DESIGN-0018** — the model this diffs.
- **DESIGN-0019 / DESIGN-0005** — the invariant→test linkage and coach loop the
  drift check reuses.
