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
**architectural delta** of the change. Three deterministic capabilities, all
computed on the existing model — no network, no LLM:

1. **The diff (M-B).** Added / removed / changed nodes; new and removed
   dependency edges; **a dependency cycle that did not exist on base** (in the
   *parsed-import* graph — see the honesty caveat in Architecture); `@sivru`
   blocks added / removed / field-changed.
2. **Hot spots (M-A).** A `churn × coupling` score per symbol/module, surfaced
   as a ranked "Attention" panel on the static System page and as context in
   the diff ("this change lands in a top-5 hot spot").
3. **Drift (M-A).** `@sivru` invariants whose linked test/code no longer holds,
   detected by reusing the DESIGN-0019 invariant→test linkage. The change that
   breaks an authored invariant is the one the gate exists to stop.

The static explainer is opened at onboarding; **the diff explainer runs on
every PR.** That is the habit change.

## Eng-review revisions (2026-06-12, `/plan-eng-review` + outside voice)

The review reshaped the gate posture and several mechanics. Locked decisions:

- **Slice 1 ships the diff as a REPORT, not a gate.** `--diff` emits the
  architectural delta (text + JSON) on every PR as a review aid. `--gate`
  does **not** ship in v0.14. Rationale (outside voice C2/M2/M3): a
  module-level new-cycle gate is the *weakest* signal — it is a no-op on a
  single-package repo (one module can't form a module cycle), commodity
  (madge / dependency-cruiser do it finer), and has no suppression, so gating
  it *before* the differentiated drift signal risks teams deleting `--gate`
  from CI on the first false fail. The diff is valuable informational on every
  PR; the **gate waits for the signal worth gating on**.
- **`--gate` lands in v0.15 with the drift signal AND a suppression baseline.**
  It gates on a broken `@sivru` invariant→test linkage (the moat) and a new
  cycle, and a `.sivru/gate-allowlist` (or a baseline file) ships in the same
  release so a known-accepted finding is suppressible without disabling the
  gate.
- **Drift = linkage integrity only (v1).** DESIGN-0019's `enforced-by` check
  verifies the linkage *resolves*; it does not run the test or judge the code
  semantically. So the drift gate fails only when the diff **deletes/renames
  the `enforced-by` test or breaks the linkage** for an invariant on a touched
  symbol. It does NOT execute tests (that would duplicate CI's test job) or
  claim to detect semantic violation (undecidable). Invariants with
  `enforced-by: null` are **unguardable** and are reported as such, never
  silently "passed".
- **"Changed node" compares structural fields only** (`exports`, `depEdges`,
  `collaborators`, `block`) — never `churn`, which shifts on nearly every node
  between base and head and would flood the diff. Churn delta is reported
  separately.
- **Exit-code contract:** `0` = clean/no gate, `1` = gate fired (a named
  regression), `2` = could-not-evaluate (base unfetchable, worktree failed —
  `SIVRU-E2013`). A could-not-evaluate is **loud** (exit 2 + a CI annotation),
  never a silent exit 0 — a gate that silently turns itself off is worse than
  no gate.

## Architecture

### Base model via a temporary git worktree

The model builder reads the working tree, so "the repo as it was at `base`"
is materialized by checking it out — reusing `buildExplainerModel` verbatim,
correct by construction, zero new plumbing in `packages/search`.

```
resolve baseRef          # default: merge-base(HEAD, origin/<default>); override via --base
worktreePath = <cacheDir>/base-worktrees/<sha(baseRef)>   # STABLE per ref (see cost note)
flock(worktreePath):                                       # serialize concurrent gate runs
  git worktree prune                                       # clear a crashed run's stale entry
  git worktree add --force <worktreePath> <baseRef>        # idempotent re-add
  modelBase = projectModel(<worktreePath>)
modelHead = projectModel(.)
delta     = diffModels(modelBase, modelHead)
# worktree is reused across runs (not removed); `git worktree prune` collects orphans
```

**Cost, honestly (review C3).** The model cache is keyed by
`sha256(repoPath)/stateId` — *path-dependent*. The **stable** worktree path
per base ref is what lets the base model cache-hit across runs; a temp path per
run would miss every time. But the **HEAD** model is the expensive one and is a
**cold build every PR** in CI — CI's HEAD is a synthetic merge commit with a
unique sha, so a fresh `stateId` → a full symbol-index build + churn walk each
run. So the real per-PR cost is ~one cold model build (seconds on a few-k-file
repo), not "free". This goes behind the perf gate; the base-cache only saves the
*second* model.

**Concurrency + shallow clones (review M1, A4).** The stable per-ref path is
shared, so two PRs on the same base race — serialize with a file lock and
`prune` + `add --force` to survive a killed run that left a registered
worktree. The gate's home is CI, which often shallow-clones (`fetch-depth: 1`);
`merge-base` and `worktree add <base>` need history, so the design **requires
`fetch-depth: 0`** and, when the base commit is genuinely absent, exits `2`
(could-not-evaluate) loudly — never a silent pass.

**Version skew (review M4).** The base model is built by *whichever sivru is
installed now* (the worktree rebuilds, it does not reuse a stale cache across
builder versions). The model is stamped with a builder/grammar version; a diff
across mismatched builder versions is refused (the edge-derivation logic must
match or phantom edges/cycles appear).

### `diffModels(base, head) → ArchDelta`

Index both models by node `id` (`module:…`, `package:…`, `symbol:path#name`).
All of these read fields the model **already carries** (`derived.depEdges`,
`derived.churn`, `block`, `blockHash`):

- **nodes** — `added` (in head, not base), `removed` (in base, not head),
  `changed` (same id, different **structural** fields: `exports`, `depEdges`,
  `collaborators`, `block`). **`churn` is excluded** from the change test — it
  shifts on nearly every node between base and head (the diff adds a commit) and
  would flood the result; churn delta is reported separately (review A2).
- **edges** — `head.depEdges − base.depEdges` = **new coupling**;
  `base − head` = removed. Module/package granularity.
- **cycles** — build the module dependency graph at base and head; find
  strongly-connected components (Tarjan) of size > 1 plus self-loops;
  `cyclesHead − cyclesBase` = **new cycles**. Rendered as a **canonicalized**
  string (lexicographically smallest rotation) so the same diff prints the same
  cycle across runs (review m1), and **naming the specific edge that closed it**
  so a human can judge (review A5).
  - **Honesty caveat (review C1/C2).** `depEdges` is the *parsed-import* graph —
    edges come only from files the symbol index parsed (no JSON/generated/`.d.ts`,
    no dynamic `import()` the parser misses), so a cycle through those is
    invisible. And module granularity is coarse: a single-package repo has one
    module and **cannot** form a module cycle. This is why Slice 1 ships the
    cycles **informational, not gated** — the report says "new cycle in the
    parsed-import module graph", not "your architecture got worse". Finer
    granularity (package, then symbol) and edge-coverage measurement precede any
    gate on this signal.
- **blocks** — `@sivru` blocks `added` / `removed` / `changed` (compare
  `blockHash`, already on each node). The authored-intent delta of the PR.
- **drift** (v0.15) — for each touched symbol carrying an `@sivru` block, check
  the DESIGN-0019 invariant→test **linkage**: did this diff delete/rename the
  `enforced-by` test, or does the linkage no longer resolve? → `brokenLinkages`.
  Invariants with `enforced-by: null` are reported as **unguardable** (review
  m2), never counted as passing. The check does **not** run tests or judge
  semantics (see Eng-review revisions).
- **hotspots** (v0.15) — touched symbols ranked by `hotScore` (below); flag
  those in the repo's top-N.

### Hot-spot score (M-A) — a model field, not a new input

Add to `ExplainerNode.derived`:

```
hotScore = churn × (inDegree + outDegree)     // coupling = dep-graph degree
```

Pure computation over the existing model (`churn` is already there; degree is
counted from `depEdges`). The static System page renders a ranked **Attention**
panel; the diff reuses the score for "you touched a hot spot" context. No new
data, deterministic, on-thesis.

### `--gate` (v0.15, NOT Slice 1)

`--gate` does not ship in v0.14 (see Eng-review revisions). When it lands in
v0.15 it exits with the codes above (`1` = fired, `2` = could-not-evaluate) when
the delta contains **either**:

- **(a)** a new dependency cycle (once the signal is finer than module-level and
  edge-coverage is measured), **or**
- **(b)** a broken `@sivru` invariant→test linkage (the moat — the diff
  deleted/renamed an `enforced-by` test on a touched symbol).

It ships with a `.sivru/gate-allowlist` (baseline) so a known-accepted finding
is suppressible without disabling the gate — a gate with no escape hatch gets
deleted from CI on the first false fail.

### Outputs

- **Text** (default; the CI log) — a compact, scannable summary:
  ```
  Architectural delta vs <base> (3 files):
    edges     +2  -0
    cycle     NEW (parsed-import, module): auth → session → auth
              closed by new edge: session → auth   (report-only in v0.14)
    blocks    1 changed (rankResults: responsibility), 1 added
    linkage   BROKEN: ChurnAgg — enforced-by churn.test.ts was deleted   (gate: v0.15)
    hot spot  touched model.ts (rank #2 by churn×coupling)               (v0.15)
  ```
- **`--json`** — the full `ArchDelta` (its schema is the tooling contract; locked
  in the Slice 1 implementation).
- **HTML diff view** (`--diff --html`) — the changed slice of the map,
  highlighted. **Deferred**; v0.14 is text + JSON (CI-first).

## CEO-review decisions (2026-06-12, `/plan-ceo-review`, SELECTIVE EXPANSION)

- **Strategy confirmed: ship as planned** (v0.14 diff report → v0.15 gate +
  drift), over folding into one release or pivoting Move 1 to the agent map
  (M-C). The worktree/diff plumbing de-risks the gate and works on any repo day
  one; the diff core is already built.
- **Accepted expansion — `--format=github` in v0.14** (eng-review-2: pinned to a
  **markdown PR comment body**, NOT inline annotations). The arch delta is a
  repo-level summary (cycles/edges between modules), not anchored to a changed
  line, so a single PR comment is its natural home; GitHub Actions inline
  annotations (`::warning file,line::`) are deferred to the v0.15 gate when
  findings are line-specific (the closing edge's file:line). sivru **emits** the
  markdown to stdout and the CI workflow posts it — `gh pr comment`, finding +
  replacing one comment by a hidden marker so it never spams a comment per push.
  sivru never handles a GitHub token (credential-free, on the privacy thesis);
  if posting context is absent it degrades to plain stdout, exit unaffected.
  The formatter escapes node/module names (a name with backticks or `|` can't
  break the markdown).
- **Folded UX:** an explicit "no architectural change" green signal when a PR is
  structurally inert (builds trust), and impact-ordering so the report leads
  with cycles > new cross-module edges > block changes.
- **Deferred:** the HTML diff view (`--diff --html`) — its own later move, not a
  v0.14 lean-foundation fit.

## Slicing (build order)

The doc covers all of Move 1; the build ships in three releases. Per the eng
review, the **diff is a report in v0.14**; the **gate** waits for v0.15 so it
gates on the differentiated signal with an escape hatch.

| Slice | Ships | Scope |
|------:|-------|-------|
| 1 | v0.14.0 | `sivru explain --project --diff` as a **report** (text + JSON + `--format=github` markdown PR-comment body, emitted to stdout for the CI workflow to post/update by a marker): the model diff — added/removed/changed nodes (structural), new/removed edges, new cycles (parsed-import, module-level, informational), `@sivru` block changes; impact-ordered, with a clear "no architectural change" signal. No `--gate`. The deterministic M-B core + the worktree/diff/exit-code plumbing. |
| 2 | v0.15.0 | Hot spots: `hotScore` on the model + the ranked **Attention** panel on the static System page + hot-spot context in the diff. (M-A hot-spots.) |
| 3 | v0.15.0 | **The gate + drift:** `--gate` (exit codes + `.sivru/gate-allowlist` baseline) firing on a broken invariant→test linkage and a new cycle; the `@sivru` linkage check wired into the diff. (M-A drift — the moat.) |

Deferred: the HTML diff view; gating on new cross-layer edges (needs FP data).

## Reuses (no new machinery for the core)

- `buildExplainerModel` / `projectModel` / the stateId model cache
  (DESIGN-0018) — verbatim, just pointed at the base worktree.
- The model's `depEdges`, `blockHash`, `churn` — already computed in Slice 1
  of DESIGN-0018.
- DESIGN-0019 invariant→test linkage (E230/E231/E232) for the drift check.
- `git worktree` — already part of the project's own workflow.

## Resolved questions (eng review)

- **Gate home** → `--diff --gate` (it is about a *change*); `checkup` stays
  about the static repo state. Resolved.
- **Cycle granularity** → module-level for the v0.14 **report** (the cycle is
  informational, so coarseness is disclosed, not gated). Before any **gate** on
  cycles, move to package- then symbol-level and measure edge coverage (review
  C2). Resolved for v0.14; revisited before the cycle gate.
- **Base ref default** → `merge-base(HEAD, origin/<default>)`, override via
  `--base=<ref>`. Requires `fetch-depth: 0` in CI; absent base → exit 2.
  Resolved.
- **Worktree cost** → one cold HEAD build per PR (the base caches via the stable
  path); behind the perf gate. Resolved (review C3).

## Test plan

```
diffModels(base, head)                          unit, pure — the core
  ├── added / removed nodes per level            [★★★] node-set diff
  ├── changed node = STRUCTURAL only             [★★★] churn-only change → NOT flagged (review A2)
  ├── new / removed edges                        [★★★] edge-set diff
  ├── new cycle (Tarjan SCC)                     [★★★] base has cycle → not re-reported; new back-edge → reported
  │                                              [★★★] canonical render: same diff → same string (review m1)
  │                                              [★★]  single-module repo → no cycle possible (review C2, documented)
  ├── block added/removed/changed (blockHash)    [★★★]
  └── (v0.15) broken invariant linkage           [★★★] enforced-by test deleted → flagged; enforced-by:null → unguardable, not passed
worktree orchestration (injected git)            [★★] add/prune/lock/remove; stale worktree → prune+force recovers
  └── base ref absent (shallow clone)            [★★★] → exit 2, loud, NOT exit 0 (review M5)
exit codes                                       [★★★] 0 clean · 1 gate-fired · 2 could-not-evaluate
output: text + JSON ArchDelta schema             [★★] snapshot the JSON contract
integration (real worktree on a temp repo)       [★★★] introduce a real back-edge across two modules → appears in delta
```
`diffModels` is a pure function over two `ExplainerModel`s, so the algorithm is
fully unit-testable with constructed models; the worktree/git layer is injected
(like the DESIGN-0018 `feedback/apply` deps) so the orchestration tests need no
real checkout.

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

- **Slice 1 (v0.14, report — NO gate):** `sivru explain --project --diff
  [<base>]` emits the architectural delta (structural added/removed/changed
  nodes, new/removed edges, new cycles in the parsed-import module graph
  labelled informational, `@sivru` block changes) as text and `--json`. Base
  model built via a stable per-ref worktree (locked, prune-recovered); HEAD
  cold-build behind the perf gate. Absent base → exit 2, loud. Deterministic;
  no network; no `--gate`.
- **Slice 2 (v0.15):** the model carries `hotScore`; the static System page
  ranks an Attention panel; the diff flags changes touching top-N hot spots.
- **Slice 3 (v0.15, the gate):** `--gate` with the exit-code contract + a
  `.sivru/gate-allowlist` baseline, firing on a broken `@sivru` invariant→test
  linkage (naming the block + the broken `enforced-by`) and a new cycle;
  `enforced-by: null` invariants reported unguardable.

## Error codes + exit contract

- New `SIVRU-E2013` — base ref not found / worktree setup failed → process
  **exit 2** (could-not-evaluate), loud.
- Exit codes: **0** = clean / no gate, **1** = gate fired (named regression),
  **2** = could-not-evaluate. A gate failure is an exit code + named-reason
  message, not a thrown error (expected CI outcome, not a fault). Exit 2 is
  never silently swallowed to 0.

## Relationship to existing designs

- **DESIGN-0022** — the spine; this is its Move 1.
- **DESIGN-0018** — the model this diffs.
- **DESIGN-0019 / DESIGN-0005** — the invariant→test linkage and coach loop the
  drift check reuses.

## What already exists (reused, not rebuilt)

- `buildExplainerModel` / `projectModel` / the model cache (DESIGN-0018) — the
  base + head models, verbatim.
- `derived.depEdges`, `blockHash`, `churn` on the model (DESIGN-0018 Slice 1) —
  the diff reads them; no new extraction.
- DESIGN-0019 `enforced-by` invariant→test linkage — the drift check (v0.15).
- The injected-deps test pattern (DESIGN-0018 `feedback/apply`) — the worktree
  orchestration tests reuse it.
- `git worktree` — already in the project's own dev flow.

## NOT in scope

- **`--gate` in v0.14** — deferred to v0.15 (ships with drift + a baseline; a
  gate on the weak module-cycle signal alone burns adoption).
- **Running tests for semantic invariant violation** — the drift gate is
  linkage-integrity only; executing `enforced-by` tests duplicates CI's test job
  and is a scope balloon.
- **Symbol-level cycle detection** — v0.14 reports module-level; finer
  granularity precedes the cycle *gate*, not the report.
- **HTML diff view** (`--diff --html`) — text + JSON first (CI-first).
- **Gating on new cross-layer edges** — needs field FP data first.
- **The agent map (M-C)** and **authored-story (M-D)** — separate DESIGN-0022
  moves.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 2 | CLEAR | SELECTIVE EXPANSION: strategy confirmed (ship as planned); 1 expansion accepted (`--format=github`), 2 UX folded, 1 deferred (HTML diff) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR | run 1: 6 findings (1 fork, 5 folded) + outside voice; run 2 (post-CEO expansion): pinned `--format=github` to a markdown PR comment (annotations deferred to the gate), escaping + update-in-place folded |
| Outside Voice | Claude subagent (codex account-blocked) | Independent challenge | 1 | issues_found | 3 CRITICAL / 5 MAJOR / 3 MINOR — 1 strategic fork resolved, rest folded |

- **OUTSIDE VOICE (eng review):** read `model.ts` and found the signal-quality + adoption gaps the review missed (parsed-import edge graph C1, module-cycle no-op C2, cold HEAD build C3, concurrency M1, no escape-hatch M3, version skew M4, exit codes M5). Reshaped the gate posture.
- **CROSS-MODEL TENSION (resolved):** Eng review shipped a cycle gate in Slice 1; outside voice argued the gate is premature on a weak commodity signal. **Chose: Slice 1 = diff report only; `--gate` waits for v0.15 with drift + a baseline.** Granularity/honesty findings folded.
- **CEO DECISIONS:** ship as planned (over fold-into-one-release / pivot-to-agent-map); **accepted** `--format=github` PR-surfaced output in v0.14 (the report appears on the PR, not just CI logs; sivru emits, CI posts — credential-free); folded the "no architectural change" signal + impact-ordering; deferred the HTML diff view.
- **UNRESOLVED:** none.
- **VERDICT:** CEO + ENG CLEARED — design settled (v0.14 diff report incl. `--format=github` → v0.15 gate+drift), ready to implement Slice 1.
