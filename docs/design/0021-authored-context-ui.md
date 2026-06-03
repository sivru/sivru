# DESIGN-0021: Authored-context UI — block lifecycle as first-class in observe-ui

**Status:** Accepted (promoted from Draft on 2026-05-29 by `/plan-ceo-review` HOLD SCOPE iter-1 + `/plan-eng-review` iter-1 + `/plan-design-review` iter-1 all PASS) <!-- Stub → Draft → Accepted → Implemented → Superseded -->
**Class:** Spine (per [GOALS.md](../../GOALS.md) — promotes authored
context from a CLI-only surface to a first-class lifecycle in the
UI sivru ships AND in the MCP surface agents drive, and closes the
feedback loop between block usage and sivru's own tuning)
**Targets:** multi-release plan (2 mega-slots — see §7). First slot
candidate for the post-v0.8 backlog.
**Issue:** filed when the first slot becomes next release.
**Extends:** [DESIGN-0016](0016-sivru-annotation-blocks.md) (`@sivru`
block schema), [DESIGN-0017](0017-serving-authored-context.md)
(`sivru explain` surfacing + drift diagnostics),
[DESIGN-0019](0019-block-reliability.md) (cross-block graph,
diff-scoped CI, autofix surface, scaffolding bridges).
**Built-on:** [DESIGN-0005](0005-coach-loop-skill-drift.md) (coach
loop infra — Checkup tab, `mcp__sivru__checkup`).
**Feeds-into:** [DESIGN-0006](0006-coach-loop-looped-on-error.md)
and [DESIGN-0007](0007-coach-loop-low-context-edit.md) — the
feedback loop in slot 2 ships the data signal those designs need
to calibrate against (today they would tune against intuition).
**Created:** 2026-05-28
**Updated:** 2026-05-28 — revised through `/plan-ceo-review`
HOLD SCOPE iter-1 (PASS), `/plan-eng-review` iter-1 (PASS),
and `/plan-design-review` iter-1 (PASS). CEO pass folded three
structural forks (agent-side MCP writes shipped in slot 2;
origin-check + path-normalize security; 409 conflict +
last-write-wins) plus 17 obvious-fix amendments, and re-cut
the slot plan from 5 sequential slots to 2 mega-slots. The
lifecycle frame (authoring → triage → edit → feedback →
tuning) leads the proposal. Eng pass folded three more forks
(separate `/api/blocks/stream` SSE endpoint; observe-ui
imports types directly from `@sivru/search/block/types`;
per-day audit log with 7-day retention) plus 16 obvious-fix
amendments covering Hono `csrf()` adoption, FIFO drop, MCP
error envelope, shared handler module, test plan additions,
and concrete perf benchmark. Design pass added the
"UI design & interaction states" architecture subsection
mapping every Blocks-tab surface to DESIGN.md tokens
(`--error` / `--warn` / `--text-secondary` for edge severity,
13/14/16/11px type scale, Geist Sans/Mono, `--radius` 4px,
J/K node nav matching the §6.9 convention), folded 13
amendments (Blocks tab header, sub-view toggle keys,
inspector empty state, loading / error / partial /
SSE-disconnected / empty-triage / dirty-editor states,
diagnostic row design, reduced-motion + ARIA, collapsible
editor groups), and resolved the editor-form-layout fork
(collapsible groups in inspector).
**Author:** @pochadri
**Inputs:** real-usage feedback from driving sivru blocks in
BuildWright (Quarkus/Hibernate Java repo; same project that fed
batch B into DESIGN-0019). After authoring ~24 blocks and
exercising the v0.8 graph + diagnostics in CI for two weeks, four
distinct UI-shaped gaps surfaced. Each is concrete and
reproducible; together they argue that the next step is not more
CLI ergonomics but a first-class lifecycle surface for blocks —
on both the UI (for the human in the loop) and the MCP tools (for
the agent in the loop).

## Problem

By the end of v0.8 sivru has:

- A schema for authored context (`@sivru` blocks).
- Drift diagnostics on the single-block side
  (`broken-collaborator`, `missing-required`, `stale-block`,
  `expired-decision`).
- A cross-block graph + diagnostics
  (`collaborator-asymmetric`, `collaborator-rename-suspect`,
  `collaborator-order-contradiction`).
- Diff-scoped CI flags + autofix for YAML traps (E237/E238).
- An observe-ui with five read-only tabs (Sessions, Checkup,
  Replay, Costs, Bench).
- One read-only MCP tool for drift surfaces (`mcp__sivru__checkup`).

All block functionality is **CLI-only** for humans and **absent**
for agents. Diagnostics print to stdout; the graph emits as JSON
for tooling; the autofix runs in the terminal; the MCP surface
exposes no block operations at all. After two weeks of using this
surface to drive 24 blocks in BuildWright, four gaps came back
with reproducers:

**Gap 1 — invisible graph.** `sivru block graph --json` returns
nodes and edges. A human cannot read 200-edge JSON and spot the
three asymmetric edges that matter, the one cluster of orphan
blocks, or the rename-suspect chain. Today the answer is "grep the
diagnostics for E234 and trust them." Diagnostics are a signal;
the **shape** of the graph (who's central, who's isolated, where
the contract surface concentrates) is invisible. When BuildWright
hit ~40 blocks, the agent stopped using the graph entirely —
"can't see it, can't reason about it."

**Gap 2 — noisy diagnostics with no triage surface.** E234
(`collaborator-asymmetric`) fires legitimately on dozens of
intentional leaf-utility relationships in BuildWright (a service
declares a logger as a collaborator; the logger does not declare
the service back, by design). Today the only way to dismiss is
`graph.orderingChecks: false`-style global toggles or per-block
prose comments. Per-edge acknowledgment requires hand-editing
`.sivru/block.json` with edges-as-strings. Result: a 12-finding
report where 10 are known-intentional. The agent learned to skim
the report instead of read it — **diagnostic blindness**, the
exact failure mode the coach loop is supposed to prevent.

**Gap 3 — block authoring is a YAML-in-comment exercise.** Writing
a block from scratch still takes ~3 min per symbol (DESIGN-0019
§5 surfaced this; `block init` scaffolding lands in slot 4). Even
with scaffolding, *editing* an existing block — adding a
collaborator, marking a decision expired, bumping `maturity` —
means opening the file, finding the YAML region, editing in-place,
re-running validate, fixing the colon-trap mistake (E237) the
edit just introduced, re-running validate. In BuildWright we lost
~15 min/day to this loop. Worse: when the agent does the editing,
it routinely re-introduces E237/E238 traps that v0.8's autofix
catches but that the agent has no UI to *see* before commit.

**Gap 4 — no feedback path back to sivru itself.** When a
diagnostic is a false positive (the asymmetric edge is
intentional, the stale-block heuristic tripped on a formatter
pass, the rename-suspect named two unrelated symbols), the user
has no place to say so durably. The only options today are
`.sivru/block.json` overrides (per-rule, not per-finding) or
silence-by-comment. Sivru's own heuristic tuning — the false-
positive rate on `stale-block`, the precision of
`rename-suspect`, the calibration of `staleness` against real
PRs, the coach-loop v2/v3 signals — depends on a feedback signal
that does not exist. We are flying blind on the exact dimension
the roadmap says we should be tuning.

These four gaps share a shape: **blocks are now a real object in
the repo, but the only surface for working with them is the
terminal, and only the human-driven kind.** The observe-ui already
exists, already has a dark-only, fast, dogfooded layout, and
already hosts the Checkup tab whose purpose is exactly this kind
of drift surface. The MCP server already hosts `checkup`, `search`,
`explain`, `find_related`. The next step is to make the **block
lifecycle** first-class on both surfaces.

## Proposal

### The lifecycle frame (read this first)

A block's life cycle is:

```
AUTHORING ──▶ TRIAGE ──▶ EDIT ──▶ FEEDBACK ──▶ TUNING
   │              │          │          │             │
   v0.6 ships    Gap 1+2    Gap 3      Gap 4       coach v2/v3
   (extract,     (invisible (YAML in   (no signal  (no data
   validate)    graph,     comment is  back to     signal)
                 noisy      slow)      sivru)
                 triage)
```

v0.6-v0.8 shipped AUTHORING. This design ships TRIAGE → EDIT →
FEEDBACK → TUNING — the four downstream phases — across one
coherent surface (the Blocks tab + supporting MCP tools) instead
of bolting each phase to a different terminal command.

The surface is the same for both human and agent. The UI is the
human's view of the lifecycle; the MCP tools are the agent's view.
Both write to the same disk under the same `--writable` gate.

### The surface, in five layers

**1 — Graph view.** A two-pane Blocks tab. Left pane: force-
directed graph of blocked symbols (nodes) and collaborator
relationships (edges), with edge styling carrying reciprocity
(thick = reciprocal; dashed = asymmetric; red = broken-
collaborator; amber = rename-suspect). Right pane: the selected
node's full block content (role, responsibility, invariants,
decisions, collaborators, maturity, source location) plus any
diagnostics attached to that node. The graph is `computeBlockGraph`
output rendered, nothing more — no new graph algorithm.

**2 — Diagnostic triage inbox.** The **default** sub-view on the
Blocks tab (information hierarchy: triage is the more frequent
activity than graph browsing). Lists every diagnostic the graph +
drift checks emit, grouped by severity and code, with per-finding
actions: **Fix** (where an autofixer exists, applies it to disk),
**Acknowledge** (records the finding as intentional in
`.sivru/acknowledgments.jsonl`, keyed by content-hash so a real
change re-fires it), **Open in editor** (`vscode://file/...` URL),
**Mark false positive** / **Suggest fix** (records as feedback;
see layer 5). Diagnostic blindness becomes a triage inbox.

**3 — Block editor.** When a node is selected, the right pane
gains an **Edit** button that turns the block content into a form:
typed fields per YAML key, autocomplete for `collaborators` (reads
from the v0.2 symbol index), a `maturity` dropdown, a "mark
expired" action per decision, validation-as-you-type that runs the
same `validateBlock` the CLI runs. Save writes the YAML back to
the source file, preserving comment-fence framing, and re-runs the
graph + diagnostics. Edits are local file writes; no network.

**4 — Block-aware Replay/Checkup.** The existing Replay tab gains
a "Blocks touched" lane: for every file the agent edited in the
session, surface the blocks attached to that file and whether the
edit overlapped a block's source range. The Checkup tab gains a
"Block drift" section that surfaces E233/E234/E235/E236 counts and
a one-click "Open in Blocks tab" link. Blocks stop being a
separate axis and become a lens across the existing surfaces.

**5 — Feedback loop + agent MCP surface.** Every "Acknowledge,"
"Suggest fix," or "Mark false positive" action writes a JSONL
record to `.sivru/feedback.jsonl` (local, git-trackable). Records
carry diagnostic code, file/range, content hashes, the user's
label (intentional / false-positive / suggested-rewrite), a free-
text note, and an `actor` field. **The agent gets a symmetric MCP
write surface in slot 2**: `mcp__sivru__block_autofix`,
`mcp__sivru__block_acknowledge`, `mcp__sivru__feedback_append`,
and `mcp__sivru__feedback_read`. All four route through the same
`--writable`-gated handlers the UI uses. This is what closes
Gap 4 — and what gives DESIGN-0006 (coach loop v2 looped-on-error)
and DESIGN-0007 (coach loop v3 low-context-edit) a real data
signal to tune against, instead of intuition.

### Public surface

```ts
// packages/observe/src/server/app.ts — new routes (REST-plural)
GET  /api/blocks                        // graph + diagnostics for a rootPath
GET  /api/blocks/:filePath/:symbol      // single block detail
GET  /api/blocks/stream?rootPath=…      // SSE for block.* events (slot 1)
POST /api/blocks/autofix                // apply autofix (writable only)
POST /api/blocks/edit                   // write a block YAML edit (writable only)
POST /api/blocks/acknowledge            // record an acknowledgment (writable only)
POST /api/feedback                      // append a feedback record (writable only)
GET  /api/feedback                      // read feedback records (rootPath-scoped)

// packages/observe/src/handlers/block/*.ts — shared handler module
//   single source of truth; HTTP routes + MCP tools both call these.
//   applyAutofix, editBlock, acknowledgeDiagnostic,
//   appendFeedback, readFeedback.

// packages/observe-ui/src/components/BlocksView.tsx — new tab
// packages/observe-ui/src/components/BlockGraph.tsx — force-directed render
// packages/observe-ui/src/components/BlockTriageInbox.tsx — default sub-view
// packages/observe-ui/src/components/BlockEditor.tsx — YAML-aware form

// packages/cli/src/commands/observe.ts — flag
sivru observe [--writable]   // default: read-only. --writable enables mutation routes.
                             // requires bind 127.0.0.1; --writable + --host 0.0.0.0 errors.

// packages/cli/src/mcp/ — new MCP tools (slot 2), naming aligns with
//   existing mcp__sivru__checkup / mcp__sivru__explain (singular).
mcp__sivru__block_autofix       // apply autofix; requires --writable on the host server
mcp__sivru__block_acknowledge   // record acknowledgment; same gate
mcp__sivru__feedback_append     // append feedback record; same gate
mcp__sivru__feedback_read       // read feedback records (no --writable required)
```

**Naming asymmetry is intentional.** HTTP routes follow REST
convention (`/api/blocks/*` plural — "the resource collection").
MCP tools follow the existing sivru convention (singular,
`block_*` — matches `mcp__sivru__checkup`, `mcp__sivru__explain`).
The shared handler module hides the convention difference: the
same `applyAutofix(rootPath, filePath, code)` function backs both
`POST /api/blocks/autofix` and `mcp__sivru__block_autofix`.

The mutation routes (and the MCP write tools) return a structured
error unless the server was booted with `--writable`. The UI hides
write affordances when `/api/health` reports `writable: false`. No
silent fallback; the user sees "read-only mode" inline.

## Architecture

### Layer boundaries

- **`packages/search/src/block/`** — graph builder, validator,
  autofix, drift checks. Already exists post-v0.8. This design
  adds no logic here; it consumes the existing surface.
- **`packages/observe/src/server/`** — new routes call into
  the shared block-handler module (below); routes are thin
  HTTP-to-handler adapters. Privacy boundary holds:
  `computeBlockGraph`, `validateBlock`, `autofixFile` are all
  local-disk operations.
- **`packages/observe/src/handlers/block/*.ts`** — shared
  handler module. **Single source of truth for every block
  write operation.** Both the HTTP routes (in
  `packages/observe/src/server/`) and the MCP tools (in
  `packages/cli/src/mcp/`) call into the same exported
  functions: `applyAutofix`, `editBlock`, `acknowledgeDiagnostic`,
  `appendFeedback`, `readFeedback`. This prevents drift between
  the UI and agent surfaces — there is exactly one
  implementation per operation.
- **`packages/observe/src/feedback/`** — append-only JSONL
  reader/writer for `.sivru/feedback.jsonl`. One JSON object
  per line, git-trackable. Malformed JSONL lines on read are
  skipped with a structured warning, never throw — a single
  bad line cannot break the read endpoint.
- **`packages/observe/src/acknowledgments/`** — same shape as
  feedback: append-only JSONL at `.sivru/acknowledgments.jsonl`.
  **Decided to split from `.sivru/block.json` because
  acknowledgments grow unboundedly per repo** (50+ per
  BuildWright already); keeping them in a config file inflates
  that file and conflates config with log.
- **`packages/observe/src/audit/`** — append-only audit writer.
  Daily-rotated: writes to `.sivru/audit/YYYY-MM-DD.jsonl`. A
  background sweep on observe boot deletes files older than 7
  days. See Observability for the record shape.
- **`packages/observe-ui/src/components/`** — new tab +
  supporting components. Graph rendering uses an in-house force
  layout (~150 LOC) rather than a dependency — see Alternatives.
- **`packages/observe-ui/package.json`** — adds workspace dep on
  `@sivru/search`. The UI imports
  `BlockGraph`, `BlockDiagnostic`, `SourceRange`, `SivruBlock`
  types directly from `@sivru/search/block/types`. **Single type
  source of truth**; observe-ui's `src/types.ts` no longer
  duplicates block-related types. (Pre-flight check before
  slot 1: confirm the search package's types are exported
  through a clean import path; today they live at
  `packages/search/src/block/types.ts`.)
- **`packages/cli/src/commands/observe.ts`** — adds the
  `--writable` flag and threads it into the server boot.
- **`packages/cli/src/mcp/`** — adds the four new MCP tools, all
  thin wrappers around the shared handler module. **HTTP routes
  use REST-plural** (`/api/blocks/autofix`); **MCP tools use
  singular** (`mcp__sivru__block_autofix`), aligning with the
  existing `mcp__sivru__checkup` / `mcp__sivru__explain`
  convention. The asymmetry is intentional; the shared handler
  layer hides the convention difference from the underlying
  logic.

### Security & trust model

Three layers, designed up-front because this is the first sivru
surface that writes to disk on behalf of a non-CLI caller:

**1 — `--writable` gate.** Defaults to off. Boot banner says
"READ-ONLY mode." With `--writable`, boot banner says "WRITABLE —
UI + MCP can modify .sivru/ and source files in {rootPath}."
Banner is in the UI's ConnectionBanner component plus printed to
stderr.

**2 — Bind address coupling.** `--writable` requires bind
`127.0.0.1` (the default). The combination `--writable` +
`--host 0.0.0.0` (or any non-loopback bind) **errors at boot**
with a clear message: "writable mode does not support non-loopback
binds; remove --host or remove --writable." This prevents the
"writable to the whole LAN" footgun, which is the most predictable
way users get bitten by localhost services.

**3 — Per-request mitigation.**
- **Origin check via `hono/csrf` middleware.** Mount Hono's
  built-in `csrf()` middleware on the mutation route group:
  `app.use("/api/blocks/*", csrf({ origin: "http://127.0.0.1" }))`
  and same for `/api/feedback`. The middleware enforces
  Origin/Referer match against the configured origin and
  rejects mismatches with 403. **Layer 1 boring-tech win**:
  framework-maintained, the standard answer to localhost-service
  CSRF, no custom code to drift. (Sivru already imports
  `hono/cors`; `hono/csrf` is from the same middleware family.)
- **Path normalization.** Every route that takes a `filePath`
  argument resolves it through `path.resolve(rootPath, filePath)`
  and rejects (400) if the resolved path escapes `rootPath`. The
  resolved path is what's passed to the shared handler module;
  callers cannot pass an absolute path that bypasses rootPath.
  Implemented once in `packages/observe/src/handlers/block/path.ts`
  and reused across HTTP + MCP entry points.
- **MCP path.** MCP tools do not go through the Hono CSRF
  middleware (no browser, no Origin header), but they obey the
  same `--writable` gate and call into the same shared handler
  module — which means the path-normalization check runs
  unconditionally for every write. The stdio MCP transport is
  per-process; trust is the same as any CLI invocation.

**4 — Privacy boundary stays intact.** `packages/observe/` still
must not make network calls (CLAUDE.md hard rule #2). The new
routes write only to local disk and only when `--writable` is set
at boot. The privacy ESLint rule already bans `fetch`,
`node:http`, `node:https`, `node:net` imports in
`packages/observe/`. No change needed.

**5 — Enforceability.** A new test in
`packages/observe/src/server/app.test.ts` asserts:
- Every mutation route returns 405 from a non-writable boot.
- `--writable` + `--host 0.0.0.0` errors at boot.
- Origin-less POST returns 403 on every mutation route.
- `filePath: "../../etc/passwd"` returns 400 on every route that
  accepts a filePath.

The denylist test enumerates routes by introspecting the route
table, so a forgotten new route can't silently become writable.

### Concurrency & multi-process write conflicts

`sivru observe --writable` can run concurrent with
`sivru block validate --autofix` from a CLI, or with another
`sivru observe --writable` process in a sibling Conductor
worktree pointing at the same `.sivru/`. Concurrent writes will
happen.

**Strategy: detect-and-409, last-write-wins, no filesystem
locks.** Reasoning: file locks are platform-painful (Windows
flock semantics, NFS edge cases); conflicts are rare in practice;
409-and-re-read is the standard web pattern.

Mechanics:
- On every write that takes an existing file as input, the
  handler reads the file, captures `mtime` + `contentHash`,
  performs its write, then re-checks `mtime`. If `mtime`
  changed between read and write, the response is 409 with the
  current file contents; the UI prompts the user to re-read.
- On `.sivru/acknowledgments.jsonl` and `.sivru/feedback.jsonl`
  appends, the write is `fs.appendFile`-style (atomic append,
  no read-modify-write); no 409 needed.
- The CLI `--autofix` path adopts the same mtime-check shape:
  if a file changed between extract and write, the autofix
  errors instead of overwriting. The UI's "Fix" button uses the
  same path under the hood.
- No advisory file lock. No `.sivru/.lock` file.

### Index re-extraction post-edit

When a block edit lands (via UI form or via
`mcp__sivru__block_autofix`), the shared handler:
1. Writes the YAML to the source file (atomic temp + rename).
2. Calls `extractBlocksFromFiles([filePath])`, which is the
   **single contract** for re-extraction: it re-parses the
   file, updates the in-memory block cache in
   `@sivru/search/block`, **and** invalidates the matching
   v0.2 symbol-index entry as part of its own work. Callers
   never need a separate `indexInvalidate(filePath)` call —
   that responsibility lives inside `extractBlocksFromFiles`.
3. Recomputes the graph (incremental: re-runs collaborator
   resolution touching that file).
4. Pushes an SSE event `block.updated` on the dedicated
   `/api/blocks/stream` channel (see below).

The full graph re-extract is **not** triggered — that would be
seconds for a 500-block repo. Per-file re-extract is
milliseconds (benchmarked: see Performance gate below).

### Live updates

The observe HTTP server already exposes one SSE endpoint:
`/api/sessions/:id/stream` (`app.ts:122`), session-scoped.
**Blocks are not a session concept**, so slot 1 ships a
dedicated, separately-scoped SSE endpoint:

- **New endpoint: `GET /api/blocks/stream?rootPath=<path>`**.
  Single connection per Blocks tab, scoped to the active
  rootPath. The existing session stream stays unchanged.

Events on the new stream:
- `block.updated` — emitted on every successful edit / autofix /
  acknowledge / feedback append. Payload: the file path that
  changed and the new content hash; clients refetch the graph
  or diagnostic detail as needed.
- `block.graph.rebuilt` — emitted after `block.updated` when
  the graph topology (not just block content) changed.

Two browsers on the same observe server stay in sync: each
subscribes to `/api/blocks/stream` and receives the same events.

For **CLI ↔ UI awareness** (CLI `--autofix` writes a file while
the UI is open), the observe server uses **`node:fs.watch` on
the rootPath**, with the standard platform caveats:
- macOS, Linux: works reliably for the file events sivru cares
  about (write, rename).
- Windows: works for the same events with occasional duplicate
  fires; the handler debounces by file path + content hash so
  duplicates collapse to one `block.updated`.
- The caveats are documented in `sivru observe --help` and in
  the CONTRIBUTING.md "writing into `.sivru/` from external
  processes" section.

**Rejected: FIFO/socket-based ping.** Earlier draft proposed
`.sivru/events.fifo` as a CLI → observe-server signaling
channel. Rejected by eng review iter-1 — FIFOs are not
available on Windows, the `fs.watch` fallback already covers
the platforms we support, and rolling our own socket protocol
is "two innovation tokens" for a problem the platform already
solves.

### UI design & interaction states

The Blocks tab inherits the observe-ui's existing 3-pane shell,
dark-only theme, Geist Sans/Mono, zinc + amber palette, and
keyboard conventions documented in
[DESIGN.md §6](../../DESIGN.md). This section maps every Blocks
surface to those existing primitives — no new design system, no
new tokens, no new lint exceptions.

**Information hierarchy.**
- **Blocks-tab header.** Reads
  `Blocks · {rootPath} · {N} blocks · {M} diagnostics`,
  mirroring the session-header pattern from DESIGN.md §6.3.
- **Default sub-view.** Issues (triage inbox), not Graph.
  Triage is the more frequent activity; surfacing it first
  respects user time.
- **Sub-view toggle.** Two segmented pills in the tab header:
  `[Issues] [Graph]`. Keyboard: `I` (issues) / `G` (graph),
  matching the J/K convention already in DESIGN.md §6.9.
- **Inspector pane when nothing is selected.** Scope counters
  (`{N} blocks · {E1} errors · {E2} warnings`) + the three
  most recent diagnostics + a one-line explainer
  ("Select a node to inspect or filter the issues list").

**Interaction state coverage.** Every state below maps to an
existing §6.2 pattern from DESIGN.md, so the look is
recognizable rather than novel.

- **Loading** — `/api/blocks` first compute (up to ~2s on a
  500-block repo). Skeleton in graph pane + thin amber progress
  strip in the tab header reading
  `Computing graph · 200 / 500 blocks`. Matches §6.2 jsonl-loading.
- **Error** — graph build failed (e.g.,
  `computeBlockGraph` threw). Red banner in tab header:
  `Failed to build graph: {reason}. [Retry]`. Matches §6.2
  hub-unreachable.
- **Partial** — graph built but some files were unparseable.
  Amber strip below the tab header:
  `Graph built with {N} files skipped (parse errors). [Show]`.
  Matches §6.2 interrupted-turn.
- **SSE disconnected** —
  `/api/blocks/stream` connection dropped. Muted-red strip:
  `Lost live updates · retrying… · [Reconnect now]`. Last-known
  graph stays on screen, dimmed 30%. Matches §6.2
  connection-lost.
- **Empty triage inbox** (no findings) — neutral, not
  celebratory: `No active diagnostics. {A} acknowledged · {F}
  false-positives labeled. [Show acknowledged]`. The label
  counters make the "I triaged real things" history visible.
- **Read-only mode** (`--writable` not set) — persistent banner
  at the top of the inspector pane:
  `Read-only mode. Restart with --writable to enable edits.`
  Hides the Fix / Edit / Acknowledge / Mark FP buttons from
  every row. Boot banner duplicates the message on stderr.
- **Dirty-editor** — see "The block editor" below.

**Diagnostic row design.** Each row in the triage inbox is one
line:

```
{severity-glyph}  SIVRU-EXXX   {file}:{line}  ·  {one-line title}
```

Severity glyph maps to the existing semantic tokens:
- `--error`: filled red dot
- `--warn`: filled amber dot
- `--text-secondary` (info): hollow zinc circle

Row actions (`Fix` / `Acknowledge` / `Mark FP` / `Open` /
`Suggest fix`) are **visible on row hover**, not always-shown.
Reduces visual noise on a 30-row list; keeps the row readable
at a glance.

**Design token map.** Every UI element below points at the
existing DESIGN.md token. No new tokens are introduced; the
ESLint rule banning hardcoded colors in observe-ui still passes.

| Surface | Token |
|---|---|
| Background (graph pane, triage list) | `--bg-base` |
| Background (inspector, sub-view header) | `--bg-elevated` |
| Background (selected node, selected diagnostic row) | `--bg-selected` |
| Body text (block content, diagnostic title) | `--text-primary` |
| Secondary text (file paths, metadata) | `--text-secondary` |
| Muted text (timestamps, counters) | `--text-muted` |
| Edge: broken-collaborator + glyph | `--error` |
| Edge: rename-suspect + glyph | `--warn` |
| Edge: asymmetric (dashed only, no color) | `--text-secondary` |
| Selected node ring, "Save" button | `--accent` |
| Save bar background | `--bg-elevated` |
| Hairlines, group borders | `--border` |
| Node, button, pill geometry | `--radius` (4px) / `--radius-sm` (2px on pills) |
| Diagnostic rows | 13px / `--line-prose` |
| Block content body | 14px / `--line-prose` |
| Metadata + counters | 11px / `--line-prose` |
| Tab headers, group titles | 16px / `--line-prose` |
| YAML in editor, file paths | Geist Mono / `--line-code` |
| All prose | Geist Sans |

**A11y commitments** (per DESIGN.md §6.9 conventions).
- ARIA landmarks: graph pane is `<main>`; sub-view header is
  `<nav>`; inspector is `<aside>`.
- Each graph node is `role="button"` with
  `aria-label="block {symbol} in {file}; {count} diagnostics"`.
- Each diagnostic row is `role="listitem"` inside a
  `role="list"` triage container.
- Focus ring uses `--accent-ring`, 2px solid, 2px offset —
  never removed.
- Color contrast meets WCAG AAA via the existing zinc-on-zinc
  palette (DESIGN.md §6.9 ratios apply unchanged).
- `prefers-reduced-motion: reduce` — force sim settles in ≤1
  step (or uses precomputed coordinates); no transitions; the
  live SSE pulse becomes a static dot.

**Keyboard nav** (extends the existing DESIGN.md §6.9 set):
- `I` / `G` — switch sub-view (Issues / Graph).
- `J` / `K` — next/prev node (Graph) or next/prev diagnostic
  (Issues), in degree-sort or severity-sort order
  respectively.
- `Enter` — inspect the focused node / diagnostic.
- `Esc` — deselect; if a dirty editor is open, prompts before
  closing.
- `/` — focus the diagnostic filter input.
- `F` — fix the focused diagnostic (when actionable).
- `A` — acknowledge the focused diagnostic.
- `Cmd+S` / `Ctrl+S` — save the editor.

**Responsive.** The min-viewport story is inherited from
DESIGN.md §6.9: below 1280×720, the existing centered fallback
("sivru-observe needs ≥ 1280px") covers the Blocks tab too.
No mobile or tablet design in v1.

**"Copy CLI" button mapping.** Each diagnostic row's "Copy CLI"
action emits the exact command that fixes or surfaces the
diagnostic. Mapped per code:

| Diagnostic code | CLI emitted by "Copy CLI" |
|---|---|
| E230-E232 (invariant→test linkage) | `sivru block validate {file}` |
| E233 (stale-block) | `sivru block staleness --since=origin/main` |
| E234 (asymmetric) | `sivru block graph --check {file}` |
| E235 (rename-suspect) | `sivru block graph --check --strict {file}` |
| E236 (order-contradiction) | `sivru block graph --check {file}` |
| E237/E238 (YAML traps) | `sivru block validate --autofix {file}` |
| E220-range (broken-collaborator) | `sivru block check {file}` |

The mapping lives in the shared handler module so HTTP + MCP
return the same command string.

### The graph render

Force-directed layout, in-house. ~150 LOC of D3-flavored force
sim (no D3 dependency — we already ship React; a custom
`useReducer`-driven sim is straightforward). Nodes are uniform
circles (no size encoding — collaborator-count range of 0-8
doesn't produce perceivable diff at this scale; reciprocity and
severity already give two independent visual axes). Edges are
SVG paths styled by **two independent encodings** so the graph
stays colorblind-safe:

- **Reciprocity** (edge axis 1): thick stroke = reciprocal,
  dashed stroke = asymmetric. Independent of severity.
- **Severity** (edge axis 2): mapped to DESIGN.md tokens.
  - `--error` (red-400, #f87171) → broken-collaborator (E22X)
  - `--warn` (amber-400, #fbbf24) → rename-suspect (E235)
  - `--text-secondary` (zinc-400) → asymmetric (E234), no color —
    severity signal is the dash pattern only

Two axes, two encodings — a user with deuteranopia (most common
form of colorblindness) sees the dash pattern unchanged; severity
information survives.

Interaction: click selects; drag re-positions; scroll zooms.
Keyboard: `J` / `K` for next/prev node in degree-sort order,
`Enter` to inspect, `Esc` to deselect, `/` to focus the
diagnostic filter. Mirrors DESIGN.md §6.9 navigation conventions.

A11y:
- Each node is `role="button"` with
  `aria-label="block {symbol} in {file}; {count} diagnostics"`.
- Edges are `role="presentation"` (decorative; the
  same information is in the diagnostics list).
- Reduced-motion (`prefers-reduced-motion: reduce`): the force
  sim runs at most one settling step (or uses precomputed
  coordinates) and animates no transitions.

No mini-map, no clustering algorithm in v1 — if BuildWright
hits 500+ blocks before slot 1 ships, we revisit.

Empty states:
- **0 blocks** — graph pane shows a centered explainer:
  "No `@sivru` blocks in this project yet. Run
  `sivru block init <file>` to scaffold one, or see
  DESIGN-0016." Diagnostic inbox shows "No findings."
- **1 block** — graph pane shows the single node, no edges. The
  block's content fills the right pane by default.
- **A block with no diagnostics** — node renders normally; right
  pane shows content; "no findings" appears under the diagnostics
  list.

Rejected: bringing in `d3-force` or `cytoscape`. Both are
~200-400KB minified and the project's `package.json` is
intentionally lean. The CLAUDE.md rule "Add a dependency that
isn't already there" goes through user approval; for a v1 visual
where the algorithm is a 30-line force sim, the dep is
unjustified.

### The block editor

The editor renders the YAML schema as a typed form, not a free
text area. **Layout: collapsible groups in the inspector**
(the right pane of the standard 3-pane observe-ui shell), not a
modal. Five groups in display order:

1. **Identity** — schema, role, responsibility, maturity.
2. **Invariants** — list of rule/enforced-by pairs.
3. **Decisions** — list of chose/because/valid-while/revisit-if
   structures.
4. **Collaborators** — autocompleting list of symbol names.
5. **Source** — read-only file path + range, with "Open in
   editor" affordance.

Groups collapse/expand independently; first open defaults
expanded (Identity, Invariants), rest collapsed. A **dirty-state
pill** appears in the inspector header the moment any field
changes ("● Unsaved changes"). A **save bar** pins to the
bottom of the inspector with `[Save]` and `[Discard]`. `Cmd+S` /
`Ctrl+S` saves; `Esc` while dirty prompts "Discard changes?"
before closing.

Each field is a controlled React input. On save:

1. The form state serializes to YAML using the same
   `serializeBlock` helper the `block init` scaffolding uses
   (DESIGN-0019 §5; confirmed exported from
   `@sivru/search/block/serialize` before slot 2 begins —
   tracked as a slot 2 pre-flight check).
2. `validateBlock` runs against the serialized YAML. Errors
   render inline, save is disabled.
3. The handler reads the source file, captures `mtime`, locates
   the existing `@sivru ... @end` fence by source range, writes
   the new YAML in-place via temp-file + rename. If `mtime`
   changed between read and write, returns 409.
4. On 409, the UI prompts: "The file was modified externally.
   Reload latest?" — user clicks reload; the form re-populates
   with the current YAML; any in-flight edits are preserved as a
   visible "your unsaved changes" diff that the user can re-apply.
5. The graph + diagnostics are recomputed and an SSE
   `block.updated` event fires.

Editor edge cases:
- **File moved/renamed between graph load and edit** — the
  handler reads the original path; if it's gone, returns 404
  with a hint that the file may have moved. The UI tells the user
  to refresh the graph.
- **Symbol renamed between extraction and edit** — handler
  checks that the symbol the form was opened for still resolves
  to a block in the file at the recorded range. If not, returns
  409 same as the mtime case; user re-reads.
- **Form-saved YAML longer/shorter than original** — fence
  re-anchoring uses byte offsets recorded at extract time; the
  write replaces only the bytes between the fence delimiters and
  preserves everything outside.

What we do **not** do: full file edit. The editor only ever
rewrites the bytes inside a single `@sivru ... @end` fence.

### Feedback record shape + agent MCP surface

```jsonc
// .sivru/feedback.jsonl — one record per line, append-only
{
  "schema": 1,
  "timestamp": "2026-05-28T14:21:00Z",
  "kind": "acknowledge",  // "acknowledge" | "false-positive" | "suggest"
  "diagnostic": {
    "code": "SIVRU-E234",
    "filePath": "src/services/UserService.java",
    "symbolName": "UserService",
    "contentHash": "a3f9..."
  },
  "label": "intentional",
  "note": "Logger is a leaf utility; no back-reference by design.",
  "actor": "ui"  // "ui" | "cli" | "mcp"
}
```

`.sivru/acknowledgments.jsonl` uses the same record shape with
`kind: "acknowledge"` (acknowledgments are a subset of feedback,
stored separately so the diagnostic-suppression read path is
cheap — `readAcknowledgments()` is a single-file scan, no
filtering across feedback kinds). Records are append-only;
never edited or deleted by sivru. A user can
`rm .sivru/acknowledgments.jsonl` or `rm .sivru/feedback.jsonl`
to start over.

**Content-hash-keyed invalidation.** Acknowledgments key on
`{code, filePath, symbolName, contentHash}`. The next graph
build hashes the current block content; if the hash differs
from any acknowledgment's `contentHash`, the acknowledgment is
treated as stale and the diagnostic re-fires with a note: "this
finding was previously acknowledged but the block has changed."
This prevents the "acknowledge once, forget forever" failure
mode.

**Schema migration.** `schema: 1` today. Future schema bumps
follow the standard pattern: `readFeedback()` reads any
supported schema and normalizes to the current one in-memory;
writes always emit the current schema; old records are left in
place. A new reader sees a record with `schema: 2` and either
knows how to parse it or skips with a structured warning. The
field is mandatory; missing-schema records are rejected.

**Agent MCP surface.** Slot 2 ships four tools. All four call
into the shared block-handler module
(`packages/observe/src/handlers/block/*.ts`), so there is
exactly one implementation per operation behind both the HTTP
surface and the MCP surface:

- `mcp__sivru__block_autofix(rootPath, filePath, diagnosticCode)`
  — applies the autofix for the named diagnostic on the file.
  Requires `--writable` on the host server.
- `mcp__sivru__block_acknowledge(rootPath, diagnostic, note?)`
  — appends an acknowledgment record. Same `--writable` gate.
- `mcp__sivru__feedback_append(rootPath, kind, diagnostic, label, note?)`
  — appends a feedback record. Same gate.
- `mcp__sivru__feedback_read(rootPath, filter?)`
  — reads feedback records. **Not** `--writable`-gated; read is
  always allowed.

**Error envelope (shared across all four tools).** Every tool
returns one of:

```ts
type McpResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code:                        // structured error codes
        | "SIVRU-WRITABLE-DISABLED"
        | "SIVRU-PATH-OUTSIDE-ROOT"
        | "SIVRU-FILE-NOT-FOUND"
        | "SIVRU-FILE-CHANGED"     // mtime mismatch (409 equivalent)
        | "SIVRU-VALIDATION-FAILED"
        | "SIVRU-AUTOFIX-RAISED"
        | "SIVRU-INTERNAL-ERROR";
      message: string;             // human-readable
      retryable: boolean;          // safe to retry without side effects?
    };
```

Codes are stable and agent-tunable — an agent that gets
`SIVRU-FILE-CHANGED` knows to re-read and retry; one that gets
`SIVRU-WRITABLE-DISABLED` knows to surface a config issue
rather than retry. The same envelope shape backs the HTTP
mutation routes (as the JSON body of 4xx/5xx responses), so
UI and agent paths share one error contract.

An agent running DESIGN-0007 low-context-edit can use these
tools to triage in-context: it spots a diagnostic, decides
it's intentional, calls `block_acknowledge`, and moves on —
same as a human clicking Acknowledge in the UI. This is the
architectural symmetry the design depends on.

### `.sivru/` git-tracking story

Both `acknowledgments.jsonl` and `feedback.jsonl` are
git-trackable but not opinionated. Recommended default:
acknowledgments committed (team-shared diagnostic decisions);
feedback uncommitted by default (private label data; opt-in if
the team wants shared tuning). The CLI documents this in
`sivru observe init` output. Users decide per-repo.

## Release plan — 2 mega-slots

Down from 5 sequential slots. Each slot is independently
shippable; each delivers real BuildWright value standalone. The
collapse removes the "release-cycle drag" failure mode where
slots 4-5 ship long after BuildWright needs them.

### Slot 1 — Read-only Blocks tab (graph + triage + Replay/Checkup)

Closes Gap 1 and most of Gap 2. New `Blocks` tab in observe-ui.
Force-directed graph (graph sub-view), default triage inbox
(issues sub-view). Click a node → see block content + attached
diagnostics. Each diagnostic row has "Open in editor" (`vscode://`)
and "Copy CLI fix command." Block-aware Replay/Checkup: Replay
tab gains "Blocks touched" lane; Checkup tab gains "Block drift"
section linking into Blocks tab. **No editing, no writes, no
`--writable` flag.** New `/api/blocks` + `/api/blocks/:file/:symbol`
routes return read-only graph and detail data.

**Acceptance:** A BuildWright user can open `sivru observe`,
click Blocks, see the 40-block graph, click any node, read its
authored context, and triage the 12-finding report in under 1
minute. Asymmetric edges are visually distinct from reciprocal.
The Java repo's three orphan blocks pop visually without grepping
a diagnostic. Replay shows blocks touched per session. Checkup
links through.

### Slot 2 — Write surface (autofix + acknowledge + editor + feedback + agent MCP)

Closes Gap 2 fully, plus Gap 3 and Gap 4. Adds the `--writable`
flag to `sivru observe`. Each diagnostic with an autofixer (E237/
E238 today) gains a **Fix** button. Each diagnostic gains an
**Acknowledge** button that appends to
`.sivru/acknowledgments.jsonl`. Each diagnostic gains **Mark
false positive** and **Suggest fix** buttons that append to
`.sivru/feedback.jsonl`. The block editor (form-based YAML edit)
ships in this slot. The four new MCP tools
(`mcp__sivru__block_autofix`, `block_acknowledge`,
`feedback_append`, `feedback_read`) ship in this slot. Mutation
routes 405 when not writable; `--writable` + `--host 0.0.0.0`
errors at boot; origin check on every mutation route; path
normalization on every `filePath` argument.

A benchmark `pnpm bench feedback` reports per-diagnostic
**precision against the user-labeled set** (i.e., on this user's
repo: how often did sivru flag something the user later labeled
intentional or false-positive?). This is repo-local tuning data,
not a generalizable benchmark — explicit in the bench output.

**Acceptance:** A BuildWright user starts `sivru observe
--writable`, clicks **Fix** on three E237 colon-traps, clicks
**Acknowledge** on five intentional E234 asymmetries, edits one
block to bump maturity from "experimental" to "stable" via the
form, and marks two findings as false positives. The report drops
from 12 findings to 4 real ones. The agent (BuildWright using
sivru via Claude/Codex) does the same triage via MCP tools in a
separate session and lands the same outcome. `pnpm bench feedback`
returns per-diagnostic precision; `mcp__sivru__feedback_read`
returns the records.

## Alternatives considered

**Stay CLI-only; ship a `sivru block report --html` static
report.** Rejected. Static reports do not solve Gap 3 (editing)
or Gap 4 (feedback loop). They partially solve Gap 1 and Gap 2
but degrade to "another file in `dist/` that nobody opens" within
a week — we've seen this exact failure mode on past tools. The
observe-ui exists, is dogfooded daily, and is the obvious home.

**Bring in `d3-force` or `cytoscape` for the graph render.**
Rejected for v1; revisit if BuildWright or a downstream user
hits a real scaling wall. The force-sim we need is ~150 LOC;
the deps are 200-400KB minified plus license + maintenance
surface. Bundle weight matters for the localhost UI's startup
feel.

**Make all routes writable by default; rely on `127.0.0.1` for
trust.** Rejected. The `--writable` flag is a deliberate friction
that matches CLAUDE.md hard rule #2's caution about the observe
surface. It is also a useful contract for CI / shared-machine
scenarios: someone tailing the localhost UI on a build server
should not be able to mutate `.sivru/`. The flag is one extra
keystroke; the protection is worth it. The bind-address coupling
(`--writable` requires loopback) makes the "writable to the LAN"
footgun structurally impossible.

**Push feedback to a hosted service for cross-repo learning.**
Rejected outright. Violates hard rule #2 and the local-first
principle. Cross-repo learning, if we ever do it, ships in a
separately installable `sivru-analytics` package the user adds
explicitly. `.sivru/feedback.jsonl` is local; sharing is the
user's choice.

**Edit blocks as raw YAML in a textarea.** Rejected for the
editor. The whole reason E237/E238 exist as diagnostics is that
raw YAML editing in a comment fence is error-prone. A typed form
is the fix — the form cannot generate the problem patterns the
autofix exists to clean up. Power users who want raw YAML edits
have the source file; the UI is the assisted path.

**5-slot incremental rollout** (original draft). Rejected via
`/plan-ceo-review` HOLD SCOPE iter-1. Reasoning: each slot
shippable but the cumulative release-cycle drag pushes Gap 3 and
Gap 4 closure far past BuildWright's actual need; the write
surface is incoherent if it ships piecewise (autofix early,
editor and feedback months later); 5 PRs of rollback choreography
is worse risk than 2 well-tested PRs.

**Advisory file locking via `.sivru/.lock`** for concurrency.
Rejected. Platform-painful (Windows flock semantics differ; NFS
edge cases); blocks rather than fails-fast; 409-and-re-read is
the standard pattern and matches what every web app already does.

**`mcp__sivru__feedback` as read-only.** Rejected (was the
original draft). An agent driving block triage needs the same
write surface as a human. Read-only MCP creates a two-tier system
where humans can close diagnostics and agents can't — exactly the
wrong axis to split on for an agent-primary product.

## Open questions

- **Graph layout at 500+ nodes** — force-sim degrades visually
  past ~300 nodes. Defer clustering/binning to a slot 1 follow-up
  unless BuildWright hits the wall first. (owner: @pochadri, by
  slot 1 ship)
- **`--writable` discoverability** — the flag is one keystroke
  but users won't know it exists. Slot 2 ships with a banner on
  the read-only UI saying "Read-only mode. Restart with
  `--writable` to enable edits." Is that enough, or do we want a
  one-shot "enable writes" config? Lean: banner is enough; a
  config knob makes the trust boundary less visible. (owner:
  @pochadri, by slot 2 ship)
- **`fs.watch` Windows reliability** — resolved at eng review
  iter-1: ship `fs.watch` with debounce on (path, content-hash);
  documented platform caveats live in `sivru observe --help`.
  FIFO socket plan dropped. Open question is whether the
  debounce window of 50ms is right; tune in slot 2 on real
  Windows data. (owner: @pochadri, by slot 2 ship)
- **`.sivru/acknowledgments.jsonl` git policy default** — commit
  or ignore? Recommended: commit (team-shared decisions). Adds a
  one-line `sivru observe init` hint suggesting it. Slot 2 ships
  this as a documentation default, not enforced. (owner:
  @pochadri, by slot 2 ship)
- **Bench harness scope** — `pnpm bench feedback` reports
  per-diagnostic precision on the user's labeled set. Is the
  generalizable cross-repo benchmark also in scope (would
  require aggregating labels from multiple opt-in repos), or
  strictly local? Lean: strictly local in slot 2; cross-repo is
  the `sivru-analytics` separate-package story. (owner:
  @pochadri, by slot 2 ship)

## Acceptance criteria

Cross-slot, the design is done when:

- BuildWright (or any repo with 30+ blocks) can drive its block
  diagnostic queue end-to-end from the UI **and** from an
  agent-driven MCP session without dropping to the CLI for
  triage, editing, or feedback.
- The privacy boundary tests pass: `packages/observe/` has no
  network imports; mutation routes 405 without `--writable`;
  `--writable` + `--host 0.0.0.0` errors at boot; origin-less
  POST returns 403; `filePath: "../.."` returns 400; a fresh
  `sivru observe` defaults to read-only with a clear banner.
- `.sivru/acknowledgments.jsonl` and `.sivru/feedback.jsonl` are
  real, append-only files readable by `mcp__sivru__feedback_read`,
  and the file format is documented in CONTRIBUTING.md with the
  recommended git-tracking policy.
- The Blocks tab's default sub-view is the triage inbox (Issues),
  with the graph available as a toggle.
- Per-slot acceptance bullets (above) are each independently
  green.

Per-slot acceptance is enumerated in §7.

## Test plan

**Slot 1.**
- Unit: `BlockGraph.tsx` render against fixture graphs (10, 50,
  200 nodes); asymmetric / broken / reciprocal edge styling;
  empty-state renders (0 blocks, 1 block, single-node degenerate).
- Unit: `BlockTriageInbox.tsx` groups by code, sorts by severity,
  renders "Open in editor" + "Copy CLI" actions correctly.
- Integration: `/api/blocks` route returns the same shape
  `computeBlockGraph` produces; **5xx path** — when
  `computeBlockGraph` throws, route returns 500 with structured
  envelope and increments the error counter. Confirm no
  regression in existing routes.
- Integration: `/api/blocks/stream` SSE — emits `block.updated`
  on file change (driven via the fs.watch path), debounces
  duplicate events within 50ms, supports multi-client fanout
  (open two EventSource connections, both receive the same
  event), and closes cleanly on client disconnect.
- A11y: graph view tab-navigable; node selection works via
  keyboard (Arrow keys navigate edges, Enter selects, Esc
  deselects); node detail readable by screen reader (ARIA
  labels on every node + edge); force-sim doesn't trap focus.
- Manual: open against BuildWright's 40-block graph; confirm
  the three orphan blocks pop visually; confirm Checkup
  link-through works.

**Slot 2.**
- Unit: every mutation route (`/api/blocks/autofix`, `/edit`,
  `/acknowledge`, `/api/feedback` POST) — happy path, 405 without
  `--writable`, 403 without matching Origin (via `hono/csrf`),
  400 on path traversal, 409 on mtime conflict, **500 when the
  underlying handler throws** (structured error envelope on the
  body in every case).
- Unit: form → YAML round-trip preserves all fields; validation
  rejects invalid combinations; file write is atomic (temp +
  rename); fence re-anchoring is correct when the new YAML is
  shorter or longer than the old; symbol-renamed-mid-edit returns
  409; file-moved-mid-edit returns 404.
- Unit: editor 409-reload UI flow — when the API returns 409,
  the form shows the conflict banner, surfaces the user's
  unsaved diff against the new file content, and the "Reload
  latest" button refetches without losing the user's pending
  edits.
- Unit: feedback record schema; append-only enforcement;
  content-hash-keyed invalidation when the block changes;
  schema-version normalization on read; **malformed JSONL lines
  on read are skipped with a structured warning** (one bad line
  cannot break the read endpoint).
- Unit: `GET /api/feedback` — happy, file missing returns 200
  with empty array, malformed line on disk is skipped + counted,
  filter param semantics correct.
- Unit: acknowledgments JSONL file behaves the same as feedback
  (append-only, malformed-skip, content-hash-keyed).
- Unit: `--writable` + `--host 0.0.0.0` errors at boot with the
  documented message; `--writable` + default loopback bind boots
  with the writable banner.
- Unit: shared handler module — `applyAutofix`, `editBlock`,
  `acknowledgeDiagnostic`, `appendFeedback`, `readFeedback`
  unit-tested as standalone functions before any HTTP/MCP
  wrapping; the same fixture exercises both wrappers.
- Integration: every MCP write tool exercised end-to-end
  (`block_autofix`, `block_acknowledge`, `feedback_append`,
  `feedback_read`) — per-tool happy path returns
  `{ ok: true, data: ... }`; per-tool error envelope
  (`SIVRU-WRITABLE-DISABLED`, `SIVRU-FILE-CHANGED`,
  `SIVRU-PATH-OUTSIDE-ROOT`, `SIVRU-INTERNAL-ERROR`) shape and
  retryable flag correct; same handlers as the HTTP routes
  (verified by mocking at the handler layer, not the
  transport layer).
- Integration: re-run `sivru block validate` after a UI fix;
  diagnostic gone. After an MCP-driven acknowledgment, run the
  CLI; diagnostic is suppressed with the "previously
  acknowledged" note.
- Concurrency: spawn `sivru observe --writable` + a parallel
  `sivru block validate --autofix` against the same file; both
  conclude without data corruption; one of them gets a 409 or
  the equivalent CLI error; user-facing message is clear.
- Concurrency: two parallel POSTs to `/api/blocks/acknowledge`
  for the same diagnostic — both records land in
  `acknowledgments.jsonl` (append-only), no record loss, no
  garbled bytes.
- Concurrency: two parallel POSTs to `/api/feedback` — same
  property, append-race resolves cleanly.
- Security: path traversal via `filePath: "../../etc/passwd"`
  rejected by every accepting route (400 + `SIVRU-PATH-OUTSIDE-ROOT`);
  CSRF (Origin missing / Origin mismatched) rejected by every
  mutation route via `hono/csrf` middleware; absolute path
  outside rootPath rejected (covered by the same normalization).
- Manual: drive BuildWright's report from 12 to 4 findings via
  the UI; do the same drive via MCP tools from a separate
  Claude Code session; CI agrees with both.

**Cross-slot.**
- Privacy: ESLint rule against network imports in
  `packages/observe/` passes.
- Perf benchmark (`benchmarks/block-ui/`, new fixture):
  - `/api/blocks` against a 500-block fixture
    (`benchmarks/fixtures/blocks-500/`) returns in <2s cold,
    <300ms warm on the M-series baseline machine used by the
    existing `pnpm bench` suite (matches the
    DESIGN-0013 perf-gate hardware target).
  - Graph render holds 60fps at 200 nodes on the same baseline
    (BuildWright +5x headroom).
  - Per-file re-extract via `extractBlocksFromFiles([filePath])`
    completes in <50ms on a 200-block file (median of 20 runs).
  - `fs.watch` event → SSE `block.updated` latency under 100ms
    p95.
- Bench: `pnpm bench feedback` runs end-to-end against the same
  fixture with a seeded label set; reports per-diagnostic
  precision against the labels.

## Customization shape

Per the CONTRIBUTING.md three-layer rule:

1. **Built-in defaults.** Force-directed layout; edge styling
   per §3.1 above; triage inbox is the default Blocks sub-view;
   `--writable` off by default; `--writable` requires loopback
   bind; `.sivru/feedback.jsonl` and `.sivru/acknowledgments.jsonl`
   as the storage sinks; the pre-defined diagnostic codes get
   autofix/acknowledge/mark-FP actions per their type (autofix
   when an autofixer exists, acknowledge for all, mark-FP for
   all warning-level).
2. **Declarative override.** `.sivru/observe.json` (new file):
   - `ui.blocks.defaultSubview: "issues" | "graph"` — override
     the default Blocks tab landing pane.
   - `ui.blocks.graph.layout: "force" | "hierarchical"` (only
     force in v1; hierarchical is the slot 1 follow-up).
   - `ui.blocks.graph.collapseDirs: string[]` — glob list of
     directories to render as collapsed super-nodes.
   - `ui.blocks.acknowledgments.path: string` — override the
     default `.sivru/acknowledgments.jsonl` location.
   - `ui.feedback.path: string` — override the default
     `.sivru/feedback.jsonl` location.
   - `ui.audit.path: string` — override the default
     `.sivru/audit/` directory.
   - `ui.audit.retentionDays: number` — override the default
     7-day retention.
3. **Code-level extension.** `.sivru/observe/*.tsx` can register
   custom diagnostic-row actions:

   ```ts
   // packages/observe-ui/src/extensions.ts — exported interface
   import type {
     SourceRange,
     BlockDiagnostic,
   } from "@sivru/search/block/types";

   export type DiagnosticAction = {
     code: string;                                      // SIVRU-EXXX
     label: string;                                     // button text
     icon?: "fix" | "ack" | "edit" | "custom";          // styling hint
     handler: (
       ctx: {
         filePath: string;
         range: SourceRange;
         diagnostic: BlockDiagnostic;
         rootPath: string;
       },
     ) => Promise<
       | { ok: true }
       | { ok: false; code: string; message: string; retryable: boolean }
     >;
   };
   ```

   Registered via `~/.sivru/extensions/*.ts`; loaded at observe
   boot; failures to load are logged but non-fatal. The handler
   is server-side — runs in the observe process, has disk
   access. Subject to `--writable` gating same as built-in
   actions. Handler return shape matches the MCP error envelope
   so extensions slot cleanly into the same triage UI.

## Observability

This is the first sivru surface that writes to disk on behalf of
remote callers; observability is scope, not afterthought.

**Per-route request log.** Every mutation route (and every read
route) emits a structured log line to stderr: timestamp, route,
method, status, duration, actor (`ui` from Origin / `mcp` from
transport), and any 4xx/5xx error code. Log lines are
human-readable (one line each); a `--log-json` flag emits JSONL
instead.

**Counters.** A new `/api/metrics` route exposes a minimal
counter set:
- `sivru_observe_graph_builds_total{rootPath}`
- `sivru_observe_block_autofixes_applied_total{code,rootPath}`
- `sivru_observe_block_edits_total{rootPath}`
- `sivru_observe_acknowledgments_total{code,rootPath}`
- `sivru_observe_feedback_records_total{code,kind,actor,rootPath}`
- `sivru_observe_writable_mode{value}` (gauge, 0/1)

Format: Prometheus text. No remote push; the user scrapes it
locally if they care.

**Write audit trail.** Distinct from `feedback.jsonl` (which is
user-labeled diagnostic data). Audit is "this write happened at
this time, by this actor, to this file." Stored in
`.sivru/audit/YYYY-MM-DD.jsonl` — **per-day files**,
append-only, schema-versioned, same shape as feedback minus the
label. Audit is **always** written when `--writable` is on; no
flag to disable.

**Retention.** A background sweep on observe boot (and once per
hour while running) deletes audit files older than 7 days. The
sweep is bounded and predictable; users who want longer retention
configure `ui.audit.retentionDays` in `.sivru/observe.json`. The
per-day-file design replaces the earlier 10MB-rotation plan,
which lost history past ~20MB on chatty servers.

**Read routes get the same observability.** Every read route
(`GET /api/blocks`, `GET /api/blocks/:f/:s`,
`GET /api/blocks/stream`, `GET /api/feedback`) also emits a log
line and increments
`sivru_observe_http_requests_total{route,status}`. A slow
`/api/blocks` shows up in the log + counter the same as a slow
mutation; you don't need `--writable` to see read latency.

**Banner content.** Boot banner in `--writable` mode includes:
"Writes are logged to .sivru/audit/. Retention: 7 days."
Sets expectations.

## Backward compatibility

- **`.sivru/block.json` shape.** Old configs without
  `acknowledged[]` parse fine (acknowledgments moved to their
  own JSONL file in this design). If an old config has an
  `acknowledged[]` array left over from earlier experimentation,
  slot 2 ships a one-time migration on first
  `sivru observe --writable` boot: copies entries to
  `.sivru/acknowledgments.jsonl`, then prints a hint suggesting
  the user remove the now-empty field from block.json. No hard
  error.
- **`feedback.jsonl` schema bumps.** Future readers handle any
  `schema:` value they know; reject unknown with a structured
  warning; never crash. Writers always emit current schema.
- **Old observe-ui builds.** The Blocks tab is additive; existing
  tabs are unchanged. A user on an older observe-ui pointing at
  a newer server gets the existing tabs working and the Blocks
  tab not visible — no break.
- **No `--writable` clients.** A user who never enables
  `--writable` is in the same product they had before slot 1
  shipped, plus the read-only Blocks tab. No upgrade pressure.

## Relationship to other designs

- **[DESIGN-0017](0017-serving-authored-context.md)** —
  introduces `sivru explain` block surfacing and the single-
  block drift diagnostics. This design consumes those
  diagnostics in the UI; no schema change.
- **[DESIGN-0019](0019-block-reliability.md)** — introduces the
  cross-block graph (consumed by slot 1), the autofix surface
  (consumed by slot 2), the diff-scoped flags (orthogonal),
  and the scaffolding (`block init`, slot 4 of 0019; the same
  serialize helper backs the slot 2 editor here).
- **[DESIGN-0005](0005-coach-loop-skill-drift.md)** — the
  Checkup tab and `mcp__sivru__checkup` infrastructure. Slot 1
  adds a "Block drift" section to Checkup that links into the
  Blocks tab.
- **[DESIGN-0006](0006-coach-loop-looped-on-error.md)** — the
  looped-on-error coach signal. This design ships the feedback
  channel DESIGN-0006 should consume: when an agent loops on a
  block-bearing file repeatedly, the feedback log shows whether
  the block was acknowledged-but-stale, false-positive-labeled,
  or fresh. DESIGN-0006's signal calibration uses
  `mcp__sivru__feedback_read` instead of intuition.
- **[DESIGN-0007](0007-coach-loop-low-context-edit.md)** — the
  low-context-edit coach signal. Same shape: when an agent
  edits a block-bearing symbol with low context, feedback says
  whether the block was actually load-bearing. The MCP write
  tools let the agent close diagnostics in-context rather than
  context-switching to the human triage UI.
- **Block reliability follow-on (DESIGN-002X TBD)** — the
  watchable `revisit-if` predicate. When that lands, the
  diagnostics it produces flow into the same triage inbox and
  feedback log; no new design.
