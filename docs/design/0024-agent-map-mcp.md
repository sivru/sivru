# DESIGN-0024: The agent's working map (M-C, the platform layer)

**Status:** Draft <!-- Stub → Draft → Accepted → Implemented → Superseded -->
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

A new MCP tool — working name **`map`** — that, given the file or symbol an
agent is about to work on, returns the relevant **slice of the `ExplainerModel`
plus its health flags**. Deterministic, no network, no LLM: a projection of the
already-built model, exactly like the rest of the explainer.

```
mcp__sivru__map  { path: "<file>" | "<file>::<symbol>" }
  → {
      target:       { id, level, name, path, block?, declLine? },
      module:       { name, role?, responsibility?, churn, hotScore, rank },
      dependsOn:    NodeRef[],   // 1-hop: what the target's module imports
      dependedOnBy: NodeRef[],   // 1-hop: what imports it (the blast radius)
      collaborators: string[],   // symbol-level callees ∪ block.collaborators
      health: {
        hot:         { score, rank } | null,   // churn × coupling, repo rank
        inCycle:     { render } | null,        // the module dependency cycle it sits in
        driftBroken: { rule, enforcedBy, reason }[],  // @sivru linkages that no longer resolve
        unguardable: { rule }[]                // invariants with enforced-by: null
      }
    }
```

The agent calls it the way a careful engineer orients before a change: *"I'm
about to edit `AgentRunLoop.run`. What is this, what's around it, and is it
healthy?"* The tool answers in one call what would otherwise be five greps and
a guess — and it answers with the **authored intent** (the `@sivru` block) and
the **M-A health** (hot/cycle/drift), which greps can never surface.

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

**Cost discipline.** `staticBrokenLinkages` resolves every `@sivru`
`enforced-by` across the repo (one shared symbol map via
`createEnforcementResolver` — DESIGN-0023). On a large repo that is a few
hundred ms on the *first* call and is the only non-trivial cost. Two mitigations
for review: (a) compute drift lazily and **scope it to the target's module**
rather than the whole repo, or (b) cache the health passes alongside the model
(same stateId key). Either keeps `map` sub-second after warm-up.

**Honesty (inherited).** The graph is the parsed-import graph at module
granularity (DESIGN-0023). `inCycle` and the neighbor edges carry the same
caveat: unparsed/dynamic imports are invisible, and a single-module repo has no
module cycles. `map` states this in its tool description so the agent doesn't
over-trust the blast radius.

## Slicing

| Slice | Ships | Scope |
|------:|-------|-------|
| 1 | v0.15.0 | The `map` MCP tool, **target-based** (`path` / `path::symbol`): the deterministic model slice + M-A health, off the cached model. The full platform value with zero new engine. A CLI mirror (`sivru explain --project --map=<path>`) for parity + testing. |
| 2 | later | **Task-based** entry: a free-text task string → semantic selection of the relevant slice (which modules/symbols this task touches) via the existing embedding search, for agents that describe intent before they know the file. |

## NOT in scope

- **Any LLM.** `map` is a projection of the authored model, never a generated
  summary. (LLM narratives remain deferred — DESIGN-0022 "Deferred".)
- **Free-text task routing** — Slice 2; Slice 1 is target-based only.
- **Writing / steering through the tool.** `map` is read-only orientation. The
  PR gate is M-B (DESIGN-0023); authoring is the feedback loop (DESIGN-0018
  Slice 3). `map` does not mutate.
- **A new health metric.** `map` serves the M-A signals that already exist; it
  does not invent new ones (that was the deferred "full metric suite").

## Open questions

- **New method vs. `scope` arg on `explain`** — proposed new method; reviews decide.
- **Tool name** — `map` / `orient` / `context_map` / `architecture`. `map` is
  short and matches the mental model; `orient` names the verb. Bikeshed for review.
- **Slice size** — 1-hop neighbors (proposed) vs 2-hop. 1-hop is the blast
  radius; 2-hop risks flooding the agent's context. Cap + "+N more" like the diff.
- **Drift cost** — whole-repo `staticBrokenLinkages` per call vs module-scoped vs
  cached-with-model. Leaning module-scoped for latency; confirm in eng review.
- **Symbol-less targets** — `map` on a file with no load-bearing symbol returns
  the module/package slice; confirm that is the right fallback.

## Relationship to existing designs

- **DESIGN-0022** — this is Move 2 (M-C), the platform layer, after Move 1
  (DESIGN-0023) shipped the engine it serves.
- **DESIGN-0018** — `map` is a read API over the same `ExplainerModel` + cache.
- **DESIGN-0023** — `map` serves the M-A health passes (hot/cycle/drift) that
  the PR gate also uses; the gate blocks on a PR, `map` informs mid-task.
- **DESIGN-0003/0004** — `map` joins the MCP tool family (`search`, `explain`,
  `checkup`, `find_related`); composes with `explain` (per-symbol intent) and
  `find_related` (callers/tests) rather than replacing either.
