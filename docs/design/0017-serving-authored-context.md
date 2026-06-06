# DESIGN-0017: Serving authored context — `explain` integration + drift

**Status:** Implemented at v0.10.0 (promoted Draft → Accepted on 2026-06-05
by `/plan-eng-review` iter-1 PASS, surface-only scope; implemented same
day) <!-- Draft → Accepted → Implemented → Superseded -->
**Targets:** v0.10.0 (planned v0.7.0; the slot moved as the v0.7–v0.9
sequence diverged — see ROADMAP "shipped sequence" note)
**Issue:** filed when v0.7 becomes next release
**Created:** 2026-05-15
**Author:** @pochadri

> **Implementation note (2026-06-05) — surface-only Part 2.** Between this
> doc's Draft and its build, DESIGN-0019 (block reliability) shipped a
> *superset* of Part 2's drift machinery as standalone `sivru block`
> subcommands: `validate` (missing-required, E217), `staleness` (E233),
> `graph` (cross-block E234–E236), `check-enforcement` (E230–E232),
> `check-bridges`. The eng review therefore scoped Part 2 down to
> **surfacing**, not rebuilding:
>
> - `sivru explain` / `mcp__sivru__explain` now lead with an `AUTHORED
>   CONTEXT` section (Part 1, fully delivered) and carry a `BLOCKS HEALTH`
>   section + `blocks_health: BlockDiagnostic[]` on the artifact. Health
>   surfaces the **full `validateBlock` diagnostic set** for the target
>   file — including diagnostics on blocks that failed to parse, which the
>   authored render omits (closing the "invalid block silently vanishes"
>   rot this doc names).
> - **`broken-collaborator`** (resolve `collaborators` against the v0.2
>   symbol index) is **deferred** — unbuilt; DESIGN-0019's E235
>   rename-suspect covers the common case. Tracked as a block-reliability
>   follow-on.
> - **`expired-decision`** is **deferred** — opt-in/off by this doc's own
>   design; needs a `DecisionChecker` registry (the type stub exists, no
>   evaluator).
> - **Diff-scoped git drift** (staleness, cross-block graph) is **not run
>   inline** in `explain` — it needs a git ref `explain` does not carry and
>   is better as the dedicated, already-shipped `sivru block staleness` /
>   `graph` commands. `BLOCKS HEALTH` prints a one-line pointer to them.
>
> Acceptance criteria below are annotated `[met]` / `[deferred]`
> accordingly.

## Problem

DESIGN-0016 extracts `@sivru` blocks. Nothing surfaces them yet. An
agent calling `mcp__sivru__explain` (v0.5.0) still gets derived facts
only — it cannot see the authored intent that block extraction now
makes available.

And an authored block, once written, rots. The code it describes
changes; a `collaborators` entry is renamed; a decision's
`revisit-if` condition quietly comes true. A stale block is worse
than no block — it asserts intent that is no longer real, and an
agent that trusts it makes a confident wrong call. Today, when a
block goes stale, the user sees nothing: no warning, no diff, no
signal. The block just lies.

## Proposal

Two parts: surface the blocks, then keep them honest.

**1 — `sivru explain` surfaces authored context.** When
`explain <path>` or `mcp__sivru__explain` runs, every symbol with a
`@sivru` block gains an "Authored context" section in the output:
`role`, `responsibility`, `invariants`, `decisions`, `maturity` —
shown alongside the derived API, call graph, and churn from v0.5.0.
One call returns both layers: what the code *is* and what it is
*for*. `--format json` carries `block: SivruBlock | null` per symbol.
Authored context is rendered first, before derived facts — intent
before mechanism.

**2 — drift detection.** A new command `sivru block check [path]`,
and a `blocks` section in `explain` output, report:

- `broken-collaborator` — a `collaborators` entry resolves to no
  symbol in the v0.2 index. Error level.
- `missing-required` — from DESIGN-0016's `validateBlock`. Error.
- `stale-block` — the symbol's body hash changed in git after the
  block's last-touched commit. Heuristic; warning level only,
  surfaced as "may be stale," never a hard failure.
- `expired-decision` — a decision's `revisit-if` references a
  condition that a registered checker evaluates true. Optional,
  off by default.

Diagnostics carry codes in the `SIVRU-E2xx` range (claimed at
implementation). `sivru block check` exits non-zero on any
error-level diagnostic, so it drops into CI unchanged.

This is the same shape as the Phase-3 coach loop, whose first signal
(skill drift) is CLAUDE.md age plus dead references. `@sivru`-block
drift is a sibling signal. When the coach loop and its Checkup tab
ship, block drift feeds the same surface; until then it is a
standalone command.

**3 — `@sivru/skill` gains an authoring section.** The skill
(DESIGN-0003, v0.4.0) currently teaches Claude when to call which
sivru tool. It gains: when to write a `@sivru` block, the schema, and
the rule — "before editing a symbol, call `explain` and read its
authored context; if your change alters the symbol's contract or
invalidates a decision, update its block in the same edit."

Public surface — extends `packages/cli/src/commands/explain.ts`; new
`packages/search/src/block/drift.ts`; new `block` subcommand in the
CLI.

## Alternatives considered

**A separate `sivru describe` command for authored context.**
Rejected: `explain` and `describe` are synonyms to a user. Two
commands for "tell me about this symbol" is a worse API than one
command with two data sources. Authored context is a section of
`explain`, not its own verb.

**Hard-fail CI on any stale block.** Rejected: staleness is a
heuristic — a body-hash comparison against the block's commit. A
rename or a formatting pass trips it. Hard-failing on a heuristic
trains users to ignore the signal. Only `broken-collaborator` and
`missing-required` are error level; staleness is a warning.

**LLM-judged staleness** (ask a model whether the block still
matches the code). Rejected for sivru core: it needs a model and
either a network call or local inference, which violates the
local-first boundary. An agent can make that judgment itself when it
reads the block during `explain`; sivru's job is to hand it the
inputs, not the verdict.

## Open questions

- The `stale-block` heuristic's false-positive rate. Body-hash is
  crude. Tune it on real repos before block drift is wired into the
  coach loop. (owner: @pochadri, by the coach-loop version)
- Should `expired-decision` ship on by default once checkers exist,
  or stay opt-in? Lean: opt-in until FP data exists. (owner:
  @pochadri)

## Acceptance criteria

- **[met]** `sivru explain <path>` shows an `AUTHORED CONTEXT` section
  for annotated symbols, in markdown and JSON, rendered before the
  derived facts.
- **[met]** `mcp__sivru__explain` JSON carries `block` per symbol (in
  `artifact.authored[].block`, preserved through the MCP cap).
- **[met, reconciled]** Block drift is reported — not via a new `sivru
  block check`, but via the DESIGN-0019 `sivru block` subcommands
  (`validate` / `staleness` / `graph` / `check-enforcement`), each
  exiting non-zero on error-level diagnostics. `explain` surfaces the
  cheap, git-free subset (the full `validateBlock` set, incl.
  missing-required) as `BLOCKS HEALTH` + `artifact.blocks_health`, and
  points to the git-based commands for diff-scoped drift.
- **[deferred]** `broken-collaborator` resolving entries against the
  v0.2 symbol index — unbuilt; E235 rename-suspect covers the common
  case. Block-reliability follow-on.
- **[met]** A repo with no blocks: `explain` adds no authored/health
  noise (the `BLOCKS HEALTH` section is omitted entirely); the `sivru
  block` commands report clean and exit zero.
- **[met]** `@sivru/skill` SKILL.md has an authoring section covering
  when and how to write a block, now tied to `explain`'s `AUTHORED
  CONTEXT` surfacing and the "update the block in the same edit" rule.

## Test plan

- Unit: `explain` output with and without blocks; the JSON shape;
  the drift detector per diagnostic type against fixtures.
- Integration: seed blocks in `packages/search/`, run `explain` and
  `block check`; rename a collaborator and confirm
  `broken-collaborator` fires; mutate a symbol body and confirm
  `stale-block` warns.
- Manual: `mcp__sivru__explain` against a seeded file through the
  MCP server.
- Performance gate: drift check on the vitest corpus completes
  within the existing `explain` budget.

## Customization shape

Per the CONTRIBUTING.md three-layer rule:

1. **Built-in defaults** — four diagnostics; `stale-block` is a
   warning, `broken-collaborator` and `missing-required` are errors,
   `expired-decision` is off.
2. **Declarative override** — `.sivru/block.json` `drift` key:
   per-diagnostic severity, and enable/disable `expired-decision`.
3. **Code-level extension** — `.sivru/block/*.ts` register
   `DecisionChecker`s that evaluate a decision's `revisit-if`
   condition against the repo.
