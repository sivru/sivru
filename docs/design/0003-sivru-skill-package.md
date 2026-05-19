# DESIGN-0003: the sivru skill

**Status:** Draft
**Class:** Spine (per [GOALS.md](../../GOALS.md))
**Targets:** v0.4.0
**Issue:** filed when v0.4 work starts
**Created:** 2026-05-08
**Updated:** 2026-05-19 — revised back to Draft after CEO + engineering
review (`/plan-ceo-review`, `/plan-eng-review`). The review cut scope:
the install edit-safety subsystem moves to v0.6, the observe efficacy
baseline to v0.5, and the §6 smoke test gains a real harness. See
"Deferred to later versions" and Effort. Prior Accepted revision (the
full installer subsystem) is superseded by this one.
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
  registration. The engineering review expected this channel to carry
  most of v0.4's value because it has no activation risk — but the §5
  measurement contradicted that (see §5, "Measured result"): with the
  hint present and the skill absent, behavioural-query routing was
  0/6. The always-on hint, on its own, moved nothing.

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

Why bundled: the skill describes the routing policy and the MCP tool
surface; shipping them in one package keeps the install path simple,
and the skill is meaningless without the CLI, so a separate package and
second install buy nothing. (This deliberately overrides the roadmap's
`@sivru/skill` package name.)

**Packaging (engineering review, finding A1).** The bundled `SKILL.md`
is a **static asset** — static per CLI release, not interpolated per
install; two installs from the same CLI version produce a
byte-identical file. `@sivru/cli` builds with plain `tsc`, which emits
only compiled `.js` into `dist/`, and `package.json` `files` is
`["dist", "README.md"]`. A raw `SKILL.md` would therefore be **silently
dropped from the published npm package**. So:

- the `SKILL.md` asset is added to `package.json` `files`;
- `sivru skill install` resolves it at runtime relative to the package
  root via `import.meta.url`, not via a source-tree path;
- CI runs `npm pack` and asserts the tarball contains `SKILL.md`, so a
  wrong `files` entry fails CI rather than failing users after
  `npm install -g`.

### 3. Install — minimal, `--force` by default (D2, revised)

The skill is the customization layer — users may edit their copy. v0.4
ships the **minimal** installer; the edit-preservation subsystem
(marker file, content hashing, `SKILL.md.new` dead-drop) is deferred to
v0.6, where the `@sivru`-authoring content gives users a real reason to
edit (see "Deferred to later versions").

`sivru skill install`:

- Resolves the target scope: default `~/.claude/skills/sivru/`;
  `--project` writes `.claude/skills/sivru/` **at the git repo root**
  (not the current working directory — running it from a subdirectory
  still targets the repo-root `.claude/`; reuse `doctor.ts`'s
  `resolveRepoRoot`).
- Reads the bundled `SKILL.md` asset (§2). If the asset is missing,
  fail loud — "install is corrupt; reinstall `@sivru/cli`" — never
  write a stub.
- Ensures the target directory exists (`mkdir -p`; surfaces a named
  error on `EACCES`, fails clean on `ENOSPC` with no partial stub).
- Overwrites by default. If a file already exists at the path and its
  content **differs** from what would be written, print a one-line
  notice ("note: your edited SKILL.md was overwritten"); if identical,
  stay silent. The difference check is a best-effort raw content
  compare — it is only a cosmetic notice, install proceeds either way,
  so a CRLF-only false notice is acceptable until v0.6's normalised
  hashing lands.
- **Scope-collision notice (engineering review, finding 4 / open
  question #2).** If a copy already exists in the *other* scope
  (user-scope when installing `--project`, or vice versa), print a
  one-line note so a shadowed or stale copy is visible. No change to
  Claude Code's own precedence; the `doctor` double-install check ships
  with the deferred `doctor` work in v0.6.

`sivru skill uninstall` removes the installed `SKILL.md` (and its
directory if empty). It is idempotent — an already-absent file is
reported as success, not an error.

`sivru help` lists the `skill` subcommand.

### 4. The `SKILL.md` content — one canonical policy

The body is the routing policy: when `sivru.search` vs Grep, when
`find_related` after edits, that `observe` exists. It is **honest** —
it names the cases where Grep beats `sivru.search`. That honesty is in
mild tension with the feature's goal (it hands the agent its trained
default), and the choice is deliberate: a skill that oversold sivru to
capture tool-calls would violate the project's honesty principle, and
the §5 smoke test measures whether honest framing still routes
correctly. If it does not, revisit then — do not pre-emptively shade
the truth.

**One canonical source.** The routing policy is canonically the
`SKILL.md` body. The MCP tool descriptions are a deliberate one-line
compression of it; the README and `WHY-SIVRU.md` **link** to it rather
than restate it, so they cannot drift.

**Drift guard (engineering review, finding 5).** Because the MCP
description strings are code that can silently fall out of sync with
the canonical body, a unit test asserts each description still contains
its routing hint — the `search` description names the
grep-for-identifiers case, the `find_related` description names the
after-edit case. A substring check, not semantic equivalence: it guards
against the hint being deleted, which is the realistic failure.

### 5. In-cycle efficacy smoke test (D5, revised)

v0.4's value rests on "the routing guidance changes agent behaviour."
The full A/B proof is the v0.16 skill-efficacy bench, but shipping a
Spine release with that hypothesis 100% unverified for ~12 releases is
not acceptable. v0.4 includes a **smoke test** — a rough confidence
check and the seed corpus for the v0.16 harness.

**Harness (engineering review, finding A2 — gates the section).** The
smoke test must actually run a model; it is not a human eyeballing
prompts. It does so by **shelling out to the `claude` CLI** in
print / JSON output mode, with the sivru skill installed:

- a small corpus of routing-decision prompts, each labelled with the
  correct tool for its query shape (e.g. *"where is retry backoff
  handled"* → behavioural → `sivru.search`; *"find every call site of
  parseConfig"* → identifier → Grep);
- each prompt is run through `claude` with the skill+MCP guidance
  present and again with it absent;
- the runner reads structured `tool_use` events from `claude`'s
  JSON / stream-json output to determine which tool was picked — it
  does **not** scrape prose text.

Driving `claude` with the skill installed means the smoke test also
exercises **activation** — whether the frontmatter `description`
actually makes Claude Code load the skill body. That was a separate
un-budgeted concern; the harness folds it in.

If a runnable harness turns out not to be feasible inside v0.4's
budget, this section must say so honestly rather than ship a test that
cannot execute. The harness is research-shaped; treat its feasibility
as the first thing to verify.

**Success metric (engineering review, finding 1).** Success is
**routing correctness** — "picked the correct tool for the query
shape" — *not* "shifted toward sivru". A shift toward `sivru.search` on
an identifier-shaped query is a regression, not a win. The result is
recorded in the v0.4 changelog; it is a confidence check, not a hard
CI gate.

**Measured result (v0.4, claude 2.1.144, n=15, single run).** Routing
correctness 53% without the skill, 67% with it (+14 points).
Behavioural-query routing to `sivru.search`: 0/6 without the skill,
2/6 with it. Two findings, both honest and both load-bearing for the
next version:

1. **The §1 hypothesis is half wrong.** §1 expected the always-on MCP
   descriptions to carry most of the value. They carried *none* of the
   behavioural lift — 0/6 with the hint present and the skill absent.
   Every point of behavioural movement came from the conditionally
   loaded `SKILL.md`, the channel §1 rated less reliable. A one-line
   tool-description hint did not overcome the trained grep default;
   the fuller skill prose did, weakly. v0.5+ should treat the skill,
   not the descriptions, as the primary lever.
2. **The ceiling is sub-agent delegation, not the skill wording —
   confirmed.** The §5 headline (2/6 behavioural with the skill) is
   depressed by an artifact: on a behavioural query, headless `claude`
   delegates the codebase search to a sub-agent (the Task tool), and
   the sub-agent runs with its own context — it never carries the
   sivru skill, so it greps. A follow-up trace with delegation blocked
   (`--disallowedTools Task Agent`) showed the real picture: the main
   agent loads the `sivru` skill and routes to `sivru.search` on 2 of
   3 behavioural prompts. The skill works on the agent that reads it;
   it just is not the agent doing the search. v0.5+ should address the
   delegation directly — either the `SKILL.md` tells the agent not to
   delegate a behavioural codebase search (do it directly so the skill
   applies), or sivru's routing guidance has to reach sub-agents.
   Wordsmithing the skill body in isolation will not move this.

## Deferred to later versions

The CEO + engineering review cut the following out of v0.4. They are
recorded here so the cut is explicit and the work is not lost.

- **v0.6 — install edit-safety subsystem.** A marker file
  (`.sivru-skill-version`, carrying a bundled-content hash and an
  install timestamp), normalised-content hashing (so a CRLF /
  trailing-newline change is not mistaken for a user edit), a
  pristine-vs-edited re-install decision, and a `SKILL.md.new`
  dead-drop when the user has edited their copy. Rebuilt in v0.6
  alongside the `@sivru`-block authoring content that gives users a
  reason to edit the skill. When this lands: a sivru-looking file with
  no marker is treated as user-owned (write `SKILL.md.new`, never
  clobber).
- **v0.6 — `sivru doctor` checks.** Warn on a stale installed skill —
  comparing the **bundled content hash**, not the CLI version number,
  so a no-op version bump does not fire a spurious warning — surface a
  pending `SKILL.md.new`, and flag a double-install across scopes.
- **v0.6 — `sivru skill diff`.** Unified diff between an installed,
  user-edited `SKILL.md` and the version `@sivru/cli` would write,
  reconciling the `SKILL.md.new` dead-drop.
- **v0.5 — observe efficacy baseline.** An `observe`-based baseline
  routing-rate over local session jsonl. Deferred because a baseline
  with no with/without comparison drives no v0.4 decision; it belongs
  in the release that can trend against it.
- **No version yet — tool-neutral routing rules.** Emitting Cursor
  (`.cursor/rules`) and Codex (`AGENTS.md`) variants from the same
  canonical policy. Tracked in `TODOS.md`.

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

**Full install edit-safety subsystem in v0.4.** The prior Accepted
revision shipped the marker / hashing / `SKILL.md.new` / `doctor`
subsystem in v0.4. The CEO review cut it: it preserves edits nobody has
made on the skill's first release. Moved to v0.6 (see "Deferred").

**`postinstall` hook auto-writing `~/.claude/skills/`.** npm
postinstall writing outside the package dir is a silent footgun. An
explicit `sivru skill install` is predictable. Rejected.

## Open questions

- **How prescriptive the routing rules are** — settle the exact
  wording of the `SKILL.md` body and the frontmatter `description`
  against the §5 smoke-test prompts during implementation.

(Open question #2 from the prior revision — `install` default scope —
is resolved: user scope by default, `--project` opt-in, and the §3
scope-collision notice makes a double-install visible.)

## Acceptance criteria

- The one-line routing hint is in the `sivru.search` /
  `sivru.find_related` MCP tool `description` strings (always-on), and
  a unit test asserts each description still contains its hint (§4).
- `SKILL.md` ships inside `@sivru/cli`, Claude Code skill format, with
  a frontmatter `description` written to trigger on the general
  code-search/navigate situation. It is in `package.json` `files`, and
  a CI `npm pack` check confirms it is in the published tarball.
- `sivru skill install` writes the skill (resolving the bundled asset
  via `import.meta.url`); `--project` writes to the git repo root;
  `uninstall` removes it idempotently; `sivru help` lists the `skill`
  subcommand.
- Install overwrites by default; an existing file whose content
  differs triggers a one-line "overwritten" notice; a copy in the
  other scope triggers a one-line collision notice.
- Install error paths are explicit: missing bundled asset fails loud,
  `EACCES` gives a named error, `ENOSPC` fails clean with no stub.
- The routing policy has one canonical home (`SKILL.md` body); README
  and `WHY-SIVRU.md` reference it rather than restate it.
- The §5 efficacy smoke test runs through the `claude` CLI with the
  skill installed, scores routing **correctness** per query shape, and
  its result is recorded in the changelog. If no runnable harness is
  feasible in budget, §5 is amended to say so.

## Test plan

- **Unit — `sivru skill install`.** Fresh install writes the file;
  `--project` resolves to the git repo root from a subdirectory;
  default overwrite; an existing differing file triggers the notice;
  an identical file does not; a copy in the other scope triggers the
  collision notice; a non-sivru file at the path is reported, not
  adopted; missing bundled asset fails loud; `uninstall` removes the
  file and is idempotent when the file is absent.
- **Unit — packaging resolution (test gap 1).** Resolve the bundled
  `SKILL.md` via the same `import.meta.url` logic the command uses and
  assert it exists. Plus a CI `npm pack` step asserting the tarball
  contains `SKILL.md`.
- **Unit — skill format.** The shipped `SKILL.md` frontmatter parses
  and has the required fields.
- **Unit — `sivru help`.** Lists the `skill` subcommand.
- **Unit — MCP description drift (§4).** Each tool description string
  contains its routing hint.
- **Unit — smoke-runner parser (test gap 2).** A recorded `claude`
  JSON output fixture; the tool-choice parser extracts the right tool.
- **Smoke test — efficacy (§5).** The routing-prompt corpus run
  through the `claude` CLI with the skill installed; routing
  correctness per query shape with vs without the guidance; recorded,
  not asserted as a hard gate.
- **Review-gated — content.** Routing policy correct and honest;
  verified by reading.

## Effort

The prior Accepted revision estimated ~1.5–2 weeks. The CEO review cut
the install edit-safety subsystem (to v0.6) and the observe baseline
(to v0.5); the engineering review added the packaging fix, the
`claude`-CLI smoke harness, the drift test, and two test-coverage
items. Revised estimate: **~1–1.5 weeks** human-team — the
roadmap-facing number for the v0.4 slot — or **~1.5–2.5 days** with CC.
Implementation tasks are tracked as T1–T7 from the engineering review.

## Customization shape

The skill *is* the customization layer (per the three-layer rule, the
declarative and code layers are N/A — a skill is prompt content).
`sivru skill install` drops an editable file. In v0.4 a re-install
overwrites by default and notices that it did; the re-install logic
that *preserves* edits is the v0.6 edit-safety subsystem (see
"Deferred to later versions"). Built-in default: the curated
`SKILL.md`. Nothing here to over-engineer.
