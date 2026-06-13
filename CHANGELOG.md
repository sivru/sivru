# Changelog

All notable changes to sivru will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: pre-1.0 semver. Any breaking change in 0.x.y bumps `x`. Patches `y` are bug-fix only.
Breaking changes are prefixed `BREAKING:` per DESIGN.md §21.10.

## [0.14.0] — 2026-06-14

**Architectural diff + drift gate — the PR surface.** `sivru explain --project
--diff` builds the [`ExplainerModel`](docs/design/0018-codebase-explainer.md) at
a base ref and at HEAD, diffs them, and reports what the change did to the
architecture: new cross-module edges, new dependency cycles, and `@sivru`
authored-intent changes. With `--gate` it blocks the PR on the one signal worth
gating — a broken invariant→test linkage, the differentiated 10x from
[DESIGN-0022](docs/design/0022-explainer-reasoning-surface.md) Move 1.
Implements [DESIGN-0023](docs/design/0023-architectural-diff-gate.md);
deterministic, no LLM.

### Added

- **`sivru explain --project --diff [--base=<ref>] [--format=text|json|github]`**
  — the architectural delta of a change. The base model is built in a stable
  per-ref git worktree (advisory-locked, reuse-if-at-sha, prune-recovered) so it
  works on any repo — including a shallow CI clone. Impact-ordered output
  (cycles > new edges > block changes > nodes); an explicit "no architectural
  change" signal when the PR is structurally inert. `--format=github` emits a
  markdown PR-comment body with a hidden marker so CI updates one comment instead
  of spamming one per push (sivru emits; the workflow posts — credential-free).
  Exit `0` report / `2` could-not-evaluate (an unfetchable base is never a silent
  pass).
- **`--diff --html`** — the delta as a standalone, shareable page: the HEAD
  architecture map with the change overlaid (added/changed module boxes, new
  edges, the cycle's closing edge) plus a "What changed" digest. Every change is
  named with a text tag (NEW / CHG / DEL / ⟳ CYCLE) and a distinct border stroke,
  so color is never the only signal (WCAG 1.4.1).
- **Attention panel** on the HTML System page — modules and symbols ranked by
  `hotScore` (churn × coupling), the first place to read in an unfamiliar repo.
  `hotScore` is a new derived field on the model (pure computation, no new input).
- **`--gate`** — exit `1` on a gateable regression: a new dependency cycle, or a
  broken `@sivru` invariant→test linkage on a symbol the diff touched (reusing
  the [DESIGN-0019](docs/design/0019-block-reliability.md) enforcement resolver).
  Invariants with `enforced-by: null` are reported as **unguardable**, never
  silently passing and never gated. Ships with a `.sivru/gate-allowlist` escape
  hatch (one canonical, rotation-independent key per line); a suppressed finding
  is still reported. Exit `0` clean / all-suppressed, `1` fired, `2`
  could-not-evaluate — never a silent off.
- **Diff footprint + hot spots** — the `--diff` report (text / github / html) now
  shows where a large change actually landed: added modules/packages by name,
  added symbols bucketed by module, and the touched symbols ranked by `hotScore`
  ("this change landed on these high-traffic spots"), instead of collapsing the
  bulk into a single count.
- **Static health badges** on the HTML System page — `↻ in a cycle` for modules
  in a dependency cycle, `⚠ drift` for symbols whose `@sivru` linkage no longer
  resolves (drift you can see without a PR). Text-first (WCAG 1.4.1).
- **`--diff --html` map** shows the changed slice + its 1-hop neighbors on a
  multi-module repo, not the whole map.
- **Example PR workflow** at [`docs/examples/arch-delta.yml`](docs/examples/arch-delta.yml)
  — a report job (posts/updates one comment by the marker) + a gate job. sivru
  emits, CI posts (credential-free).

### Performance

- The drift check builds the whole-repo symbol map once and reuses it across all
  references (`createEnforcementResolver`), instead of rebuilding it per reference
  — important on CI, the gate's home.

## [0.13.0] — 2026-06-11

**Codebase explainer — the feedback loop (Slice 3: closing the loop).** The
explainer stops being read-only. A reader corrects authored intent right in the
HTML, exports a structured patch, and `sivru feedback apply` writes it back to
the `@sivru` block in source — so the correction lands where the truth lives and
the next `sivru explain` reflects it everywhere. Completes
[DESIGN-0018](docs/design/0018-codebase-explainer.md). Deterministic, no LLM
(per [DESIGN-0022](docs/design/0022-explainer-reasoning-surface.md)).

### Added

- **Feedback mode in the HTML explainer** — toggle it on, then:
  - **edit** an existing block field (role / responsibility / maturity /
    collaborators) inline;
  - **author** a new `@sivru` block on an un-annotated symbol (the "add intent"
    affordance) — apply inserts a minimal block above the declaration;
  - **suggest** the system narrative;
  - leave a **freeform note** (recorded to `.sivru/feedback-notes.md`).
  Annotations accumulate in `localStorage`; **Export** downloads a `patch.json`
  (stamped with git HEAD; each edit carries the block's content hash).
- **`sivru feedback apply <patch.json>`** — a distinct subcommand (not a flag on
  read-only `explain`). It edits the targeted field's line **in place**,
  preserving the comment prefix and every other byte (no whole-block re-emit, no
  canonicalization, no lost formatting). `--dry-run` shows the per-block diff;
  `--force` overrides the uncommitted-changes guard.
- **Safety throughout** (`SIVRU-E2012` for a bad patch). The patch is untrusted
  input, so: each edit is hash-gated and symbol-located — a changed block is
  **refused, never corrupted**; a `sourcePath` that escapes the repo root (`..`,
  absolute, or a symlink out) is **rejected** (lexical + realpath); a missing
  symbol/file is a **reported failure, never a silent drop**; a create whose
  `declLine` no longer holds the symbol is **refused** (creates aren't
  hash-gated, so they're guarded against a moved declaration); create inserts
  run bottom-up and edits re-extract after, so line ranges never shift; field
  values
  are YAML-quoted (colons, control chars, number/bool-looking strings) so a value
  can't break the block; EOL is preserved; `--dry-run` writes nothing anywhere;
  the uncommitted-changes guard runs `git -C <repo>` (correct under `--repo`);
  nonzero exit if any edit is refused (CI-gateable).
- **Narrative feedback** → `.sivru/explainer.md` (the source the projection
  prefers); **freeform notes** → `.sivru/feedback-notes.md` (recorded for a
  human, never auto-applied).
- The `ExplainerModel` carries per-node `blockHash` + `declLine` and a top-level
  `head` (the patch stamps). The shareable HTML embeds the repo **basename**, not
  the author's absolute path.

### Deferred (DESIGN-0018 follow-ups)

- Editing multi-line invariants/decisions and list add/remove (line-count-
  changing edits); adding a field that isn't present yet; authoring blocks in
  Python (docstrings) and other non-C-like languages. The v1 edit ops are all
  single-line replacements; create inserts a fresh `/** … */` block.

## [0.12.0] — 2026-06-10

**Codebase explainer — `sivru explain --html` (Slice 2: the UI).** Renders the
Slice-1 model into a single self-contained HTML file you can open offline,
email, or commit to a wiki — hash-routed drill-down across System → Module →
Package → Symbol, three inline-SVG diagrams, and client-side search, with
**zero external assets**. Implements [DESIGN-0018](docs/design/0018-codebase-explainer.md),
Slice 2 (design + eng reviewed).

### Added

- **`sivru explain --html [--out <path>]`** — writes `./sivru-explainer.html`
  (gitignored) by default. The whole UI is **pre-rendered in TypeScript** (SSR);
  the browser ships a ~50-line vanilla nav shim (no bundler, no library, no
  framework). All layout, escaping, and routing logic is typechecked and
  unit-tested.
- **Architecture-first System page**: a **layered system map** — modules placed
  in dependency layers (foundation on the left, consumers to the right), boxes
  sized by symbol count, with the foundation module named in a one-line
  overview. The repo narrative renders as **Markdown** in a collapsed
  "About this system" disclosure below the structure, never a raw-text wall.
- **Three inline-SVG diagrams**, all hand-rolled and deterministic (same model →
  identical SVG): the layered architecture map (boxes link to module pages), a
  sorted **churn bar** per module, and a per-symbol radial **collaborator
  graph** whose radius grows with neighbour count and whose labels are
  angle-anchored so they don't collide.
- **Empty states as authoring prompts** — a symbol with no `@sivru` block shows
  its derived facts plus a paste-able annotation stub ("add intent"); a repo
  with no narrative gets an "add `.sivru/explainer.md`" card. On the sivru repo
  that surfaces 400 gentle nudges toward authored context.
- **Post-build self-verify** (`SIVRU-E2011`): the generator walks every route,
  asserts zero dead internal links and zero missing views, and **refuses to
  write a broken file**. Also runs as a vitest test.
- **XSS-safe**: every repo-derived string is HTML-escaped; the inlined model
  JSON island escapes `<` so a symbol or block-prose containing `</script>`
  cannot break out.
- Dark theme mirroring the `observe-ui` tokens; keyboard-navigable
  (`/` focuses search); mobile sidebar drawer.

### Deferred (Slice 3, tracked in DESIGN-0018)

- The feedback loop — annotate a section in place → export a patch → apply it to
  the `@sivru` block / `.sivru/explainer.md` the section was projected from.

## [0.11.0] — 2026-06-10

**Codebase explainer — `sivru explain --project` (Slice 1: the model).**
A whole-repo projection: `sivru explain --project` walks the repo and emits a
four-level model — System → Module → Package → Symbol — as JSON, fusing the
facts sivru already derives (public API, resolved imports, churn,
module/package dependency edges, per-symbol collaborators) with the authored
`@sivru` blocks on each symbol. It is the agent-consumable foundation the
HTML projection (Slice 2) and the feedback loop (Slice 3) will render from.
Implements [DESIGN-0018](docs/design/0018-codebase-explainer.md), Slice 1.

### Added

- **`sivru explain --project`** — emits the `ExplainerModel` (a generic
  recursive `ExplainerNode` typed by level) for the whole repo. A monorepo's
  workspace packages become modules and their `src/` subdirs become packages;
  a single-package repo collapses module/package onto one node. Symbol pages
  are capped to load-bearing symbols (a public export OR an `@sivru` block),
  so the model stays navigable rather than listing every function.
- **Cross-module dependency edges** derived from package-name imports
  (`@sivru/search`), which the file-level resolver leaves unresolved —
  so the module dependency graph is populated, not empty.
- **`computeStateId`-keyed model cache** (`~/.cache/sivru/explainer-models/`,
  atomic write). Built from one symbol-index pass + the index's batched churn
  + `@sivru` extraction (gated behind an `@sivru` substring so the vast
  majority of files skip the tree-sitter parse, and run with bounded
  concurrency) — NOT a per-file `assembleArtifact` loop. On the sivru repo:
  ~3.5s cold, ~1.6s warm, ~0.3s on a model-cache hit, with the cached output
  byte-identical to a fresh build.
- **Works on a brand-new repo.** `--project` on a fresh `git init` with no
  commits builds a churn-0 model rather than crashing (churn lookup is
  best-effort).

### Deferred (later slices, tracked in DESIGN-0018)

- `--html` self-contained projection (hash routing, inline-SVG diagrams,
  search, self-verify route walk) — Slice 2, with a `/plan-design-review`.
- Feedback loop (annotate → patch → apply to `@sivru` blocks /
  `.sivru/explainer.md`) — Slice 3.
- An MCP `explain_project` tool — the CLI JSON is consumable today; the MCP
  surface lands when an agent flow needs it.

## [0.10.1] — 2026-06-07

**Windows path portability.** `sivru block check-enforcement` /
`mcp__sivru__checkup` silently produced wrong results on Windows: an
`enforced-by` reference to an absolute test path was treated as relative
(its absolute check was `path.startsWith("/")`, which is false for a
`C:\…` Windows path), so the file was looked up under the wrong location
and reported as missing — a false `SIVRU-E231`. sivru targets coding
agents, many of which run on Windows, so this was real user-facing
breakage.

### Fixed

Three production Windows bugs, plus a sweep of Windows-fragile test
assertions that had left the Windows CI leg red since before v0.9.0:

- **`resolveFileAnchored` (block enforcement)** now uses
  `node:path`'s `isAbsolute` + `resolve` instead of a `/`-prefix check and
  hand-rolled string concatenation, so absolute and relative `enforced-by`
  paths resolve correctly on Windows as well as POSIX.
- **`relativizePath` (ground-truth)** emitted native `\` separators on
  Windows (`src\auth\login.ts`), leaking into ground-truth keys that are
  meant to be stable POSIX-relative paths. Now POSIX-normalized.
- **`sivru doctor`'s pnpm check** reported "pnpm not found" on Windows even
  when pnpm was installed: the launcher is `pnpm.cmd`, which bare `execFile`
  can't resolve. `runCmd` gained an opt-in `shell` flag (default off, so the
  coach's path-bearing git calls are untouched) that the pnpm probe uses on
  Windows.
- **CI is green on Windows again.** The remaining breakage was
  Windows-fragile *test* assertions:
  - `@sivru/search`: `mkRepo` in `authored.test.ts` / `block.test.ts` built
    parent dirs with a `/`-only regex (creating the file path as a directory
    → `EISDIR`); `artifact.test.ts` mocked `fileExists` with a posix-slash
    suffix the native `absPath` never matched; `enforcement.test.ts` embedded
    absolute paths with backslashes inside YAML double-quotes (where `\…` is
    an escape). Now `dirname` / `basename` / forward-slash-normalized.
  - `@sivru/observe`: `blocks.test.ts` asserted POSIX path literals against
    native-separator output; `server.test.ts` stubbed only `HOME` (Windows
    `os.homedir()` reads `USERPROFILE`); `git-info.test.ts` compared 8.3
    short paths (`RUNNER~1`) to git's long form and flaked on an `EBUSY`
    rmdir. Now platform-resolved expectations, both home vars stubbed,
    realpath'd scratch dirs, and `rmSync` retries.
  - `@sivru/cli`: parseArgs tests (explain / checkup / bench-personal /
    block) asserted POSIX path literals against `resolve()`d native output;
    `bench-history` / `skill` tests stubbed only `HOME`. Now `resolve()` /
    `isAbsolute()` and both home vars stubbed. A repo-root `.gitattributes`
    forces `eol=lf` so Windows checkouts don't break the byte-exact
    bundled-`SKILL.md` comparison in `sivru skill install`.

## [0.10.0] — 2026-06-05

**Serving authored context — `explain` now leads with intent.**
`sivru explain` and `mcp__sivru__explain` surface the `@sivru` block on
each symbol *before* the derived facts, so an agent reads why the code is
shaped this way — and when that reasoning expires — before it reads what
the code mechanically is. The block extraction shipped in v0.6; this is
the release that makes it readable. Implements
[DESIGN-0017](docs/design/0017-serving-authored-context.md) at
surface-only scope (the eng review reconciled Part 2 against the drift
machinery DESIGN-0019 already shipped).

### Added

- **`AUTHORED CONTEXT` section in `sivru explain`** — full per-symbol
  render of the `@sivru` block: role, responsibility, invariants (with
  their `enforced-by` reference), time-bounded decisions (`chose` /
  `because` / `valid-while` / `revisit-if`), maturity, and collaborators.
  Rendered first, before `PUBLIC API` — intent before mechanism. The
  `--json` path already carried the structured `authored[].block`; the
  `explain` MCP tool description now names authored context.
- **`BLOCKS HEALTH` section + `artifact.blocks_health`** — lint
  diagnostics for the target file's blocks, computed from the same single
  extraction. Surfaces the full `validateBlock` diagnostic set
  (missing-required, enforcement-unset, …) **including diagnostics on
  blocks that failed to parse**, which the authored render omits — so a
  broken block surfaces instead of silently vanishing. Quiet by design:
  a clean note when blocks have no issues, omitted entirely for blockless
  files. The markdown render caps at 20 diagnostics (the full set is always
  in `--json` and `sivru block validate`) so health never buries the
  derived-fact sections it now renders above. Points to `sivru block
  staleness` / `graph` for diff-scoped git drift (kept in the dedicated
  commands, not run inline).
- **SKILL.md** — the `sivru explain` and `@sivru`-authoring sections now
  teach the agent that `explain` hands back authored context, and codify
  the rule: if your edit alters a symbol's contract or invalidates a
  decision, update its block in the same edit.
- **`countSeverities` (`@sivru/search`) + `formatDiagnostic` (CLI lib)** —
  shared helpers consolidating the error/warning split and the diagnostic
  line renderer that were duplicated across the `sivru block` subcommands
  and the new explain surface. `formatDiagnostic` carries two explicit
  styles (`path-prefixed` for multi-file block listings, `code-first` for
  the single-file explain section).

### Fixed

- **Annotated symbols were dropped from the explain symbol index.** An
  exported (TS/JS) or public (Java) symbol whose declaration sat behind an
  `@sivru` doc-comment was missing from `explain`'s `PUBLIC API`, and
  region-level explain (`path::symbol`) on it failed with `SIVRU-E2004` —
  i.e. you could not drill into exactly the symbols that carry authored
  intent. Cause: the export/visibility resolvers tested the keyword
  (`export` / `public`) against a fixed 3–5 line head window, and a
  multi-line `@sivru` block pushed the declaration past it. A shared
  `codeHead()` now skips the leading comment carrier first; it also fixes
  the signature line (was showing `/**`). Found during DESIGN-0017 QA;
  pre-existing (DESIGN-0016 era). Regression tests added for TS + Java +
  the helper.

### Deferred (tracked, block-reliability follow-on)

- `broken-collaborator` (resolve `collaborators` against the v0.2 symbol
  index) — DESIGN-0019's E235 rename-suspect covers the common case.
- `expired-decision` — opt-in/off by design; needs a `DecisionChecker`
  evaluator (the type stub exists).

## [0.9.0] — 2026-06-04

**Authored-context UI — slot 2 (the write surface).** `sivru observe
--writable` turns the read-only Blocks tab into a full lifecycle surface:
fix a YAML trap, acknowledge an intentional finding, mark a false
positive, or edit a block through a form — from the UI or, symmetrically,
from an agent via four new MCP tools. The whole BuildWright triage loop
(12 findings → 4 real) now runs without dropping to the CLI. Slot 2 of
[DESIGN-0021](docs/design/0021-authored-context-ui.md).

### Added

- **`sivru observe --writable`** (default off; loopback-bind only — it
  errors if combined with a non-loopback `--host`). Boots with a loud
  WRITABLE banner; `/api/health` reports `writable`. Read-only otherwise,
  with every write affordance hidden behind a banner.
- **Mutation routes** — `POST /api/blocks/autofix | /edit | /acknowledge`
  and `POST /api/feedback` (405 when not writable), plus `GET
  /api/feedback` (always readable). Guarded by `hono/csrf` + a
  localhost-Origin check; every `filePath` is normalized and rejects
  traversal; edits use a detect-and-409 mtime check (last-write-wins, no
  file locks) and an atomic temp+rename write.
- **Block editor** — a form (not a raw textarea) over a block's YAML, with
  collapsible groups, a dirty-state pill, Save/Discard + `Cmd/Ctrl+S`, and
  a 409 "file changed — reload" flow. Rewrites only the bytes inside the
  `@sivru … @end` fence, preserving comment framing (`/** */`, `//`, `#`).
- **Four agent MCP tools** — `mcp__sivru__block_autofix`,
  `block_acknowledge`, `feedback_append` (writable-gated via `sivru mcp
  --writable`), and `feedback_read` (ungated). They call the exact same
  shared handlers the HTTP routes use, and return a structured error
  envelope (`SIVRU-WRITABLE-DISABLED` / `-FILE-CHANGED` / `-PATH-OUTSIDE-
  ROOT` / …) with a `retryable` flag.
- **`.sivru/feedback.jsonl` + `.sivru/acknowledgments.jsonl`** (append-only,
  git-trackable, malformed-line-tolerant) and a per-day
  `.sivru/audit/YYYY-MM-DD.jsonl` write log (7-day retention sweep). A
  one-time migration lifts any legacy `block.json` `acknowledged[]` into
  the new file. `sivru observe init` documents the recommended git policy.
- **`/api/metrics`** (Prometheus text) and **`pnpm bench feedback`**
  (per-diagnostic precision against the repo's labeled set —
  repo-local tuning data, not a generalizable benchmark).
- **`serializeBlock`** in `@sivru/search` (the inverse of extraction;
  shared by the scaffolder and the editor).

---

**Authored-context UI — slot 1 (read-only Blocks tab).** Promotes
`@sivru` blocks from a CLI-only surface to a first-class lifecycle view
in observe-ui. The block graph, its diagnostics, and the authored
context behind every block are now something you look at, not 200-edge
JSON you grep. Slot 1 of
[DESIGN-0021](docs/design/0021-authored-context-ui.md); the write
surface (editing, acknowledge/feedback, agent MCP tools) lands in slot 2
behind `--writable`.

### Added

- **Blocks tab in observe-ui.** Two sub-views over a repo's block graph:
  **Issues** (the default — a triage inbox grouping every diagnostic by
  code, error-before-warning, with per-row *Open in editor* and *Copy
  CLI fix*) and **Graph** (an in-house force-directed render — no
  d3/cytoscape dependency). Edges carry two independent, colorblind-safe
  encodings: reciprocity (solid/thick vs dashed) and severity
  (broken-collaborator red, rename-suspect amber, asymmetric uncolored).
  A right-pane inspector shows the selected block's role, responsibility,
  invariants, decisions, collaborators, and attached diagnostics.
  Keyboard: `I`/`G` switch sub-view, `J`/`K` walk nodes, `/` filters,
  `Esc` deselects.
- **`GET /api/blocks`, `GET /api/blocks/:filePath/:symbol`,
  `GET /api/blocks/stream`** — read-only block graph + single-block
  detail + an `fs.watch`-backed SSE channel that surfaces external CLI
  `--autofix` writes as `block.updated` events. `rootPath` safety mirrors
  `/api/checkup` (absolute + homedir-or-git containment); `filePath`
  arguments are normalized and reject traversal.
- **Block-aware Replay + Checkup.** Replay gains a *Blocks touched* lane
  (blocks sitting on files the agent edited this session); Checkup gains
  a *Block drift* section (E233/E234/E235/E236 counts) with an *Open in
  Blocks tab* link.
- **`pnpm --filter @sivru/benchmarks bench:block-ui`** — perf benchmark
  over a generated 500-block fixture for the `/api/blocks` engine path
  (cold/warm graph build + per-file re-extract) against the
  DESIGN-0021 targets.

### Notes

- observe-ui takes a (type-only) workspace dependency on `@sivru/search`
  so block types have a single source of truth; the import is erased at
  build (bundle stays ~72 kB gzip). `packages/observe` consumes
  `@sivru/search`'s pure-filesystem block surface only — the privacy
  boundary (no network egress) holds and its enforcement test stays
  green.

## [0.8.0] — 2026-05-27

**Block reliability — slots 1 through 4.** Turns `@sivru` blocks from
prose into something the tool can actually verify. Invariants now
carry an `enforced-by` reference; broken blocks surface as
diagnostics instead of silent drift; the chunker accepts Java
records, enums, sealed types, and `package-info.java` as block
hosts. One release, every slot from
[DESIGN-0019](docs/design/0019-block-reliability.md) except Rust
(deferred — adds a tree-sitter grammar dependency that needs its
own discussion).

### Added

- **`@sivru` invariant object form.** Invariants accept either the
  legacy bare-string shape or `{ rule, enforced-by }`. The new
  form names a test that proves the invariant — symbol form
  (`Class.method`) or file-anchored form (`path::test name`).
  Schema stays at `1`; bare-string form is grandfathered.
- **`sivru block check-enforcement [path]`** — walks every
  `enforced-by` reference and emits SIVRU-E230 (missing test),
  SIVRU-E231 (test exists but is skipped), or SIVRU-E232
  (`enforced-by: null` declared but not yet written, default
  warning). Skip detection covers vitest/jest (`it.skip`, `xit`,
  `test.skip`, `describe.skip`), JUnit (`@Disabled`/`@Ignore`),
  pytest (`@pytest.mark.skip`), and Go (`t.Skip()` /
  `t.SkipNow()` scoped to the test body, not textual).
- **`sivru block validate path1 path2 path3`** — accepts multiple
  positional paths, walks all of them, exits with the worst
  diagnostic across the set.
- **`--changed-since=<ref>`** on `validate`, `check-enforcement`,
  `check-bridges`, and `graph` — filters the walked file set to
  `git diff --name-only <ref>...HEAD`. Multi-path + `--changed-since`
  is rejected at parse time (the git diff is per-repo;
  cross-repo silently filters wrong).
- **`sivru block validate --autofix`** — rewrites SIVRU-E237
  (yaml-colon-in-prose) and SIVRU-E238 (yaml-quote-context) lines
  in place. Refuses files with uncommitted changes unless
  `--allow-dirty` is passed; refuses values containing embedded
  `"` that would need escape rewriting. Idempotent.
- **SIVRU-E237 yaml-colon-in-prose** — surfaces the silent-drift
  case where `- tx: REQUIRES_NEW per-row…` parses as a YAML
  mapping instead of a prose string. Diagnostic location points
  at the trapped line, not the whole block.
- **SIVRU-E238 yaml-quote-context** — wraps js-yaml errors when
  the failing line carries unbalanced apostrophes around an
  identifier-like token (`'this.commit()'`).
- **SIVRU-E213 maturity-invalid** — now carries a Levenshtein
  "did you mean" suggestion (`maturity: beta` →
  `did you mean experimental?`). Distance cap 3 prevents noise.
- **`sivru block staleness --since=<ref>`** — SIVRU-E233
  block-likely-stale. Reports blocks whose body is byte-identical
  but whose surrounding code changed since `<ref>`. `--strict`
  exits non-zero; `--json` for tooling. Cache opt-in via the new
  `BlockCache` shape (HEAD-side parse cost amortised when callers
  pre-build it).
- **`sivru block graph --check`** — cross-block consistency:
  SIVRU-E234 (asymmetric collaborator), SIVRU-E235 (rename-suspect,
  requires unique back-reference evidence — no fan-in
  false-positives), SIVRU-E236 (ordering contradiction, opt-in via
  `.sivru/block.json` `graph.orderingChecks`). `graph --json`
  emits the raw graph for downstream tooling.
- **`sivru block init <file>`** — scaffolds a starter `@sivru`
  block from imports + doc-comment first sentence + role
  heuristics. `--write` inserts above the declaration (or as a
  docstring for Python). `--symbol=<name>` targets a specific
  declaration; `--force` overwrites existing blocks.
  Responsibility carries an `auto-generated, replace` marker so
  reviewers catch the auto-pull. Generated via `js-yaml.dump` —
  no quote-injection risk from doc comments containing `"`.
- **`sivru block check-bridges`** — SIVRU-E239 bridge-suggestion
  (warning) and SIVRU-E260 deprecated-maturity-mismatch (error /
  warning per direction). Java seed catalog (8 markers:
  `@ApplicationScoped`, `@Singleton`, `@RequestScoped`,
  `@Transactional`, `@Filter`, `@Audited`, `@SecurityChecked`,
  `@Retryable`). Python seed catalog (4 decorators). E260 fires
  for Java, Python, TS/JS/TSX/JSX, and Go.
- **Java slot-4 carriers** — `record` declarations, `enum`
  (including nested-in-class), sealed interfaces/classes,
  `@interface` annotation types, and `package-info.java`
  (module-level locator) all host their own blocks. TS gains
  `enum_declaration` and `abstract_class_declaration`. Go gains
  top-level `var_declaration` and `const_declaration`.
- **Per-language `maxLines`** — `.sivru/block.json` accepts the
  object form (`{ default: 25, java: 40, python: 30, ... }`).
  Single-number form remains valid as v0.6 shorthand. Java's
  default is bumped to 40 to fit invariant-heavy JavaDoc style.
- **Code-level extension API** — three new interface types:
  `EnforcementResolver`, `DecisionChecker`, `BlockGraphRule`.
  Layer-3 `.sivru/block/*.ts` extension authors can now compile
  against a stable contract; registry consumers ship in a
  follow-on.

### Changed

- **`SivruBlockJSON` adds `invariantsV2`** alongside the existing
  `invariants: string[]`. The string-array form preserves the
  v0.6 wire contract for downstream consumers (DESIGN-0017
  explain artifact, MCP, anything reading `block extract --json`).
  New consumers that want `enforced-by` read `invariantsV2`.
- **`SivruBlockConfig`** gains `enforcement`, `diff`, `graph`,
  `bridges`. `decisions` and `generated` are reserved (no v0.8
  consumer; DESIGN-002X and §11 follow-on).
- **`SymbolIndexEntry.blocks?: BlockCacheEntry[]`** — per-file
  block range + content hash cache. Optional so existing
  consumers and test fixtures stay compatible. Populated by the
  new `buildBlockCache(filePaths)` helper.
- **Self-dogfood:** every existing `@sivru` block in
  `packages/search/` with an invariant was migrated from
  bare-string to object form with `enforced-by: null` (33
  invariants across 17 files). `block check-enforcement
  packages/search/` reports 0 errors, satisfying the
  slot-1 acceptance gate.

### Fixed

- **Stable content hash for the block cache.** Earlier sketches
  used `JSON.stringify(block)` directly — insertion-order
  semantics meant a tiny parser refactor would silently
  invalidate every cached hash. The new `hashBlockContent`
  recursively sorts keys before stringifying, preserving array
  order (which carries authorial intent).
- **Go skip detection scoped to the function body.** Was a
  textual `/\bt\.Skip\(/` scan that false-positived on comments
  and sub-tests; now walks the body for an actual
  `call_expression` whose callee is `t.Skip` or `t.SkipNow`.
- **`graph.ts` E235 rename-suspect requires unique evidence.**
  Earlier draft fired on every fan-in pattern; now demands
  exactly one back-reference candidate.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## [0.7.0] — 2026-05-25

**Coach loop v1 — skill drift.** Three deterministic, descriptive checks
that surface drift in Claude Code memory files (`CLAUDE.md`, every
`SKILL.md`, every agent file) against the current state of the repo. The
checks render the fact, never a judgment — "your CLAUDE.md is 130 days
old, 487 commits behind HEAD" — and the user decides whether the file
needs attention. Library + CLI + MCP + HTTP route + observe-ui Checkup
tab ship together. See
[DESIGN-0005](docs/design/0005-coach-loop-skill-drift.md).

### Added

- **`@sivru/observe/coach` library entry**:
  `runCheckup(repoRoot, opts): Promise<CheckupReport>`. Schema version
  pinned to `1`. Returns every memory file considered, every finding,
  the resolved config (echoed back), and any infrastructure
  diagnostics (e.g. `SIVRU-E244` git unavailable).
- **Three built-in checks**:
  - `memory-claude-age` (default `info`) — fires when a file is
    BOTH ≥ 90 days old AND ≥ 50 commits behind HEAD; mtime fallback
    when git is unavailable. **D6a delight:** the finding's summary
    appends a one-line "Biggest changes since: <segment> (N files),
    …" preview when `git diff --name-only --diff-filter=AMD
    <last-commit>..HEAD` succeeds.
  - `memory-dead-reference` (default `warning`) — flags inline-code
    path mentions inside memory files that don't resolve on disk
    today. Filters by "path-separator OR known extension" so bare
    identifiers / npm packages stay out (mostly). Skips fenced code
    blocks per CommonMark §4.3 + §4.4. **D6b delight:** when a
    matching rename is found in the file's git history (the
    deletion commit's `git show --name-status` carries an `R<score>`
    line with `<score> >= 90`), the finding appends "May have been
    renamed to `<target>` in commit `<sha>`."
  - `memory-skill-tools-drift` (default `warning`) — validates
    `tools:` entries in SKILL.md and agent-file YAML front-matter
    against the documented Claude Code built-in tool set (pinned
    in `known-tools.ts` with a `LAST_VERIFIED:` header asserted by
    CI) plus discoverable subagent names from `.claude/agents/`.
- **CLI:** `sivru checkup [path] [--json] [--check <id>] [--no-git]`
  in `packages/cli/src/commands/checkup.ts`. Defaults `path` to cwd.
  Exit codes: 0 on findings (descriptive only — not an error); 1 on
  config-malformed (`SIVRU-E240`) or path-missing (`SIVRU-E241`).
- **MCP:** `checkup` tool registered in the stdio MCP server. Args:
  `{ path?: string, noGit?: boolean, check?: string[] }`. Returns
  the `CheckupReport` JSON shape.
- **HTTP:** `GET /api/checkup?path=<absolute>` on the observe Hono
  app. Path safety: must be (a) absolute, (b) an existing directory,
  AND (c) contained under `homedir()` OR a git working tree. Falls
  back to homedir-only containment when the server's git binary is
  missing — surfaces a `SIVRU-E244` info diagnostic in the response.
  Reuses the existing localhost-only CORS.
- **observe-ui Checkup tab** between Sessions and Replay (tab order:
  Sessions / Checkup / Replay / Costs / Bench). Reads
  `selectedProject` from App state (sidebar filter), falls back to
  the most-recent session's `projectRoot` when null. Findings table
  groups by file with severity-descending sort within each file
  (errors → warnings → info, design-D1). Files-without-findings
  collapse to a disclosure at the bottom; unreadable files render
  italic with a "Skipped: cannot read" badge.
- **Three-layer config** (`packages/observe/src/coach/config.ts`):
  built-in defaults → user-global `~/.config/sivru/checkup.json` →
  project `<repoRoot>/.sivru/checkup.json` (wins). Schema:
  `{ ageDays, ageCommits, disabled, severityOverrides, skipPaths,
  pathExtensions }`. `pathExtensions` is override-replaces-default
  (matches v0.6 `maturityValues` precedent); `disabled` and
  `severityOverrides` merge additively.
- **Stub deletion:** `packages/cli/src/lib/memory-audit/types.ts`
  removed (superseded by the new module; nothing imported it).
- **Shared exec wrapper** at `packages/observe/src/coach/exec.ts`
  (per eng-review A3). `packages/cli/src/commands/doctor.ts` now
  consumes it through a thin compat adapter; the duplication never
  landed.

### Diagnostic codes (DESIGN-0005 §4)

- `SIVRU-E240` `checkup-config-malformed` — error, blocks the run.
- `SIVRU-E241` `checkup-path-missing` — error, blocks the run.
- `SIVRU-E242` `checkup-file-too-large` — warning; file scanned to
  the first 200KB only.
- `SIVRU-E244` `checkup-git-unavailable` — info; mtime-only mode.
- `SIVRU-E245` `checkup-path-unsafe` — error; HTTP route rejects.
- `SIVRU-E243` reserved for a future coach-loop release's dynamic
  `.sivru/checkup/*.ts` loader (deferred from v0.7 entirely per the
  customization shape).

### Privacy

- The new `coach/` module is covered by the existing
  `packages/observe/src/egress.test.ts` static + runtime checks: no
  `fetch` / `node:http` / `node:https` / `node:net` / `node:tls` /
  `undici` imports. `node:child_process` is allowed for the
  `git`-shell-out path (local IO, not network egress); a new test
  asserts this is the only sub-process boundary.

### Known false-positive patterns (deferred to v0.7.x)

The `memory-dead-reference` check's "path-shape" filter follows the
design's spec literally (DESIGN-0005 §3b: `path separator OR known
extension`). Dogfooding this repo surfaced several real-world
patterns that match the filter but aren't file paths:

- Scoped npm packages (`@scope/package`).
- GitHub Action refs (`pnpm/action-setup@v4`).
- Slash-command names from gstack-style skills (`/freeze`,
  `/sync-gbrain`).
- Pattern strings (`.test.ts`).
- Directory references with trailing `/` (`src/commands/`).

The design's < 10% FP-rate gate is meant to catch this — an honest
real-world FP corpus is in scope per D7 but **NOT included in v0.7.0**
(see "Deferred" below). A v0.7.x point release will tighten the
filter once the FP-corpus exists to measure against.

### Deferred

- **FP-rate corpus** — DESIGN-0005 §Test plan requires 10–20
  anonymized real-world OSS memory files with per-span labels and
  per-file `attribution.md`. v0.7.0 ships without this; it requires
  manual judgment (which OSS repos? what counts as "personal info"?
  is partial anonymization honest?) that a single autonomous run
  couldn't credibly produce. **Tracked as a v0.7.x follow-up.**
- **Performance gate measurement.** Design asks for a measured
  number on this repo (< 200ms p95) + a 50-file fixture (< 1s).
  v0.7.0 demonstrates the library works end-to-end on this repo
  (51 memory files, ~800ms with both git delights enabled), but
  the formal perf gate with a 50-file synthesized fixture is a
  v0.7.x follow-up.
- **observe-ui browser smoke test.** The Checkup tab ships with
  logic-only unit tests for `groupFindings`. A React-mount smoke
  test against a mocked `/api/checkup` is deferred — observe-ui
  does not declare `@testing-library/react`, and CLAUDE.md forbids
  adding dependencies without explicit approval. Manual browser
  verification needed before promoting to a stable release.
- **Repo-mixed and repo-rename fixture repos.** The integration
  test in `coach/index.test.ts` covers the same paths through
  seeded temp git repos; standalone fixtures are a v0.7.x add.

## [0.6.0] — 2026-05-22

`@sivru` annotation blocks — small, structured, language-neutral blocks of
authored context carried inside whatever doc-comment syntax the host language
already uses. Attached to a symbol or to a module via the language's
convention. See [DESIGN-0016](docs/design/0016-sivru-annotation-blocks.md).

### Added

- **Block module** in `@sivru/search/block/`: `extractBlocks(path)`,
  `validateBlock(block, ctx)`, `validateExtracted(blocks)`, `blockToJSON(block)`,
  `loadBlockConfig(repoRoot?)`. Per-symbol blocks for TS / JS / Java / Go via
  the leading doc-comment carrier; per-symbol blocks for Python via the PEP
  257 docstring. Module-level blocks for Python (`__init__.py` etc.) and TS
  (top-of-file `/** */` on the package entry point) — Java and Go module-level
  deferred to v0.6.x.
- **CLI:** `sivru block validate [path]` lints every `@sivru` block under
  `path` (default cwd) and exits non-zero on any error-level diagnostic;
  `sivru block extract [path] --json` emits every block plus its diagnostics
  as JSON. Invalid blocks appear with `block:null` and `diagnostics:[...]` —
  never silently dropped (per the project rule on silent exclusion).
- **Diagnostic table.** `SIVRU-E210..E218` cover the v0.6 surface:
  decision-no-revisit (warn), block-prose (warn at 25 lines), block-runaway
  (error at 100 lines, hardcoded), maturity-invalid (error), schema-version-
  unsupported (error, strict-reject at v0.6), fence-unclosed (error),
  yaml-malformed (error), missing-required (error), module-locator-failed
  (warn). E219 reserved.
- **JSON wire shape (`SivruBlockJSON`)**: camelCased decision fields
  (`validWhile`, `revisitIf`); missing optional fields null- or empty-fill so
  consumers get a fully populated, type-stable object.
- **Project config**: `.sivru/block.json` overrides defaults
  (`requiredFields`, `optionalFields`, `maxLines`, `maturityValues`, `drift`).
  Project beats user (`~/.config/sivru/block.json`) beats defaults. Array
  overrides REPLACE the default array (don't extend); the 100-line runaway
  ceiling is NOT configurable. Same precedence model as `.sivru/explain.json`.
- **21 self-dogfood blocks** committed across `@sivru/search` and `@sivru/cli`
  symbols, covering 21 distinct roles. CI gate: `node packages/cli/dist/
  index.js block validate packages/` exits 0, AND the role-coverage gate
  asserts >=21 blocks AND >=5 distinct roles.
- **SKILL.md** gains an authoring section: when to write a block, the
  minimal valid form, the optional fields, and the read-the-block-before-
  editing rule.
- **DESIGN-0004 reconciliation.** `explain` artifacts now fill `authored[]`
  from `blockToJSON()` for blocks extracted from the target file. Region-
  level filters to entries whose symbol matches the region's exported symbol.
  v0.5's `Array.isArray(artifact.authored)` invariant is preserved.

### Dependency notes

- New direct dep on `@sivru/search`: `js-yaml@^4.1.0` (+ `@types/js-yaml`).
  Loaded exclusively via `yaml.load(text, { schema: JSON_SCHEMA })`; never
  `loadAll()`, never `DEFAULT_FULL_SCHEMA`. Threat-model test asserts
  `!!js/function` is rejected.

### Performance

- Block extraction is invoked by the explain artifact's `authored[]` fill
  (one `extractBlocks` call per target file) and by the `block` CLI's bulk
  walk. It does NOT add to the chunker pipeline used at index time.
- Measured chunker fixture suite (DESIGN-0016 P1 corpus,
  `packages/search/src/chunker/__fixtures__/`): 553ms post-v0.6 vs the same
  duration pre-v0.6 (block module is sibling, not in the chunker path).
  Overhead: 0% — the < 5% gate is satisfied trivially.
- Block module test suite (47 tests across 8 files) runs in ~510ms; bulk
  validate over `packages/` (~600 files, 21 blocks, NUL-binary filter +
  __fixtures__ / dist / node_modules skip) completes in ~2.5s on a warm
  parser cache.

### Forward-pointer

- v0.7 (DESIGN-0017) will surface authored context through the existing
  `sivru.explain` MCP tool and add the drift detector that consumes
  `SIVRU-E210 decision-no-revisit` plus four new diagnostics in the
  `SIVRU-E220..E229` range.

## [0.5.0] — 2026-05-20

`sivru explain <path>` — public API, callers, callees, churn, ownership,
and tests for a file or symbol, surfaced over CLI and MCP before an edit.
See [DESIGN-0004](docs/design/0004-sivru-explain.md).

### Added

- **CLI:** `sivru explain <path> [--json] [--since=<N>] [--depth=1] [--diff] [--repo=<dir>]`
  emits the canonical artifact as markdown (default) or bare JSON.
  Uncapped — `--json` returns the full caller/callee lists.
- **MCP tool:** `explain({ path, symbol?, diff?, since?, depth?, repoRoot? })`
  registered alongside `search` and `find_related`. Returns the canonical
  artifact wrapped in an envelope with `tool`, `path`, `latencyMs`,
  `refreshMs`, `refreshDelta`. The MCP path applies the cap from
  `.sivru/explain.json` (default 30 callers + 30 callees, hard ceiling
  500). Tool description carries the always-on routing hint ("Get the
  public API, callers, callees, churn, and ownership of a file or symbol
  before editing it.").
- **Region-level explain.** Pass `path::symbol` (CLI) or `symbol: "..."`
  (MCP) to slice the artifact to one symbol's line range. Per-region
  churn uses `git log -L`, ownership uses `git blame --line-porcelain`.
- **`--diff` mode.** Reads the working-tree diff against HEAD, identifies
  exported symbols that are *removed* by the edit, and for each one
  reports the callers that will break. v0.5 ships REMOVED only; symbol
  renames are deferred. CI gate (12-fixture corpus): mean FP rate ≤ 15%
  per the design.
- **Symbol-index module** in `@sivru/search/explain/`: walker → chunker
  (warm-path Chunk[] reuse) → per-language Resolver (TS / JS / Python /
  Go / Java) → exports + import edges. On-disk cache at
  `~/.cache/sivru/symbol-indexes/<repo-slug>/<state_id>.json`, atomic
  tmp→fsync→rename writes, format-version bump on shape change.
- **Per-file commitCount cache.** One `git log --name-only` walk per
  state_id, memoised by `(repoPath, stateId, sinceDays)` — zero git
  invocations per MCP request after the first per state.
- **Threat model.** Path-validator rejects absolute paths, `..` escapes,
  and symlinks that exit the repo (SIVRU-E2001 / E2002 / E2009);
  test-pattern realpath validation drops candidate test files whose
  resolved path leaves the repo root; MCP cap hard ceiling clamps to
  500 with `0 → ceiling` foot-cannon fix (SIVRU-E2008).
- **Scaled precision floor (D16 + D4).** For Go and Java targets, when
  the candidate caller list exceeds `max(100, repoFileCount × 0.05)`,
  callers is nulled and `callers_skipped_reason: "precision-floor"` is
  surfaced. Footer reports the chosen floor.
- **Honest footer.** Every artifact carries a footer string documenting
  the call graph's identifier-based (not type-resolved) limit, the
  precision floor at the current repo size, Go package / Java class
  granularity when applicable, and the region-level `git log -L`
  performance disclosure.
- **Cold-build budget gate.** 200-file synthetic TS corpus, 5 trials,
  p95 < 15s (well under in practice; the gate catches O(N²) regressions
  and parse-cache wiring bugs).
- **SKILL.md** now describes three instruments — grep / search / explain
  — with the "before edit" workflow for `sivru.explain`.

### Implementation notes

- Error code range claimed: **SIVRU-E2001..E2010** (path-validator,
  symbol-not-found, cache load/save failures, git failures, mcpCap
  validation).
- `authored: []` is the v0.6 prepay slot (DESIGN-0016). Locked in v0.5
  so a future fill is purely additive.
- Privacy boundary intact: `packages/observe/` not touched; explain
  shells out to local `git` only.

## [0.4.0] — 2026-05-20

The sivru skill. See
[DESIGN-0003](docs/design/0003-sivru-skill-package.md).

### Added

- **`sivru skill install` / `uninstall`** — installs a Claude Code
  routing skill (`SKILL.md`) into `~/.claude/skills/sivru/`, or
  `<repo>/.claude/skills/sivru/` with `--project`. The skill is the
  policy layer: when to reach for `sivru.search` versus grep, and when
  to run `find_related` after an edit. Install overwrites by default,
  notices when it replaced an edited copy, refuses a non-sivru file
  unless `--force`, and notes a cross-scope collision. The bundled
  `SKILL.md` is the one canonical routing policy.
- **Routing hints in the MCP tool descriptions.** The `search` and
  `find_related` tool `description` strings now carry a one-line
  routing hint — the always-on channel, in the agent's context every
  turn. A drift-guard test keeps them in sync with `SKILL.md`.
- **§5 routing-efficacy smoke test** — a 15-prompt routing testbench
  (`pnpm --filter @sivru/cli smoke`, `packages/cli/src/smoke/`) run
  through the `claude` CLI, scored on whether the agent picks the tool
  that matches each query's shape (`sivru.search` for behavioural,
  `grep` for identifiers, `find_related` after an edit). Kept out of
  CI — it makes live `claude` calls. Measured result (claude 2.1.144,
  45 trials per arm — n=15 × 3 repeats, sub-agent delegation blocked so
  the test isolates the skill from Claude Code's search-delegation):
  routing correctness **56% without the skill, 76% with it** (+20
  points). Behavioural-query routing to `sivru.search`: **0/18 trials
  without the skill, 7/18 with it** — the skill is the entire reason
  behavioural routing happens at all; the always-on tool descriptions
  alone moved nothing. It works but is not yet consistent — 3 of 6
  behavioural prompts move, 3 do not. In normal headless use Claude
  Code delegates a codebase search to a sub-agent that does not carry
  the skill; measured that way the gap is smaller (~67%). Closing the
  delegation gap is v0.5+ work. A confidence check, not a gate. See
  [DESIGN-0003](docs/design/0003-sivru-skill-package.md) §5.

### Changed

- `@sivru/cli` `package.json` `files` now includes `SKILL.md`, and a CI
  job asserts the asset ships in the published tarball.

## [0.3.0] — 2026-05-19

Per-model chunk-windowing. See
[DESIGN-0002](docs/design/0002-per-model-chunk-windowing.md).

### Added

- **Per-model chunk-windowing** (`@sivru/search`). Chunk size is now a
  function of the embedder's token budget instead of a fixed line count.
  A new `rewindowForBudget` post-pass re-splits any chunk that exceeds
  the configured embedder's context window, so a short-context embedder
  (MiniLM, BGE) no longer silently truncates a dense chunk down to its
  first ~256 tokens. `chunkFile` itself is unchanged — it stays
  embedder-agnostic; the post-pass owns token sizing. `buildIndex` and
  `refreshStale` both run it; BM25-only builds and windowless embedders
  (potion) behave exactly as in 0.2. See
  [DESIGN-0002](docs/design/0002-per-model-chunk-windowing.md).

### Changed

- `EmbeddingProvider` gains three optional members: `id`,
  `contextTokens`, and `countTokens`. Transformers.js providers populate
  them from the loaded tokenizer; potion declares none (windowless).
- The on-disk index cache key now includes the embedder id, and
  `CACHE_FORMAT_VERSION` moves `2 → 3`. Chunk boundaries depend on the
  embedder, so a 0.2 cache is rejected on read and rebuilt once.

### Benchmarks

- Windowing was validated with a MiniLM windowed-vs-truncated A/B on
  the 60-query corpus. Honest result: windowing **lowers** MiniLM
  hybrid NDCG@10 — 0.611 windowed vs 0.632 un-windowed (−0.021,
  consistent across all three repos). A large chunk that MiniLM
  truncates is embedded from its head (signature, declaration), which
  retrieves well for natural-language queries; splitting it into
  budget-sized fragments dilutes that. v0.3's value is **correctness**
  — MiniLM no longer silently truncates, so its numbers are now
  honest — not a quality gain. The default embedder (potion) is
  windowless and unaffected; BM25 is unaffected.
- This is the second release where smaller chunks cost hybrid NDCG
  (0.2's tree-sitter chunker cost potion hybrid −0.011). The
  chunk-size-vs-hybrid-retrieval-quality tradeoff is tracked in
  [`TODOS.md`](TODOS.md) as a retrieval-architecture item.

## [0.2.0] — 2026-05-18

The tree-sitter chunker. See
[DESIGN-0001](docs/design/0001-tree-sitter-chunker.md).

### Added

- **Tree-sitter chunker** (`@sivru/search`). Files in TypeScript,
  JavaScript, Python, Go, and Java (7 language ids incl. tsx/jsx) are
  chunked on function / class / method boundaries instead of fixed
  50-line windows. The AST view is the substrate the v0.6–0.8
  authored-context layer extracts from; the retrieval gain ships with
  it. Every other language keeps the line-window chunker.
- `Chunk` gains `nodeType` (the AST node that produced the chunk) and
  `symbolName` (its identifier) — populated by the tree-sitter path,
  `undefined` for line/gap chunks.
- The 6 grammar WASM files are bundled in the package; no runtime
  download. `web-tree-sitter` and `tree-sitter-wasms` pinned exact.
- `windowLines()` — a range-aware line-window primitive reused for
  gap-fill and oversized-node splitting.

### Changed

- **BREAKING: `chunkFile()` is now async** (`Promise<Chunk[]>`). It
  awaits grammar load (memoised after first use). Internal callers
  already awaited; external callers must add `await`.
- Chunking runs on the main thread — the `worker_threads` pool is
  removed (`BuildIndexOptions.workers`, `WORKER_FILE_THRESHOLD`).
  Tree-sitter parses in milliseconds per file and a worker pool cannot
  share loaded grammars; one `Parser` is simpler and uses less memory.
- `CACHE_FORMAT_VERSION` 1 → 2 — v0.1 indexes rebuild once on upgrade.
- A tree-sitter file is always fully indexed: AST node chunks plus
  line-fallback "gap" chunks over every range no node covers, so no
  line is silently dropped. Oversized nodes are line-windowed.
- Bench re-baselined on the 3-repo / 60-query corpus. BM25 NDCG@10
  0.5933 → 0.6168 (**+0.024**). Hybrid 0.6013 → 0.5908 (**−0.011** —
  within point-estimate noise on a small-function corpus; see the
  bench-corpus TODO). Perf: 993 → 3531 chunks at flat build time
  (570 → 585 ms) — tree-sitter parsing is not the bottleneck.

## [0.1.0] — 2026-05-05

First public release. The 0.1.0-rc.1 work that landed during dogfooding
is folded in below; this is what actually ships to npm.

### Added

**Retrieval quality**
- Cross-encoder reranker primitive (`CrossEncoder` interface +
  Transformers.js implementation) plumbed via
  `BuildIndexOptions.rerank` into both `searchBM25` and `searchHybrid`.
  Pipeline: BM25⊕embedding fuse → top-N candidates (default 50) →
  cross-encoder rescore → top-K. Default
  `Xenova/ms-marco-MiniLM-L-6-v2` (~100 ms / 50 pairs CPU);
  `Xenova/bge-reranker-base` available for ~5× the latency and
  stronger quality. Mock cross-encoder for tests.
- Asymmetric query encoding via optional `embedQuery(text)` on
  `EmbeddingProvider`. Transformers provider auto-applies
  model-specific instruction prefixes for BGE
  (`"Represent this sentence for searching relevant passages: "`),
  Nomic (`"search_query: "` / `"search_document: "`), and E5
  (`"query: "` / `"passage: "`). Without this, those models retrieved
  at sub-optimal capacity. Symmetric encoders (potion, MiniLM,
  jina-code) get empty prefixes; behavior unchanged.
- `SivruIndex.refreshStale()` — mid-session embedding refresh on
  file changes. Per-file mtime tracking + content-hash dedup so
  unchanged chunks reuse old embeddings. The MCP server calls this
  before every search.
- `createPotionProvider()` — Model2Vec static embedder runtime.
  Default model `minishlab/potion-retrieval-32M`. No transformer
  inference: tokenize → row lookup → mean-pool → L2-normalize.
  ~32 µs / embed CPU. Hand-rolled safetensors parser + HF Hub
  fetcher with on-disk cache.

**CLI**
- `sivru bench personal` — benchmark embedders + rerankers on YOUR
  Claude Code sessions + repos. Auto-discovers projects from
  `~/.claude/projects/`, derives ground truth from session edits,
  computes file-level recall@5 + MRR + tokens-saved with bootstrap
  90% CIs. Honest baseline reads narrow context windows around grep
  hits (not full files). Run history persisted to
  `~/.cache/sivru/bench-history/`.
- `sivru bench models` — catalog of registered embedders +
  rerankers with size / RAM / latency / license / cold-start.
- `sivru config get / set / unset / list / path` — persistent
  embedder choice in `$XDG_CONFIG_HOME/sivru/config.json`. Atomic
  rename writes, parse-failure-tolerant. The MCP server reads it
  on startup.
- `sivru search --rerank=<name>` and `--rerank-top-n=<n>`.
- `sivru search --embed=<name>` accepts every catalog short name
  (`bm25`, `potion`, `minilm`, `bge-small`, `jina-code`,
  `nomic-embed`) plus `hf:owner/model-name`.
- Interactive raw-mode checkbox picker when `bench personal` runs
  without `--models`. Arrow keys, space-toggle, `a` for all, digit
  shortcuts (1–9), esc/q to cancel.
- Build-progress reporter with cold-start heartbeat — fires every
  30 s during the chunked → first-embed gap so the user knows
  whether MiniLM / BGE is downloading or hung.
- `sivru observe replay <id>` and `sivru observe costs --since=N`
  — counterfactual replay (Layer 2) over existing sessions. Zero
  API cost; runs offline against the model pricing table.
- `sivru observe init` — emits a `~/.claude/agents/sivru-search.md`
  subagent file scoped to retrieval queries.

**Observe + UI**
- Worktree-aware project grouping. `inferred-prefix` heuristic
  surfaces deleted worktrees under their parent project.
- Per-turn coaching signal on the timeline (missed-opportunity
  badge + sivru.search → consumer linking).
- Replay-diff view (DESIGN.md §6.5) — turn-by-turn counterfactual
  scoreboard.
- "Bench" tab — past `sivru bench personal` runs surfaced via
  `GET /api/bench-history` + `/api/bench-history/:id`. Dual-fill
  bar: solid p50 + faded p05–p95 90% CI band, for both recall@5
  and tokens-saved.
- Project switcher, live pulse indicator, costs view, sessions
  list refinement, robustness banners.

**MCP**
- Search response is now a JSON envelope with `latencyMs` /
  `refreshMs` / `refreshDelta` / per-result
  `score` / `source` / line range.
- Refreshes the index on every search via `refreshStale()`.

### Changed
- **`bench personal` primary metric is file-level recall@5 + MRR**
  (ground truth derived from session edits). Tokens-saved becomes
  secondary. Reason: a retriever returning empty / random short
  chunks "saved" the most tokens with the old framing — the metric
  scored compactness, not retrieval correctness.
- **Honest bench baseline.** Reads narrow context windows (~30
  lines) around grep hits, not 3 full files. The previous "% saved"
  headline was inflated by 30+ percentage points; the new number is
  defensible.
- Bench passes `signals: false` to BOTH BM25 and hybrid runs so the
  retriever-vs-retriever comparison is apples-to-apples (production
  defaults differ — that's the live-product question, not the
  bench question).
- Default hybrid embedder is `createPotionProvider()`. Cold-start
  indexing on a 16k-chunk repo drops from ~10–15 min to ~30 s.
  Quality hit on the W2 bench is -0.059 NDCG@10 (0.6601 → 0.6013).
- `searchBM25` is now async (was sync) so cross-encoder reranking
  can apply uniformly. Existing callers that awaited the conditional
  `... ? hybrid : bm25` continue to work; in-process callers that
  used the result synchronously need an `await`.

### Fixed
- onnxruntime-node `mutex lock failed: Invalid argument` crash when
  worker_threads + transformers ran together on Node < 22.11.
  `buildIndex` now defaults to single-threaded chunking when
  `embed` is enabled.
- `buildIndex` cache persists embeddings on partial-cache-hit
  upgrades (chunks loaded from cache, embeddings computed this
  run); fixes a bug where second-time hybrid runs kept re-embedding.
- Per-session % saved was using the wrong denominator in observe-ui
  (could exceed 100%).
- Lossy decode of project directory names — observe now reads `cwd`
  from jsonl events directly so worktree grouping is reliable.
- Search-result share clamp + replay-view chip clarity
  (code-review follow-through).

### Performance
- 7-phase observe-ui sprint targeting long-session render: SSE
  batching (50 ms windows), React.memo on TimelineEvent /
  TurnHeader / SessionRow with custom equality functions,
  `useDeferredValue` for the filter input, per-turn render cap
  (500 events with a "show all" footer), Inspector pre-block cap
  (50 000 chars). On a 5 000-event session, scroll latency drops
  from ~600 ms to ~40 ms.

## [0.1.0-rc.1] — 2026-05-04

### Added

**Engine (`@sivru/search`)**
- Gitignore-aware async walker (`walk()`) with nested `.gitignore` + negations, symlink-loop bounds, binary skip, size cap, typed skip reasons.
- Line-fallback chunker (50 lines, 5 overlap per DESIGN.md §4.1) with extension-driven language detection for the 16 grammars in scope.
- Identifier-aware BM25 tokenizer (`tokenize`) — splits camelCase / snake_case / kebab-case, preserves dotted identifiers.
- Lucene-style BM25 (`createBm25Index`) over a sparse posting list. Hand-computed scoring reference verified to 1e-6.
- Float32Array flat-matrix cosine top-k (`cosineTopK`, `packMatrix`).
- Reciprocal Rank Fusion (`reciprocalRankFusion`).
- Reranking signals (`applySignals`): definition boost / multi-chunk file boost / path penalties / identifier-stem matching. Default-on for BM25; off in hybrid (RRF over-double-counts).
- Pluggable `EmbeddingProvider` interface + three implementations: deterministic mock for tests, `@huggingface/transformers` (default `Xenova/all-MiniLM-L6-v2`), OpenAI-compatible HTTP (works with OpenAI / Voyage / Ollama / vLLM / LM Studio).
- `worker_threads` pool (`min(8, cpus)`) for parallel chunking.
- On-disk index cache keyed by `(repo_path, state_id)` with atomic-rename writes (Windows-safe rename retry + filename sanitization), format-version + corruption tolerance, embeddings rehydration when the provider's `dim` matches.
- `SivruIndex.fromPath()` facade tying everything together: `searchBM25(query, k)` and `searchHybrid(query, k)`.

**CLI (`sivru`)**
- `sivru search <query> [path]` with `--top=N`, `--hybrid`, `--json`. Cache opt-in by default — second runs in the same repo are sub-second.
- `sivru index <path>` with `--json`. Reports `cacheHit: true|false`.
- `sivru mcp` — stdio MCP server using `@modelcontextprotocol/sdk`. Two tools: `search` (full retrieval), `find_related` (placeholder, lands W3+).
- `sivru from-git <url> [-r <ref>]` — depth=1 clone, SSRF guard (default-block private IPs / localhost / `file://`), cached by `(url, ref)` hash in `~/.cache/sivru/git/`.
- `sivru session list` / `sivru session show <id-prefix>` — read Claude Code's `~/.claude/projects/<cwd>/<uuid>.jsonl` session files, with `--json` for ndjson output.
- `sivru observe` — boots the Hono HTTP server on `127.0.0.1:7676` (default) and serves the built observe-ui on `/`. SIGINT-aware shutdown.
- `sivru version` / `sivru help`.

**Observe (`@sivru/observe`)**
- Jsonl source: `listSessions`, `readSession`, `createJsonlSource` — full normalizer for the real Claude Code on-disk format (handles user/assistant entries with content as plain string OR array of text/tool_use/tool_result/thinking blocks; tool_results inside user entries; system events).
- Hono v4 HTTP server: `GET /api/health`, `/api/sessions`, `/api/sessions/:id/events?limit=N`. CORS allowlist restricted to `http://localhost:*` and `127.0.0.1:*`. Optional static UI mount with SPA fallback + path-traversal guard.
- Layer 1 savings estimator (`estimateSavings` per DESIGN.md §20.1) — counterfactual K=5 grep+read baseline, per-call chunk count from tool_result output shape, configurable via `SavingsOptions`.
- Layer 2 cost analytics (`pricing.ts`) — known-Claude-model pricing table, `turnCostUsd`, `blendedRateUsdPerMTok`, `dollarsConsumed` / `dollarsSaved` / `percentDollars` / `turns[]` fields on `SavingsEstimate`.
- Privacy boundary (DESIGN.md §5.5) enforced statically (data-layer files banned from importing `node:http`/`node:https`/`node:net`/`node:tls`/`undici` — `src/server/` excepted as the inbound listener) and at runtime (fetch spy throws on call during representative reads).

**Observe UI (`@sivru/observe-ui`)**
- Vite + React 18 + Tailwind v3, dark-only, soft-amber accent per DESIGN.md §6.7 tokens.
- Three-pane layout: sessions sidebar / event timeline / inspector. Sticky panel headers.
- Keyboard nav: J/K (or ↓/↑) cycle events, Enter inspect, Esc clear, Cmd/Ctrl+K focus quick-filter.
- Zero-search nudge banner (DESIGN.md §6.6) when no `sivru.search` calls in the selected session.
- Inspector renders user/assistant text, tool_use input as JSON, tool_result output (red border on `isError`), raw event JSON expander.
- Build output ~150 KB raw / 48 KB gzipped JS.

**Benchmarks (`benchmarks/`)**
- 3 pinned OSS repos (zod / requests / gson) cloned by `pnpm fetch-corpus`.
- 60 hand-labeled queries spanning architecture / behavior / error-path / api / data-flow.
- `runner.ts` adapter-driven NDCG@10 with `--hybrid` and `--json` flags.
- `baseline.json` (BM25 + signals): 0.5933.
- `baseline-hybrid.json`: 0.6601.

**CI**
- 6-cell matrix (ubuntu / macos / windows × Node 20 / 22). Build → typecheck → test order so cross-package imports resolve.

### Notes
- The W4 issue's `doctor`, `find-related` (real impl), and `model` commands are scoped out of `0.1.0-rc.1`. Track on https://github.com/sivru/sivru.
- Layer 2 replay/compare and the 20-task agent-task benchmark are W8 follow-ups.

## [0.0.0]
- Pre-release scaffold. No engine yet. See DESIGN.md §12 for the W0–W8 roadmap.
