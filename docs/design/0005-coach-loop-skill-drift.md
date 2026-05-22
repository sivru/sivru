# DESIGN-0005: Coach loop v1 — skill drift

**Status:** Stub
**Targets:** v0.6.0
**Issue:** [#17](https://github.com/sivru/sivru/issues/17) (broader scope; this is the v0.6 subset)
**Created:** 2026-05-08

## Problem

The architect-thinking thesis (see
[`project_sivru_architect_thinking_thesis`](../../README.md#thesis))
identifies two long-lived authored surfaces that rot silently and
cause confident wrong edits: agent-instruction files (CLAUDE.md,
skills, agent definitions) and `@sivru` blocks. Both are architect-
thinking captured at one moment; both go stale because nothing
mechanically forces them to follow the code.

**Tier 1 — agent-instruction drift.** Stale CLAUDE.md is the most
expensive silent failure mode for Claude Code workflows. The user
wrote it once, the code drifted under it, and Claude is still being
instructed against the old shape. Result: confident edits that
contradict current conventions, and the user can't see why.

Same for skills + agent files: a SKILL.md that references a removed
file, a `.claude/agents/` file with stale tool names. Invisible
until something breaks.

**Tier 2 — `@sivru` block drift.** A v0.6 block records the
architect's view of a symbol: role, invariants, decisions and their
`revisit-if` triggers. When the code changes and the block does not,
the block lies — it asserts architectural intent that is no longer
real. DESIGN-0017 ships `sivru block check` as a standalone command
in v0.7; this design surfaces the same diagnostics in the Checkup
tab alongside the tier-1 signals. The two memory-rot signals unify
under one coaching concept: "your captured architectural intent has
drifted from the code."

Both tiers are the lowest false-positive coaching signals —
staleness is data, not judgment. We can ship the data; users decide
what to do with it.

## Acceptance (from ROADMAP.md v0.9)

- Two tier-1 checks ship: file-age and dead-references (broken file
  path mentions in CLAUDE.md / skills / agents)
- Tier-2 block-drift checks (`broken-collaborator`, `stale-block`
  from DESIGN-0017) render in the same Checkup tab via the shared
  `DiagnosticList` primitive defined in DESIGN-0019
- A new "Checkup" tab in observe-ui surfaces both tiers
- All checks fire descriptively: "your CLAUDE.md is 90 days old"
  rather than "your CLAUDE.md is stale"; "block on resolveRoute may
  be stale (body changed in commit abc1234)" rather than "block is
  wrong" (judgment is the user's)
- FP rate < 10% on a labeled test set per tier
- Three-layer customization: turn off, change thresholds, write
  custom checks

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** age threshold = 90 days OR 1000 commits
   since last edit. Dead-reference check = path doesn't resolve
   relative to repo root.
2. **Declarative override:** `~/.config/sivru/memory-audit.json`
   and `.sivru/memory-audit.json` accept severity overrides,
   `disabled` list, `skipPaths` glob list, threshold tuning.
3. **Code-level extension:** `.sivru/memory-audit/*.ts` files
   register custom checks (e.g., "CLAUDE.md must mention SOC2
   compliance for our regulated codebase").

Type stub already exists at `packages/cli/src/lib/memory-audit/types.ts`.

## Open questions

- "Dead reference" detection on CLAUDE.md is harder than it looks.
  Markdown can mention paths inside code blocks (which may be
  examples, not assertions). Strategy: only check paths inside
  inline code that resolve relative to repo root. Other forms get
  ignored.
- Age threshold: 90 days is a default; should it scale with repo
  churn? A repo with 10 commits/year doesn't have stale CLAUDE.md
  at 90 days. Consider: ratio of last-CLAUDE.md-edit to last-N
  commits to repo HEAD.
- Where does the Checkup tab fit in the existing observe-ui? It's
  the first new tab since 0.1.0. Probably between Sessions and
  Costs.

## Status note

This is a Stub. Full design lands when v0.6 becomes the next
release.
