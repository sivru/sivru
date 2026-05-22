# DESIGN-0017: Serving authored context — `explain` integration + drift

**Status:** Draft <!-- Draft → Accepted → Implemented → Superseded -->
**Targets:** v0.7.0
**Issue:** filed when v0.7 becomes next release
**Created:** 2026-05-15
**Updated:** 2026-05-22 — folded in the architect-thinking thesis (no
behavioural change; problem framing and "why this is the right shape"
sharpened)
**Author:** @pochadri

## Thesis (the lens this design is evaluated under)

**In the AI coding world, every engineer needs to think like a
technical architect.** AI produces code at high velocity but without
the architect's mental model — invariants, decisions and their
lifetimes, why-this-not-that, blast radius. The `@sivru` block is
architect-thinking written down: `role` is the symbol's place in the
architecture; `invariants` are the assertions the type system cannot
enforce; `decisions[]` is the four-field `chose / because /
valid-while / revisit-if` quadruple — a pre-commitment that the
decision has a lifetime and a trigger for re-evaluation.

DESIGN-0016 made that architect-thinking durable (it lives in the
repo, survives the senior leaving). This design makes it
**visible** at the moment of decision (an agent or editor about to
touch the symbol gets the architect's view alongside the derived
facts) AND keeps it **honest** (the drift detector catches when the
architect's claim no longer matches the code).

Two release-narrative questions answered:

- **Why surface + drift in the same release:** an architect's
  decision recorded but invisible is dead weight; an architect's
  decision visible but rotted is worse than no decision at all
  (anchors the next reader on a wrong premise). Ship both or
  neither.
- **Why a heuristic-not-LLM drift signal:** an architect-thinking
  tool that delegates the judgement to a black-box model trains
  users to outsource the judgement. Sivru's job is to surface the
  inputs precisely; the agent / human still makes the call.

## Problem

DESIGN-0016 made architect-thinking durable: `@sivru` blocks live in
the repo and survive the senior engineer leaving. But nothing
surfaces them yet. An agent calling `mcp__sivru__explain` (v0.5.0)
still gets derived facts only — it cannot see the architect's view
of the symbol it is about to edit. The intent is captured but not
visible at the moment of decision.

And an authored block, once written, rots. The code it describes
changes; a `collaborators` entry is renamed; a decision's
`revisit-if` condition quietly comes true. A stale block is worse
than no block — it asserts architectural intent that is no longer
real, and the next reader (agent or human) makes a confident wrong
call anchored on a wrong premise. Today, when a block goes stale,
nobody sees anything: no warning, no diff, no signal. The block
just lies.

The architect-thinking thesis (top of doc) says sivru's job is
making that thinking durable, visible, and actionable. v0.6
delivered durable. This release delivers visible (part 1 — surface)
and keeps it honest (part 2 — drift). Without both, the layer is
not trustworthy.

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

- `sivru explain <path>` shows an "Authored context" section for
  annotated symbols, in markdown and JSON.
- `mcp__sivru__explain` JSON carries `block` per symbol.
- `sivru block check` reports the four diagnostic types and exits
  non-zero on error-level diagnostics.
- `broken-collaborator` resolves entries against the v0.2 symbol
  index.
- A repo with no blocks: `explain` output is unchanged from v0.5.0;
  `block check` reports clean and exits zero.
- `@sivru/skill` SKILL.md has an authoring section covering when and
  how to write a block.

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
