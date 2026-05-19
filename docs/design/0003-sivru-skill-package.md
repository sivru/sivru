# DESIGN-0003: the sivru skill

**Status:** Accepted
**Class:** Spine (per [GOALS.md](../../GOALS.md))
**Targets:** v0.4.0
**Issue:** filed when v0.4 work starts
**Created:** 2026-05-08
**Updated:** 2026-05-19 — Stub → Draft → Accepted through engineering
review (decisions D1, D2, D4, D5 below). The review materially grew
scope; see Effort.
**Author:** @pochadri

## Problem

After `npm install -g @sivru/cli` + `claude mcp add sivru`, Claude has
the sivru MCP tools registered but **no policy for when to use them**.
It figures out by trial and error and usually reaches for Grep first —
that is what it was trained on. So a developer installs sivru and the
agent barely changes its behaviour.

The fix is a routing policy: teach the agent *when* to reach for
`sivru.search` / `sivru.find_related` versus Grep / Read. But there is
a trap in *how* that policy is delivered (see §1) — a Claude Code
skill is loaded conditionally, and the condition is the very
recognition the agent gets wrong today.

This is **Spine**, not Supporting. The routing policy is where sivru's
public framing turns from "a code-search MCP" into "the comprehension
layer for AI-written code" — and from v0.6 on it is where the agent
learns to author and read `@sivru` annotation blocks.

## Proposal

### 1. Two delivery channels — always-on + conditional (D4)

A Claude Code skill's body is **not** always in the prompt. It loads
when the agent matches the skill's frontmatter `description` to the
situation. So a routing policy that lives only in a `SKILL.md` body
fires only if the agent already recognised "this is a code-search
situation" — the exact recognition the Problem says it fails. The MCP
tool `description` strings, by contrast, are **always** in the agent's
context. v0.4 therefore uses both channels:

- **Always-on — MCP tool descriptions.** The `description` strings on
  `sivru.search` and `sivru.find_related` (registered by the MCP
  server) carry the one-line routing hint. This is the reliable
  channel and it is cheap — a few lines in the MCP server's tool
  registration.

  ```
  sivru.search      — Semantic + lexical code search. Best for
                      natural-language / behavioural queries ("where
                      is auth refresh handled", "how does retry
                      backoff work"). For an exact known identifier
                      or string, plain grep is faster and more precise.
  sivru.find_related — Find code related to a symbol or line range —
                      callers, tests, similar code. Use after editing
                      a symbol, before you finish.
  ```

- **Conditional — the `SKILL.md`.** The richer layer: the
  find_related-after-edit workflow, that `sivru observe` exists, the
  runtime-vs-skill framing, and (from v0.6) `@sivru` block authoring.
  Its frontmatter `description` is spec'd to trigger on the **general
  situation** the agent *can* recognise — "searching or navigating a
  codebase, finding where something is implemented, finding code
  related to an edit" — never on "should I use sivru". The body is
  the canonical routing policy (see §4).

### 2. The skill ships inside `@sivru/cli` (D1)

The roadmap sketched a separate `@sivru/skill` package. This design
**supersedes that** — the `SKILL.md` ships *inside* `@sivru/cli`, and a
new subcommand installs it:

- `sivru skill install` writes it to `~/.claude/skills/sivru/SKILL.md`
  (or `.claude/skills/sivru/` with `--project`).
- `sivru skill uninstall` removes it.

Why bundled: the skill describes the MCP tool surface a given CLI
version exposes — shipping them together keeps them in sync at install
time, and the skill is meaningless without the CLI, so a separate
package and second install buy nothing. (`> note:` overrides the
roadmap's `@sivru/skill` package name, deliberately.)

### 3. Install without destroying user edits (D2)

The skill is the customization layer — users are expected to edit
their copy. So `sivru skill install` must not silently clobber edits:

- On install it writes the `SKILL.md` **and** a version marker
  (`.sivru-skill-version` — the sivru version + a content hash of
  exactly what was written).
- On re-install: hash the existing file with **line-ending-normalised
  content** (so a CRLF / trailing-newline / whitespace change is not
  mistaken for an edit — finding #4). If it matches the marker's
  recorded hash, the file is pristine → update in place. If it
  differs, the user edited it → do **not** overwrite; write the new
  version as `SKILL.md.new`, leave the marker, and report it.
- `--force` overwrites outright (the "just give me the latest" path).
- The marker stores only the **last-written** hash — no registry of
  all historical versions is needed.
- Before treating a hash mismatch as a user edit, check the file even
  looks like the sivru skill (frontmatter `name`); a stray unrelated
  file at the path is reported, not adopted (finding #8).

### 4. The `SKILL.md` content — one canonical policy

The body is the routing policy: when `sivru.search` vs Grep, when
`find_related` after edits, that `observe` exists. It is **honest** —
it names the cases where Grep beats `sivru.search`. That honesty is in
mild tension with the feature's goal (it hands the agent its trained
default), and the choice is deliberate: a skill that oversold sivru to
capture tool-calls would violate the project's honesty principle, and
the §6 smoke test measures whether honest framing still shifts
routing. If it does not, revisit then — do not pre-emptively shade the
truth.

**One canonical source (finding #6).** The routing policy is currently
stated in `WHY-SIVRU.md`, will be in the `SKILL.md`, the MCP tool
descriptions, and the skill README. The `SKILL.md` body is canonical;
the MCP descriptions are a deliberate one-line compression; the README
and `WHY-SIVRU.md` link to it rather than restate it, so they cannot
drift.

### 5. Staleness — `sivru doctor` (findings #3, #5)

The installed `SKILL.md` is a static copy. The CLI moves on — new MCP
tools, renamed tools — and nothing re-runs `install`, so the copy goes
stale **silently**. `sivru doctor` gains two checks:

- the installed skill's marker version is behind the running CLI →
  warn, suggest `sivru skill install`;
- a `SKILL.md.new` is sitting unmerged next to the active skill →
  surface it so the dead-drop from §3 actually gets reconciled.

### 6. In-cycle efficacy smoke test (D5)

v0.4's value rests on "the routing guidance changes agent behaviour."
The full A/B proof is the v0.16 skill-efficacy bench, but shipping a
Spine release with that hypothesis 100% unverified for ~12 releases is
not acceptable. v0.4 includes a **smoke test**: a handful of
routing-decision prompts (e.g. *"where is retry backoff handled"* →
should pick `sivru.search`; *"find every call site of parseConfig"* →
should pick Grep), run with the guidance present vs absent, checked
for a routing shift. Not the v0.16 harness — a rough confidence check,
and the seed corpus for it. The result is recorded in the v0.4
changelog.

## Alternatives considered

**Separate `@sivru/skill` npm package.** The roadmap's sketch.
Reintroduces skill-vs-MCP version drift and a second install for a
skill useless without the CLI. Rejected (§2).

**`SKILL.md` as the only channel.** Leaves 100% of efficacy on the
agent choosing to load a conditionally-loaded skill — the activation
risk §1 exists to mitigate. Rejected (D4).

**Drop the skill; routing guidance only in MCP tool descriptions.**
Always-on, zero activation risk, but tool descriptions are short — no
room for the find_related workflow, the `observe` pointer, or the v0.6
`@sivru`-block authoring the skill is meant to grow into. Rejected
(D4) — the tool descriptions are the floor, the skill is the depth.

**`postinstall` hook auto-writing `~/.claude/skills/`.** npm
postinstall writing outside the package dir is a silent footgun. An
explicit `sivru skill install` is predictable. Rejected.

## Open questions

- **How prescriptive the routing rules are** — settle the exact
  wording against the §6 smoke-test prompts during implementation.
- **`sivru skill install` default scope** — user (`~/.claude/skills/`)
  by default, `--project` opt-in. Confirm no surprise if both exist.

## Acceptance criteria

- The one-line routing hint is in the `sivru.search` /
  `sivru.find_related` MCP tool `description` strings (always-on).
- `SKILL.md` ships inside `@sivru/cli`, Claude Code skill format, with
  a frontmatter `description` written to trigger on the general
  code-search/navigate situation.
- `sivru skill install` writes the skill + a version marker;
  `--project` variant; `uninstall` removes it; `sivru help` lists the
  `skill` subcommand.
- Re-install: a pristine file (normalised-hash match) updates in
  place; a user-edited file is preserved and the update written as
  `SKILL.md.new`; `--force` overwrites; a non-sivru file at the path
  is reported, not adopted.
- `sivru doctor` warns on a stale installed skill and on a pending
  `SKILL.md.new`.
- The routing policy has one canonical home (`SKILL.md` body); README
  and `WHY-SIVRU.md` reference it.
- The §6 efficacy smoke test runs and its result is in the changelog.

## Test plan

- **Unit — `sivru skill install`.** Default path; `--project` path;
  fresh install writes file + marker; pristine re-install updates;
  user-edited file → `SKILL.md.new` written, original untouched;
  `--force` overwrites an edited file; non-sivru file at the path is
  reported; `uninstall` removes file + marker.
- **Unit — normalised hashing.** A CRLF / trailing-newline-only
  difference still counts as pristine (not a false "edited").
- **Unit — skill format.** The shipped `SKILL.md` frontmatter parses
  and has the required fields.
- **Unit — `sivru doctor`.** Stale-marker warning fires; pending
  `SKILL.md.new` is surfaced.
- **Unit — `sivru help`.** Lists the `skill` subcommand.
- **Smoke test — efficacy (§6).** The routing-prompt set; routing
  shift with vs without the guidance; recorded, not asserted as a
  hard gate.
- **Review-gated — content.** Routing policy correct and honest;
  verified by reading.

## Effort

The roadmap budgeted v0.4 at ~1 week. Engineering review grew it: D4
adds MCP-tool-description changes, D5 adds the efficacy smoke test,
and findings #3/#5/#8 add `doctor` checks and `uninstall`. Realistic
estimate is now **~1.5–2 weeks**. This is a deliberate, reviewed
expansion — the bare ~1-week version would have shipped a skill that
mostly never loads and was never tested. Recorded here so the roadmap
estimate is not silently wrong.

## Customization shape

The skill *is* the customization layer (per the three-layer rule, the
declarative and code layers are N/A — a skill is prompt content).
`sivru skill install` drops an editable file; §3 makes sure a later
re-install never destroys those edits. Built-in default: the curated
`SKILL.md`. Nothing here to over-engineer.
