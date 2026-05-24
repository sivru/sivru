# DESIGN-0005: Coach loop v1 — skill drift

**Status:** Accepted (promoted from Draft on 2026-05-23 by
`/plan-ceo-review` SELECTIVE EXPANSION mode + 3 iterations of
fresh-context spec-review subagent → PASS at 9/10. Re-verified on
2026-05-24 by `/plan-eng-review` iter-1 PASS — 2 architectural
decisions (E1 git batching, E2 Checkup tab path source) absorbed
inline, 5 code-quality / observability findings folded. Re-verified
on 2026-05-24 by `/plan-design-review` — design score 7/10 → 9/10
after folds; one design decision absorbed (D1 severity sort:
errors → warnings → info within each file).)
<!-- Draft → Accepted → Implemented → Superseded -->
**Class:** Spine (per [GOALS.md](../../GOALS.md))
**Targets:** v0.9.0
**Issue:** filed when v0.9 work starts
**Created:** 2026-05-08
**Updated:** 2026-05-24 — eng-review iter-1 absorbed two architectural
decisions: E1 (batch-and-cache git shell-outs — one `git log` per
file capturing lastEdit + last-commit + rename history; cache
`headCommitCount` once per run) and E2 (Checkup tab reads
`selectedProject` from observe-ui App state, falling back to
most-recent session's `projectRoot` only when none is selected).
Plus 5 inline folds: shared exec helper for DRY across
`doctor.ts` + `git-stats.ts`; HTTP path-safety degrades to
homedir-only containment when git is unavailable; known-tools
registry pinned with last-verified date + CI assertion; DESIGN-0017
vs DESIGN-0005 surface separation documented (block drift surfaces
via `sivru explain` only, NOT the Checkup tab at v0.9); `sivru
observe init` meta-flagging noted in Open questions.

**Updated:** 2026-05-23 — promoted Stub → Draft; retargeted v0.6.0 → v0.9.0
per ROADMAP sequencing note; specified module location, check IDs, age
algorithm, surfaces (CLI / MCP / HTTP / Checkup tab), and error-code
range. Cherry-picks from `/plan-ceo-review` iter-1 SELECTIVE EXPANSION
absorbed: D1 (module location locked to `packages/observe/src/coach/`),
D3 (single-shipment v0.9), D4 (third built-in check
`memory-skill-tools-drift`), D5 (`--strict` flag deferred to TODOS.md),
D6 (delight: rename-suggestion on dead-reference findings + "what
changed since" diff preview on aged-file findings), D7 (FP corpus
real-world-only, 10–20 files). Iter-1 spec-review found 30 issues
across 5 dimensions (quality 6/10); folded in iter-2: consistency
fixes (3-checks wording propagated; tab placement locked to
Sessions/Checkup/Replay/Costs/Bench; path-safety unified to
strict-containment-only), completeness adds (CLAUDE.local.md
included; project-vs-user-global shadowing rule; MCP stdio
transport pinned; severityOverrides unknown-id semantics), scope
trims (free-form path picker deferred to v0.10; `.sivru/checkup/*.ts`
discovery dropped from v0.9 entirely), and feasibility fixes
(FP-rate gate replaced with labelled-span N ≥ 50 denominator;
test + corpus budgets corrected to match real work).
**Author:** @pochadri

## Problem

A Claude Code project carries three kinds of authored agent guidance —
`CLAUDE.md`, skills (`.claude/skills/**/SKILL.md`), and agent files
(`.claude/agents/**/*.md`). The user wrote them once and the repo
moved underneath. The skill still references a file that was renamed
in PR #112. The agent file still names a tool that the v0.6 refactor
removed. `CLAUDE.md` describes a code layout that hasn't existed
since the migration.

Today the user sees none of this. The agent keeps reading the
guidance, keeps issuing confident edits against the old shape, and
keeps producing PRs that quietly contradict current conventions.
Drift is the most expensive silent failure mode in agent workflows
and the easiest one to surface — staleness is data, not judgment.

The failure mode is concrete. A skill written six months ago says
"call `runScan()` from `scanner.ts`." `scanner.ts` was renamed to
`audit.ts` two months ago. The agent reads the skill, reads
`runScan` no longer exists, decides the skill is wrong, improvises
a new approach, and ships a regression. The user never knew the
skill had drifted until the regression landed.

## Proposal

v0.9 ships the **lowest-false-positive coaching signal first**: three
checks that detect skill / memory drift, exposed through CLI, MCP,
HTTP, and a new **Checkup tab** in observe-ui. All checks fire
descriptively — *"your CLAUDE.md is 130 days old and 487 commits
behind HEAD"* — never judgmentally. The user decides whether that
matters.

The library + CLI + MCP land together; the Checkup tab consumes
them through a new HTTP route on the observe server. After v0.9
this becomes the shared substrate for v0.10 (looped-on-error) and
v0.11 (low-context edit).

### 1. The three checks

**`memory-claude-age`** — file-age check. CLAUDE.md, every
`SKILL.md`, and every agent file are scored as "fresh" / "aged"
against a churn-scaled age threshold (§3a). Finding renders with
a one-line "what changed since" preview:

> CLAUDE.md last edited 2026-01-13 (130 days ago, 487 commits
> behind HEAD). Biggest changes since: `packages/observe/`
> (23 new files), `packages/search/block/` (entire new module).

**`memory-dead-reference`** — broken file path mentions inside
inline-code spans in those same files. A reference is "dead" when
the path resolves relative to repo root (or to `~` for user-global
files) and the resolved target doesn't exist. When `git log
--follow --diff-filter=R` shows the path was renamed in history,
the finding includes the suggested rename:

> SKILL.md:42 references `src/scanner.ts` — no such file in the
> repo today. May have been renamed to `src/audit.ts` in commit
> `4a2b3c5` (2026-02-14).

**`memory-skill-tools-drift`** — front-matter `tools:` field
validation on SKILL.md + `.claude/agents/*.md`. Tool names listed
in the front-matter are checked against the known-tool set:

- Claude Code's documented built-in tools (canonical list
  maintained in `known-tools.ts`; the v0.9 PR pins it to the
  current set as of Claude Code's documented public tools at
  release time, plus a comment naming the documentation
  source — a brittle but honest pin).
- Subagent names resolved from `.claude/agents/*.md` filenames
  (project-local and `~/.claude/agents/`).

When the documented Claude Code tool list changes between
versions, sivru's known-tool list lags until a sivru release
catches up — meaning a newly-added Claude Code tool will
**false-positive flag** until then. v0.9 accepts that lag as a
honest cost; v0.10+ may add a `knownTools` config field (already
implied by §8 layer-2 extensibility) so users can patch
locally without waiting for a sivru release. Tracked in the
known-tools maintenance note inside `known-tools.ts`.

Finding renders as:

> SKILL.md front-matter lists tool `LegacyTool` — not a built-in
> Claude Code tool and no `.claude/agents/LegacyTool.md` found.

Three checks is the v0.9 floor. v0.10 / v0.11 add more signals
once v0.9's FP rate is measured.

### 2. Module location + surfaces

The coach signals live with their natural consumers. They read
local files (CLAUDE.md, repo paths, optional `git log`) — no
network — so the observe privacy boundary (DESIGN.md §5.5) holds.

```
packages/observe/src/coach/
  types.ts          — MemoryFile, AuditFinding, MemoryCheck,
                       AuditContext, CheckupConfig
  index.ts          — public exports: runCheckup(repoRoot, opts)
                       → CheckupReport
  load.ts           — discoverMemoryFiles(repoRoot): MemoryFile[]
  age.ts            — git-log + churn-scaled age scoring
  config.ts         — loadCheckupConfig(repoRoot) with project-
                       beats-user-beats-default precedence
  checks/
    claude-age.ts        — memory-claude-age built-in
    dead-reference.ts    — memory-dead-reference built-in
    skill-tools-drift.ts — memory-skill-tools-drift built-in
  known-tools.ts    — known-tool registry: built-in tools list +
                       agent-name scan from .claude/agents/.
                       Header carries `// LAST_VERIFIED: <date>
                       against Claude Code <version>` comment;
                       CI assertion checks the date format exists
                       (forces a manual touch when the registry
                       is updated).
  git-stats.ts      — batched git shell-out helpers. Per E1:
                       perFileStats() runs ONE `git log` per file
                       (lastEdit + last-commit + rename history
                       in one invocation); headCommitCount()
                       cached once per runCheckup. Diff-stats for
                       the "what changed since" preview remain
                       per-aged-file (delight only, not in the
                       hot path). Imports `node:child_process`
                       (allowed by the existing egress test which
                       bans only http/https/net/tls/undici).
  exec.ts           — shared execFile wrapper: timeout + error
                       rescue + result shape. Extracts the
                       pattern from packages/cli/src/commands/
                       doctor.ts (its private `exec()` helper);
                       both consumers import to avoid duplication.
  __fixtures__/
    repo-stale/          — labelled "should flag all three checks"
    repo-fresh/          — labelled "should flag nothing"
    repo-mixed/          — partial-drift case
    repo-rename/         — file-rename in history for the
                            rename-suggestion delight test
```

The existing stub at `packages/cli/src/lib/memory-audit/types.ts`
is **superseded** by `packages/observe/src/coach/types.ts`. The
stub file is deleted in the v0.9 PR; nothing imports from it today.

**CLI:** `sivru checkup [path]` —
`packages/cli/src/commands/checkup.ts`. Defaults `path` to cwd.
Flags: `--json` (machine output), `--check <id>` (filter to one
check id, repeatable), `--no-git` (skip git-log lookup; fall back
to mtime). Exit code: 0 for all findings (descriptive only — there
are no "errors"); 1 only on config-malformed or path-doesn't-
exist (`SIVRU-E240` / `SIVRU-E241`, §4).

**MCP:** `mcp__sivru__checkup` — same library entry point as the
CLI, returns the JSON report. Agents call it proactively when the
sivru skill (v0.4) routes them ("before trusting CLAUDE.md, check
its age").

**HTTP:** `GET /api/checkup?path=<absolute>` on the observe Hono
app. Returns the JSON report. Localhost-only by the existing CORS
rule; no auth needed because the binding is loopback.

**Path-safety validation** before any read: the `path` query
parameter must be (a) absolute, (b) an existing directory, AND
(c) **contained under either `homedir()` or a known git working
tree**. "Known git working tree" = either the path itself is a
git working tree (`git rev-parse --is-inside-work-tree` from
that directory succeeds) or it's a descendant of one. Anything
else returns 400 with `SIVRU-E245 checkup-path-unsafe`. This is
a containment rule, not a blocklist — there is no enumeration
of sensitive system dirs. Containment is stricter and simpler.
(Spec-review iter-1 finding: the original blocklist was theater
that hid the containment requirement.)

**Graceful degradation when git is unavailable** (eng-review A7
fold): if the `git rev-parse` check itself fails because the git
binary is missing from PATH, the containment check **degrades to
homedir-only** — paths under `homedir()` are accepted, everything
else is rejected. The HTTP layer logs an `info` diagnostic in the
response noting the degradation. Matches the same fallback pattern
the per-file git checks use; same `SIVRU-E244` code, surfaced via
the route's response body.

At v0.9 the Checkup tab only passes paths from the session list
(`projectRoot` values that are by construction inside git
working trees), so this check is defense-in-depth, not the
primary mechanism. v0.10's free-form path picker is the
consumer that actually needs containment validation.

**observe-ui:** new **Checkup tab** between Sessions and Replay
(tab order: Sessions / Checkup / Replay / Costs / Bench). Lists
findings grouped by file, color-coded by severity, with a
"Refresh" button that re-fetches `/api/checkup`.

**Path source** (eng-review E2): tab reads `selectedProject` from
`App.tsx`'s existing state (the project the user is filtering on
in the sidebar — consistent with how Sessions / Replay / Costs
behave). When `selectedProject` is null ("all projects"), tab
falls back to the most-recent session's `projectRoot`. Free-form
text input is NOT exposed at v0.9 (deferred to v0.10 per
spec-review iter-1; closes the HTTP attack surface concern until
the FP rate of the checks themselves is field-measured). Tab
uses existing `BenchView` / `CostsView` patterns.

Argument parsing is hand-rolled (matches v0.5 / v0.6 convention).

### 3. The check algorithms

**3a. `memory-claude-age` (file-age, churn-scaled).**

A file is **aged** when **both** of the following hold:

1. `daysSinceLastEdit(file) ≥ 90` (default; tunable via
   `.sivru/checkup.json` `ageDays`).
2. `commitsSinceLastEdit(file) ≥ 50` (default; tunable via
   `ageCommits`).

Both-must-hold means a low-churn repo (≤ 50 commits in 90 days)
never flags purely on calendar age, and a high-churn repo with a
file edited last week never flags purely on commit count. The
two conditions calibrate each other.

`daysSinceLastEdit` and `commitsSinceLastEdit` are derived from
**batched git calls** (per eng-review E1):

- `perFileStats(path)` runs ONE invocation per file:
  `git log -1 --follow --name-status --diff-filter=AMRD
   --format='%H%n%ct' -- <path>`. Returns `{ lastCommitHash,
  lastCommitTs, renameHistory[] }` parsed from a single
  stdout stream. `renameHistory[]` is populated by walking
  back up to 500 commits (paginated) only if `dead-reference`
  asks for it later.
- `headCommitCount()` runs ONCE per runCheckup:
  `git rev-list --count HEAD`. Cached for the duration of the
  run. `commitsBehindHead` per file derives from
  `count - perFileStats.lastCommitTs-resolved-count`.

This cuts shell-outs ~3× compared with naive per-call invocation
and avoids spawning N+ child processes simultaneously on big
repos. The shared `exec.ts` wrapper applies a 4-second timeout
(matches `doctor.ts` precedent).

Files outside any git repo (user-global `~/.claude/CLAUDE.md`)
fall back to mtime + null commit count; the finding still fires
on calendar age alone for those.

**Git failure modes** (all degrade gracefully, none crash):

- Git binary missing from PATH → emit `SIVRU-E244` once per
  run, fall back to mtime mode for every file.
- `<path>` not inside a git working tree → same fallback,
  same single-emit diagnostic.
- `git log` exits non-zero (corrupted repo, locked index) →
  treat the file as "no git data" individually; other files
  in the same run still get git data when their `git log`
  succeeds.
- `git log` timeout (4s ceiling, matches doctor.ts pattern) →
  same as exit non-zero.

`--no-git` (CLI flag) forces the mtime fallback for every file
unconditionally; useful for non-repo paths and for users who
don't want shell-outs. Equivalent to the `SIVRU-E244` auto-
fallback but without the diagnostic.

**In mtime mode**, only the day floor applies. The commit floor
is treated as satisfied — otherwise no user-global file ever
flags, which would defeat the check's purpose. So the
"aged" decision in mtime mode collapses to `daysSinceLastEdit
≥ ageDays`. The day-floor comparison is `≥` (inclusive), and
matches the comparison used in the both-floors-apply mode for
consistency.

Severity tier `info / warning / error` extends v0.6's
`warning / error` (DESIGN-0016 §4) with a lower tier for
descriptive observations like `memory-claude-age` — see §4 below
for the partition.

**"What changed since" preview delight (D6a).** When
`memory-claude-age` fires for a file with a known
`lastCommitTs`, the check runs

```
git diff --name-only --diff-filter=AMD <last-commit>..HEAD
```

bounded to 10000 path entries (defensive cap; real repos
rarely exceed). Group by **first path segment** (the immediate
directory under `<repoRoot>`). Take the top-3 segments by
count. Render as one-line:

> Biggest changes since: `packages/observe/` (23 files),
> `packages/search/block/` (17 files), `docs/design/` (8 files).

Edge cases:

- Fewer than 3 segments → show only those that exist.
- `git diff` non-zero exit or timeout → finding emitted without
  the preview. The preview is delight, not correctness.
- Path entries with no segment (root-level files, e.g.
  `CHANGELOG.md`) → grouped under the bucket `(root)`.

**3b. `memory-dead-reference` (path-mentions-must-resolve).**

For each memory file:

1. Parse markdown line by line. For each line, extract every
   inline-code span (the `` `...` `` form) and every markdown
   link target (`[text](path)` — but only when the path looks
   like a file path, see below).
2. Filter to candidates that **look like file paths**. A
   candidate qualifies when **any** of:
   - it starts with `~/`, `./`, `../`, or `/`, OR
   - it contains a path separator `/` somewhere mid-string, OR
   - it ends in a recognized extension (`.ts`, `.tsx`, `.js`,
     `.jsx`, `.md`, `.json`, `.yaml`, `.yml`, `.sh`, `.py`,
     `.go`, `.rs`, `.java` at v0.9; tunable via `pathExtensions`).
   Discard everything else (bare words like `git`, `pnpm`,
   `runScan`; bare flags like `--strict`; npm package names).
3. **Normalize** before resolution:
   - Strip trailing `#anchor` (markdown fragment) and `?query`
     (URL query) — these are read-only embellishments.
   - Reject anything containing whitespace (likely not a path).
4. **Resolve** to an absolute path:
   - Path is already absolute (`/foo`) → used as-is.
   - Path starts with `~/` → resolved against `homedir()`.
   - Path is relative (`./foo`, `../foo`, `foo/bar`) → resolved
     against the repo root (NOT the memory file's own directory —
     matches how CLAUDE.md authors reference paths). For
     user-global memory files (`~/.claude/CLAUDE.md`) which have
     no repo root, **relative paths are skipped** (not checked) —
     the resolution would be ambiguous.
5. **Existence check.** If the resolved target does not exist on
   disk → emit a finding (subject to the rename-suggestion
   delight below).

**Lines inside fenced code blocks are ignored.** Fence semantics
match CommonMark:

- Triple-backtick fence opens and closes the block; content
  between is sample code.
- Triple-tilde fence (`~~~`) behaves identically.
- Four-space (or one-tab) indented blocks open on the first
  indented line of a paragraph and close on the first
  non-blank, non-indented line. Blank lines inside the block
  remain part of it. CommonMark §4.4 reference.
- Nested backticks inside an inline-code span (`` `path
  with `nested` backticks/foo.ts` ``) match CommonMark inline-
  code: the entire span is one path candidate, scanned as one.

**Reference-style links** (`[text][id]` with a separate
`[id]: docs/path.md` definition) are NOT scanned at v0.9 —
uncommon in real CLAUDE.md files, and adding them needs a
second parse pass. Tracked as an `Open question` for v0.10
revisit if users surface real cases.

**Rename-suggestion delight (D6b).** When the existence check
fails for path X, the check runs
`git log --follow --diff-filter=R --name-status -- X` to find
a rename in the file's git history. Walk bounded:

- Scope: from `HEAD` back at most 500 commits OR 365 days,
  whichever fires first. Older renames are interesting but
  rarely actionable.
- Single hit (`R100 src/scanner.ts src/audit.ts` with score 100)
  → finding includes the rename suggestion + commit hash.
- Multiple hits (X renamed through Y then to Z) → take the
  most recent rename; include only the final target.
- Ambiguous rename (Git reports rename score < 90 OR multiple
  files in the same commit could match) → finding emitted
  WITHOUT a rename suggestion. The hint is "we don't know."
- Git unavailable / repo not git → finding emitted without
  the suggestion.

The "looks like a path" filter is the false-positive control:
markdown carries many things in inline code (commands, env vars,
variable names) that aren't paths. The combined "path-separator
OR known extension" rule keeps obvious paths in and bare
identifiers out.

### 4. Diagnostic + error-code partition

Findings are tagged with a stable `checkId` (the check's id, used
in config to disable / re-severity) and a severity. Severity is
`info` / `warning` / `error` to extend v0.6's `warning` / `error`
with a third tier for descriptive observations.

**Built-in finding types at v0.9:**

| checkId | Default severity | Trigger |
|---------|------------------|---------|
| `memory-claude-age` | `info` | file's `daysSinceLastEdit ≥ ageDays` AND `commitsSinceLastEdit ≥ ageCommits` (both inclusive — matches §3a comparison) |
| `memory-dead-reference` | `warning` | inline-code path mention resolves to no file in the repo / under `~` |
| `memory-skill-tools-drift` | `warning` | front-matter `tools:` entry is not a built-in tool and not a discovered subagent |

`info` is the right default for `memory-claude-age` because age
alone is not a problem — it's a fact the user weighs. `warning`
on `memory-dead-reference` because a broken path is almost
always wrong.

**Error-code range partition** (extends DESIGN-0016 §4 + DESIGN-0017):

- **v0.6:** `SIVRU-E210–E219` (block extraction / validation)
- **v0.7:** `SIVRU-E220–E229` (block drift)
- **v0.8:** `SIVRU-E230–E239` (codebase-explainer diagnostics, reserved)
- **v0.9:** `SIVRU-E240–E249` (coach loop infrastructure errors —
  config malformed, path errors)
- **v0.10:** `SIVRU-E250–E259` (looped-on-error signals, reserved)
- **v0.11:** `SIVRU-E260–E269` (low-context-edit signals, reserved)

v0.9 reserves the codes below. Some are hard errors that block
the run (E240, E241, E245; E243 is reserved for v0.10);
E242 and E244 are non-blocking
diagnostics that surface in the report alongside findings.

| Code | Severity | Trigger |
|------|----------|---------|
| `SIVRU-E240 checkup-config-malformed` | error | `.sivru/checkup.json` parse error or schema violation |
| `SIVRU-E241 checkup-path-missing` | error | CLI `<path>` argument doesn't exist or isn't a directory |
| `SIVRU-E242 checkup-file-too-large` | warning | a memory file exceeds 200KB; scan stops at the first 200KB of content with a partial-scan diagnostic |
| `SIVRU-E243` | reserved | reserved for v0.10's dynamic loader for `.sivru/checkup/*.ts` (deferred from v0.9 per spec-review iter-1: shipping a stubbed loader that throws if a file exists is a footgun for early adopters; v0.9 does not discover that directory at all) |
| `SIVRU-E244 checkup-git-unavailable` | info | git binary not on PATH OR `<path>` is not a git working tree; CLI auto-falls-back to mtime + null commit count (equivalent to `--no-git`). Emitted **once per run** (not per file) for the missing-binary / not-a-git-tree cases. Transient per-file failures (timeout, non-zero exit on one file) silently fall back without emitting a diagnostic, since they're noisy and the absence of `lastCommitTs` in the per-file `MemoryFile` is the user-visible signal. |
| `SIVRU-E245 checkup-path-unsafe` | error | HTTP route received a path that is not contained under `homedir()` and is not a git working tree (or descendant of one). Strict-containment rule; no blocklist. Request rejected before any file read. |

Built-in check findings use `checkId`, NOT a `SIVRU-Exxx` code —
they're observations, not errors. The error-code range is reserved
for infrastructure errors that block running the checks.

### 5. Memory-file discovery

`discoverMemoryFiles(repoRoot)` walks a fixed set of locations and
classifies each file. Discovery does NOT shell out; it uses
`node:fs/promises` only.

| Path | Kind |
|------|------|
| `<repoRoot>/CLAUDE.md` | `claude-md` |
| `<repoRoot>/CLAUDE.local.md` | `claude-md` (documented Claude Code convention for personal-not-shared agent guidance — included so a stale local override surfaces too) |
| `<repoRoot>/.claude/skills/**/SKILL.md` | `skill` |
| `<repoRoot>/.claude/agents/**/*.md` | `agent` |
| `~/.claude/CLAUDE.md` | `claude-md` (user-global) |
| `~/.claude/skills/**/SKILL.md` | `skill` (user-global) |
| `~/.claude/agents/**/*.md` | `agent` (user-global) |

**Project-vs-user-global shadowing.** When a same-name SKILL or
agent file exists in both `<repoRoot>/.claude/skills/foo/SKILL.md`
and `~/.claude/skills/foo/SKILL.md`, **both** are returned by
`discoverMemoryFiles`, each with its own `displayPath` (`./` and
`~/`). Findings fire on each independently. No de-duplication;
both files are real and either could drift. The user reads the
display path to disambiguate.

**Cursor + Codex sources deferred.** Cursor's `.cursor/rules/*`
lands with the Cursor adapter (v0.13, DESIGN-0010). Codex's
`AGENTS.md` lands with the Codex adapter (v0.14, DESIGN-0011).
Adding them now multiplies the FP surface before v0.9's
file-age algorithm has any field data.

Globbing depth caps at 3 segments below the `<repoRoot>/.claude/`
or `~/.claude/` anchor. Matches: `.claude/skills/foo/SKILL.md`
(depth 3 from `<root>`), `.claude/agents/bar.md` (depth 2).
Does NOT match: `.claude/skills/foo/sub/SKILL.md` (depth 4) —
that nesting isn't a documented Claude Code convention, and
allowing arbitrary depth invites runaway walks on misconfigured
trees. v0.9.x can extend the cap if users surface a real nesting
convention sivru is missing.

**Sort order** is stable: repo files first (so `<repoRoot>/...`
shows above `~/...`), then alphabetical by path within each
group. Display path uses `~/...` for user-global files and
`./...` for repo-relative files.

### 6. The `CheckupReport` JSON shape

The library + MCP + HTTP all return the same shape.

```ts
export type Severity = "info" | "warning" | "error";

export type MemoryFileKind = "claude-md" | "skill" | "agent";

export interface MemoryFile {
  path: string;          // absolute
  displayPath: string;   // ./foo or ~/foo
  kind: MemoryFileKind;
  mtimeMs: number;
  lastCommitTs?: number;        // unix seconds; absent when --no-git
  commitsBehindHead?: number;   // absent when --no-git;
                                 // computed via `git rev-list --count
                                 // <last-commit>..HEAD`
  unreadable?: boolean;          // true when file exists but EACCES
                                 // prevented reading content. No
                                 // findings emitted for the file;
                                 // it still appears in `files[]` so
                                 // the user sees the file was
                                 // skipped and why.
}

export interface AuditFinding {
  checkId: string;              // "memory-claude-age" etc.
  severity: Severity;
  filePath: string;             // file the finding is about
  line?: number;                // 1-indexed; absent for whole-file findings
  summary: string;              // one-line plain-text description
  detail?: string;              // longer rationale + suggested fix
  data?: Record<string, unknown>;  // structured payload (e.g., ageDays)
}

export interface RunCheckupOptions {
  /** When true, skip git shell-outs entirely; fall back to mtime
   *  + null commit count for every file. CLI `--no-git`. */
  noGit?: boolean;
  /** When set, run only checks whose id appears in this list.
   *  CLI `--check <id>` (repeatable). Unknown ids are silently
   *  ignored. */
  check?: readonly string[];
}

export interface CheckupReport {
  schema: 1;
  repoRoot: string;
  ranAt: string;                // ISO timestamp
  files: MemoryFile[];          // every file considered, even no-finding
  findings: AuditFinding[];
  config: {
    ageDays: number;
    ageCommits: number;
    disabled: string[];
    severityOverrides: Record<string, Severity>;
    skipPaths: string[];
    pathExtensions: string[];
  };
}
```

`schema: 1` reserves the version slot (same evolution rules as
DESIGN-0016 §5). `files[]` always lists every file considered so
the UI can render "no findings on CLAUDE.md" alongside aged
SKILL.md files — the absence of a finding is meaningful.

### 7. observe-ui Checkup tab

Tab order in App.tsx becomes: **Sessions / Checkup / Replay /
Costs / Bench**. Checkup sits adjacent to Sessions because the
data it surfaces is repo-scoped, not session-scoped, and the user
typically lands on Sessions first.

**Layout (single page, no sub-routes):**

- Header: path is read from `selectedProject` (sidebar state) per
  eng-review E2. When `selectedProject` is null, falls back to
  most-recent session's `projectRoot`. When neither is available,
  the tab renders the empty state at the bottom of this section.
  No free-form text input at v0.9 (deferred to v0.10 per
  spec-review iter-1). "Refresh" button re-fetches. A
  "Just fetched" / "Fetched <N>s ago" label tracks the in-memory
  timestamp of the last successful `/api/checkup` call within
  the current tab session — no persistence across reloads.
- Findings table, grouped by file. **Within each file, sort
  by severity descending: errors → warnings → info** (design
  decision D1: prioritizes signal over volume; the worst issue
  per file bubbles up first; matches the "hierarchy as service"
  principle). Each row:
  - Severity dot (info = `bg-zinc-400`, warning = `bg-amber-400`,
    error = `bg-red-500`; calibrated for the existing dark-only
    Tailwind palette per CLAUDE.md). Each dot carries an
    `aria-label` matching the severity name so screen-reader
    users get the same signal as sighted users.
  - Display path + line number (skips line number for whole-file
    findings).
  - One-line summary.
  - "Show detail" expander for the `detail` field — rendered as
    a button with `aria-expanded` toggling on click; chevron
    icon rotates via CSS to indicate state.
- Files-without-findings section at the bottom, collapsed by
  default. Shows the green "all clear" for transparency.

**Loading state.** While `/api/checkup` is in flight (initial
load or after Refresh), the findings area shows a single inline
spinner row with "Loading…" text — NOT a full-page skeleton
(matches the relatively-quick <200ms expected response on the
typical repo). The header path + Refresh button remain enabled
so the user can change selectedProject mid-load (latest fetch
wins; in-flight responses for prior selections are discarded).

**Partial-result rendering.** A `MemoryFile` with `unreadable:
true` (per the failure-modes table) appears in the
files-without-findings section with an italic file row and a
small "Skipped: cannot read" badge in zinc-400 — so the user
knows the file existed but wasn't scanned. No findings are
attributed to it. Distinct from "all clear" green for files
that scanned cleanly.

**Keyboard nav + a11y.**
- Tab order: path label → Refresh button → first finding's
  "Show detail" expander → next finding → … → files-without-
  findings disclosure → individual unreadable rows.
- Focus rings: standard observe-ui pattern (Tailwind
  `focus-visible:ring-2 focus-visible:ring-zinc-400`).
- Findings table is `role="table"` with `role="row"` /
  `role="cell"` on children; severity column has
  `aria-label="Severity"`.
- The Refresh button has `aria-busy={isLoading}` so screen
  readers announce loading state.
- Color is never the sole signal: severity dots also carry the
  `aria-label` (above), and the "Skipped" badge carries plain
  text, not just the italic styling.

**Empty + error states:**

- No memory files found → "No CLAUDE.md, skills, or agent files
  under this path. Sivru only audits what's there."
- All clear → "Everything checked, nothing aged or dead."
- Path missing → red error banner with the `SIVRU-E241` code.
- Containment violation → red error banner with the `SIVRU-E245`
  code (HTTP path-safety; see §2 path-safety validation).
- Git unavailable on server → info banner above the findings
  with the `SIVRU-E244` code ("checkup ran without git history;
  age-only mode"). Findings still render. Not an error state.

**No persistence at v0.9.** The Checkup tab is stateless — every
visit re-fetches. v0.10+ may add finding history if the data
becomes useful.

### 8. Three-layer customization

Per the CONTRIBUTING.md three-layer rule.

1. **Built-in defaults** — `packages/observe/src/coach/checks/*.ts`.
   `ageDays: 90`, `ageCommits: 50`, the §3b path-extension list.
   Same precedence as v0.6's `.sivru/block.json`.

2. **Declarative override** — `~/.config/sivru/checkup.json`
   (user-global) and `<repoRoot>/.sivru/checkup.json`
   (per-project, wins). Schema:

   ```jsonc
   {
     "ageDays": 90,              // number ≥ 0
     "ageCommits": 50,           // number ≥ 0
     "disabled": [],             // string[] of checkId
     "severityOverrides": {},    // checkId → "info" | "warning" | "error"
     "skipPaths": [],            // glob[] of paths to skip during dead-reference scanning (i.e., paths whose missing-target findings should be suppressed)
     "pathExtensions": [".ts", ".tsx", ".js", ".jsx", ".md",
                         ".json", ".yaml", ".yml", ".sh", ".py",
                         ".go", ".rs", ".java"]
   }
   ```

   **Override-replaces-default semantics** for `pathExtensions` —
   user overrides fully replace the default array (matches v0.6
   `maturityValues` precedent). `disabled` and
   `severityOverrides` merge into defaults additively.
   `severityOverrides` entries that reference an unknown
   `checkId` are silently ignored (not validated against the
   registered check set) — checks may come and go across
   versions, and an opinionated unknown-id error would break
   configs across upgrades. Logged at `info` in the
   `CheckupReport.config` echo so users can spot typos.

3. **Code-level extension** — DEFERRED from v0.9 entirely.
   v0.9 ships the `MemoryCheck` interface in
   `packages/observe/src/coach/types.ts` for v0.10 to consume,
   but v0.9 **does not discover `<repoRoot>/.sivru/checkup/`** at
   all. (Spec-review iter-1 finding: a stubbed loader that throws
   `SIVRU-E243` if a directory happens to exist is a footgun for
   early adopters who try the feature optimistically.) The
   dynamic loader lands with v0.10's second coach signal when the
   second consumer forces it (same rationale as v0.6's
   `.sivru/block/*.ts` deferral, applied more honestly: defer the
   discovery too, not just the wiring).

## Alternatives considered

**Use mtime instead of git log for file age.** Rejected: mtime
resets on clone, on `git checkout`, on filesystem touch. It
encodes nothing about when the file was actually authored. Git
log is the only honest source for files in a git repo. mtime
remains a fallback for user-global files outside any repo.

**Single age threshold (just days).** Rejected: the stub's open
question. A 90-day-old CLAUDE.md in a repo with 5 commits/year
isn't drifted — the repo simply isn't moving. The
days-AND-commits rule eliminates that class of false positive
without adding new ones.

**Aggressive dead-reference detection (every bare word that looks
like an identifier).** Rejected: identifiers in markdown are
mostly NOT file paths — they're function names, npm packages,
env vars. The "path separator OR known extension" rule keeps the
FP rate honest at the cost of missing things like `` `scanner` ``
that an author meant as a file. v0.10+ can revisit if user
feedback shows we missed real cases.

**Put audit code in `@sivru/search`** (alongside the v0.6 block
module and v0.7 drift detector). Rejected: the coach loop will
grow with v0.10 (session-derived signals) and v0.11 (low-context
edit) — both of which need observe-layer infrastructure. Locating
v0.9 in observe gets the substrate right the first time. The
search package stays focused on retrieval + comprehension
primitives.

**Standalone `@sivru/coach` package.** Rejected for v0.9: three
checks do not justify a new workspace package. If v0.10 and v0.11
demonstrate the coach loop has genuine independent identity,
extract then.

**MCP-only, no CLI.** Rejected: humans need this too. The Checkup
tab + CLI are the dogfood loop that surfaces issues before the
agent does. MCP exposure is a third surface, not the only one.

**The earlier `CHECKUP.md` unified design** (lived on the
`feature/checkup-stage-1` branch, now superseded). That spec
bundled six signals — `spec-driven-ratio`, `agents-md-present`,
`skill-load-efficiency`, `skill-drift`, `security-review-on-risk`,
`plan-before-code` — plus a stage profile and a recommendation
engine, into one stage-1 release. Superseded by the current
roadmap, which splits that scope across v0.9 (this release,
narrow drift signal), v0.10 (looped-on-error), v0.11
(low-context-edit), and v0.12 (skill recommender) per
[ROADMAP.md](../../ROADMAP.md) principle 3 — *Depth over
breadth. Coaching signals get tuned for false-positive rate one
at a time.* The earlier `agents-md-present` and `skill-drift`
signals are the closest cousins of v0.9's `memory-claude-age` +
`memory-skill-tools-drift`, but the v0.9 versions are
deliberately narrower (file-age + structured front-matter
checks only — no session-context awareness, no recommendation
engine). The earlier `packages/checkup/` package layout is
superseded by `packages/observe/src/coach/` (D1). Decisions
from the earlier doc that survive: descriptive-not-judgmental
finding tone; three-surface delivery (CLI + slash command +
observe-ui tab); deterministic-only signals at first release.

## Open questions

- **Pathological CLAUDE.md sizes.** Some real CLAUDE.md files are
  10–50KB. The dead-reference check scans every inline-code span;
  does that stay under the perf gate (§Test plan) at p95? Resolved
  by measurement at implementation; if not, we cap per-file work
  at the first N inline-code spans and emit
  `SIVRU-E242 file-too-large` (warning, file partially scanned).
- **Worktree handling.** If `<repoRoot>` is a linked worktree, do
  we run against the worktree's `CLAUDE.md` or the main checkout's?
  Decision: worktree's. The user is working in the worktree;
  drift in that branch matters. Documented in CLI help.
- **`memory-claude-age` cleanup signal.** Today the finding says
  "CLAUDE.md is 130 days old." It doesn't say "you should edit
  it." The descriptive-only stance is deliberate, but a future
  Phase 3 release (v0.10+) may want an opinionated "consider
  reviewing" message. Deferred — see if users ask for it.
- **sivru-authored CLAUDE.md content gets flagged by sivru
  itself** (eng-review A6). `sivru observe init` writes a hint
  section into the user's CLAUDE.md (`packages/cli/src/commands/
  observe.ts:451`). When that section ages, `memory-claude-age`
  fires on content sivru itself authored. Treated as a feature,
  not a bug — the section IS aged if sivru hasn't refreshed it,
  and the user benefits from the prompt. v0.9.x or v0.10 may
  consider an opt-in suppression flag for sivru-authored
  sections; deferred until users surface real friction.
- **DESIGN-0017 vs DESIGN-0005 surface separation** (eng-review
  A5). DESIGN-0017 (v0.7 block drift) detects drift in `@sivru`
  blocks via `sivru explain`. v0.9's Checkup tab does NOT surface
  block drift — users see block drift via `sivru explain` only.
  Two parallel drift surfaces is deliberate per DESIGN-0005's
  forward-pointer section (different inputs, different consumers,
  sharing infrastructure would be premature). If v0.10 demands
  unification, refactor then.

## Deferred to TODOS.md

- **`sivru checkup --strict` CI mode.** Exits non-zero on any
  warning-or-higher finding. Trivial (~30 min). Deferred because
  gating CI on a check whose FP rate isn't yet measured is worse
  than no gate. Revisit after v0.9-v0.9.x produces field data on
  the FP rate of `memory-dead-reference` and
  `memory-skill-tools-drift`. (Cherry-pick D5, neutral
  recommendation accepted as defer.)

## Acceptance criteria

- **Module location:** `packages/observe/src/coach/` (matches
  CEO/eng-review preference of putting coach signals with their
  natural consumers; the v0.10 + v0.11 signals will reuse this
  substrate).
- **Stub deletion:** `packages/cli/src/lib/memory-audit/types.ts`
  is removed in the v0.9 PR; nothing imports from it.
- **Three checks:** `memory-claude-age` + `memory-dead-reference`
  + `memory-skill-tools-drift` ship as built-ins. Their defaults
  match §4. Their algorithms match §3. The
  `memory-claude-age` finding carries the "what changed since"
  diff preview (delight D6a); `memory-dead-reference` carries
  the rename suggestion when `git log --follow --diff-filter=R`
  produces a hit (delight D6b).
- **`runCheckup(repoRoot, opts): Promise<CheckupReport>`** exported
  from `@sivru/observe` (subpath `@sivru/observe/coach`).
- **CLI:** `sivru checkup [path]` exits 0 on findings; exits 1 on
  config-malformed or missing-path with the corresponding
  `SIVRU-E240` / `SIVRU-E241` code printed to stderr. `--json`
  emits the `CheckupReport` shape (§6) verbatim. `--check <id>`
  filters; `--no-git` forces mtime fallback.
- **MCP:** `mcp__sivru__checkup` tool registered in the MCP server
  over **stdio transport** (matches existing sivru MCP tools).
  Same JSON shape. Args:
  `{ path: string, noGit?: boolean, check?: string[] }` —
  parity with CLI flags. `check` filters to the named check ids
  (unknown ids silently ignored).
- **HTTP:** `GET /api/checkup?path=<absolute>` returns the
  `CheckupReport`. Optional `noGit` (accepts `true` / `1` /
  present-with-no-value) and repeatable `check` (`?check=A&check=B`
  or comma-separated) query params for CLI parity. Returns 400
  + the error code on config-malformed, missing-path, or
  containment-violation. Reuses the existing localhost-only CORS.
- **observe-ui Checkup tab:** new tab between Sessions and Replay
  in `App.tsx` (final order:
  Sessions / Checkup / Replay / Costs / Bench). Path source is
  `selectedProject` from App state (eng-review E2), falling back
  to most-recent session's `projectRoot` when null. **No free-form
  input at v0.9** (deferred to v0.10). Findings table groups by
  file. Files-without-findings section collapses by default. When
  neither `selectedProject` nor any session has `projectRoot`
  populated, the tab renders an empty state pointing at
  `sivru observe init`.
- **Memory-file discovery:** §5 paths only. Cursor / Codex
  sources NOT included.
- **Configuration:** `.sivru/checkup.json` (project) overrides
  `~/.config/sivru/checkup.json` (user) overrides built-in
  defaults. Schema in §8.
- **Code-level extension:** the `MemoryCheck` interface ships in
  `packages/observe/src/coach/types.ts` for v0.10 to consume.
  v0.9 does NOT discover `.sivru/checkup/*.ts`. (Deferred from
  v0.9 per spec-review iter-1 — see Customization shape §8.)
- **Privacy:** the new coach module makes no `fetch` /
  `node:http` / `node:https` / `node:net` calls. The existing
  observe ESLint + egress test catches violations.
- **FP-rate target:** `memory-dead-reference` < 10% FP rate
  measured against **labelled flagged spans** (NOT files) on the
  fixture corpus, with **N ≥ 50** flagged spans required for the
  measurement to count. (Spec-review iter-1 fix: 10-20 files
  produce too few flagged spans for the < 10% claim to be
  statistically credible. The denominator change anchors the
  claim in the unit that actually matters — flagged spans, not
  files.) If the corpus does not produce ≥ 50 flagged spans, the
  acceptance bar reverts to **"zero unexplained false positives
  on the labelled corpus"** and the CHANGELOG records the
  flagged-span count honestly. `memory-claude-age` has no FP
  rate target at v0.9 because every finding is by construction
  true — it's a measurement, not a judgment.
  `memory-skill-tools-drift` requires zero false positives on
  the labelled corpus (the check operates on structured
  front-matter; ambiguity should not exist).
- **Performance gate:** `runCheckup` completes in < 200ms on
  this repo (current memory-file count: 1 CLAUDE.md, ~3 skills).
  < 1s on a fixture repo with 50 memory files.

## Test plan

### Unit tests

- **Age algorithm (`age.ts`):**
  - Fresh file (10 days, 5 commits behind) → not aged.
  - Old + low-churn (200 days, 30 commits behind) → not aged
    (commit floor not met).
  - Young + high-churn (40 days, 500 commits behind) → not aged
    (day floor not met).
  - Old + high-churn (200 days, 500 commits behind) → aged.
  - Boundary: exactly 90 days, exactly 50 commits → aged.
  - `--no-git`: only the day floor applies; commit count omitted.
  - **"What changed since" preview delight (D6a):** aged file +
    `git diff --name-only --diff-filter=AMD <last-commit>..HEAD`
    succeeds → finding includes the one-line preview (top-3
    first-path-segment buckets by count; per §3a algorithm).
    `git diff` unavailable, non-zero exit, or timeout → finding
    emitted without the preview.
- **Dead-reference scanner (`dead-reference.ts`):**
  - Inline code with valid path → no finding.
  - Inline code with broken path → finding.
  - Inline code with bare identifier (`runScan`) → no finding
    (no path separator, no known extension).
  - Markdown link `[text](docs/x.md)` with broken target → finding.
  - Triple-backtick fenced block → ignored entirely.
  - Triple-tilde fenced block → ignored entirely.
  - Indented 4-space fenced block (2+ consecutive lines) →
    ignored; single 4-space-indented line in a paragraph → scanned.
  - Nested backticks inside an inline-code span (`` `path with
    `embedded` backticks/foo.ts` ``) → whole span scanned as
    one path candidate.
  - Reference-style link `[text][id]` → NOT scanned at v0.9
    (open question for v0.10).
  - Tilde path `~/projects/x` → resolved against homedir; missing
    → finding.
  - Relative path `./foo.ts` → resolved against repo root (NOT
    file's directory) → behavior matches the §3b rule.
  - Path with query / hash (`docs/x.md#anchor`) → strip
    hash/query before resolution.
  - **Rename-suggestion delight (D6b):** dead path X with
    `git log --follow --diff-filter=R --name-status` hit
    → finding includes the suggested rename + commit hash.
    `git` unavailable → finding emitted without rename hint.
  - Memory file > 200KB → scan stops at first 200KB content,
    `SIVRU-E242 file-too-large` warning emitted.
- **Skill-tools-drift scanner (`skill-tools-drift.ts`):**
  - SKILL.md with `tools: [Bash, Read]` → no finding (both
    built-in).
  - SKILL.md with `tools: [Bash, FooAgent]`, and
    `.claude/agents/FooAgent.md` exists → no finding.
  - SKILL.md with `tools: [Bash, FooAgent]`, no
    `FooAgent.md` agent file → finding pointing at the
    front-matter line.
  - SKILL.md with malformed YAML front-matter → skip,
    document body still scanned by dead-reference.
  - Agent file `.claude/agents/MyAgent.md` referencing tools
    in its own front-matter → same drift check applies.
- **Memory-file discovery (`load.ts`):**
  - Repo with no memory files → empty result, no crash.
  - Repo with `CLAUDE.md` + 2 skills + 1 agent → 4 files.
  - Glob depth cap: file at `.claude/skills/a/b/c/d/SKILL.md`
    NOT found.
  - User-global files: `~/.claude/CLAUDE.md` present → discovered
    and tagged with display path `~/.claude/CLAUDE.md`.
- **Config loading (`config.ts`):**
  - Malformed JSON → `SIVRU-E240`.
  - Schema violation (`ageDays: "ninety"`) → `SIVRU-E240` with
    the specific field named.
  - Project overrides user overrides default (precedence).
  - `pathExtensions` override REPLACES default (matches
    `maturityValues` precedent).

### Integration tests

- **`runCheckup` round-trip** against the three `__fixtures__/`
  repos (`repo-stale`, `repo-fresh`, `repo-mixed`). Assert the
  exact `CheckupReport.findings` set per fixture.
- **CLI smoke:** `node packages/cli/dist/index.js checkup
  __fixtures__/repo-fresh` exits 0 with no findings; same on
  `repo-stale` exits 0 with the labelled finding set (one
  `memory-claude-age` info, ≥ 1 `memory-dead-reference` warning,
  ≥ 1 `memory-skill-tools-drift` warning); same on a path that
  doesn't exist exits 1 with `SIVRU-E241`.
- **MCP smoke:** the MCP server returns the same `CheckupReport`
  the CLI prints with `--json`.
- **HTTP smoke** (existing observe-server test pattern in
  `packages/observe/src/server/server.test.ts`):
  - `GET /api/checkup?path=<fixture>` returns 200 + the report.
  - Bad path returns 400 + `SIVRU-E241`.
  - Malformed `.sivru/checkup.json` returns 400 + `SIVRU-E240`.

### FP-rate test (`memory-dead-reference`)

Labelled corpus under
`packages/observe/src/coach/__fixtures__/fp-corpus/`:

- **10–20 real-world CLAUDE.md / SKILL.md / agent files** —
  pulled from public GitHub repos (Anthropic's claude-code
  repo, popular OSS adopters of Claude Code), anonymized and
  sanitized (strip secrets, internal URLs, personal info).
  Synthesized files are NOT accepted at v0.9 — the FP rate
  claim is only honest if the corpus is files we didn't write
  to game the test. (Decision D7.)
- Each file carries a `.labels.json` sidecar listing the
  known-true-positive broken references (paths that should
  flag) and known-true-negative inline code (paths that should
  NOT flag). Each labelled span is counted toward the N ≥ 50
  acceptance threshold (§Acceptance criteria).
- Each file carries an `attribution.md` sidecar with the
  source URL, commit hash, license, and anonymization notes.
  License must be permissive (MIT / Apache 2.0 / BSD / similar);
  GPL-licensed files require explicit fixture-use permission.
- **Test:** run `memory-dead-reference` over the corpus.
  Compute `FP rate = (false-positive flagged spans) / (total
  flagged spans)`. Two paths to acceptance:
  - **Primary:** total flagged spans ≥ 50 AND FP rate < 10%.
  - **Fallback** (when corpus produces < 50 flagged spans):
    zero unexplained false positives on the labelled corpus,
    and the CHANGELOG records the exact flagged-span count
    so the claim's basis is visible to users.
- v0.9 PR can ship with 10 files minimum if 20 are not yet
  sourced cleanly, and the CHANGELOG records the exact corpus
  count + a TODO entry to grow it. Below 10 files → v0.9
  doesn't ship; the FP claim is not credible at fewer.

### Rename-suggestion test (D6b)

- Fixture `repo-rename/` under
  `packages/observe/src/coach/__fixtures__/`: a git repo with
  a file renamed in history (`git mv src/scanner.ts
  src/audit.ts && git commit`), a CLAUDE.md still referencing
  `src/scanner.ts`. `memory-dead-reference` emits a finding
  with the rename hint pointing at `src/audit.ts` + commit
  hash.
- **Ambiguous-rename test:** fixture with two files renamed
  in the same commit (both could plausibly be the rename
  target of the dead reference). Assert the finding emits
  WITHOUT a rename suggestion (rather than picking one
  arbitrarily).
- **Git unavailable test:** run with `--no-git`. Finding
  emitted without rename hint; no error.

### Egress test

- Existing `packages/observe/src/egress.test.ts` already greps
  the observe package for `fetch` / `http` / `https` / `net`
  imports. The new `coach/` subdirectory is covered by the
  existing glob; no test change needed but the v0.9 PR
  confirms the test still passes.
- **`node:child_process` verification.** `git-stats.ts`
  shells out via `child_process.execFile`. The egress test
  must NOT flag this as network egress — the existing test
  matchers only catch `node:http`/`https`/`net`/`fetch`, but
  the v0.9 PR adds a one-line assertion that the egress test
  passes on a coach/ file that imports `child_process`. If a
  future refactor strengthens the egress test, this assertion
  catches the regression at PR-time, not at runtime.

### Performance gate

- Baseline: `runCheckup(repoRoot)` on this repo before v0.9.
- After v0.9: same measurement. Assert < 200ms p95 on this
  repo's memory-file count.
- Fixture-scale: `runCheckup` on a synthesized repo with 50
  memory files completes < 1s.
- Documented in CHANGELOG with the measured number, not the
  budget number (v0.6 P1 precedent).

### observe-ui smoke

- Manual: open the Checkup tab, point it at this repo,
  confirm the rendering matches §7.
- Vitest: `App.test.tsx` adds a smoke that mounts the Checkup
  tab against a mocked `/api/checkup` response and asserts the
  findings table renders.

## Customization shape

Per the CONTRIBUTING.md three-layer rule (see also §8 above):

1. **Built-in defaults** — `packages/observe/src/coach/checks/*.ts`;
   three checks ship: `memory-claude-age`, `memory-dead-reference`,
   `memory-skill-tools-drift`.
   Defaults: `ageDays: 90`, `ageCommits: 50`, `pathExtensions:
   [...]`. Known-tools registry built from Claude Code's
   built-in tools list plus discovered `.claude/agents/*.md`
   filenames.
2. **Declarative override** — `~/.config/sivru/checkup.json`
   (user) and `<repoRoot>/.sivru/checkup.json` (project, wins).
   Schema: `{ ageDays, ageCommits, disabled, severityOverrides,
   skipPaths, pathExtensions }`. Override-replaces-default for
   `pathExtensions`; additive merge for `disabled` and
   `severityOverrides`.
3. **Code-level extension** — **deferred entirely from v0.9.**
   The `MemoryCheck` interface ships in
   `packages/observe/src/coach/types.ts` for v0.10 to consume,
   but v0.9 does not discover `<repoRoot>/.sivru/checkup/*.ts`
   at all (no read attempt, no error code emitted). v0.10 ships
   the dynamic loader alongside the second coach signal.
   (Reverses v0.9's earlier "stub-and-throw" plan per
   spec-review iter-1 — a stub that throws if a user
   optimistically creates the directory is a footgun, not a
   forward-compat signal.)

## Effort

| Item | Working days |
|---|---|
| Module scaffolding (`packages/observe/src/coach/`) | ~0.5d |
| `exec.ts` shared wrapper (extracted from `doctor.ts:48-72`) | ~0.5d |
| `discoverMemoryFiles` + 4 fixture repos | ~1d |
| `age.ts` (churn-scaled algorithm + mtime fallback; consumes batched git-stats) | ~1d |
| `git-stats.ts` (batched per E1: one `git log` per file capturing lastEdit + last-commit + rename history; cached `headCommitCount`; bounded walk; ambiguous-rename handling) | ~1.5d |
| `dead-reference.ts` (markdown parse + path filter + CommonMark fence semantics + resolver + rename-suggestion integration) | ~2d |
| `skill-tools-drift.ts` + `known-tools.ts` (front-matter parse + tool registry + LAST_VERIFIED header) | ~0.5d |
| `config.ts` (3-layer precedence; matches v0.6 pattern) | ~0.5d |
| `runCheckup` orchestrator + `CheckupReport` shape | ~0.5d |
| CLI `sivru checkup` command | ~0.5d |
| MCP `mcp__sivru__checkup` tool (stdio transport) | ~0.5d |
| Observe `GET /api/checkup` route + path-safety containment + git-unavailable graceful degradation + tests | ~0.5d |
| observe-ui Checkup tab (reads `selectedProject` per E2 + table) | ~1d |
| FP-rate fixture corpus (10–20 real-world labelled files; sourcing, anonymizing, labelling each span, attribution.md per file) | ~2.5d |
| Unit + integration tests (all of §Test plan; ~50 unit tests across 6 modules + integration + HTTP + observe-ui smoke) | ~3.5d |
| Performance gate measurement (at least one 20+ file fixture repo to validate E1 batching) + CHANGELOG entry | ~0.5d |
| Stub deletion (`packages/cli/src/lib/memory-audit/`) | ~15min |
| **Total** | **~4–4.5 weeks** |

Matches the roadmap's "~3 weeks" budget for v0.9.

Critical path: `discoverMemoryFiles` → `age.ts` + `dead-reference.ts`
(parallelizable) → `runCheckup` → CLI / MCP / HTTP (parallelizable) →
observe-ui tab + tests.

## Failure modes registry

Compact table per the eng-review convention. Every row has a
rescue strategy and a user-visible artifact; zero silent failures.

| Codepath | Failure mode | Rescued? | Rescue action | User sees |
|---|---|---|---|---|
| `discoverMemoryFiles` | Glob enters a symlink loop | Yes | `realpath` resolution + visited-set cap of 100 | Skip + diagnostic in report |
| `discoverMemoryFiles` | EACCES on a memory file | Yes | Skip the file with diagnostic | File listed in `files[]` with `unreadable: true`; no findings |
| `git-stats.lastEdit` | Git binary missing | Yes | `SIVRU-E244`, mtime fallback | One-line `info` diagnostic in report |
| `git-stats.lastEdit` | Not a git tree | Yes | Same as above | Same |
| `git-stats.lastEdit` | `git log` non-zero exit | Yes | Per-file fallback to mtime | File's `lastCommitTs` absent, `mtimeMs` present |
| `git-stats.lastEdit` | `git log` timeout (4s) | Yes | Per-file fallback to mtime | Same as exit non-zero |
| `git-stats.renames` | `git log --follow` empty or fails | Yes | Skip rename suggestion (delight degrades gracefully) | Finding still emitted, just without the rename hint |
| `git-stats.diffStats` | `git diff` non-zero exit | Yes | Skip "what changed since" preview | Aged finding emitted without the preview hint |
| `dead-reference` | Memory file > 200KB | Yes | Scan first 200KB, emit `SIVRU-E242` | Partial-scan diagnostic; report still emitted |
| `dead-reference` | Malformed markdown | N/A | Markdown is permissive; no parse failure | — |
| `skill-tools-drift` | YAML front-matter malformed | Yes | Skip the file's front-matter; document body still scanned by dead-reference | One-line warning in report |
| `loadCheckupConfig` | `.sivru/checkup.json` syntax error | Yes | `SIVRU-E240`, abort run | CLI exit 1, named-field error message |
| `loadCheckupConfig` | `.sivru/checkup/*.ts` files present | N/A at v0.9 | Discovery not attempted | No-op; loader lands v0.10 |
| HTTP `/api/checkup` | Path query param missing | Yes | 400 with named-field error | JSON error body |
| HTTP `/api/checkup` | Path not contained under `homedir()` or a git working tree | Yes | `SIVRU-E245`, 400 | JSON error body |
| HTTP `/api/checkup` | Git binary missing on the server (containment check can't run `git rev-parse`) | Yes | Degrade to homedir-only containment; emit `SIVRU-E244` info diagnostic in the response | Report still returned; `info` line surfaces the degradation |
| `git-stats.perFileStats` | Single `git log` parse error (corrupted output) | Yes | Treat per-file result as null; subsequent files unaffected | File's `lastCommitTs` absent in report |
| `git-stats.headCommitCount` | `git rev-list` fails / times out | Yes | Cache null; per-file `commitsBehindHead` absent for whole run | One-line `info` diagnostic in report |
| HTTP `/api/checkup` | Concurrent requests | Yes | runCheckup is stateless (no shared mutable state) | Both responses correct, no interference |

No `catch (e)` / `except Exception` blocks. Every rescue
mentions the specific failure mode it handles.

## DESIGN-0017 / DESIGN-0007 forward pointers

- **DESIGN-0017 (v0.7).** v0.7 ships its own drift module for
  `@sivru` blocks under `packages/search/src/block/drift.ts`.
  That work is conceptually a *cousin* of v0.9 (both detect
  drift, both surface as findings) but operates on different
  data — blocks against the symbol index vs. memory files
  against the repo. v0.9 deliberately does NOT try to share
  infrastructure with v0.7 because the inputs differ enough
  that abstraction would be premature. If v0.10 / v0.11 show a
  unified finding shape is wanted, refactor then.
- **DESIGN-0007 (v0.11).** The low-context-edit signal will
  reuse `packages/observe/src/coach/` as its home and the
  `AuditFinding` shape as its output type. v0.9's substrate is
  scoped to make that easy: the `MemoryCheck` interface
  extends naturally to a `SessionCheck` interface (takes a
  session, returns findings) without renaming.

---

## GSTACK REVIEW REPORT

*Combined CEO + Eng review log for v0.9.0.*

### Iteration history

| Iter | Reviewer | Outcome | Quality | Key findings |
|------|----------|---------|---------|--------------|
| 1 | `/plan-ceo-review` Step 0 + Cherry-pick ceremony | 7 decisions accepted (D1–D7) | n/a | Module location, single-shipment, third built-in check, `--strict` deferred, two delights, real-world FP corpus |
| 1 | spec-review subagent | REVISE | 6/10 | 30 issues across 5 dimensions: "two checks" wording, tab placement drift, path-safety told 3 ways, `unreadable` field missing from type, FP-rate statistically not credible at 10–20 files |
| 2 | spec-review subagent | REVISE | 8/10 | 4 regressions from iter-1 fold (orphan prose) + 7 new minor issues (surface parity, skipPaths comment, runCheckup options shape, etc.) |
| 3 | spec-review subagent | **PASS** | 9/10 | All 11 iter-2 issues fixed cleanly; remaining items are stylistic redundancies, not blockers. **Promoted Draft → Accepted.** |
| 4 | `/plan-eng-review` (architecture + code-quality + tests + perf) | **PASS** | n/a | 2 architectural AUQs absorbed (E1 git batching, E2 Checkup tab path source) + 5 inline folds (shared exec helper, HTTP graceful git-unavailable degradation, known-tools registry pinning, DESIGN-0017 surface separation, sivru-observe-init meta-flag note). Coverage diagram produced (56/57 paths, 98%, 0 unintentional gaps). |
| 5 | `/plan-design-review` (7 passes against minimal UI scope) | **PASS** | 7→9/10 | 1 design AUQ absorbed (D1 severity sort: errors → warnings → info within each file) + 4 inline folds (loading-state spec; partial-result rendering for `unreadable: true` files; dark-mode severity dot Tailwind tokens; keyboard-nav + ARIA basics including `aria-label` on severity dots, `aria-expanded` on detail toggles, `aria-busy` on Refresh, screen-reader-safe severity-not-just-color signal). Mockup generation skipped (designer binary not available; findings-table scope doesn't justify variants). |

### Decisions absorbed in this review

**From `/plan-ceo-review` Step 0:**

- **D1 — Module location:** `packages/observe/src/coach/`.
  Co-locates with v0.10/v0.11 future signals; observe-ui
  consumes via existing HTTP; deletes the stub at
  `packages/cli/src/lib/memory-audit/types.ts`.
- **D2 — Mode:** SELECTIVE EXPANSION.
- **D3 — MVP split:** Ship v0.9 as one piece (library + CLI +
  MCP + HTTP + Checkup tab together). Substrate decision
  validates against all four surfaces at once.
- **D4 — Third built-in check:** `memory-skill-tools-drift`
  validates SKILL.md and agent-file front-matter `tools:`
  against the known-tool set. Adjacent code to dead-reference;
  same FP profile.
- **D5 — `--strict` flag:** Deferred to TODOS.md. Gating CI on
  a check whose FP rate isn't yet field-measured is worse than
  no gate.
- **D6 — Two delights:** rename-suggestion on dead-reference
  findings (via `git log --follow --diff-filter=R`); "what
  changed since" preview on aged-file findings (via
  `git diff --name-only --diff-filter=AMD`).
- **D7 — FP corpus sourcing:** Real-world only (10–20 files
  from public OSS). Synthesized files NOT accepted at v0.9 —
  the FP rate claim is only honest if the corpus is files we
  didn't write.

**From iter-1 spec-review (folded inline, no separate AUQs per the
workflow-pacing memory rule):**

- §1 / §Customization "three checks" wording propagated.
- §2 / §7 / §Acceptance tab placement consistent
  (Sessions / Checkup / Replay / Costs / Bench).
- §3 / §4 / §Failure modes path-safety unified to a single
  strict-containment rule (under `homedir()` or a git working
  tree); no blocklist.
- §6 `MemoryFile` interface gained `unreadable?: boolean`;
  dropped unused `lastCommitHash`.
- §5 includes `CLAUDE.local.md`; project-vs-user-global
  shadowing rule specified (both files returned, distinct
  display paths, no de-duplication).
- §3a fully specs the "what changed since" preview algorithm
  (10000-entry cap, first-path-segment buckets, top-3,
  edge cases).
- §3b fully specs the rename-suggestion timeframe (500
  commits OR 365 days), multi-hit + ambiguous-rename + git-
  unavailable cases.
- §7 free-form Checkup tab path picker deferred to v0.10.
- §8 `.sivru/checkup/*.ts` discovery dropped from v0.9
  entirely; not stubbed-and-throws (footgun for early
  adopters).
- §Acceptance FP-rate gate replaced with labelled-span
  denominator (N ≥ 50 primary; "zero unexplained FPs"
  fallback).
- §Effort table corrected (corpus 2.5d, tests 3.5d).

**From iter-2 spec-review (folded inline, iter-3 verified):**

- 4 regressions from iter-1 fold cleaned (orphan prose in
  §Alternatives, §Failure modes, §7 path picker, test plan
  git command).
- §4 row 356 wording fixed (`≥ threshold` instead of "exceed").
- Surface parity: MCP and HTTP both accept `noGit` + `check`
  params (matching CLI flags).
- `skipPaths` JSON comment renamed to match the field name.
- Built-in tool list version-pinning addressed honestly:
  `known-tools.ts` pins to documented Claude Code tools at
  release time + comment naming the doc source; lag
  acknowledged; v0.10+ may add `knownTools` config escape
  hatch.
- §6 added `RunCheckupOptions` interface.
- §7 "Last checked" label clarified to track in-memory
  fetch-time per tab session (no persistence).

**From `/plan-design-review` iter-5 (design decisions + inline
folds):**

- **D1 (design) — Severity sort order.** Findings sort by
  severity descending within each file (errors → warnings →
  info). Prioritizes signal over volume; worst issue per file
  bubbles up first.
- **Loading state.** Inline spinner row with "Loading…" text
  while `/api/checkup` is in flight; header path + Refresh
  remain enabled (latest fetch wins).
- **Partial-result rendering.** `unreadable: true` files
  appear in the files-without-findings section with italic
  styling + "Skipped: cannot read" badge in zinc-400.
- **Dark-mode severity colors (Tailwind tokens).** info =
  `bg-zinc-400`, warning = `bg-amber-400`, error = `bg-red-500`.
- **Keyboard nav + ARIA.** Tab order specified; severity dots
  carry `aria-label` (color isn't the only signal); detail
  toggles carry `aria-expanded`; Refresh button carries
  `aria-busy`; standard observe-ui focus-ring pattern.
- **New empty/error states.** SIVRU-E245 containment-violation
  banner; SIVRU-E244 git-unavailable info banner (findings
  still render in age-only mode).

**From `/plan-eng-review` iter-4 (architectural decisions + inline
folds):**

- **E1 — Git shell-out batching.** Per-file `git log` runs in
  one invocation per file (capturing lastEdit + last-commit +
  rename history together); `headCommitCount` cached once per
  run. Cuts shell-outs ~3× on a 20-SKILL.md repo; closes the
  "<200ms gate doesn't catch the regression at scale" hole.
  §3a + §3b + Module layout updated.
- **E2 — Checkup tab path source.** Reads `selectedProject`
  from `App.tsx:72` (existing sidebar state), falling back to
  most-recent session's `projectRoot` when null. Consistent
  with how Sessions / Replay / Costs respect `selectedProject`.
  §2 + §7 + §Acceptance updated.
- **A3 — Shared exec helper.** New `exec.ts` extracts the
  `execFile` + timeout + error-rescue pattern from
  `packages/cli/src/commands/doctor.ts:48-72`. Both consumers
  import; the duplication never lands.
- **A4 — `known-tools.ts` registry pinning.** Header carries
  `// LAST_VERIFIED: <date> against Claude Code <version>`
  comment; a CI assertion checks the date format exists so the
  registry can't silently rot.
- **A5 — DESIGN-0017 vs DESIGN-0005 surface separation.**
  Documented explicitly in Open questions: v0.9 Checkup tab
  does NOT surface block drift; users see block drift via
  `sivru explain` only. Two parallel drift surfaces is
  deliberate.
- **A6 — sivru-authored CLAUDE.md content meta-flag.** Noted
  in Open questions: `sivru observe init` writes a section
  into CLAUDE.md, which `memory-claude-age` will eventually
  flag. Treated as feature, not bug.
- **A7 — HTTP path-safety graceful degradation.** When git
  binary is missing on the server, the containment check
  degrades to homedir-only; emits `SIVRU-E244` info diagnostic
  in the response body. Failure-modes table updated.
- **ASCII coverage diagram produced** during Test review:
  56/57 paths tested (98%), ★★★:42 ★★:13 ★:0, one
  intentional gap (reference-style links deferred to v0.10).

### Dashboard

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (SELECTIVE EXPANSION) | CLEAR | 7 expansion decisions accepted (D1–D7); 0 deferred to TODOS block ship |
| Spec Review | spec-review subagent | Architecture / consistency / feasibility | 3 (iter-3 PASS at 9/10) | CLEAR | 30 → 11 → 0 blocking issues across iterations |
| Eng Review | `/plan-eng-review` | Architecture & tests (required for shipping) | 1 (iter-4 PASS) | **CLEAR (PLAN)** | 2 AUQs absorbed (E1, E2) + 5 inline folds (A3-A7); 0 critical gaps; coverage diagram 56/57 paths (98%) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 (PASS, 9/10) | **CLEAR (FULL)** | 1 AUQ absorbed (D1 severity sort) + 4 inline folds (loading, partial-result, dark-mode color tokens, a11y); minimal UI scope confirmed appropriate |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

### Outside voice

**Skipped.** Three iterations of fresh-context spec-review on the
design (iter-1 6/10 → iter-2 8/10 → iter-3 9/10 PASS) already
provided independent review depth before the eng-review pass.
v0.9 is a "build the obvious thing inside the established
substrate pattern" release; this is not a strategic re-question
moment. Per the workflow-pacing memory rule, additional outside
voice would be double-work at this stage.

### VERDICT

**CLEARED.** CEO + Spec review + Eng review + Design review all
PASS. DESIGN-0005 **Accepted** with eng-review iter-4 + design-
review absorbed. 10 total decisions (D1–D7 + E1–E2 + design-D1)
plus 51 findings (30 spec-iter-1 + 11 spec-iter-2 + 5 eng-folds
+ 4 design-folds + 1 design AUQ) folded. Zero critical failure-
mode gaps. Zero unresolved decisions. The doc is
implementation-ready.

### Worktree parallelization

After the spine (`exec.ts` + `types.ts` + `git-stats.ts` batched
helpers) is in place, three lanes can run in parallel:

| Lane | Tasks | Module(s) | Depends on |
|---|---|---|---|
| A | `age.ts` + `dead-reference.ts` + `skill-tools-drift.ts` + check tests | `packages/observe/src/coach/checks/`, `__fixtures__/` | spine (`git-stats.ts`, `types.ts`) |
| B | CLI + MCP + HTTP route + path-safety + their tests | `packages/cli/src/commands/checkup.ts`, MCP server, `packages/observe/src/server/app.ts` | spine (`runCheckup`) |
| C | observe-ui Checkup tab + smoke tests | `packages/observe-ui/src/components/CheckupView.tsx`, `App.tsx` | Lane B (HTTP route) |

**Conflict flag:** Lane B's `app.ts` edits + Lane C's `App.tsx`
edits land in different packages — no conflict. Lane A's check
files + the FP-rate corpus sourcing can parallelize across two
contributors.

### Next steps

1. **Open design PR.** `design/coach-loop-skill-drift` → `main`.
   Pure docs PR. Same pattern as v0.5's PR #22 and v0.6's PR #24.
2. **Create worktree + feat branch off updated main.** Per the
   v0.6 pattern.
3. **`/auto-ship`** against this Accepted design + a v0.9 tasks
   sidecar.
4. **v0.9.0 ship** — `release: v0.9.0 — coach loop v1: skill drift`
   commit + `v0.9.0` tag (same pattern as v0.5's 76fcf82 and
   v0.6's 0a34eff).

### Handoff note

DESIGN-0005 is **Accepted** as of 2026-05-23, re-verified by
eng-review iter-4 PASS + design-review PASS on 2026-05-24. Three
iterations of spec-review + one `/plan-ceo-review` SELECTIVE
EXPANSION + one `/plan-eng-review` + one `/plan-design-review`
have shaped the spec across §1–§8, acceptance criteria, test
plan, failure-modes table, customization shape, observe-ui
Checkup tab specification, and worktree parallelization. Ten
cycle-level decisions (D1–D7, E1–E2, design-D1) plus 51 review
findings absorbed. The doc is implementation-ready; the next
handoff is the design PR → `main`, then `/auto-ship` against the
task sidecar.
