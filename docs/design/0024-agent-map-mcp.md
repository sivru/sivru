# DESIGN-0024: The agent's working map (M-C, the platform layer)

**Status:** Accepted (CEO + Eng reviewed 2026-06-14; SCOPE EXPANSION → trimmed by
the outside voice → eng-hardened) <!-- Stub → Draft → Accepted → Implemented → Superseded -->
**Targets:** v0.15.0 (Slice 1).
**Implements:** [DESIGN-0022](0022-explainer-reasoning-surface.md) **Move 2**
(M-C) — *"expose the model as the context substrate an agent routes through,
so it grounds on the architecture instead of re-grepping every turn."*
**Builds on:** [DESIGN-0018](0018-codebase-explainer.md) (the `ExplainerModel`
+ the stateId model cache), [DESIGN-0023](0023-architectural-diff-gate.md) (the
M-A health signals — `hotScore`, cycle membership, drift linkage), the existing
MCP surface ([DESIGN-0003](0003-sivru-skill-package.md)/[DESIGN-0004](0004-sivru-explain.md)).

## Problem

The `ExplainerModel` is the best map of a repo sivru has — System → Module →
Package → Symbol, with dep edges, authored `@sivru` intent, churn, and (since
v0.14) hot-spot, cycle, and drift health. But **only humans can read it**:
`sivru explain --project` / `--html` is a CLI artifact. The agent doing the
actual editing — Claude Code, Cursor, Codex — never sees it. So every turn it
re-greps, re-reads files, and rebuilds a shallow mental model from scratch,
blind to the architecture a human onboarded through. It edits a symbol without
knowing the module's role, who depends on it, that it sits in a cycle, or that
its `@sivru` invariant's test was just deleted.

sivru already has the map. The move is to **hand it to the agent at the moment
it matters** — before it touches a symbol — as an MCP tool. This is the "host
more agent-helping tools" half of the long-term goal: the explainer makes
*every other coding agent* smarter on this repo, not just the human who ran the
CLI. It is the platform moat — the model becomes a substrate other agents
depend on.

Nobody else serves authored-intent + architectural health as agent context.

## Proposal

A new MCP tool — working name **`map`** — that, given the file/symbol an agent
is about to work on (or a free-text task), returns the relevant **slice of the
`ExplainerModel` plus its descriptive health**. Deterministic, no network, no
LLM: a projection of the already-built model, exactly like the rest of the
explainer.

```
mcp__sivru__map {
  path?: "<file>" | "<file>::<symbol>",   // target-based entry
  task?: "<free-text task>"                // task-based entry (returns candidates first)
}
  → // path given, or a candidate confirmed:
    {
      target:       { id, level, name, path, block?, declLine? },
      module:       { name, role?, responsibility?, churn, hotScore, rank },
      dependsOn:    NodeRef[],   // 1-hop: what the target's module imports
      dependedOnBy: NodeRef[],   // 1-hop: what imports it (the blast radius)
      collaborators: string[],   // symbol-level callees ∪ block.collaborators
      health: {                  // DESCRIPTIVE state, never a prediction (CEO review T1)
        hot:         { score, rank } | null,   // churn × coupling, repo rank
        inCycle:     { render } | null,        // the module is ALREADY in this cycle
        driftBroken: { rule, enforcedBy, reason }[],  // @sivru linkages that DON'T resolve now
        unguardable: { rule }[]                // invariants with enforced-by: null
      },
      authoring?: { stubHint: string }  // present ONLY when target has no @sivru block:
                                        // surfaces the GAP ("authoring this would let
                                        // sivru guard it"); does NOT hand over a fill-in
                                        // stub (CEO review T2 — no machine-authored intent)
    }
  → // task given (no path): candidates first, the agent confirms before a slice (CEO review T3):
    { candidates: { ref: NodeRef, score: number }[] }   // never auto-orient on the top hit
```

The agent calls it the way a careful engineer orients before a change: *"I'm
about to edit `AgentRunLoop.run`. What is this, what's around it, and is it
healthy?"* The tool answers in one call what would otherwise be five greps and
a guess — and it answers with the **authored intent** (the `@sivru` block) and
the **descriptive M-A health** (hot/cycle/drift), which greps can never surface.

**Honesty (CEO review T1).** `health` reports the target's *current* state, never
a prediction about an edit `map` hasn't seen. The "would my in-progress edit
break something" check already exists in the right tool — `explain diff:true`
("shows what an in-progress edit is about to break") — and is *not* duplicated
here under a name that overclaims. `map` orients; `explain --diff` judges an
actual edit; the PR gate (DESIGN-0023) blocks a regression. Three honest moments,
no overlap.

### What it serves (the slice)

Everything below is read off the cached `ExplainerModel` + the v0.14 health
passes. Nothing new is computed that the model doesn't already hold:

- **`target`** — the resolved node for `path`/`path::symbol`: its authored
  `@sivru` block (role, responsibility, invariants, decisions) when present, so
  the agent edits *with* the intent, not against it. When absent, the same
  "add `@sivru`" affordance the HTML view shows — a gap becomes an authoring
  prompt, not a guess.
- **`module` + neighbors** — the containing module's role/responsibility and
  its 1-hop dependency neighborhood (`dependsOn` / `dependedOnBy`). This is the
  blast radius: who breaks if the agent changes the contract.
- **`health`** — the M-A signals from DESIGN-0023, reused verbatim:
  - `hot` — `hotScore` (churn × coupling) + the symbol's rank in the repo's
    Attention list. "You are editing a top-N hot spot."
  - `inCycle` — if the module is a dependency-cycle member, the canonical cycle
    render. "This module is already in a cycle; don't deepen it."
  - `driftBroken` — `@sivru` invariants on the target whose `enforced-by` test
    no longer resolves (the moat signal, made visible *before* the PR gate).
  - `unguardable` — invariants with `enforced-by: null` (surfaced, never hidden).

### New method, not an overload of `explain` (the DESIGN-0022 open question)

DESIGN-0022 left open whether this is a new MCP method or an extension of the
existing `explain` tool. **Proposed: a new method.** Rationale:

- **Different return shape.** `explain` returns *one symbol's* authored context
  (role/invariants/decisions + dependents, per-file, DESIGN-0004). `map`
  returns a *model slice* — module + neighbors + health flags. Bolting the slice
  onto `explain` via a mode flag makes one tool with two contracts, which the
  agent has to disambiguate at call time.
- **Different moment, different routing hint.** The MCP tool *description* is the
  routing signal (DESIGN-0003 §1). `explain` says "inspect the intent of the
  symbol you're about to change"; `map` says "orient in the architecture around
  it." Two clear hints route better than one muddy one.
- **Composability.** `map` (orient) → `explain` (inspect one symbol's intent) →
  `find_related` (callers/tests) → edit → `find_related` again is a clean arc.

The alternative — a `scope: "symbol" | "module" | "map"` argument on `explain` —
is recorded for review (it keeps the tool count down at the cost of contract
clarity). The reviews decide.

## Precondition — resolve before building (CEO review T4)

The outside-voice review named the real risk: `map` could overlap `explain`'s
routing slot ("orient before editing"), and shipping a 5th tool adds *supply*
without proven *demand* — its value is zero until an agent harness reliably
routes to it pre-edit. Two cheap checks gate the build:

1. **Routing-hint diff.** Write `map`'s candidate one-sentence description and
   diff it against the live `EXPLAIN_TOOL_DESCRIPTION` in `mcp-entry.ts`. If the
   two hints can't be made non-overlapping in one sentence each (orient-the-area
   vs inspect-the-symbol), fall back to the `scope` arg on `explain` rather than
   ship two tools competing for one slot.
2. **Consumption signal.** Confirm agents call the *existing* pre-edit tools
   (`explain` / `find_related`) at all today. If pre-edit tool use is near-zero,
   the bottleneck is routing/harness, not a missing tool, and the next design
   should be the harness hook / SKILL workflow that forces the orient-before-edit
   arc — not a fifth tool. (Ties to the deferred Cursor/Codex adapters,
   DESIGN-0010/0011, and the efficacy bench, DESIGN-0013.)

## Architecture

```
agent ──MCP──► map(path)
                 │
                 ▼
        projectModel(repoRoot)          ← DESIGN-0018 cache (stateId-keyed):
                 │                          first call ~11s on a 5.7k-file repo,
                 │                          every later call instant
                 ├─ resolve path/symbol → target node + ancestors
                 ├─ reverseDeps map (1-hop neighbors)            ← already built for --html
                 ├─ topHotNodes(model) → rank                    ← DESIGN-0023 attention.ts
                 ├─ cycleMemberIds(model) → inCycle              ← DESIGN-0023 cycles.ts
                 └─ staticBrokenLinkages(model) → driftBroken    ← DESIGN-0023 drift.ts
                 ▼
            the slice (JSON) — deterministic, no LLM, no network
```

**Reuses (no new engine):**

- `projectModel` + the stateId model cache (DESIGN-0018) — verbatim.
- `topHotNodes`, `cycleMemberIds`, `staticBrokenLinkages` (DESIGN-0023) — the
  exact health passes the static System-page badges already run.
- The path/symbol resolution + `reverseDeps` already in `renderSections`.

**Cost discipline (CEO review — decided: cache with the model).**
`staticBrokenLinkages` resolves every `@sivru` `enforced-by` across the repo (one
shared symbol map via `createEnforcementResolver` — DESIGN-0023); `topHotNodes` +
`cycleMemberIds` are whole-model passes too. `map` is an MCP tool an agent calls
*liberally* mid-task, so per-call recomputation is a latency smell that would
suppress the very behavior we want. **Decision:** compute the three health passes
**once per model build** and cache them under the same stateId key as the model.
The first `map` call warms the cache (a few hundred ms); every later call is a
slice lookup (sub-10ms). Whole-repo accuracy, no per-call recompute.

**Freshness under active editing (eng review).** M-C's use case is an agent
editing the repo it maps — so the working tree changes between `map` calls, which
changes `stateId` (= `commit_sha` + `hash(git diff)`) and would force a full
model rebuild (~11s on a 5.7k-file repo) on *every* orient call. Cache thrash
exactly when the tool is used. **Decision:** `map` serves the last cached
model/health and stamps a `freshAsOf` marker (the HEAD + dirty-hash it reflects);
the rebuild happens lazily, not inline. `map` is *orientation*, not a gate — one
edit of staleness is fine, and the agent that just made the edit already knows
it. The edit-aware judgment lives in `explain --diff` and the PR gate, which are
always current. (`stateId` correctness is verified: a committed *or* uncommitted
test change moves the dirty-hash, so cached health never lies about a linkage —
it just may lag the agent's own in-flight edit by one call, which `freshAsOf`
makes visible.)

**Honesty (inherited).** The graph is the parsed-import graph at module
granularity (DESIGN-0023). `inCycle` and the neighbor edges carry the same
caveat: unparsed/dynamic imports are invisible, and a single-module repo has no
module cycles. `map` states this in its tool description so the agent doesn't
over-trust the blast radius.

## Slicing (CEO-reviewed, SCOPE EXPANSION → trimmed by outside voice)

| Slice | Ships | Scope |
|------:|-------|-------|
| 0 | (precondition) | The routing-hint diff vs `explain` + the consumption signal (above). Gates the build; cheap. |
| 1 | v0.15.0 | The `map` MCP tool. **Target-based** (`path` / `path::symbol`) AND **task-based with a confirm step** (`task` → top-N candidates with scores → agent confirms → slice; never auto-orient on the top hit, CEO review T3). The deterministic slice (block + module + 1-hop neighbors + collaborators, neighbors capped with "+N more") + **descriptive `health`** (hot / inCycle / driftBroken / unguardable) off the **cached** health passes. The **surface-the-gap** authoring hint (no fill-in stub, CEO review T2). A CLI mirror (`sivru explain --project --map=<path>`) for parity + testing. |

**Output budget.** Neighbors + collaborators are capped (default depth 1) with a
`+N more` overflow, like the diff view — a slice that floods the agent's context
is a slice it stops calling.

## NOT in scope (CEO review)

- **Any LLM.** `map` is a projection of the authored model, never a generated
  summary. (LLM narratives remain deferred — DESIGN-0022 "Deferred".)
- **A predictive `wouldRegress` signal** (CEO review T1). Pre-edit, `map` has no
  edit to judge; predicting a regression from static state is a false-positive
  engine and a duplicate of `explain diff:true`. `map` reports descriptive health
  only; the edit-aware judgment stays in `explain --diff` and the PR gate.
- **Handing the agent an `@sivru` fill-in stub** (CEO review T2). `map` surfaces
  the *gap* ("no `@sivru` here") but never solicits machine-authored intent into
  the human-authored trust layer. Agent-assisted authoring — *with* provenance
  marking (`@sivru source: agent-drafted`) and a human-confirm step — is its own
  future design, not a free rider on `map`.
- **Cross-agent reach proof** (CEO review E4 → TODOS). Verifying `map` serves a
  non-Claude MCP client is the Cursor/Codex adapter work (DESIGN-0010/0011); the
  MCP tool is already client-neutral.
- **Auto-orienting on a task's top semantic hit** (CEO review T3). A wrong hit
  silently mis-grounds the agent; task-entry always confirms a candidate first.
- **A new health metric.** `map` serves the M-A signals that already exist.

## Resolved in eng review

- **Tool name → `map`.** Short, matches the mental model; the description carries
  the routing hint ("orient in the architecture around a target"). (`orient` was
  the runner-up; revisit only if the routing-hint diff vs `explain` is muddy.)
- **Symbol-less targets → module/package slice.** A file with no load-bearing
  symbol returns its package/module slice + health, not an error — orientation is
  still useful without a symbol.
- **Task candidate count → top-5 with a score floor.** Return up to 5 candidates;
  below a similarity threshold, return `{ candidates: [], hint }` ("no clear
  target — here's what I searched") rather than a confident wrong slice.
- **Cache thrash under active editing → serve-stale + `freshAsOf`** (see Freshness
  above). The one architecture risk; resolved.
- **`stateId` cache correctness → verified.** It hashes the git diff (and the
  gitignore-aware walk when non-git), so test-file changes invalidate the cached
  health. No silent stale-linkage.

## Test plan + failure modes (eng review)

```
CODE PATHS                                              FAILURE / EDGE
[+] explainer/agent-map.ts  (slice assembler)
  ├── buildMap(model, target)
  │     ├── [TEST] target resolves → full slice              path::symbol, file-only, module
  │     ├── [TEST] symbol-less file → module/package slice   GAP→fallback, not error
  │     ├── [TEST] path resolves to NO node → {error}        unknown/ignored/binary path
  │     └── [TEST] neighbors capped at depth 1 + "+N more"   hot module w/ 50 dependents
  ├── health(model) [cached]
  │     ├── [TEST] hot/inCycle/driftBroken/unguardable shape on real fixture
  │     └── [TEST] cache hit on same stateId; miss + rebuild on dirty change
  ├── taskCandidates(model, task)
  │     ├── [TEST] returns top-5 with scores, never auto-orients
  │     └── [TEST] below threshold → { candidates: [], hint }   empty/garbage task
  └── authoringHint(node)
        └── [TEST] present only when block === null; surfaces gap, NO stub
[+] mcp-entry.ts  (map tool)
  ├── [TEST] { path } → slice ; { task } → candidates
  ├── [TEST] neither arg → { error } ; both args → path wins (documented)
  └── [TEST] freshAsOf marker present + reflects HEAD/dirty-hash

FAILURE MODES
  CODEPATH            | FAILURE             | HANDLED?        | USER (agent) SEES
  --------------------|---------------------|-----------------|-------------------
  resolve target      | path not a node     | Y → {error}     | "no such target: <path>"
  projectModel        | model build throws  | Y → {error}     | structured error, never a half-slice
  enforcement resolve | test file unreadable| Y (DESIGN-0023) | linkage = unresolved (honest)
  taskCandidates      | embed search empty  | Y → {candidates:[],hint} | "no clear target"
  health cache        | stale vs in-flight edit | Y → freshAsOf | the marker; lag of ≤1 call
```

No silent failures: every path returns either a slice or a structured `{error}`,
matching the existing `explain`/`find_related` MCP contract.

## Relationship to existing designs

- **DESIGN-0022** — this is Move 2 (M-C), the platform layer, after Move 1
  (DESIGN-0023) shipped the engine it serves.
- **DESIGN-0018** — `map` is a read API over the same `ExplainerModel` + cache.
- **DESIGN-0023** — `map` serves the M-A health passes (hot/cycle/drift) that
  the PR gate also uses; the gate blocks on a PR, `map` informs mid-task.
- **DESIGN-0003/0004** — `map` joins the MCP tool family (`search`, `explain`,
  `checkup`, `find_related`); composes with `explain` (per-symbol intent) and
  `find_related` (callers/tests) rather than replacing either.

## Implementation Tasks

Synthesized from the CEO review. Each derives from a specific finding.

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — mcp-entry — Routing-hint diff (precondition)
  - Surfaced by: outside voice F1/T4 — `map` may overlap `explain`'s routing slot.
  - Write `map`'s candidate description; diff vs the live `EXPLAIN_TOOL_DESCRIPTION`. If not non-overlapping in one sentence each, fall back to a `scope` arg on `explain`.
  - Verify: the two descriptions read as distinct moments (orient-area vs inspect-symbol).
- [ ] **T2 (P1, human: ~half day / CC: ~20min)** — explainer — Cache the 3 health passes with the model
  - Surfaced by: Section 1/7 — per-call whole-repo drift is an MCP latency smell.
  - Compute `topHotNodes` + `cycleMemberIds` + `staticBrokenLinkages` once per build; cache under the stateId key.
  - Verify: 2nd `map` call is sub-10ms; cache invalidates on working-tree change.
- [ ] **T3 (P1, human: ~1 day / CC: ~30min)** — mcp-entry/explainer — The `map` tool + slice assembler
  - Surfaced by: the core proposal. target-based + task-based(confirm) entry; slice (block + module + 1-hop neighbors capped + collaborators) + descriptive health + surface-the-gap authoring hint.
  - Verify: `map { path }` returns the slice; `map { task }` returns candidates-first.
- [ ] **T4 (P2, human: ~2h / CC: ~10min)** — explainer — Share neighbor logic with the diff
  - Surfaced by: Section 5 DRY — `affectedModules` / `reverseDeps` overlap.
  - Verify: one helper builds the 1-hop neighborhood for both `--diff --html` and `map`.
- [ ] **T5 (P2, human: ~2h / CC: ~10min)** — mcp-entry — Error contract + output cap
  - Surfaced by: Section 2/4 — unresolved path, empty model, no task match, oversized slice.
  - Structured `{error}` like `explain`; neighbors/collaborators capped with `+N more`.
- [ ] **T6 (P1, human: ~half day / CC: ~20min)** — explainer/mcp-entry — Serve-stale + `freshAsOf`
  - Surfaced by: Eng review finding 1 — cache thrash when the agent edits the mapped repo.
  - `map` serves the last cached model/health with a `freshAsOf` marker; rebuild lazily, not inline.
  - Verify: a `map` call right after an in-tree edit returns sub-second with `freshAsOf` reflecting the pre-edit state.

_No new tasks from Sections 3 (security — map returns repo content the agent already reads), 8 (observability — standard MCP call logging), 9 (deploy — ships in @sivru/cli, no migration, reversible), 11 (design — no GUI; the JSON shape is the agent's UX)._

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | SCOPE EXPANSION: 4 expansions accepted, then 3 trimmed + 1 reframed by the outside voice; 1 architecture fork (health latency → cache) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 1 architecture finding (cache thrash → serve-stale + freshAsOf); 3 open questions resolved; cache invalidation verified correct; test plan + failure modes produced. 0 critical gaps |
| Outside Voice | Claude subagent | Independent challenge | 1 | issues_found | 7 findings, verdict "trim-to-minimal"; 4 cross-model tensions all resolved toward the trim |

- **OUTSIDE VOICE:** challenged the EXPANSION scope hard — `wouldRegress` dishonest pre-edit (→ reframed to descriptive health), authoring stub breaks the human-authored brand (→ softened to surface-the-gap), task-entry risks silent mis-grounding (→ top-N confirm), and supply-before-demand (→ added a consumption precondition).
- **ENG REVIEW:** scope under the complexity threshold; the one real architecture risk (cache thrash when the agent edits the mapped repo) resolved to serve-stale + `freshAsOf`. Verified `stateId` invalidation covers test-file changes, so cached health can't lie about a linkage. Open questions resolved (name=`map`, symbol-less=module slice, candidates=top-5+floor). Test plan + failure-mode table produced; no silent failures (every path → slice or structured `{error}`).
- **CROSS-MODEL:** the outside voice and the review agreed on the latency fix (cache health with the model). The 4 tensions were the user's calls; all resolved toward the trim.
- **UNRESOLVED:** 0.
- **VERDICT:** CEO + ENG CLEARED — ready to implement (Slice 1, gated on the T1 routing-hint/consumption precondition).
