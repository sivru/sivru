# DESIGN-0016: `@sivru` annotation blocks — authored code context

**Status:** Draft <!-- Draft → Accepted → Implemented → Superseded -->
**Targets:** v0.6.0
**Issue:** filed when v0.6 becomes next release
**Created:** 2026-05-15
**Author:** @pochadri

## Problem

`sivru explain` (DESIGN-0004, v0.5.0) gives an agent *derived* facts
about a symbol — public API, 1-hop call graph, churn, ownership. All
of it is computed from code plus git. None of it answers the
questions that actually decide whether a change is safe:

- What is this symbol *for* — its role in the system, not its
  signature?
- What invariants must hold that the type system does not enforce?
- Why is it built this way — what was chosen, and what was rejected?
- Is that choice still valid, or has the world moved since?

Today that knowledge lives in three bad places: a senior engineer's
head, a stale `docs/` page, or nowhere. When an agent edits a file it
reconstructs intent from the code itself — which is exactly the
information that is missing, because the code is the *what*, not the
*why*.

The failure mode is concrete. An agent "correctly" refactors a
central router into per-channel routers. The tests pass. It has
silently destroyed a deliberate architectural decision — "channels
stay thin, routing logic stays in one place" — that no artifact
recorded. The decision had a reason and a lifetime; the agent never
saw either, so it could not weigh them.

## Proposal

A `@sivru` annotation block: a small, structured, language-neutral
block of authored context, carried inside whatever doc-comment syntax
the host language already uses, attached to a code symbol.

The block is delimited `@sivru` ... `@end` and contains YAML:

```
@sivru
role: routing-brain
responsibility: resolve which solution owns an inbound message
collaborators: [SolutionRouteResolver, HookDispatcher]
invariants:
  - runs on the request thread; tenant context must be set first
decisions:
  - chose: one central router, not per-channel routers
    because: channels must stay thin; routing logic in one place
    valid-while: no channel needs channel-specific routing state
    revisit-if: a channel must route differently from the others
maturity: stable
@end
```

Carrier syntax is the language's native doc comment — `/** */` for
Java and TypeScript, `//` runs for Go, `"""` for Python, `///` for
Rust. The block content is identical across all of them. The only
language-specific code sivru writes is "given a symbol, find its
attached doc comment" — and tree-sitter (v0.2.0, DESIGN-0001) already
provides the parse tree to do that. One small comment-locator per
grammar; everything downstream is shared.

Required fields are `role` and `responsibility`. Everything else —
`collaborators`, `invariants`, `decisions`, `maturity` — is optional,
added only where it earns its place. A block with two fields is valid
and useful; authoring cost scales with value, so the repo accumulates
depth exactly where depth matters.

The `decisions` list is the part that makes a block more than a doc
comment. Each decision is `chose / because / valid-while /
revisit-if` — a claim with a lifetime. An agent reading the block
before an edit sees not just "this is a router" but "single-router
was chosen *because* X, holds *while* Y, revisit *if* Z." It can now
respect the decision, or consciously recognize the revisit condition
is met and override it on purpose. Authored context turns a blind
edit into a judgment.

Sivru's role is the schema, the extractor, and validation — not
authoring. Blocks are written by whoever changes the code: a human,
or far more often a coding agent following `@sivru/skill`
(DESIGN-0003 / DESIGN-0017). On first contact with an un-annotated
load-bearing symbol the agent proposes a block. Sivru parses,
validates, and exposes the parsed structure as `SivruBlock` for the
downstream consumers in DESIGN-0017 and DESIGN-0018.

Public surface — new module `packages/search/src/block/`:

- `SivruBlock` — the parsed type, in `block/types.ts`.
- `extractBlocks(filePath, tree): SivruBlock[]` — given a parsed
  tree-sitter tree, return every `@sivru` block with the symbol it is
  attached to.
- `validateBlock(block): BlockDiagnostic[]` — required-field and
  schema check.

The extractor is pure parse: no network, no LLM, ever. A repo with
zero blocks extracts to `[]` with no error and no cost beyond the
walk that already happens.

## Alternatives considered

**A sidecar manifest** (`.sivru/context.yaml`, one file). Non-
intrusive and language-free. Rejected: it drifts the instant code
moves, and nothing in code review forces it current. The whole point
is context that travels *with* the symbol it describes.

**Native doc-comment conventions only** (Javadoc tags, TSDoc tags,
godoc prose). Rejected: each language's tag vocabulary and tooling
differ, none has anything like `valid-while`, and we would be
maintaining five incompatible schemas. The fenced `@sivru` block
reuses the comment purely as a *carrier* and keeps one schema.

**A new comment syntax or decorator.** Rejected: anything that is not
already a comment breaks compilers, linters, and formatters. The
block must be invisible to every tool except sivru.

**Authoring blocks through a sivru command into sivru's index, never
in source.** Rejected: defeats the purpose. The context would live
outside the repo, invisible in code review and in the editor, and
would not survive a clone.

## Open questions

- Module-level context has no natural symbol. Package level attaches
  to `package-info.java` / `doc.go` / `__init__.py`. Module level —
  repo `README` front-matter, or a `.sivru/module.yaml`? Decide by
  the time v0.6 is cut. (owner: @pochadri)
- A `decision` with no `revisit-if` — allowed (a decision with no
  known expiry) or warned? Lean: allowed. (owner: @pochadri)
- Block size. A block past ~25 lines is probably prose that belongs
  in a design doc. Soft lint warning, or no cap? (owner: @pochadri)

## DESIGN-0004 reconciliation gate (v0.5 forward-pointer)

DESIGN-0004 v0.5 reserved the `authored: []` field on the explain
artifact (decision A1 in the CEO plan, locked in this design doc's
acceptance criteria). The v0.6 PR description for this design MUST
include a section titled "DESIGN-0004 reconciliation" that states
the v0.6 contract for filling the `authored` field on `sivru explain`
artifacts. Specifically:

- What `extractBlocks()` output goes into `artifact.authored[]`.
- How a region-level `sivru explain path::symbol` call filters
  `authored[]` to blocks attached to that symbol.
- Whether v0.6 also surfaces unvalidated blocks (with a diagnostic)
  or strips them.

This gate is the v0.5 → v0.6 contract pin per the DESIGN-0001
reconciliation pattern (the only protection against the v0.5
`authored: []` placeholder silently never getting filled). Sivru's
release CI should reject v0.6 PRs whose body does not contain the
"DESIGN-0004 reconciliation" heading.

## Acceptance criteria

- `SivruBlock` type defined in `packages/search/src/block/types.ts`.
- `extractBlocks()` pulls `@sivru`/`@end` blocks from doc comments
  across the v0.2.0 tree-sitter grammars; one comment-locator each.
- `validateBlock()` flags missing `role`/`responsibility` and
  malformed YAML; diagnostics carry codes in the `SIVRU-E2xx` range
  (claimed at implementation).
- A block with only `role` + `responsibility` validates clean.
- Extraction is pure: no network, no LLM. A zero-block repo extracts
  to `[]`.
- Round-trip test: an identical block written in 4 carrier syntaxes
  (Java, Go, TypeScript, Python) parses to the same `SivruBlock`.
- **DESIGN-0004 reconciliation gate** (see section above): v0.6 PR
  description includes the named reconciliation section, and the
  v0.5 `authored: []` placeholder is filled per the stated contract.

## Test plan

- Unit: `extractBlocks` against per-language fixture files;
  malformed-block fixtures; a zero-block file.
- Unit: `validateBlock` — missing required field, bad YAML, and the
  valid-minimal case.
- Manual: run extraction on the sivru repo itself once a handful of
  blocks are seeded in `packages/search/`.
- Performance gate: extraction adds < 5% to index time on the vitest
  corpus.

## Customization shape

Per the CONTRIBUTING.md three-layer rule:

1. **Built-in defaults** — schema in `packages/search/src/block/
   schema.ts`; required fields `role`, `responsibility`; the set of
   recognized optional fields fixed.
2. **Declarative override** — `~/.config/sivru/block.json` (user) and
   `.sivru/block.json` (per-project, wins): `{ requiredFields,
   optionalFields, maxLines }`. A team can require `decisions` on
   anything under `src/core/`.
3. **Code-level extension** — `.sivru/block/*.ts` register custom
   field validators (for example, "`collaborators` entries must
   resolve to real indexed symbols").

---

## GSTACK REVIEW REPORT

*CEO review log for v0.6.0. Per `/plan-ceo-review` skill — review
log, decisions ledger, dashboard, next-steps. The CEO plan (with
full decision rationale) lives at
`~/.gstack/projects/sivru/ceo-plans/2026-05-21-sivru-annotation-blocks.md`.*

### Iteration history

| Iter | Reviewer | Outcome | Findings | Lock state |
|------|----------|---------|----------|------------|
| 1 | `/plan-ceo-review` spec-review | REVISE | 24 issues across 5 dimensions, quality 6/10 | Iter-1 CEO plan stale relative to feasibility / consistency / clarity gaps |
| 2 | `/plan-ceo-review` spec-review | REVISE | 22 second-order issues, quality 7/10 | Cross-doc reconciliation with DESIGN-0017 needed; BlockDiagnostic shape under-specified; role-coverage arithmetic off |
| 3 | `/plan-ceo-review` spec-review | **PASS** | 8.5/10 (2 trivial editorial nits cleaned inline) | CEO plan locked; all D1 + E1–E8 + F1–F3 decisions absorbed |

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (iter-3 PASS) | CLEAR | 8 proposals proposed, 8 accepted, 7 deferred to TODOS |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — (no UI scope at v0.6) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CROSS-MODEL:** spec-review subagent ran three independent rounds
on the CEO plan (treated as cross-model verification of document
quality). Strategic outside-voice not run — the spec-review loop
already provided three rounds of independent review; v0.6 is a
"build the obvious thing" release with clear v0.7/v0.8 dependents,
not a strategic re-question.

**UNRESOLVED:** 0 unresolved decisions across all reviews.

**VERDICT:** CEO CLEARED — ready for `/plan-eng-review`, then
auto-ship, then v0.6.0 ship. Eng-review required before code lands
per `skip_eng_review = false` default.

### Decisions ledger

**Scope expansions accepted (SCOPE EXPANSION mode):**

- **D1** — Baseline = library + CLI + self-dogfood (vs library-only
  OR library+CLI+drift).
- **E1** — Module-level via language convention (Python docstring +
  TS top-of-file at v0.6; Java + Go deferred to v0.6.x).
- **E2** — `decision` without `revisit-if` → warning (`SIVRU-E210`).
- **E3** — Block size: warn 25 (`SIVRU-E211`), error 100
  (`SIVRU-E212`); "block lines" inclusive of `@sivru`/`@end`;
  100-line ceiling hardcoded.
- **E4** — Lock `maturity` to `stable/experimental/deprecated/wip`;
  override-replaces-default semantics; `SIVRU-E213`.
- **E5** — Medium dogfood: 21 named symbols across @sivru/search +
  @sivru/cli; spike `resolvers/typescript.ts` first to validate
  the 5-7d estimate.
- **E6** — Pre-lock `SivruBlock` JSON shape + `schema: 1` at v0.6;
  v0.7 owns the `explain.authored[]` consumption contract fixture.
- **E7** — `schema: 1` version slot; strict-reject policy for
  unknown schemas (`SIVRU-E214`).
- **E8** — YAML parser: add `js-yaml ^4.0.0` + `@types/js-yaml`
  as a @sivru/search dep.
- **F1** — yaml-parse-error handling: `SIVRU-E216 yaml-malformed`
  diagnostic; other blocks in the file extract normally.
- **F2** — js-yaml safety: pin `^4.0.0`, use `yaml.load()` only;
  DEFAULT_FULL_SCHEMA forbidden in DESIGN-0016 acceptance.
- **F3** — Pathological-yaml test fixture: deeply-nested
  SivruBlock within the 100-line cap; assert extract < 10ms with
  bounded memory.

**Deferred to TODOS.md (7 items):** Go + Java module-level (v0.6.x);
`sivru block author <symbol>` scaffolder; `sivru block stats`
coverage report; block diff in PR rendering; templates by `role:`;
per-block stable `id`/hash; TS `exports` subpath module support;
multi-version graceful-downgrade schema policy.

### DESIGN-0016 sync prerequisites (11 items)

Listed in the CEO plan under "DESIGN-0016 sync prerequisites." All
11 must land in the doc rewrite before any v0.6 implementation
begins. The `/plan-eng-review` step produces the rewrite. Key
items: 4-value maturity lock, error-code partition (E210-E219 v0.6
/ E220-E229 v0.7), self-dogfood test gate with node CI script,
v0.6 JSON shape + schema:1 + strict-reject, DESIGN-0004
reconciliation gate carried forward, F1/F2/F3 acceptance bars,
dogfood-content-review note.

### DESIGN-0017 sync prerequisites (2 items, v0.7 cycle)

Tracked so v0.7 absorbs them when it scopes: (1) SKILL.md
authoring section reassigned from v0.7 to v0.6 ownership; v0.7
keeps only the "before editing, READ the block" addendum.
(2) v0.7 drift detector consumes `SIVRU-E210 decision-no-revisit`
as a fifth diagnostic; error-code range partition holds.

### Dashboard

| Surface | State |
|---------|-------|
| Module location | `packages/search/src/block/` (matches v0.5 D1 subdir pattern) |
| Schema (locked) | role + responsibility required; maturity (4 values); decisions[] with chose/because/valid-while/revisit-if; collaborators[]; invariants[]; schema:1 |
| CLI surfaces | `sivru block validate [path]`, `sivru block extract [path] --json` |
| MCP surfaces | None at v0.6 (v0.7 surfaces blocks via `sivru.explain`) |
| Carrier syntaxes | Per-symbol: doc comments per grammar (5 langs). Module-level: Python docstring + TS top-of-file (v0.6); Java/Go deferred. |
| YAML parser | js-yaml ^4.0.0, safe-load only |
| Error codes (v0.6 partition) | SIVRU-E210 through E219 reserved; E210-E216 allocated |
| Cache | None at v0.6 (no extraction cache; v0.7's drift detector is where caching becomes useful) |
| Dogfood scope | 21 named symbols across @sivru/search + @sivru/cli; CI gate asserts count ≥ 21 and distinct roles ≥ 5 |
| v0.6 → v0.7 JSON contract | v0.6 ships `blockToJSON()`; v0.7 owns the consumption-shape fixture |
| Reconciliation gate | DESIGN-0004 `authored:[]` contract carried; v0.6 PR must include "DESIGN-0004 reconciliation" heading |
| Effort | ~4.5–5.5 weeks |
| Spec-review history | Iter 1 → 2 → 3 PASS 8.5/10; metrics persisted at ~/.gstack/analytics/spec-review.jsonl |

### Next steps

1. **`/plan-eng-review`** — pressure-test the architecture against
   the iter-3 CEO plan. Specific topics to confirm: module
   boundary inside @sivru/search; BlockDiagnostic shape vs
   existing diagnostic conventions; performance gate (< 5% index
   overhead) measurement plan; the spike protocol for E5
   resolvers/typescript.ts authoring; F1/F2/F3 acceptance.
2. **`/auto-ship`** in a worktree on `design/sivru-annotation-
   blocks` after eng-review PASS.
3. **v0.6.0 ship** — tag once CI green, CHANGELOG updated.
   CHANGELOG entry includes the 21-block dogfood corpus + SKILL.md
   authoring section.

### Handoff note

CEO review is **CLEARED** for v0.6.0 as of 2026-05-21. The CEO
plan converged at quality 8.5/10 across three spec-review
iterations. All eight scope expansions (D1, E1–E8) plus the three
section-walk findings (F1–F3) are absorbed. The eight DESIGN-0016
sync prereqs (now eleven after F1/F2/F3) await the eng-review's
rewrite pass. v0.6's external dependencies are tracked: two
DESIGN-0017 sync prereqs noted for the v0.7 cycle. v0.6 is a
load-bearing release for v0.7 (serve blocks) and v0.8 (codebase
explainer); the CEO plan reflects that responsibility.
