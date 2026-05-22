# DESIGN-0019: Comprehension surface in observe-ui — making the v0.4–v0.7 layer visible to humans

**Status:** Draft <!-- Draft → Accepted → Implemented → Superseded -->
**Class:** Spine (per [GOALS.md](../../GOALS.md))
**Targets:** v0.9.0–v0.10.0 (lands as the shell that v0.9 Checkup and v0.15 Map drop into; the four sub-views below ship over two release cycles)
**Issue:** filed when v0.9 becomes next release
**Created:** 2026-05-22
**Author:** @pochadri

## Thesis (the lens this design is evaluated under)

**In the AI coding world, every engineer needs to think like a
technical architect.** AI produces code at high velocity but without
the architect's mental model — invariants, decisions and their
lifetimes, why-this-not-that, blast radius. That mental model used
to live in senior heads. The lag between AI velocity and human
comprehension shows up as production incidents nobody can diagnose,
refactors nobody dares to start, and security audits whose blast
radius nobody understands.

Sivru's job is to close that gap by making architect-thinking
**durable** (it survives the senior leaving), **visible** (it shows
up in the place the work happens, not three doc systems away), and
**actionable** (it changes what an engineer does next).

Every sub-view in this design is named in user-facing copy by the
architect question it answers:

| Sub-view | Architect question |
|---|---|
| Lint | "Is your architectural intent well-formed?" |
| Coverage | "Where is architectural intent missing?" |
| Briefing | "What is the architect's view of this symbol?" |
| Drift | "Which architectural decisions need revisiting?" |

The four `@sivru` block fields exist to support this — `role` is the
symbol's place in the architecture; `responsibility` is its
contract; `invariants` are the assertions the type system cannot
enforce; `decisions[]` are the four-field `chose / because /
valid-while / revisit-if` quadruple, which IS architect-thinking
written down. The CLI / MCP / Comprehension tab are different
surfaces for the same underlying purpose: project the architect's
mental model into the place the next decision will be made.

## Problem

By v0.7 sivru produces three layers of code comprehension and serves
them all to agents via MCP:

- v0.4 — the skill: when to call sivru
- v0.5 — `sivru explain`: derived facts (public API, callers, callees,
  churn, ownership)
- v0.6 — `@sivru` annotation blocks: authored intent (role,
  invariants, decisions)
- v0.7 — those blocks served through `sivru.explain` and a drift
  detector that catches when they go stale

Today, an engineer reviewing a PR or onboarding to a module has none
of this. The agent gets it for free over the MCP channel. The human
has to: `cat` the file, read the `@sivru` block by hand, mentally
diff it against the code, then guess which callers a change would
break by greping. The very layer sivru built to help an editor make
a judgement call before editing is invisible to the editor's
operator.

The failure mode is concrete. A reviewer opens a 200-line diff that
touches a function with a five-line `@sivru` block describing a
deliberate architectural decision and its `revisit-if` condition.
The diff doesn't mention the block. The reviewer doesn't open the
file in another tab. The decision is silently overturned in review —
exactly the failure mode v0.6 was supposed to prevent, except that
v0.6 only helps the agent, not the human reviewing the agent's
work.

`@sivru/observe-ui` exists, but its tabs (Sessions / Replay / Costs /
Bench) all read agent SESSION behaviour. There is no codebase-side
view. v0.8 (DESIGN-0018) ships a separate hash-routed HTML
explainer for whole-repo onboarding; v0.9 (DESIGN-0005) ships a
Checkup tab for one coaching signal; v0.15 (DESIGN-0014) ships a
Map tab for activity heat. None of those make the existing v0.4–v0.7
comprehension layer routinely visible during day-to-day work.

This design is the shell that closes that gap. It does not duplicate
DESIGN-0018 (whole-repo HTML projection), DESIGN-0005 (Checkup
signal tab), or DESIGN-0014 (Map heat tab) — it adds a
**Comprehension** tab to observe-ui that makes the v0.4–v0.7 layer
visible inline, and it defines the shell architecture those three
future tabs slot into without each one re-solving the navigation,
file-resolver, and diagnostic-list primitives.

## Proposal

### 1. The shell — Comprehension tab in observe-ui

A fifth top-level tab alongside Sessions / Replay / Costs / Bench.
Internally it is a left-rail sub-nav (vertical, not horizontal —
the existing top nav stays the codebase-vs-session axis) with four
sub-views:

```
┌──────────────────────────────────────────────────────────────────┐
│  sivru / observe   sessions  replay  costs  bench [comprehension]│
├────────────┬─────────────────────────────────────────────────────┤
│ • Lint     │                                                     │
│ • Coverage │                  active sub-view                    │
│ • Briefing │                                                     │
│ • Drift    │                                                     │
└────────────┴─────────────────────────────────────────────────────┘
```

The four sub-views share three primitives extracted into
`packages/observe-ui/src/components/comprehension/`:

- **`FileBrowser`** — gitignore-aware tree rooted at the
  configured repo path; reuses the v0.2 walker output via a new
  observe-server endpoint (§3). Click semantics differ per sub-view
  (jump-to-symbol vs. open-diagnostic vs. open-briefing).
- **`SymbolPicker`** — file-scoped symbol list driven by the
  explain symbol index (v0.5). Shows kind (function / class / type),
  region range, and a small dot when the symbol has an `@sivru`
  block.
- **`DiagnosticList`** — uniform render of `BlockDiagnostic[]`
  (v0.6) plus the v0.7 drift diagnostics, grouped by severity, with
  click-to-jump file:line. Reused by Lint and Drift, and ready for
  the Coach loop signals (v0.9+) without further work.

The shell is otherwise the existing observe-ui tab. No new theme,
no new font, no new framework. Dark-mode only at v1 (matches v0.4
contract per DESIGN.md §6).

### 2. The four sub-views

**2.1 Lint — live block validation**

Runs `sivru block validate` over the repo (via the §3 endpoint) and
streams diagnostics into `DiagnosticList`. The header row shows the
totals from the v0.6 CLI banner (`N block(s); E error(s), W
warning(s)`) plus a "re-scan" button.

Why first: lowest-effort surface, highest-frequency value. Catches
the same diagnostics CI catches but before commit, so the
edit-validate-commit loop closes inside the UI. Direct dogfood of
the v0.6 CLI; no new data shape, no new dependency on v0.7.

**2.2 Coverage — authored coverage treemap**

A `d3-treemap` over the repo, sized by file LOC, coloured by block
density:

- green if the file has ≥1 valid `@sivru` block AND the block has
  decisions[] (deepest authored intent)
- light-green if the file has ≥1 valid block but no decisions[]
- yellow if the file has a block with diagnostics
- grey if the file has no block

Click a tile → opens the Briefing view for that file. Filters at
the top: by language, by maturity (the v0.6 `maturity` field —
finally a place where the four-value lock pays off visually), by
file age.

Why this answers a real question: "where is our captured intent
thin?" The answer is the grey area of the treemap. The repo's own
v0.6 dogfood is the first audience — we already know `@sivru/cli`
has cli-* role coverage but the chunker is mostly bare; the
treemap makes that obvious without scrolling 21 files.

**2.3 Briefing — pre-edit pane (3-pane)**

Three-pane layout: `FileBrowser` | `SymbolPicker` | rendered
explain artifact. The artifact pane is the same data the MCP
`sivru.explain` returns — but rendered for humans with the v0.6
`authored[]` section rendered FIRST (intent before mechanism, per
DESIGN-0017 §1) and the v0.5 derived sections (callers, callees,
churn, ownership) below.

The pane also supports a `?path=src/foo.ts&symbol=resolveRoute`
URL hash, so editor integrations (a one-line VS Code task, an emacs
function) can deep-link into the pane when a file is opened.
Deferred to v0.10.x: a file-watcher that auto-pops the briefing
when the configured editor saves a file.

This is where the v0.5 + v0.6 layers fuse for human consumption.
Same fusion DESIGN-0017 §1 specifies for the agent path, exact
same data, different render.

**2.4 Drift — decision drift queue (depends on v0.7)**

Lists every `decisions[].revisit-if` clause across the repo,
ordered by likelihood-of-stale signal from the v0.7 drift detector
(`SIVRU-E220 broken-collaborator`, `SIVRU-E221 stale-block`,
`SIVRU-E222 expired-decision`). Each row: symbol, the `chose`
clause, the `revisit-if` condition, the drift evidence, and two
buttons: **"still valid"** (writes a no-op acknowledgement into a
local audit log) and **"mark stale"** (drafts a PR-comment-ready
markdown fragment the engineer can drop into the next change).

Pre-v0.7: the sub-view renders the queue from `@sivru` blocks the
v0.6 extractor already produces, but the "evidence" column says
"v0.7 drift detector not yet shipped" for each row. This is
deliberate — the queue is useful even without drift evidence (it
surfaces every decision the engineer should periodically eyeball),
and shipping the empty-evidence column locks in the layout so v0.7
is a pure data-fill, not a UI change.

### 3. Data flow — new observe-server endpoints

The observe server (Hono, `packages/observe/src/server/`) gains
read-only endpoints scoped under `/api/comprehension/`:

```
GET  /api/comprehension/walk?root=<abs-path>        → WalkEntry[]
GET  /api/comprehension/extract-blocks?root=<path>  → ExtractedBlock[] (cached by mtime)
GET  /api/comprehension/explain?path=<rel>&symbol=  → ExplainArtifact
GET  /api/comprehension/drift?root=<abs-path>       → DriftReport[]  (v0.7)
POST /api/comprehension/audit                       → record still-valid / mark-stale events
```

These endpoints import from `@sivru/search`'s public surface — no
new dependency. The privacy boundary holds: `packages/observe/` is
still network-egress-zero (the egress test in
`observe/src/egress.test.ts` continues to enforce this); these are
INBOUND HTTP endpoints serving local-repo data, no outbound calls
introduced.

The audit endpoint writes to `<repo>/.sivru/audit.jsonl` (append-
only, one event per line). Honest-scope: the audit log is local
and per-developer; a shared team view is out of scope at v0.9 (it
needs auth + a backing store — both decisions for a later
release).

### 4. Module layout

```
packages/observe-ui/src/
  views/
    ComprehensionView.tsx               — top-level sub-router
    comprehension/
      LintView.tsx
      CoverageView.tsx
      BriefingView.tsx
      DriftView.tsx
  components/
    comprehension/
      FileBrowser.tsx
      SymbolPicker.tsx
      DiagnosticList.tsx
      Treemap.tsx                       — wraps d3-hierarchy
      ArtifactRenderer.tsx              — renders ExplainArtifact + authored[]
  api/
    comprehension.ts                    — typed client for the §3 endpoints

packages/observe/src/server/routes/
  comprehension.ts                      — Hono route module
```

### 5. Configuration — `.sivru/comprehension.json`

Project config beats user config beats defaults, same precedence as
v0.6's `.sivru/block.json` (DESIGN-0016 §6).

```jsonc
{
  "repoRoots": ["."],            // multi-root repos: list each
  "include": ["**/*"],           // pre-walk filter
  "exclude": [
    "**/dist/**",
    "**/node_modules/**",
    "**/__fixtures__/**"
  ],
  "treemap": {
    "minTileBytes": 200,         // hide files smaller than this
    "groupBy": "directory"       // "directory" | "language" | "package"
  },
  "drift": {                     // v0.7 drift-detector tunables
    "severityFloor": "warning"
  }
}
```

`maxFiles` is hardcoded at 50,000 (treemap performance ceiling); the
performance gate in §"Acceptance criteria" measures the 10k-file
case. Implementers must not add a `maxFiles` key — large-repo
handling lives in a separate design.

### 6. Performance gates

- **Treemap render:** ≤ 500 ms first paint on a 10k-file synthetic
  fixture, measured via React Profiler in `pnpm --filter
  @sivru/observe-ui test`. Beyond 10k files the UI shows a "binning
  recommended" banner (separate design).
- **Lint full-scan:** ≤ 3 s on the self-fixture corpus
  (`packages/`) — matches the v0.6 CLI cold-run.
- **Briefing artifact assembly:** ≤ 200 ms p95 per click (v0.5
  `assembleArtifact` is the bound).
- **Bundle size:** Comprehension tab adds ≤ 80 KB gzipped to the
  observe-ui dist. d3-hierarchy is the only new dep candidate; if
  it pushes over budget, ship a hand-rolled squarified treemap
  instead.

### 7. Threat model

- **Path traversal in the endpoints.** Reuses v0.5's
  `resolveAndAssertInside` (already in `@sivru/search/explain/path-
  validator.ts`) to guarantee any `path` arg resolves under the
  declared `repoRoot`. Same realpath check, same SIVRU-E2001 code.
- **Browser-side render of authored content.** `@sivru` blocks
  contain author-supplied YAML strings. The renderer treats every
  string as text (React's default escapes); no `dangerouslySetInner
  HTML`, no markdown render of block content at v0.9 (markdown
  render is a v0.10 follow-up with a sanitizer choice).
- **Audit log integrity.** `.sivru/audit.jsonl` is local and not
  authenticated; it is an aid to memory, not a system of record.
  Documented in the UI footer.
- **CSRF on POST audit.** Browser-only, same-origin; observe-server
  binds to 127.0.0.1 by default (DESIGN.md §5.5). A non-default
  `--host` widens this; the audit endpoint requires a
  `X-Sivru-Local` header that the UI sets and external POSTs
  cannot trivially forge.

## Alternatives considered

**A separate `sivru-codeview` app.** Ship the comprehension surface
as a standalone Vite app, not as tabs in observe-ui. Rejected:
duplicates the shell (banner, connection status, project switcher,
keyboard nav, dark theme), splits the user's mental model into two
URLs, and forces every future comprehension signal (Checkup, Map,
Coach loop) to choose between the two apps. observe-ui is already
the place engineers look when they want to see what their agent
session did; extending it is the lower-friction path.

**Per-release dashboards (one HTML per design).** Each new
comprehension layer ships its own static report (similar to the
v0.6 auto-ship QA report). Rejected: dashboards drift, and there is
no shared shell — every report re-solves nav + filter + theme.
Acceptable for one-shot reports (post-ship QA, release notes), not
for a recurring surface.

**v0.8 codebase explainer as the only human-facing UI.**
DESIGN-0018 already ships a hash-routed HTML projection. Rejected
as the SOLE surface: the explainer is a regenerated artifact, not a
live tool — it answers "show me the system" but cannot answer "show
me the lint diagnostics on my working tree" or "did this decision's
`revisit-if` just trigger." Live tooling and the regenerated
artifact serve different cycles; both ship.

**Render full markdown for authored fields.** Would let block
authors use **bold** and links in their `chose`/`because` fields.
Rejected at v0.9: introduces a sanitizer dependency (DOMPurify or
equivalent) and a new threat-model class. Plain text reads fine for
the field lengths involved (one sentence each); reconsider at v0.10
if author requests come in.

## Open questions

- **Multi-root repo handling.** `repoRoots: [...]` accepts an array,
  but the treemap, lint, and drift sub-views currently assume one
  root. Pin the v1 contract to single-root only and treat
  multi-root as v0.10.x. *Owner: @pochadri, by v0.9 design freeze.*
- **Audit log location.** `.sivru/audit.jsonl` next to
  `.sivru/block.json` is convenient but commits to git unless
  gitignored. Decide whether to gitignore by default (private to
  reviewer) or commit (shared team history with caveats).
  *Owner: @pochadri, by v0.9 design freeze.*
- **Editor deep-link contract.** Briefing accepts `?path=&symbol=`
  query params. What URL does VS Code / emacs / vim need to open
  this? A small reference task / function should ship with v0.9.
  *Owner: TBA after first user feedback.*
- **Pre-v0.7 drift sub-view.** Drift renders the queue but no
  evidence column pre-v0.7. Confirm with users this is more
  helpful than hiding the tab entirely. *Owner: @pochadri, by v0.9
  ship.*

## Acceptance criteria

- **Tab present:** observe-ui shows a fifth top-level tab,
  `comprehension`, that loads in <200 ms (no full re-render of the
  Sessions data on switch).
- **Lint sub-view:** scanning `packages/` (the self-fixture)
  produces the same 21 blocks / 0 errors / 0 warnings as the CLI;
  clicking a diagnostic opens the file at the right line (via
  editor-deep-link or browser tab to the file's HTML on a GitHub
  remote when configured).
- **Coverage sub-view:** treemap renders the self-fixture in
  <500 ms; the four colour bands are visually distinguishable; a
  click drills into Briefing.
- **Briefing sub-view:** for a symbol with a `@sivru` block, the
  artifact pane shows authored fields FIRST (`role`,
  `responsibility`, `invariants`, `decisions`), then derived
  sections in v0.5 order; for a symbol without a block, the
  "AUTHORED (no @sivru blocks attached)" message renders (matches
  the v0.6 CLI markdown render).
- **Drift sub-view:** lists every `decisions[]` with `revisit-if`
  across the repo, sorted by symbol name pre-v0.7; v0.7 wires in
  the severity sort; the audit log appends on click.
- **Endpoints:** all five `/api/comprehension/*` endpoints return
  in <200 ms p95 on the self-fixture; path-traversal regression
  test confirms `?path=../../etc/passwd` is rejected with
  SIVRU-E2001.
- **Privacy boundary:** `packages/observe/src/egress.test.ts`
  continues to pass; the new endpoints add no outbound network
  call.
- **Bundle gate:** observe-ui `dist/assets/*.js` grows by ≤ 80 KB
  gzipped vs. the pre-v0.9 baseline; CI gate fails the PR if it
  exceeds.
- **Dark-mode contract preserved:** no light-mode CSS introduced;
  every new component honours the existing `sivru-amber` /
  `sivru-border` / `sivru-mute` palette.

## Test plan

### Unit tests (vitest, jsdom)

- `FileBrowser`: 5–10 component tests covering tree expansion,
  keyboard nav (j/k), and gitignore filtering.
- `SymbolPicker`: kind-badge rendering, region-range display,
  authored-dot indicator.
- `DiagnosticList`: severity grouping, click-to-jump callback,
  empty-state copy.
- `Treemap`: snapshot of squarified layout on a 100-file synthetic
  input; colour-band assignment.
- `ArtifactRenderer`: authored-first ordering; the "no blocks"
  fallback; the v0.7 drift section is conditionally rendered when
  the artifact carries it.

### Integration tests

- `comprehension.ts` API client against a Hono test server: each of
  the five endpoints returns the documented shape; the path-
  traversal regression fires.
- Treemap stress: 10k-file synthetic fixture renders in <500 ms in
  the React Profiler.

### Manual verification

- Run `pnpm dev` against the sivru repo itself; confirm the four
  sub-views render the 21 dogfood blocks correctly.
- Briefing: open `packages/search/src/block/extract.ts` and confirm
  the `extractBlocks` symbol's authored fields render with the
  decisions[] array fully populated.
- Drift pre-v0.7: confirm the queue lists at least the decisions
  from the 21 dogfood blocks; "evidence" column reads "v0.7 drift
  detector not yet shipped".

### Performance gate

- Pre-v0.9 bundle baseline (gzipped): record from the latest main
  CI run. Post-v0.9 measurement: assert `(new - baseline) ≤ 80 KB`.
  Documented in CHANGELOG with measured number, not budget number.

## Customization shape

Per CONTRIBUTING.md three-layer rule:

1. **Built-in defaults** — config schema in §5 above; defaults
   defined in `packages/observe/src/server/config.ts`.
2. **Declarative override** —
   `~/.config/sivru/comprehension.json` (user) and
   `<repo>/.sivru/comprehension.json` (per-project, wins):
   `{ repoRoots, include, exclude, treemap, drift }`. Override-
   replaces-default for arrays (same as DESIGN-0016 E4).
3. **Code-level extension** — `.sivru/comprehension/*.tsx` registers
   custom DiagnosticList renderers (e.g., the Checkup tab's signals
   in v0.9 register here; the Map tab's heat layers in v0.15 register
   here). Interface lives in
   `packages/observe-ui/src/components/comprehension/types.ts`.

## Effort

| Item | Working days |
|---|---|
| Shell + tab + sub-nav | 1d |
| `FileBrowser` + `SymbolPicker` + `DiagnosticList` primitives | 2d |
| Lint sub-view + endpoint + tests | 1d |
| Coverage treemap + d3-hierarchy + tests | 2–3d |
| Briefing 3-pane + URL hash + ArtifactRenderer + tests | 2d |
| Drift sub-view (pre-v0.7 placeholder evidence) + audit endpoint | 2d |
| `comprehension.ts` typed API client | 0.5d |
| 5 `/api/comprehension/*` Hono routes + path-traversal regression | 1d |
| Performance gates (treemap stress + bundle gate) | 1d |
| Docs (README section + SKILL.md note) | 0.5d |
| **Total** | **~13–14 working days (~3 weeks)** |

Drift sub-view's v0.7 evidence column lands in v0.10 once DESIGN-
0017 ships; that is incremental work, not in this estimate.

## Worktree parallelization strategy

Two lanes after the shell + primitives land:

| Lane | Tasks | Module | Depends on |
|---|---|---|---|
| A | Lint + Drift sub-views + audit endpoint | `views/comprehension/{Lint,Drift}View.tsx` + `server/routes/comprehension.ts` | shell + DiagnosticList |
| B | Coverage + Briefing sub-views | `views/comprehension/{Coverage,Briefing}View.tsx` + Treemap + ArtifactRenderer | shell + FileBrowser + SymbolPicker |

**Conflict flag:** both lanes touch `comprehension.ts` (the typed
API client). Coordinate the type additions in one PR before the
lanes diverge.

## Forward-pointers

- **v0.9 Checkup tab (DESIGN-0005).** Should plug into the shell
  defined here as a SECOND comprehension sub-view (or as a sibling
  top-level tab, owner's call). The `DiagnosticList` primitive is
  the contract.
- **v0.15 Map view (DESIGN-0014).** Heat layers register as
  treemap overlays in the Coverage sub-view, OR as a new top-level
  tab — the `Treemap` primitive is the contract either way.
- **Editor deep-link.** Ship a one-line VS Code task and an emacs
  function in `docs/integrations/` once the URL hash contract is
  pinned (open question above).
- **Audit log shared view.** A team-shared view of "still-valid" /
  "mark-stale" events needs auth + backing store, deliberately out
  of scope at v0.9. Likely a v0.11+ design.

## Why this is the right shape

The thread tying v0.4 (skill) → v0.5 (explain) → v0.6 (blocks) →
v0.7 (serve + drift) is the architect-thinking thesis above. Each
release surfaced one layer of the architect's mental model. All
four gave that layer to the agent via MCP and to the CLI.

This design closes the same loop for humans. It does not introduce
a new comprehension primitive; it makes the four that already exist
routinely visible at the moment they pay off — code review, PR
authoring, onboarding, "should I touch this?" judgement calls.
It is the foundation v0.9 (Checkup) and v0.15 (Map) plug into, so
each later release ships one signal instead of one signal plus a
shell.

Carrying the thesis through means future designs (Checkup, Map,
coach loop) are evaluated by one question: **does this enable
architect-level thinking, or does it just make the user faster at
the wrong question?** A signal that fails that test gets re-shaped
or de-prioritised. The Comprehension tab is the surface where every
sub-view's answer to that question is also the sub-view's user-
facing name.
