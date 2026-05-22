# Audit — architect-thinking thesis alignment across all designs

**Date:** 2026-05-22
**Trigger:** User stated the architect-thinking thesis (see
[`project_sivru_architect_thinking_thesis.md`](../../../.claude/projects/-Users-pochadri-dev-10xdelta-sivru/memory/project_sivru_architect_thinking_thesis.md)
in memory).
**Method:** Per-design read of all 19 design docs in `docs/design/`,
scored against the thesis, with cross-cutting opportunities synthesised
on top.
**Not a design doc.** This is a one-shot audit / change-log of which
designs were edited and why; future analysis goes in a new audit file
with the appropriate date.

## Thesis (recap)

> In the AI coding world, every engineer needs to think like a
> technical architect. AI produces code at high velocity but without
> the architect's mental model — invariants, decisions and their
> lifetimes, why-this-not-that, blast radius. Sivru's job is to make
> architect-thinking **durable**, **visible**, and **actionable** for
> every engineer using AI coding tools.

The four `@sivru` block fields operationalise this:

- `role` — place in the architecture (what layer, what subsystem)
- `responsibility` — contract (what is promised, what is depended on)
- `invariants` — non-enforced assertions (the type system's blind spots)
- `decisions[]` — architect-thinking written down (`chose / because /
  valid-while / revisit-if`)

## Per-design alignment table

| # | Title | Status | Targets | Fit | Action |
|---|-------|--------|---------|-----|--------|
| 0001 | Tree-sitter chunker | Implemented | v0.2 | VALIDATES | None — Foundation enabling block extraction |
| 0002 | Per-model chunk-windowing | Implemented | v0.3 | VALIDATES | None — plumbing |
| 0003 | Sivru skill package | Implemented | v0.4 | SHARPENS | **Edit:** routing framing should bind tool calls to architect-thinking questions |
| 0004 | Sivru explain | Implemented | v0.5 | VALIDATES | None — already correctly framed |
| 0005 | Coach loop v1 — skill drift | Stub | v0.9 | SHARPENS | **Edit:** add `@sivru` block staleness as second-tier signal |
| 0006 | Coach loop v2 — looped-on-error | Stub | v0.10 | N/A | None |
| 0007 | Coach loop v3 — low-context edit | Stub | v0.11 | SHARPENS | **Edit:** sharpen "low-context" definition to include "did agent load architect's view" |
| 0008 | Skill recommender | Stub | TBD | N/A | Light note on block-aware recommendations |
| 0009 | Hierarchical retrieval | Stub | TBD | VALIDATES | None — indirectly supports "visible" prong |
| 0010 | Cursor adapter | Stub | TBD | N/A | None — tool expansion |
| 0011 | Codex adapter | Stub | TBD | N/A | None — tool expansion |
| 0012 | Real-agent replay | Stub | TBD | N/A | None — measurement |
| 0013 | Skill efficacy bench | Stub | TBD | N/A | None — measurement |
| 0014 | Map view | Stub | v0.15 | VALIDATES | None — honest naming preserved |
| 0015 | Active steering | Stub | v0.16 | RESHAPES | **Edit:** reframe around recorded architectural boundaries, not skill presence |
| 0016 | Sivru annotation blocks | Accepted | v0.6 | VALIDATES | Already integrated (thesis section in §1) |
| 0017 | Serving authored context | Draft | v0.7 | VALIDATES | Already integrated (thesis section added 2026-05-22) |
| 0018 | Codebase explainer | Draft | v0.8 | VALIDATES | Already integrated (thesis section added 2026-05-22) |
| 0019 | Comprehension surface | Draft | v0.9–v0.10 | VALIDATES | Already integrated (thesis section added 2026-05-22) |

## Edits applied in this audit

- DESIGN-0017 — thesis section folded into the top of doc, Problem
  rewritten (2026-05-22, earlier in this session)
- DESIGN-0018 — thesis section folded in, Problem sharpened around
  architect onboarding (2026-05-22)
- DESIGN-0019 — thesis section authored as part of original write
  (2026-05-22)
- DESIGN-0003 — routing framing updated (this pass, 2026-05-22)
- DESIGN-0005 — block staleness added as second drift signal (this
  pass, 2026-05-22)
- DESIGN-0007 — low-context definition sharpened (this pass, 2026-05-22)
- DESIGN-0015 — reframed around recorded architectural boundaries
  (this pass, 2026-05-22)
- DESIGN-0008 — open question added on block-aware recommendations
  (this pass, 2026-05-22)

Shipped/Accepted designs (0001, 0002, 0004, 0016) deliberately NOT
edited — they are historical record. Forward-pointers in adjacent
designs are the right way to surface thesis alignment for those.

## Cross-cutting opportunities the agent surfaced

Eight recommendations from the per-design audit, in priority order:

1. **DESIGN-0003** routing framing — bind tool calls to architect
   questions (`role` + `responsibility` before touching a symbol).
   *Applied this pass.*
2. **README** positioning — "agents write code without the architect's
   mental model; sivru records that model in the repo." Higher-stakes
   public-facing edit; deferred to user review.
3. **GOALS.md** "Operationalisation" section — define the four block
   fields as the project's core surface. Deferred to user review.
4. **DESIGN-0007** low-context edit signal — center on "did the agent
   load the architect's view." *Applied this pass.*
5. **DESIGN-0005** drift signals — include block staleness alongside
   CLAUDE.md drift. *Applied this pass.*
6. **ROADMAP.md** phase renaming — Substrate / Comprehension /
   Architect-thinking / Coaching. Deferred to user review (high-stakes
   narrative change).
7. **DESIGN-0015** reframe on recorded boundaries. *Applied this pass.*
8. **DESIGN-0008** light note on block-aware recommendations.
   *Applied this pass.*

## Additional opportunities (product thinking on top of the audit)

Four opportunities the mechanical alignment audit did not surface
because they are *new feature directions* the thesis enables, not
existing-design refinements:

### O1 — Decision-capture-at-PR-time prompt

When an engineer opens a PR that touches a symbol with no `@sivru`
block (or whose block does not have a `decisions[]` entry that
covers the kind of change being made), prompt them: *"this PR
appears to change the role of X. Should we record a decision?"*
Could ship as a GitHub Action that runs `sivru block check` on the
diff and posts a single comment. The friction of writing a block
goes from "nobody does it" to "the tool asks at the cheapest
possible moment (right after the architect-thinking happens, while
the engineer still remembers why)."
**Status:** No design exists. Worth a Stub for v0.10+. Smaller than
DESIGN-0017 v0.7 work; could parallelise.

### O2 — Architect-thinking scorecard

A metric layer that tracks across the repo: how many symbols have
blocks, what fraction of decisions have a `revisit-if`, how many
`revisit-if` clauses have fired and been actioned vs. ignored,
average time-to-action when a revisit-if fires, fraction of
high-risk paths (auth, billing, IAM) with blocks. Gives the team
a leading indicator of architectural debt that's better than
"how stale is ARCHITECTURE.md."
**Status:** No design exists. Natural extension of DESIGN-0017
drift signals; could ride into the Comprehension tab (DESIGN-0019)
as a fifth sub-view.

### O3 — Decision lineage

When a block's `decisions[]` is updated or a decision is removed,
record the diff in `.sivru/decisions.jsonl` (append-only). Build a
timeline view per-symbol that shows: *"this symbol's architecture
has been re-decided 3 times in 18 months."* That's exactly the
information an architect needs when entering a meeting about the
same symbol. Today it lives nowhere — git log shows code changes,
not decision changes.
**Status:** No design exists. Pairs naturally with DESIGN-0017
audit log (which currently only records `still-valid` /
`mark-stale` events; this widens it to all block-content changes).

### O4 — Cross-block linkage

`@sivru` blocks should be navigable: when block A's
`collaborators` includes "SolutionRouteResolver" and block B's
`role` is "solution-route-resolver", that's a typed edge in the
architecture graph. Today the link is by-convention-only; a
resolver in the block layer (analogous to the v0.5 explain
resolvers) would make it indexable and surface broken edges
mechanically (already half-built in DESIGN-0017's
`broken-collaborator` diagnostic, but with no use beyond
diagnostic-emission). The Coverage treemap (DESIGN-0019) could
overlay these edges; the codebase explainer (DESIGN-0018) could
walk them.
**Status:** Half-spec'd as a side-effect of DESIGN-0017. Worth
promoting to a first-class design slot — likely v0.11 or v0.12.

## Recommendation

The audit confirms the thesis was already implicitly in the roadmap;
the late-2026 work (v0.6–v0.8) IS the architect-thinking layer.
What this pass did: made the thesis explicit, sharpened framing in
five drafts, and surfaced four follow-up opportunities not yet
covered by any design.

Three things the user should still consider:

1. The README + ROADMAP + GOALS.md positioning edits the audit
   flagged (items 2, 3, 6 in cross-cutting). These are public-facing
   and worth a deliberate draft → review cycle, not a single-pass edit.
2. Which of O1–O4 graduate to design slots before the v0.7 work
   starts (O1 in particular is small enough to parallelise).
3. Whether to commit this audit into the repo (default: yes, as a
   record of the thesis-folding pass; it's a one-shot file with a
   date in the name, not a living doc).
