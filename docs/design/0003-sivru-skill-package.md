# DESIGN-0003: the sivru skill

**Status:** Draft
**Class:** Spine (per [GOALS.md](../../GOALS.md))
**Targets:** v0.4.0
**Issue:** filed when v0.4 work starts
**Created:** 2026-05-08
**Updated:** 2026-05-19 — promoted Stub → Draft for the v0.4.0 cycle.
**Author:** @pochadri

## Problem

After `npm install -g @sivru/cli` + `claude mcp add sivru`, Claude has
the sivru MCP tools registered but **no policy for when to use them**.
It figures out by trial and error, and usually reaches for Grep first —
that is what it was trained on. So a developer installs sivru and the
agent barely changes its behaviour.

A skill closes that gap: a `SKILL.md` that teaches the agent *when* to
reach for `sivru.search` / `sivru.find_related` versus Grep / Read.
Without it sivru is "another registered tool"; with it sivru is a
documented workflow the agent actually follows.

This is **Spine**, not Supporting. The skill is where sivru's public
framing turns from "a code-search MCP" into "the comprehension layer
for AI-written code" — and from v0.6 on it is also where the agent
learns to *author and read* `@sivru` annotation blocks. The skill is
the playbook the runtime has been missing.

## Proposal

### 1. The skill ships inside `@sivru/cli`, installed by `sivru skill install`

The roadmap sketched a separate `@sivru/skill` package. This design
**supersedes that** — the skill ships *inside* `@sivru/cli`:

- A `SKILL.md` (+ its assets) lives in the `@sivru/cli` package.
- A new CLI subcommand `sivru skill install` writes it to
  `~/.claude/skills/sivru/SKILL.md` (or `.claude/skills/sivru/` in the
  current repo with `--project`). Idempotent; re-running updates it.

Why bundled, not a separate package:

- **It kills the versioning problem.** The skill describes the MCP
  tool surface that *a given CLI version* exposes. Ship them together
  and the skill is always in sync with the tools the user actually
  has. A separate package would drift — the central open question the
  stub raised.
- **One install.** The user installs `@sivru/cli` to get the MCP
  server regardless; the skill rides along. No second package, no
  fragile npm `postinstall` hook writing into `~/.claude/`.
- **The skill is useless without the runtime.** It only tells Claude
  when to call sivru tools — meaningless if sivru is not installed.
  There is no audience for a skill-without-CLI, so a separate
  lifecycle buys nothing.

`> note for eng-review:` this overrides the roadmap's `@sivru/skill`
package name. Flagged deliberately.

### 2. What the SKILL.md teaches

The skill follows the Claude Code skill format (frontmatter +
markdown body). The body is a routing policy — short, concrete, and
**honest about what sivru is bad at**:

```
Reach for sivru.search when:
  - the query is natural-language or behavioural
    ("where is auth refresh handled", "how does retry backoff work")
  - you do not know the exact identifier or file
Reach for Grep when:
  - you know the exact identifier or string to find
  - sivru's own benchmarks show grep wins exact-match lookups —
    do NOT route those through sivru.search
Reach for sivru.find_related after editing a symbol:
  - to surface callers / tests / related code before you finish
Know that sivru observe exists:
  - a retrospective CLI/UI surface, not an in-session tool
```

The body is tool-neutral prose — only the install location
(`~/.claude/skills/`) is Claude Code specific. Cursor / Codex
equivalents are future work, gated on the v0.13–0.14 adapters.

The skill must not overclaim (WHY-SIVRU's honesty rule): it tells the
agent the cases where Grep beats `sivru.search`, not just where sivru
wins.

### 3. README — the runtime-vs-skill split

The skill ships with a short README explaining the split: the CLI is
the runtime (the MCP server, the index); the skill is the playbook
(when to use it). Installing one without the other is half the
product.

## Alternatives considered

**Separate `@sivru/skill` npm package.** The roadmap's sketch. Own
lifecycle, but reintroduces skill-vs-MCP version drift and a second
install for a skill that is meaningless without the CLI. Rejected
(§1).

**`postinstall` hook that writes `~/.claude/skills/` automatically.**
Zero-command install, but npm postinstall writing outside the package
dir is a footgun (silent, fails on restricted installs, surprises the
user). An explicit `sivru skill install` is honest and predictable.

**Just document "copy this file."** Cheapest, but a manual copy rots —
nobody re-copies when the skill updates. The CLI subcommand makes
update a re-run.

## Open questions

- **How prescriptive should the routing rules be?** Too prescriptive
  reads as opinionated and ages badly; too vague is useless. Settle
  the specificity in eng-review against a few real example queries.
- **`sivru skill install` default scope** — user (`~/.claude/skills/`)
  or project (`.claude/skills/`)? Lean user-level default, `--project`
  opt-in; confirm in eng-review.
- **Does the skill claim efficacy?** Whether the skill *actually*
  improves agent behaviour is the v0.16 skill-efficacy bench's job,
  not a v0.4 claim. v0.4 ships the playbook; it does not benchmark it.

## Acceptance criteria

- `SKILL.md` ships inside `@sivru/cli`, in the Claude Code skill
  format (valid frontmatter + body).
- `sivru skill install` writes it to `~/.claude/skills/sivru/`;
  `--project` targets `.claude/skills/sivru/`; re-running updates in
  place; the command is idempotent and reports the path written.
- The routing policy covers all four cases: `sivru.search` vs Grep,
  `sivru.find_related` after edits, and that `sivru observe` exists.
- The skill names cases where Grep beats `sivru.search` — no
  overclaiming.
- A short README documents install + the runtime-vs-skill split.
- `sivru help` lists the `skill` subcommand.

## Test plan

- **Unit — `sivru skill install`.** Writes the file to the right path;
  `--project` variant; idempotent re-run; reports the path; refuses or
  overwrites cleanly when the target exists.
- **Unit — skill format.** The shipped `SKILL.md` frontmatter parses
  and has the required fields.
- **Review-gated — content.** The routing policy is correct and
  honest; verified by reading, not asserted by a unit test.
- **Out of scope — efficacy.** Whether the skill measurably improves
  agent routing is the v0.16 skill-efficacy bench, not v0.4.

## Customization shape

The skill *is* the customization layer for this concept (per the
three-layer rule, the declarative and code layers are N/A — a skill is
prompt content). `sivru skill install` drops an editable file; a user
or team edits their local copy or ships a variant. Built-in default:
the curated `SKILL.md`. There is nothing to over-engineer here.
