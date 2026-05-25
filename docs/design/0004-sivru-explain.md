# DESIGN-0004: `sivru explain <path>`

**Status:** Accepted (promoted from Draft on 2026-05-20 by
`/plan-eng-review` iter-6 PASS)
**Class:** Spine (per [GOALS.md](../../GOALS.md))
**Targets:** v0.5.0
**Issue:** filed when v0.5 work starts
**Created:** 2026-05-08
**Updated:** 2026-05-20 — eng-review iter-6 absorbed D1 (subdir,
overturns CEO-plan D8), D2 (commit-count cache for D15 sort),
D3 (two-tier cold-build budget), D4 (D16 floor scales with repo
size), and six folded fixes. Promoted Draft → Accepted.
**Author:** @pochadri

## Problem

Agents write code at high velocity. Humans cannot read at that pace.
When you (or your agent) is about to edit a file you have not touched
in months, there is no quick way to refresh the mental model: what
does this file expose? Who calls it? How often does it change? Who
last touched it?

Today the answer is five commands — read the file, `git log`,
`git blame`, `grep` for callers, `ls` for tests — five outputs to
mentally fuse. `sivru explain <path>` collapses that into **one
structured artifact** built from cheap local signals:

- public API surface (exports, signatures);
- 1-hop call graph (callers + callees within the repo);
- recent change frequency (churn);
- ownership (last author + top contributors);
- test coverage hint (matching test files).

This is **Spine**. It is the first *comprehension primitive* — the
goal in [GOALS.md](../../GOALS.md) is to make a codebase queryable as
a durable asset, and `explain` is the first surface a human or an
agent calls to ask "what is this file, in this codebase, right now?".
v0.6's `@sivru` annotation blocks (DESIGN-0016) layer authored *why*
on top of the derived *what* this release ships.

The MCP version (`sivru.explain`) lets the agent self-narrate before
editing: "I am about to change `processPayment`; it is called by 12
places — let me read what they expect before I touch it." Region-
level explain (`path::symbol`, see §4) and `--diff` mode (§5) are
the v0.5 surfaces that produce the actual edit-with-comprehension
behaviour [GOALS.md](../../GOALS.md) names as the project's reason
to exist.

## Proposal

### 1. The artifact (canonical JSON shape)

`sivru explain <path>` emits five descriptive sections. Every
section is **descriptive only** — no "you should refactor this",
no quality judgements (v0.7's coach loop does judgement; this does
not).

The CLI markdown rendering is one cut over the same JSON the MCP
tool returns. The JSON shape is the contract; the markdown is the
human surface. **Canonical artifact JSON shape:**

```jsonc
{
  "path": "<file path or path::symbol>",
  "public_api":     [ /* exported symbols with signatures */ ],
  "callers":        [ /* 1-hop, capped per A4 in MCP only */ ],
  "callees":        [ /* 1-hop, capped per A4 in MCP only */ ],
  "churn":          { /* commit count, last commit, since-days */ },
  "ownership":      { /* top contributors with % */ },
  "tests":          [ /* matched test files */ ],
  "authored":       [],         // empty in v0.5; v0.6 fills (A1)
  "callers_truncated": null,    // null OR count of dropped entries
  "callees_truncated": null,    // null OR count of dropped entries
  "callers_skipped_reason": null, // null OR "precision-floor" (D16)
  "footer": "<resolution-model honesty string>"
}
```

`callers_truncated` and `callees_truncated` are the v0.3
visible-degradation pattern: `null` when no truncation, the count
of dropped entries when capped. `callers_skipped_reason` is set to
`"precision-floor"` when the Go-package / Java-class fan-out
exceeds the scaled precision floor (§3b, D16) and the field
returns `null` rather than a noisy fan-out list. `authored: []` is
the A1 prepay slot for v0.6 (DESIGN-0016 holds the v0.6
reconciliation contract).

**MCP response envelope.** When invoked via `sivru.explain` over
MCP, the artifact is wrapped in an envelope with observability
fields, matching the existing `sivru.search` / `sivru.find_related`
shape (`packages/cli/src/mcp-entry.ts:340-373`):

```jsonc
{
  "tool": "sivru.explain",
  "path": "<path>",
  "latencyMs": 47,
  "refreshMs": 12,
  "refreshDelta": { "modified": 0, "added": 0, "removed": 0,
                    "embedsRecomputed": 0 },
  "artifact": { /* canonical artifact shape above */ }
}
```

The CLI does NOT wrap — `sivru explain --json` returns the bare
artifact. Only MCP wraps. Single source of observability across all
three tools.

Example markdown rendering:

```
explain  packages/cli/src/commands/skill.ts
=========================================================

PUBLIC API
  install(opts)      — write SKILL.md + version marker to a Claude
                       Code skills dir; preserve user edits; --force
                       overwrites; --project targets the repo.
  uninstall(opts)    — remove the installed skill.

CALLERS (1-hop, within this repo)            CALLEES (1-hop)
  packages/cli/src/index.ts:42 → install     packages/cli/src/lib/
                                              skill-marker.ts:
                                                computeHash, readMarker

CHURN  (last 90 days)
  3 commits  · last 2026-05-19  · touched in #21

OWNERSHIP
  top 3:        pochadri 100% (37 lines)

TESTS
  packages/cli/src/commands/skill.test.ts  (38 cases)

AUTHORED  (none yet — see v0.6)

FOOTER
  call graph is identifier-based; not type-resolved — expect
  false positives on common names. Go callers resolve at package
  granularity; Java at source-root + class granularity. Precision
  floor at this repo size: 100.
```

Output formats: `markdown` (default), `--json` for tooling.

### 2. Surfaces

- **CLI:** `sivru explain <path> [--json] [--since=<N>] [--depth=1]
  [--diff]`. The CLI is **uncapped** — both markdown and `--json`
  return the full caller/callee lists, no truncation.
- **CLI region-level:** `sivru explain <path>::<symbol>` — see §4.
- **CLI diff mode:** `sivru explain <path> --diff` — see §5.
- **MCP tool:** `sivru.explain({ path, symbol?, diff?, since?, depth? })`
  — the agent calls it before edits. The MCP response is wrapped in
  the envelope (§1) and the `artifact.callers` / `artifact.callees`
  lists are capped per §2a.

The MCP tool's always-on `description` is the channel that actually
makes the agent reach for it (per the v0.4 pattern and the existing
`SEARCH_TOOL_DESCRIPTION` / `FIND_RELATED_TOOL_DESCRIPTION`
pattern):

> *"Get the public API, callers, callees, churn, and ownership of
> a file or symbol before editing it. Use after locating a file
> and before changing a symbol — it surfaces who else depends on
> what you are about to touch. `diff: true` shows what an in-
> progress edit is about to break."*

The SKILL.md body (from v0.4) is updated to mention `explain` in
the after-editing-locate-the-file workflow. v0.4's measured
routing data (76% with skill, 56% without, sub-agents bypass the
skill entirely) is acknowledged context for v0.5: the coach loop
(v0.7+) is the named release line that addresses low-context-edit
detection. v0.5 does not try to fix delegation.

**Argument parsing.** Hand-rolled, no zod — matches the codebase
convention in `parseSearchArgs` / `parseFindRelatedArgs`
(`packages/cli/src/mcp-entry.ts:198-306`). Explain adds a
`parseExplainArgs` of the same shape.

#### 2a. MCP token cap (A4 + D15 + D2 + #10)

- **Defaults:** 30 callers AND 30 callees, applied **independently**.
- **Sort (D15 + D2 implementation).** By per-file `commitCount`
  **ASCENDING** (stable / low-churn first), ties broken by file
  mtime **ascending**. Surfaces the dangerous legacy callers the
  agent does not already know about; recently-touched callers drop
  into the truncated tail.
- **`commitCount` is cached per file in the symbol-index** (D2 —
  see §6). Build computes one `git log --name-only --pretty=format:`
  walk over the committed history and parses into a `Map<file,
  count>` applied to every per-file index entry. The MCP cap path
  reads `commitCount` from the cached symbol-index entry — **zero
  git invocations per request**. Invalidation is automatic
  (commitCount is part of the cached entry; `state_id` changes
  rebuild the cache).
- **Hard ceiling (#10):** the effective cap is
  `min(configValue, 500)`. Any user-supplied value above 500 is
  clamped to 500. A value of `0` means "use the ceiling (500)",
  not "no cap" — this is the foot-cannon fix.
- **Configuration:** via `SIVRU_EXPLAIN_MCP_CAP` env var (integer)
  and `.sivru/explain.json` `{ "mcpCap": N }`. Project config
  beats user config; env var beats both. All values pass through
  the hard-ceiling clamp.
- **CLI is uncapped** — both markdown and `--json` return full
  lists. Only the MCP `tools/call` response is capped.
- **Truncation markers** in the canonical shape:
  `callers_truncated` / `callees_truncated` — `null` when no
  truncation, the count of dropped entries otherwise. Visible
  degradation, not silent corruption.

### 3. How it is computed

```
sivru explain <path>
  │
  ├─ tree-sitter parse <path>          → public API (exports, sigs)
  │   reuses v0.2 grammars; reads from in-process SivruIndex.Chunk[]
  │   when search has already indexed the repo (warm path); fresh
  │   parse only on cold path or for files outside the index.
  │
  ├─ symbol-index lookup                → callers + callees
  │   (per-repo index: file → exports[], imports[resolved],
  │    commitCount)
  │   built on first explain, cached, mtime-invalidated
  │
  ├─ git shortlog -ns -- <path>         → ownership (file-level)
  │   git blame -L for region-level only
  │
  ├─ git log -- <path>                  → churn (file-level)
  │   git log -L for region-level only (see §3c)
  │
  └─ test-file pattern match            → test hint
```

**3a. Public API.** Reuses the v0.2 tree-sitter substrate. The
chunker already returns `Chunk[]` with `nodeType` + `symbolName`;
the explain layer keeps the *exported* symbols and pulls each
one's signature line range out of the same parse.

**Warm-path optimisation (per D1).** Explain is a subdirectory of
`@sivru/search` (see §6). When the MCP server has already built
a `SivruIndex` for the repo (the common case — the agent ran
`sivru.search` or `sivru.find_related` first), explain reads the
per-file `Chunk[]` from the in-process index and filters chunks
where `symbolName !== undefined` AND `nodeType` is in the exported-
node-type whitelist for the file's language. No re-parse on the
warm path. On the cold path (no search index built yet), explain
runs the chunker directly. Same Chunk[] shape either way.

The five covered languages (TS, JS, Python, Go, Java) are
first-class; uncovered languages get an empty `public_api`
section with an honest "language not yet supported" note.

**3b. The 1-hop call graph.** Computed against a per-repo
**symbol index** that maps, for each file:

- `exports`: name → kind (function / class / type / const) + the
  AST range, extracted via tree-sitter from the same parse the
  chunker already runs.
- `imports`: each import statement → the *resolved* path of what
  is being imported (i.e. the on-disk file the import targets).
- `commitCount`: total commits touching this file in the committed
  history. Populated at build by one `git log --name-only` walk
  bucketed by file. Used by the D15 cap sort (§2a) without per-
  request git invocations.

Resolution is best-effort and language-specific. All resolvers
implement a shared `Resolver` interface:

```ts
interface Resolver {
  language: 'typescript' | 'javascript' | 'python' | 'go' | 'java';
  /** Resolve one import statement's target path within the repo.
   *  Returns null if unresolvable (extern, type-only, etc.). */
  resolveImport(
    importStmt: string,
    fromFile: string,
    repoRoot: string,
  ): string | null;
  /** Extract exported symbols from this file's chunks. */
  exportsOf(chunks: readonly Chunk[]): Export[];
}
```

Per-language behaviour:

- **TS/JS:** relative imports (`./foo`, `../bar`) resolved against
  the importing file's dir, with the usual extension probes
  (`.ts`, `.tsx`, `.js`, `index.ts`, …). `paths`/aliases from
  `tsconfig.json` are out of scope for v0.5 (open question,
  deferred — see §"Open questions").
- **Python:** relative imports (`from .x import y`) → file in the
  same package; absolute package imports inside the repo →
  `<pkg>/__init__.py` or `<pkg>.py`.
- **Go:** module-relative imports → directory under the module
  root (per `go.mod`); resolves to a package directory, not a
  single file. The graph keys at package granularity for Go.
- **Java:** `import com.example.X` → `<sourceRoot>/com/example/X.java`,
  best-effort across configured source roots.

Once the index is built:

- **Callers of `<path>`** = every file whose `imports` resolves to
  `<path>` AND whose source mentions any of `<path>`'s exported
  names. Identifier match across an import is a strong signal even
  without type resolution — high recall, low cost.
- **Callees of `<path>`** = call expressions inside `<path>` whose
  identifier resolves either to a local definition in `<path>`
  (drop — not a callee) or to an imported symbol whose import line
  resolves to another file (keep — that other file is the callee).

The index is **not** a type-resolved call graph. It is identifier +
import-edge matching — high recall, lower precision on shadowing or
same-named symbols across files. Honest scope: documented in the
output footer.

**Go / Java precision floor (D16 + D4).** Package-level (Go) and
source-root + class-level (Java) resolution can fan out to
hundreds of "callers" for common utility files. A footer
disclaimer cannot fix a noise flood. The rule:

> If a single Go-package or Java-class call-site query yields
> **more than `floor` candidate callers** where
> `floor = max(100, repoFileCount * 0.05)`,
> explain returns `callers: null` AND `callers_skipped_reason:
> "precision-floor"` for that symbol. The footer string reports
> the actual `floor` value chosen for the repo so the user / agent
> can see it.

D4 — the floor scales with repo size: 100 minimum, 5% of total
indexed files maximum. A 2000-file repo: floor = 100. A 5000-
file repo: floor = 250. A 50000-file monorepo: floor = 2500.
Visible degradation > noisy output. User-configurable precision
floor (`.sivru/explain.json` override) is deferred to v0.5.x.

**3c. Churn + ownership.**

- **File-level (default):** churn = `git log --follow --since=<N>
  -- <path>` for change count and last commit. Ownership =
  **`git shortlog -ns -- <path>`** aggregated by author (faster
  and quieter than `git blame --line-porcelain` for the file-level
  case; blame loads the full file history into memory). The
  walker already shells out to `git` for `state_id`, so this is
  the same pattern.
- **Region-level (`path::symbol`):** the line range comes from the
  symbol index. Churn uses
  `git log -L <startLine>,<endLine>:<path> --since=<N>`;
  ownership uses `git blame --line-porcelain -L <startLine>,
  <endLine> <path>`. Both are computed **live per call** — there
  is no region-level churn cache. The symbol index gives us the
  range cheaply; git provides the per-region log.
- **Performance disclosure.** `git log -L` walks history per-commit
  for the file's hunks and is meaningfully slower than `git log --
  <path>` (typically 5–10x on a long-history file). The `--since`
  default (90 days) bounds the work for region-level calls. Hot
  files with multi-year history may see region-level explain take
  multiple seconds. Documented in the footer when region-level
  is used; v0.x perf patch if a user reports it.

**3d. Tests.** A filename-pattern match the chunker can derive:
`<path>.test.<ext>`, `<dir>/__tests__/<basename>.*`,
`<dir>/<stem>.spec.<ext>`, `<dir>/<stem>_test.<ext>` (Go),
`test_<stem>.py` (Python). Test count is a `grep` for `it(` /
`test(` / `def test_` in the matched file — informational, not
precise. Pattern matching runs against repo-relative paths only;
no glob hits files outside the repo (§6 threat model).

### 4. Region-level explain (A2 — `path::symbol`)

The agent's tool calls target specific symbols, not whole files.
v0.5 ships region-level explain so v0.6's symbol-level binding
lands against a proven surface.

- **CLI:** `sivru explain pkg/foo.ts::processPayment`
- **MCP:** `sivru.explain({ path: "pkg/foo.ts", symbol: "processPayment" })`

The artifact is **re-derived per call**. There is no artifact-
level cache and no per-symbol cache layer in v0.5. What IS cached
is the **symbol index** (§6) — region-level and file-level calls
read from the same symbol-index cache entry per
`(repoPath, state_id)`. The region-level artifact is produced by
**filtering / slicing the symbol-index data in-memory** at
request time:

- `public_api` filters to the requested symbol's signature only.
- `callers` filters to files that import the specific symbol
  (identifier-narrowed from the file-level caller set).
- `callees` filters to call expressions inside the symbol's
  line range.
- `churn` + `ownership` are computed **live per call** with
  `git log -L` / `git blame -L` over the symbol's line range
  (per §3c).
- `tests` is unchanged from file-level.

If the requested symbol is not found in the file's exports, the
CLI returns an error and exits non-zero; the MCP tool returns
`{ "error": "symbol-not-found", "path": ..., "symbol": ... }`.

### 5. `--diff` mode (A3)

`sivru explain <path> --diff` is the actual edit-with-
comprehension trigger: the agent (or human) is mid-edit, wants to
know what depends on what they are about to remove, and asks.

**Algorithm:**

1. Read the working-tree diff for `<path>` against `HEAD`
   (`git diff --no-color HEAD -- <path>`).
2. Parse the diff: identify which exported symbols are **removed**
   by the edit (the symbol name appears in `-` lines outside any
   string literal AND is in the committed-state symbol index's
   exports for `<path>`).
3. For each removed symbol, run the region-level caller analysis
   against the **committed-state** symbol index: who imports this
   file AND mentions this symbol.
4. Emit a `removed_symbols` field in the response:

```jsonc
{
  "path": "<path>",
  "diff_mode": true,
  "removed_symbols": [
    {
      "symbol": "processPayment",
      "callers": [ /* same shape as the regular callers field */ ],
      "callers_truncated": null,
      "callers_skipped_reason": null
    }
  ],
  /* the regular file-level artifact fields are still populated
     against the committed state — diff mode is additive */
}
```

**v0.5 ships REMOVED symbols only.** Symbol *renames* are deferred
to v0.5.x — combining git's line-based `-M`/`-C` rename heuristics
with the identifier+import call-graph (already high-recall / lower-
precision) compounds false positives unsafely.

**Cache interaction.** `--diff` reads the **working tree**, which
is not represented in `state_id`. Rule:

- **Symbol index** is reused from the committed-state cache entry
  per `(repoPath, state_id)` — no rebuild.
- **Diff parsing** is fresh per call — no cache on disk.
- **In-session parse cache (#11).** Within one CLI/MCP invocation,
  a small LRU keyed by `(absPath, mtime)` caches tree-sitter
  parses so a 200-file diff does not re-parse repeated files. The
  cache lives in process memory only and dies with the process.
  No disk footprint.

**Acceptance threshold (#2 — groundable).** The "≤15% false-
positive caller report rate" threshold must be measured, not
asserted. Concretely:

- Test corpus: **≥ 10 fixture cases** designed to be ambiguous
  (delete-and-re-add of a same-named symbol, cross-file shadowing,
  partial-export removals, etc.).
- For each fixture, the test harness compares `--diff` output
  against the hand-curated "true" caller set for the removed
  symbols.
- FP rate = `(reported_callers - true_callers) / reported_callers`
  averaged across the corpus.
- CI asserts **mean FP rate ≤ 15%** AND **corpus size ≥ 10**.

If the rate exceeds 15%: the implementation tightens the
algorithm OR `--diff` ambiguous-case rendering is deferred to
v0.5.x with the test marked as a known-failure. No soft-shipping
a noisy report — the test fails the build.

### 6. Cache + module layout (D1)

**Module layout (D1 — overturns CEO-plan D8).** Explain ships as
`packages/search/src/explain/` — a subdirectory of `@sivru/search`,
not a separate package. Rationale: explain reuses the tree-sitter
chunker, the `state_id` mechanism, the on-disk cache pattern, the
gitignore-aware walker, and the `refreshStale()` invariant. A
separate package duplicated all of these. The subdir gets them
for free, can read the in-process `SivruIndex.Chunk[]` for export
extraction (warm path, §3a), and is consistent with v0.6's
DESIGN-0016 which already ships `packages/search/src/block/` for
the `@sivru` annotation extractor. One package, two adjacent
modules.

**Module structure inside `packages/search/src/explain/`:**

```
packages/search/src/explain/
  types.ts          — Resolver, Export, SymbolIndex, ExplainArtifact
  index.ts          — public exports
  cache.ts          — load / save / refresh symbol index (mirrors
                       packages/search/src/cache/)
  symbol-index.ts   — buildSymbolIndex(repoPath, state_id)
  resolvers/
    typescript.ts   — TS/JS file-level resolver
    python.ts       — Python file-level resolver
    go.ts           — Go package-level resolver
    java.ts         — Java source-root + class-level resolver
  artifact.ts       — assembleArtifact(path, opts): ExplainArtifact
  region.ts         — region-level slicing (A2)
  diff.ts           — --diff mode (A3)
  parse-cache.ts    — in-session LRU parse cache (#11)
```

**Symbol-index cache.** The symbol index is the expensive piece.
Build it on first `sivru explain` against a given `(repoPath,
state_id)`; cache to `~/.cache/sivru/explain/<sha256(repoPath)>/
<state_id>.json`. Reuse verbatim on subsequent calls in the same
repo state. On mtime change to a file, re-index just that file
and patch the cache (incremental, same shape as the search
engine's `refreshStale`). A `SIVRU_EXPLAIN_CACHE_VERSION = 1`
constant lives next to the search cache's `CACHE_FORMAT_VERSION`
so a format change forces a rebuild cleanly. The cache shape is
small and human-readable (JSON, one object per file):
edit-debuggable, gitignored, never published.

**Per-file cache entry:**

```jsonc
{
  "filePath": "packages/cli/src/commands/skill.ts",
  "exports": [
    { "name": "install", "kind": "function",
      "startLine": 42, "endLine": 78 }
  ],
  "imports": [
    { "raw": "import { computeHash } from '../lib/skill-marker.js'",
      "resolved": "packages/cli/src/lib/skill-marker.ts" }
  ],
  "commitCount": 17,
  "mtimeMs": 1779251234000
}
```

The walker's existing `~/.cache/sivru/indexes/` (search) lives
next to `~/.cache/sivru/explain/`. With D1's subdir layout, the
"shared parse on disk" optimisation that was deferred at D14 is
now a **same-module refactor** — when measured to matter, the
chunker can write `imports[]` directly into search's cache entry
and explain reads from it. Not v0.5 scope; the cleanest place to
hold the option is now in-module.

**`commitCount` cache invariant (D2).** The per-file `commitCount`
is computed at build via **one** `git log --name-only
--pretty=format: --no-renames HEAD` walk parsed into a
`Map<file, count>` and applied to every per-file entry. Same
state_id-keyed invalidation. The MCP cap sort (§2a, D15) reads
`commitCount` directly from cache entries — zero git invocations
per MCP request.

**Cold-build time budget (D3 — two-tier).** The acceptance gate
is **p95 cold symbol-index build < 15 seconds on macos-latest**
GitHub Actions runner (CI assertion). The developer-machine
target is **< 6 seconds on Apple Silicon M-series** (documented
quality bar in CHANGELOG; not asserted on CI). Catches order-of-
magnitude regressions while honest about hardware variance.

**Threat model (#6 — expanded).**

- **Absolute paths / `..` escapes** in the user-supplied `<path>`
  argument: rejected by D11's path validator (must be a relative
  path inside the repo).
- **Symlinks out of the repo:** explain runs `realpath(<path>)`
  and asserts the resolved path is inside `realpath(repoRoot)`.
  Failed assertion → error code `SIVRU-Exxxx` (claimed in PR),
  no read.
- **Hostile `.sivru/explain.json`:** the `mcpCap` field cannot
  uncap MCP output — every read is `min(configValue, 500)` per
  A4's hard ceiling. Same clamp applies to `SIVRU_EXPLAIN_MCP_CAP`.
- **Tests pattern match.** The filename-pattern match (§3d) only
  globs inside the realpath-validated repo root; matched test
  paths re-validated through realpath before any `grep` reads
  them.
- **Signature exposure.** Explain DOES return public-API signature
  text in `public_api[].signature`. This is the same data
  surfaced by any other reader of the file; explain does not read
  function bodies. The footer string says so.

### 7. Honest scope

What v0.5 deliberately is *not*:

- **Not an LSP.** No type resolution, no rename refactoring, no
  cross-language go-to-definition. Identifier + import is the
  signal; precision tradeoffs are stated in the output.
- **Not a quality judgement.** No "this file is too long" or
  "consider splitting." That is v0.7's coach loop, with FP-rate
  discipline.
- **Not a search replacement.** `sivru.search` finds *where*;
  this tells you *what* about a known location.
- **Not a rename-aware diff.** v0.5's `--diff` ships removals
  only; renames are v0.5.x.
- **Not Go-file-level / Java-file-level.** Go callers resolve at
  package granularity, Java at source-root + class granularity.
  Above a `max(100, repoFileCount * 0.05)` fan-out (D16 + D4)
  the field returns `null` with a `precision-floor` reason.

## Alternatives considered

**Full LSP-grade resolution.** Type-aware callers/callees would be
precise but require per-language type servers, far more than three
weeks. The identifier+import approach is boring by default and
good enough for human + agent comprehension. Re-evaluate if FP
rate is a real complaint.

**LLM-based summary.** Ask an LLM to "explain this file." Reads
fluent; non-deterministic, expensive per call, no token-free local
mode, and worst: it makes up callers. Rejected for the descriptive
core; an `--llm-summary` add-on could ship in a later patch.

**Re-derive on every call, no cache.** A 5000-file repo takes long
enough to re-parse that the agent would visibly wait. The search
engine already caches; explain follows the same precedent.

**Separate `@sivru/explain` package (CEO-plan D8 — overturned by
eng-review D1).** The CEO plan locked explain as a separate
package. Eng-review reversed this. Rationale: explain reuses the
chunker, walker, state_id, cache layer, and `Chunk[]` shape from
`@sivru/search`; the chunker's `symbolName`/`nodeType` annotation
specifically exists "so v0.6 binds without re-parsing" (packages/
search/src/types.ts:30-36). A separate package duplicated all of
these primitives across a boundary that the v0.6 plan
(DESIGN-0016) already places inside `@sivru/search`. The subdir
gets the warm-path Chunk[] reuse for free and consolidates the
search/comprehension module set.

**Piggyback on the search index build (D14).** Tempting — the
chunker already parses every file via tree-sitter. Extending its
output with raw `imports[]` resolved at parse time would make the
first `sivru explain` call ~5–10 seconds faster on a populated
search cache. Deferred for v0.5. With D1's subdir layout, the
optimisation is a same-module refactor (no cross-package release
coordination) — tracked in TODOS.md as a v0.x perf patch when
measured to matter.

**Enrich `find_related` instead of shipping a new MCP tool
(D13 option B in the CEO plan).** The outside-voice reviewer
argued `find_related` already routes well in v0.4's bench and
adding explain's payload to its response would ride the proven
routing surface. Rejected: `find_related` is a *similarity*
engine over `Chunk[]` (cosine + BM25), not a structured-metadata
surface. Reading its implementation
(`packages/cli/src/mcp-entry.ts:424-481`) confirms the two
tools are different in kind. The v0.4 routing-gap critique is
acknowledged context; the coach loop (v0.7+) is the named release
line it gets addressed in.

## Open questions resolved by CEO + eng + outside-voice review

The Draft's three open questions are resolved:

- **Region granularity.** Region-level explain ships in v0.5 (A2;
  §4). The CLI surface is `path::symbol`, the MCP shape adds an
  optional `symbol` field. No per-symbol cache; slice from the
  symbol-index cache entry at request time.
- **TS path aliases / `tsconfig.json` paths**, monorepo `paths`,
  Python `src/` vs flat layout. **Deferred to v0.5.x.** v0.5
  handles relative imports only. The footer string names the
  limitation.
- **Go and Java cross-file precision.** v0.5 ships at Go *package*
  granularity and Java *source-root + class* granularity, surfaced
  in the footer. The **D16 + D4 scaled precision floor**
  (`callers: null` + `callers_skipped_reason: "precision-floor"`
  when fan-out > `max(100, repoFileCount * 0.05)`) prevents the
  noise-flood failure mode. Finer-grained per-file resolution is
  a v0.x follow-up if a user reports the precision gap.
- **Markdown layout.** Settled in eng-review iter-6: the §1 sketch
  is the layout; section ordering matches the JSON shape order.

## Acceptance criteria

- `sivru explain <path>` produces the five sections; `--json`
  returns the canonical artifact JSON shape in §1 with every field
  present (including `authored: []`, `callers_truncated`,
  `callees_truncated`, `callers_skipped_reason`, `footer`).
- The MCP tool `sivru.explain({ path, symbol?, diff?, since?,
  depth? })` returns the **envelope shape** in §1 with `tool`,
  `path`, `latencyMs`, `refreshMs`, `refreshDelta`, `artifact`
  fields, matching the existing `search` / `find_related` shape.
  Its always-on `description` carries the routing hint per §2.
- Argument validation is hand-rolled (no zod dependency); matches
  the `parseSearchArgs` / `parseFindRelatedArgs` convention.
- Module location: `packages/search/src/explain/` subdirectory of
  `@sivru/search` (per D1; overturns CEO-plan D8). No new package.
- The symbol index is built on first call per `(repoPath,
  state_id)`, cached, and incrementally refreshed on file mtime
  change.
- **Per-file `commitCount` field cached** in the symbol-index
  (D2); MCP cap sort (§2a) reads commitCount from cache with
  **zero git invocations per request**.
- **Two-tier cold-build budget (D3):** CI asserts p95 < 15s on
  macos-latest; CHANGELOG documents < 6s target on Apple Silicon
  M-series (not asserted on CI).
- Cross-file callers/callees work for TS, JS, Python (file-level)
  and Go, Java (package/class-level, with the scaled D16 + D4
  precision floor `max(100, repoFileCount * 0.05)`).
- All resolvers implement the shared `Resolver` interface (§3b).
- Output footer states the resolution model honestly (identifier
  + import; not type-resolved; Go-package / Java-class
  granularity; relative-imports-only for TS path resolution;
  actual `floor` value chosen for the repo).
- Churn + ownership computed via local `git`; no network call.
  File-level ownership uses `git shortlog -ns` (not `git blame`);
  region-level uses `git log -L` / `git blame -L` per §3c.
- **Region-level (§4):** `sivru explain pkg/foo.ts::processPayment`
  CLI works and matches the canonical artifact shape with the
  `symbol` filter applied. MCP equivalent
  (`sivru.explain({ path, symbol })`) returns the same shape
  wrapped in the envelope.
- **`--diff` mode (§5):** detects exported-symbol removals;
  renames produce no output (deferred to v0.5.x); CI test asserts
  **mean FP rate ≤ 15% over ≥ 10 ambiguous fixture cases**. If
  the corpus is < 10 or FP > 15%, the build fails.
- **MCP cap (§2a):** 30 callers + 30 callees independently; hard
  ceiling 500 (config `0` means "use ceiling"); sort by
  `commitCount` ascending (cached, D2), then mtime ascending
  tiebreaker; `*_truncated` fields populated when capped.
- **D16 + D4 scaled precision floor:** if Go-package / Java-class
  fan-out > `max(100, repoFileCount * 0.05)` for a single symbol,
  `callers: null` and `callers_skipped_reason: "precision-floor"`.
- **Threat model:** path-validator rejects `..` escapes and
  absolute paths; `realpath()` check confirms resolved path stays
  inside the repo root; `mcpCap` config + env value is clamped
  to `min(value, 500)`; test-pattern matching is realpath-
  validated.
- **`authored` field reconciliation gate (#12 + A1):** in v0.5
  the JSON-shape test asserts only `typeof artifact.authored ===
  "object" && Array.isArray(artifact.authored)` (compatible with
  v0.6's filled values). **DESIGN-0016** (v0.6 `@sivru` blocks)
  has a "DESIGN-0004 reconciliation gate" section pinning the
  contract; the v0.6 PR description MUST include the named
  reconciliation section.
- **`refreshStale` after edit:** MCP integration test edits a
  fixture file's exports then calls `sivru.explain` on it →
  response reflects the new exports (the staleness invariant
  `search` and `find_related` already enforce; mcp-entry.ts:391).
- `sivru help` lists `explain`.
- A `SIVRU-Exxxx` error code range is claimed in the PR
  description for the new error classes (cache load failure,
  unknown language, malformed path, symbol-not-found, symlink-
  escape).

## Test plan

- **Unit — public API extraction.** Per-language fixtures (reuse
  v0.2's `__fixtures__/`) → expected exports + signatures.
- **Unit — symbol index per language.** For each of TS/JS/Py/Go/Java
  fixtures: imports resolve to the right target file/package;
  exports list matches.
- **Unit — Resolver interface conformance.** Every resolver
  satisfies the `Resolver` type (TypeScript compile check) and
  passes a shared minimum-contract test suite.
- **Unit — callers / callees.** A fixture pair (`foo.ts` exports
  `bar`, `baz.ts` imports `bar`) → callers of `foo.ts` includes
  `baz.ts:<line>`; callees of `baz.ts` resolves back to `foo.ts`.
- **Unit — identifier shadowing.** A common name (`get`) defined
  in two files; the resolution stays scoped by import path —
  proves identifier+import is stricter than identifier-only.
- **Unit — churn / ownership.** Mock git output → expected counts
  + author percentages. File-level uses `git shortlog`; region-
  level fixture exercises `git log -L` and `git blame -L` mock
  paths.
- **Unit — `commitCount` cache (D2).** Fixture repo with 5 files
  of varying commit counts → cached commitCount matches `git log
  --oneline -- <file> | wc -l` for each file. State_id change
  forces recompute.
- **Unit — test-file detection.** Per-language naming conventions.
- **Unit — JSON shape.** The artifact JSON object passes a hand-
  rolled schema check (no zod). Asserts
  `Array.isArray(artifact.authored)` and the truncation /
  precision-floor markers default to `null`.
- **Unit — MCP envelope shape.** `sivru.explain` MCP response has
  `tool`, `path`, `latencyMs`, `refreshMs`, `refreshDelta`,
  `artifact` fields. Matches `formatSearchResultEnvelope` shape.
- **Unit — MCP cap behaviour (§2a).** Synthetic 600-caller
  fixture: `mcpCap=30` returns 30 entries + `callers_truncated:
  570`; `mcpCap=1000` returns 500 entries + `callers_truncated:
  100` (clamped); `mcpCap=0` returns 500 entries (ceiling, not
  uncapped); sort verified as `commitCount` ascending, mtime
  ascending tiebreaker. **Zero git invocations during the cap
  sort** (asserted by mocking `execFile` and counting calls).
- **Unit — D16 + D4 scaled precision floor.** Synthetic Java
  fixture with `repoFileCount = 200, fanout = 80` → callers
  returned (under floor 100). `repoFileCount = 5000, fanout =
  280` → callers returned (under floor 250). `repoFileCount =
  5000, fanout = 280, but Go package fanout = 300` →
  `callers: null`, `callers_skipped_reason: "precision-floor"`.
  Footer reports floor value.
- **Unit — threat model.** Path-validator rejects `../etc/passwd`
  and `/etc/passwd`; symlink fixture pointing outside the repo
  returns the `SIVRU-Exxxx` symlink-escape error; test-pattern
  match against a symlinked test file outside the repo refuses
  to read.
- **Integration — `buildSymbolIndex` over a fixture repo.** A
  small multi-file repo → index round-trips through cache; an
  mtime bump on one file → incremental refresh updates only
  that entry. `commitCount` populated per file.
- **Integration — refreshStale-after-edit.** Build the index over
  a fixture repo; modify a file's exports; call `sivru.explain`
  on that file via the MCP server → response artifact reflects
  the new exports. Mirrors the `searchTool` /  `findRelatedTool`
  staleness invariant (mcp-entry.ts:391-397).
- **Integration — warm-path Chunk[] reuse (D1).** Build a
  `SivruIndex` for the fixture repo; call `sivru.explain` on a
  file that's in the index → assert no fresh tree-sitter parse
  was invoked (mock `treeSitterChunks` and count calls).
- **Integration — region-level (§4).** Fixture file with two
  exported symbols → `explain path::symbolA` returns only
  symbolA's public_api, callers narrowed to symbolA mentions,
  callees within symbolA's line range. `git log -L` mock path
  exercised.
- **Integration — `--diff` mode (§5).** Working-tree fixture
  removes one exported symbol → `--diff` returns the symbol's
  callers under `removed_symbols`. Rename fixture produces no
  `removed_symbols` (deferred).
- **Integration — `--diff` in-session parse cache (#11).**
  Synthetic 50-file diff invoked twice in one process → second
  invocation's parse count is 0 (LRU hit). New process →
  re-parses (no disk cache, by design).
- **Integration — `--diff` FP corpus (#2).** ≥ 10 ambiguous
  fixtures; CI fails if corpus < 10 OR mean FP rate > 15%. Per-
  fixture FP rate logged in test output.
- **Integration — cold-build budget (D3).** A 2000-file TS
  fixture repo → cold `sivru explain` measures p95 build time
  across N≥5 runs. CI on macos-latest asserts `p95 < 15s`.
  Developer-machine test (Apple Silicon detection) logs a warning
  if p95 > 6s without failing.
- **CLI smoke.** `sivru explain packages/cli/src/commands/skill.ts`
  prints all five sections plus `AUTHORED (none yet — see v0.6)`;
  `--json` is valid JSON matching the canonical artifact shape;
  footer reports `floor` value.
- **MCP integration.** `sivru.explain(path)` and
  `sivru.explain({ path, symbol })` and
  `sivru.explain({ path, diff: true })` over the MCP server
  each return the expected envelope-wrapped JSON.
- **Honest-scope check.** A file with dynamic imports / runtime
  dispatch → the output's footer states the limitation, and the
  result is empty-or-best-effort, never silently wrong.

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in defaults.** All five sections enabled; markdown
   output; call-graph depth 1; churn window 90 days; MCP cap 30
   each (with hard-ceiling 500); precision floor
   `max(100, repoFileCount * 0.05)`.
2. **Declarative override.** `~/.config/sivru/explain.json` and
   `.sivru/explain.json` accept `{ sections, callGraphDepth,
   format, sinceDays, mcpCap }`. Project config beats user
   config. `mcpCap` is always clamped to `min(value, 500)`.
   `precisionFloor` user-override is deferred to v0.5.x.
3. **Code-level extension.** `.sivru/explain/*.ts` register
   custom analyzers — punted to a v0.x patch (the interface
   ships internal-only in v0.5; the public surface lands once
   a real user wants it).

## Effort

Roadmap budget: ~3 weeks. After all locked decisions: **~5–6.5
weeks**.

| Item | Working days | Cumulative |
|------|--------------|------------|
| Baseline (file-level explain, original Draft) | ~15 (~3 weeks) | ~3 weeks |
| A1 `authored` reserve | +0.5 | ~3 weeks |
| A2 Region-level explain | +4–5 | ~3.5–4 weeks |
| A3 `--diff` mode (+ groundable FP test corpus) | +5 | ~4.5–5 weeks |
| A4 MCP cap (+ D15 + #10 + D2 commitCount cache) | +1.5–2.5 | ~5–6.5 weeks |
| D16 + D4 scaled precision floor | (within A2) | — |
| #4 region churn via `git log -L` | (within A2) | — |
| #6 symlink/realpath threat model | +0.5 | — |
| D3 two-tier cold-build acceptance test | +0.5 | — |
| #11 in-session parse cache | (within A3) | — |
| #12 reconciliation gate copy | +0 (doc-only) | — |
| D1 subdir scaffold (vs new package) | -0.5 (savings) | — |
| Folded fixes (envelope, shortlog, resolver iface) | +0.5 | — |

The upper bound (~6.5 weeks) is the honest figure; ~5–6 weeks
absorbed buffer silently. The honest risk: TS path-aliases /
Python flat-vs-src / Go package resolution edge cases. The
open-questions section names them; the scaled precision floor
catches the worst-case Go/Java noise; relative-imports-only is
the shipped TS contract for v0.5.

---

## GSTACK REVIEW REPORT

*Last section per `/plan-eng-review` skill — review log, decisions
ledger, dashboard, next-steps.*

### Iteration history

| Iter | Reviewer | Outcome | Findings | Lock state |
|------|----------|---------|----------|------------|
| 1 | `/plan-ceo-review` spec-review | REVISE | 11 issues, 6/10 quality | DESIGN-0004 stale relative to accepted expansions |
| 2 | `/plan-ceo-review` spec-review | REVISE | 8 issues | Refinements: FP groundability, JSON shape, A2 cache, sort field, design-doc sync gate |
| 3 | `/plan-ceo-review` spec-review | **PASS** | 9/9/9/9/8 | CEO plan accepted with A1–A4 |
| 4 | outside-voice independent reviewer | REVISE | 14 issues (4 P0) | Strategic + precision-floor + sort direction + symbol-index drift |
| 5 | DESIGN-0004 rewrite (this doc, prior commit) | review-stable | — | D13–D16 + 7 folded fixes absorbed |
| 6 | `/plan-eng-review` (this section) | **PASS** | 4 issues (1 P0, 3 P1), all resolved | D1–D4 + 6 folded fixes absorbed; **Status promoted Draft → Accepted** |

### Decisions ledger

**CEO plan (locked iter-3):** A1 (`authored` field), A2 (region-
level), A3 (`--diff` removed-only with groundable FP threshold),
A4 (MCP cap 30/30 + hard ceiling 500). Open questions: Go/Java
precision = accept with footer + D16; TS path aliases = defer.

**Outside-voice (locked iter-4):**

- **D13** — Stay the course on v0.5 scope. v0.4 routing data
  acknowledged; coach loop (v0.7+) is the named answer.
- **D14** — Defer shared-parse optimisation to TODOS.md.
- **D15** — Flip MCP cap sort from `mtime-desc` to **commit-count-
  asc, mtime-asc tiebreaker**.
- **D16** — Hard precision floor at 100 callers for Go/Java; later
  scaled per D4.

**Eng-review (this iter-6):**

- **D1 — OVERTURNS CEO-plan D8.** Explain ships as
  `packages/search/src/explain/` subdirectory of `@sivru/search`,
  not a separate package. Rationale: chunker's `Chunk[]` already
  carries `symbolName`/`nodeType`; the subdir reuses every
  primitive (walker, state_id, cache, refreshStale) cleanly and
  is consistent with v0.6's DESIGN-0016 already shipping
  `packages/search/src/block/`.
- **D2 — D15 cost mitigation.** Cache `commitCount` per file in
  the symbol-index at build via one `git log --name-only` walk
  bucketed by file. MCP cap sort reads commitCount from cache,
  zero git invocations per request.
- **D3 — Two-tier cold-build budget.** CI gates p95 < 15s on
  macos-latest. Developer-machine target < 6s on Apple Silicon
  M-series, documented in CHANGELOG.
- **D4 — D16 floor scales with repo size:** `max(100,
  repoFileCount * 0.05)`. Footer surfaces the actual chosen
  value.

**Folded fixes (this iter-6, no separate decision):**

- MCP response envelope shape matches `formatSearchResultEnvelope`
  (latencyMs, refreshMs, refreshDelta, artifact).
- Argument parsing hand-rolled (no zod), matches `parseSearchArgs`
  convention.
- `refreshStale`-after-edit MCP integration test added.
- Per-language `Resolver` interface specified in §3b.
- File-level ownership uses `git shortlog -ns` (faster than blame).
- DESIGN-0016 (v0.6) stub updated with the **"DESIGN-0004
  reconciliation gate"** section pinning the v0.5 → v0.6 contract.

### Dashboard

| Surface | State |
|---------|-------|
| Module location | `packages/search/src/explain/` (D1) |
| Canonical artifact JSON shape | Specified (§1) |
| MCP envelope shape | Specified (§1) — matches search/find_related |
| CLI surfaces | `<path>`, `<path>::<symbol>`, `--diff`, `--json`, `--since`, `--depth` |
| MCP surface | `sivru.explain({ path, symbol?, diff?, since?, depth? })` capped per §2a |
| Cache | `~/.cache/sivru/explain/...` symbol-index only; `commitCount` cached per-file; version 1 |
| Threat model | path-validator + realpath + hard-ceiling clamp + test-pattern realpath |
| Acceptance | CI cold-build < 15s; dev target < 6s; FP-rate ≤ 15% over ≥ 10 `--diff` fixtures; scaled precision floor |
| Resolver interface | Specified (§3b) |
| Reconciliation gate | DESIGN-0016 stub updated |
| Effort | ~5–6.5 weeks |
| Open questions | All four resolved |
| Sync prerequisites | All eng-review decisions absorbed in this rewrite |

### Outside voice (this eng-review)

Skipped. Outside-voice was just run in CEO iter-4 (14 findings
absorbed into the iter-5 rewrite less than an hour before this
review). Running it a second time on the same scope so quickly
is double-work; the eng-review's own findings (D1–D4) are
informed by the same code-reading pass that would have grounded
a second outside voice. Recorded for the review log as
"skipped — recent fresh data".

### VERDICT

**CLEARED.** Eng-review iter-6 PASS. All four substantive
findings (1 P0, 3 P1) resolved via D1–D4. Six folded fixes
absorbed. DESIGN-0004 promoted from Draft (review-stable) to
**Accepted**.

### Next steps

1. **Update task sidecar** (`docs/design/0004-sivru-explain.tasks.md`
   + JSONL) to reflect D1 (T1 = subdir scaffold, not package),
   D2 (new T_commit-count-cache task), D3 (T17 two-tier), D4
   (T11 scaled floor), and the folded resolver-interface +
   refreshStale-after-edit test additions.
2. **`/auto-ship`** in a worktree on `design/sivru-explain`.
   The doc is Accepted; the tasks are buildable.
3. **v0.5.0 ship** — tag once CI green, CHANGELOG updated, bench
   numbers honest. Instrument routing-correctness on the explain
   tool (per D13: if explain adoption < 20%, the v0.4 routing
   data was right and the coach loop should be pulled forward).

### Handoff note

DESIGN-0004 is **Accepted** as of 2026-05-20. Three reviews (CEO
iter-3 PASS, outside-voice iter-4 absorbed, eng-review iter-6
PASS) have shaped the spec across §1–§7, acceptance criteria,
and test plan. The doc is implementation-ready; the next handoff
is `/auto-ship` against the task sidecar.
