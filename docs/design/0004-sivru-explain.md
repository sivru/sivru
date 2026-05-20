# DESIGN-0004: `sivru explain <path>`

**Status:** Draft (review-stable; promote to Accepted on
`/plan-eng-review` PASS)
**Class:** Spine (per [GOALS.md](../../GOALS.md))
**Targets:** v0.5.0
**Issue:** filed when v0.5 work starts
**Created:** 2026-05-08
**Updated:** 2026-05-20 — absorbed CEO-plan iter-3 PASS (A1–A4) and
outside-voice iter-4 decisions (D13–D16 + seven folded fixes).
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
v0.6's `@sivru` annotation blocks layer authored *why* on top of the
derived *what* this release ships.

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
no quality judgements (v0.9's coach loop does judgement; this does
not).

The CLI markdown rendering is one cut over the same JSON the MCP
tool returns. The JSON shape is the contract; the markdown is the
human surface. **Canonical JSON shape:**

```jsonc
{
  "path": "<file path or path::symbol>",
  "public_api":     [ /* exported symbols with signatures */ ],
  "callers":        [ /* 1-hop, capped per A4 in MCP only */ ],
  "callees":        [ /* 1-hop, capped per A4 in MCP only */ ],
  "churn":          { /* commit count, last commit, since-days */ },
  "ownership":      { /* last author, top contributors with % */ },
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
exceeds the precision floor (§3b, D16) and the field returns
`null` rather than a noisy 200-entry list. `authored: []` is the
A1 prepay slot for v0.6.

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
  last author:  pochadri
  top 3:        pochadri 100% (37 lines)

TESTS
  packages/cli/src/commands/skill.test.ts  (38 cases)

AUTHORED  (none yet — see v0.6)

FOOTER
  call graph is identifier-based; not type-resolved — expect
  false positives on common names. Go callers resolve at package
  granularity; Java at source-root + class granularity.
```

Output formats: `markdown` (default), `--json` for tooling. The MCP
tool returns the JSON shape directly.

### 2. Surfaces

- **CLI:** `sivru explain <path> [--json] [--since=<N>] [--depth=1]
  [--diff]`. The CLI is **uncapped** — both markdown and `--json`
  return the full caller/callee lists, no truncation.
- **CLI region-level:** `sivru explain <path>::<symbol>` — see §4.
- **CLI diff mode:** `sivru explain <path> --diff` — see §5.
- **MCP tool:** `sivru.explain({ path, symbol?, diff?, since?, depth? })`
  — the agent calls it before edits. The MCP response **is capped**
  per A4 (§2a).

The MCP tool's always-on `description` is the channel that actually
makes the agent reach for it (per the v0.4 pattern):

> *"Get the public API, callers, callees, churn, and ownership of
> a file or symbol before editing it. Use after locating a file
> and before changing a symbol — it surfaces who else depends on
> what you are about to touch. `diff: true` shows what an in-
> progress edit is about to break."*

The SKILL.md body (from v0.4) is updated to mention `explain` in
the after-editing-locate-the-file workflow. v0.4's measured
routing data (76% with skill, 56% without, sub-agents bypass the
skill entirely) is acknowledged context for v0.5: the coach loop
(v0.9–11) is the named release that addresses low-context-edit
detection. v0.5 does not try to fix delegation.

#### 2a. MCP token cap (A4 + D15 + #10)

- **Defaults:** 30 callers AND 30 callees, applied **independently**.
- **Sort (D15):** by `git log --oneline -- <file> | wc -l`
  **ASCENDING** (stable / low-churn first), ties broken by file
  mtime **ascending**. Surfaces the dangerous legacy callers the
  agent does not already know about; recently-touched callers
  drop into the truncated tail.
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
  │   (reuses v0.2 grammars + chunker AST)
  │
  ├─ symbol-index lookup                → callers + callees
  │   (per-repo index: file → exports[], imports[resolved])
  │   built on first explain, cached, mtime-invalidated
  │
  ├─ git log <path>                     → churn (commit count, last)
  │   (region-level: git log -L for path::symbol — see §4)
  │
  ├─ git blame <path> aggregated        → ownership (top authors %)
  │
  └─ test-file pattern match            → test hint
```

**3a. Public API.** Reuses the v0.2 tree-sitter substrate. The
chunker already returns `Chunk[]` with `nodeType` + `symbolName`; the
explain layer keeps the *exported* symbols and pulls each one's
signature line range out of the same parse. No new parser, no new
grammar work. The five covered languages (TS, JS, Python, Go, Java)
are first-class; uncovered languages get an empty `public_api`
section with an honest "language not yet supported" note.

**3b. The 1-hop call graph.** Computed against a per-repo
**symbol index** that maps, for each file:

- `exports`: name → kind (function / class / type / const) + the
  AST range, extracted via tree-sitter from the same parse the
  chunker already runs.
- `imports`: each import statement → the *resolved* path of what
  is being imported (i.e. the on-disk file the import targets).

Resolution is best-effort and language-specific:

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

**Go / Java precision floor (D16).** Package-level (Go) and
source-root + class-level (Java) resolution can fan out to
hundreds of "callers" for common utility files. A footer
disclaimer cannot fix a 200-row noise flood. The rule:

> If a single Go-package or Java-class call-site query yields
> **> 100 candidate callers** for one symbol, explain returns
> `callers: null` AND `callers_skipped_reason: "precision-floor"`
> for that symbol. The footer still names the granularity caveat.

Visible degradation > noisy output. The 100-row threshold is a
constant; refining it (or per-language tuning) is a follow-up if
real-world users complain it cuts too aggressively.

**3c. Churn + ownership.**

- **File-level** (default): `git log --follow --since=<N> -- <path>`
  for change count and last commit; `git blame --line-porcelain
  <path>` aggregated by author for the ownership block. No
  network. The walker already shells out to `git` for `state_id`,
  so this is the same pattern.
- **Region-level** (`path::symbol`): the line range comes from the
  symbol index. Churn uses
  `git log -L <startLine>,<endLine>:<path> --since=<N>`;
  ownership uses `git blame --line-porcelain -L <startLine>,
  <endLine> <path>`. Both are computed **live per call** — there
  is no region-level churn cache. The symbol index gives us the
  range cheaply; git provides the per-region log. This is the
  #4 fix (region churn was elided in the CEO plan).

**3d. Tests.** A filename-pattern match the chunker can derive:
`<path>.test.<ext>`, `<dir>/__tests__/<basename>.*`,
`<dir>/<stem>.spec.<ext>`, `<dir>/<stem>_test.<ext>` (Go),
`test_<stem>.py` (Python). Test count is a `grep` for `it(` /
`test(` / `def test_` in the matched file — informational, not
precise.

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

**Acceptance threshold (#2 fix — groundable).** The
"≤15% false-positive caller report rate" threshold must be measured,
not asserted. Concretely:

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

### 6. Cache

The symbol index is the expensive piece. Build it on first
`sivru explain` against a given `(repoPath, state_id)`; cache to
`~/.cache/sivru/explain/<sha256(repoPath)>/<state_id>.json`. Reuse
verbatim on subsequent calls in the same repo state. On mtime
change to a file, re-index just that file and patch the cache
(incremental, same shape as the search engine's `refreshStale`).

A `SIVRU_EXPLAIN_CACHE_VERSION = 1` constant lives next to the
search cache's version so a format change forces a rebuild
cleanly. The cache shape is small and human-readable (JSON, one
object per file): edit-debuggable, gitignored, never published.

The walker's existing `~/.cache/sivru/indexes/` lives next door;
the two are independent. **Note (D14):** the optimisation of
sharing the chunker parse with explain (one walk for both
indexes) is real but rejected for v0.5 — it would bump the search
cache format mid-release-cycle and couple @sivru/explain to
@sivru/search's cache schema. Tracked in TODOS.md as a v0.x perf
patch when measured to actually matter.

**Cold-build time budget (#9).** The acceptance gate is **p95
cold symbol-index build < 6 seconds on a 2000-file TypeScript
repo** (Apple Silicon, M-series). Below: ship. Above: optimise
or surface the regression in CHANGELOG with a release note.

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
- **Signature exposure:** explain DOES return public-API signature
  text in `public_api[].signature`. This is the same data
  surfaced by any other reader of the file; explain does not read
  function bodies. The footer string says so.

### 7. Honest scope

What v0.5 deliberately is *not*:

- **Not an LSP.** No type resolution, no rename refactoring, no
  cross-language go-to-definition. Identifier + import is the
  signal; precision tradeoffs are stated in the output.
- **Not a quality judgement.** No "this file is too long" or
  "consider splitting." That is v0.9's coach loop, with FP-rate
  discipline.
- **Not a search replacement.** `sivru.search` finds *where*;
  this tells you *what* about a known location.
- **Not a rename-aware diff.** v0.5's `--diff` ships removals
  only; renames are v0.5.x.
- **Not Go-file-level / Java-file-level.** Go callers resolve at
  package granularity, Java at source-root + class granularity.
  Above a 100-caller fan-out (D16) the field returns `null` with
  a `precision-floor` reason.

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

**Piggyback on the search index build (D14).** Tempting — the
chunker already parses every file via tree-sitter. Extending its
output with raw `imports[]` resolved at parse time would make the
first `sivru explain` call ~5–10 seconds faster on a populated
search cache. Rejected for v0.5: bumps the search cache format
mid-release-cycle (every existing v0.4 user rebuilds on upgrade)
AND couples @sivru/explain to @sivru/search's cache schema. The
two-parse cost is paid once per repo state. Tracked in TODOS.md
as a v0.x perf patch when measured to matter.

**Enrich `find_related` instead of shipping a new MCP tool (D13
option B).** The outside-voice reviewer argued `find_related`
already routes well in v0.4's bench and adding explain's payload
to its response would ride the proven routing surface. Rejected:
conceptually muddies `find_related`'s identity (related code AND
file/symbol explainer in one tool); v0.6/v0.7 block-surfacing
would need to be rewired through `find_related`. The CLI command
`sivru explain` is the human surface; the MCP tool `sivru.explain`
is the agent surface — keeping them named and separate matters
for the v0.6/v0.7 follow-ons. The v0.4 routing-gap critique is
acknowledged context; the coach loop (v0.9–11) is the named place
it gets addressed.

## Open questions resolved by CEO + outside-voice review

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
  in the footer. The **D16 precision floor** (`callers: null`
  + `callers_skipped_reason: "precision-floor"` when fan-out
  > 100) prevents the noise-flood failure mode. Finer-grained
  per-file resolution is a v0.x follow-up if a user reports the
  precision gap.
- **Markdown layout.** The sketch in §1 is one cut; the MCP path
  cares only about the JSON shape. Rubber-stamp the section
  ordering in `/plan-eng-review`.

## Acceptance criteria

- `sivru explain <path>` produces the five sections; `--json`
  returns the canonical JSON shape in §1 with every field
  present (including `authored: []`, `callers_truncated`,
  `callees_truncated`, `callers_skipped_reason`, `footer`).
- The MCP tool `sivru.explain({ path, symbol?, diff?, since?,
  depth? })` returns the JSON artifact; its always-on
  `description` carries the routing hint per §2.
- The symbol index is built on first call per `(repoPath,
  state_id)`, cached, and incrementally refreshed on file mtime
  change.
- **Cold-build budget:** p95 cold symbol-index build **< 6
  seconds on a 2000-file TS repo** (Apple Silicon, M-series).
- Cross-file callers/callees work for TS, JS, Python (file-level)
  and Go, Java (package/class-level, with the D16 precision-
  floor of 100).
- Output footer states the resolution model honestly (identifier
  + import; not type-resolved; Go-package / Java-class
  granularity; relative-imports-only for TS path resolution).
- Churn + ownership computed via local `git`; no network call.
  Region-level uses `git log -L` / `git blame -L` per §3c (#4).
- **Region-level (§4):** `sivru explain pkg/foo.ts::processPayment`
  CLI works and matches the canonical JSON shape with the
  `symbol` filter applied. MCP equivalent
  (`sivru.explain({ path, symbol })`) returns the same shape.
- **`--diff` mode (§5):** detects exported-symbol removals;
  renames produce no output (deferred to v0.5.x); CI test asserts
  **mean FP rate ≤ 15% over ≥ 10 ambiguous fixture cases**. If
  the corpus is < 10 or FP > 15%, the build fails.
- **MCP cap (§2a):** 30 callers + 30 callees independently; hard
  ceiling 500 (config `0` means "use ceiling"); sort by
  **commit-count ascending, then mtime ascending** (D15);
  `*_truncated` fields populated when capped.
- **D16 precision floor:** if Go-package / Java-class fan-out > 100
  for a single symbol, `callers: null` and
  `callers_skipped_reason: "precision-floor"`.
- **Threat model:** path-validator rejects `..` escapes and
  absolute paths; `realpath()` check confirms resolved path stays
  inside the repo root; `mcpCap` config + env value is clamped
  to `min(value, 500)`.
- **`authored` field reconciliation gate (#12 + A1):** in v0.5
  the JSON-shape test asserts only `typeof artifact.authored ===
  "object" && Array.isArray(artifact.authored)` (compatible with
  v0.6's filled values). DESIGN-0005 (v0.6 `@sivru` blocks) PR
  description MUST include a "DESIGN-0004 reconciliation"
  section listing the `authored` field's v0.6 contract — this is
  the DESIGN-0001 reconciliation-gate pattern carried forward.
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
- **Unit — callers / callees.** A fixture pair (`foo.ts` exports
  `bar`, `baz.ts` imports `bar`) → callers of `foo.ts` includes
  `baz.ts:<line>`; callees of `baz.ts` resolves back to `foo.ts`.
- **Unit — identifier shadowing.** A common name (`get`) defined
  in two files; the resolution stays scoped by import path —
  proves identifier+import is stricter than identifier-only.
- **Unit — churn / ownership.** Mock git output → expected counts
  + author percentages. Region-level fixture exercises
  `git log -L` and `git blame -L` mock paths.
- **Unit — test-file detection.** Per-language naming conventions.
- **Unit — JSON shape.** The artifact's JSON object passes a
  schema check (Zod or hand-rolled assert). Asserts
  `Array.isArray(artifact.authored)` and the truncation /
  precision-floor markers default to `null`.
- **Unit — MCP cap behaviour (§2a).** Synthetic 600-caller
  fixture: `mcpCap=30` returns 30 entries + `callers_truncated:
  570`; `mcpCap=1000` returns 500 entries + `callers_truncated:
  100` (clamped); `mcpCap=0` returns 500 entries (ceiling, not
  uncapped); sort verified as commit-count-asc, mtime-asc
  tiebreaker.
- **Unit — D16 precision floor.** Synthetic Java fixture with
  120 importers of one class → `callers: null`,
  `callers_skipped_reason: "precision-floor"`. Same with Go
  package fan-out.
- **Unit — threat model.** Path-validator rejects `../etc/passwd`
  and `/etc/passwd`; symlink fixture pointing outside the repo
  returns the `SIVRU-Exxxx` symlink-escape error.
- **Integration — `buildExplainIndex` over a fixture repo.** A
  small multi-file repo → index round-trips through cache; an
  mtime bump on one file → incremental refresh updates only
  that entry.
- **Integration — region-level (§4).** Fixture file with two
  exported symbols → `explain path::symbolA` returns only
  symbolA's public_api, callers narrowed to symbolA mentions,
  callees within symbolA's line range. `git log -L` mock
  verified.
- **Integration — `--diff` mode (§5).** Working-tree fixture
  removes one exported symbol → `--diff` returns the removed
  symbol's callers; rename fixture produces no removed_symbols
  output. **Acceptance corpus ≥ 10 ambiguous fixtures asserts
  mean FP rate ≤ 15%.**
- **Integration — `--diff` in-session parse cache (#11).**
  Synthetic 50-file diff invoked twice in one process → the
  second invocation's parse count is 0 (LRU hit). New process
  → re-parses (no disk cache, by design).
- **Integration — cold-build budget (#9).** A 2000-file TS
  fixture repo → cold `sivru explain` measures p95 build time
  across N runs; CI asserts < 6s on Apple Silicon (or skips with
  a logged note on other arches).
- **CLI smoke.** `sivru explain packages/cli/src/commands/skill.ts`
  prints all five sections plus `AUTHORED (none yet — see v0.6)`;
  `--json` is valid JSON matching the canonical shape.
- **MCP integration.** `sivru.explain(path)` and
  `sivru.explain({ path, symbol })` and
  `sivru.explain({ path, diff: true })` over the MCP server
  each return the expected JSON.
- **Honest-scope check.** A file with dynamic imports / runtime
  dispatch → the output's footer states the limitation, and the
  result is empty-or-best-effort, never silently wrong.

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in defaults.** All five sections enabled; markdown
   output; call-graph depth 1; churn window 90 days; MCP cap 30
   each (with hard-ceiling 500).
2. **Declarative override.** `~/.config/sivru/explain.json` and
   `.sivru/explain.json` accept `{ sections, callGraphDepth,
   format, sinceDays, mcpCap }`. Project config beats user
   config. `mcpCap` is always clamped to `min(value, 500)`.
3. **Code-level extension.** `.sivru/explain/*.ts` register
   custom analyzers — punted to a v0.x patch (the interface
   ships internal-only in v0.5; the public surface lands once
   a real user wants it).

## Effort

Roadmap budget: ~3 weeks. After CEO-plan accepted expansions
(A1–A4) and outside-voice folded fixes: **~5–6.5 weeks**.

| Item | Working days | Cumulative |
|------|--------------|------------|
| Baseline (file-level explain, original Draft) | ~15 (~3 weeks) | ~3 weeks |
| A1 `authored` reserve | +0.5 | ~3 weeks |
| A2 Region-level explain | +4–5 | ~3.5–4 weeks |
| A3 `--diff` mode (+ groundable FP test corpus) | +5 | ~4.5–5 weeks |
| A4 MCP cap (+ D15 sort + #10 ceiling) | +1–2 | ~5–6.5 weeks |
| D16 Go/Java precision floor | (within A2) | — |
| #4 region churn via `git log -L` | (within A2) | — |
| #6 symlink/realpath threat model | +0.5 | — |
| #9 cold-build acceptance test | +0.5 | — |
| #11 in-session parse cache | (within A3) | — |
| #12 reconciliation gate copy | +0 (doc-only) | — |

The upper bound (~6.5 weeks) is the honest figure; ~5–6 weeks
absorbed buffer silently. The honest risk: TS path-aliases /
Python flat-vs-src / Go package resolution edge cases. The
open-questions section names them; the precision floor catches
the worst-case Go/Java noise; relative-imports-only is the
shipped TS contract for v0.5.

---

## GSTACK REVIEW REPORT

*Last section per `/plan-ceo-review` skill — review log, decisions
ledger, dashboard, next-steps.*

### Iteration history

| Iter | Reviewer | Outcome | Issues | Lock state |
|------|----------|---------|--------|------------|
| 1 | `/plan-ceo-review` spec-review | REVISE | 11 issues, 6/10 quality | DESIGN-0004 stale relative to accepted expansions; canonical JSON shape missing; A4 cap semantics under-specified |
| 2 | `/plan-ceo-review` spec-review | REVISE | 8 issues | FP-threshold groundability, JSON-shape inconsistency, A2 cache rule conflated, callee sort ambiguous, effort math optimistic, design-doc-sync gate missing |
| 3 | `/plan-ceo-review` spec-review | **PASS** | 9/9/9/9/8 | iter-3 lock — CEO plan accepted with A1–A4 + open-question adjudications |
| 4 | outside-voice independent reviewer | REVISE | 14 issues (4 P0) | Strategic miscalibration vs v0.4 routing data; symbol-index drift; MCP cap sort direction; Go/Java precision floor missing; plus 7 smaller fixes |
| 5 | this rewrite | **review-stable** | — | D13–D16 + 7 folded fixes absorbed; DESIGN-0004 reflects every locked decision; awaiting `/plan-eng-review` for Accepted promotion |

### Decisions ledger

**CEO plan (locked iter-3):**

- A1 — `authored: []` field reserved in v0.5 schema (XS, accepted)
- A2 — Region-level `path::symbol` (S–M, accepted; symbol-index
  slice, no per-symbol cache, no artifact cache)
- A3 — `--diff` mode (M, accepted; REMOVED-only, renames →
  v0.5.x, groundable ≤15% FP threshold over ≥10 fixtures)
- A4 — MCP cap (S–M, accepted; 30 each independently, hard
  ceiling 500, env + config override, `*_truncated` markers)
- Go/Java precision = accept with footer **plus** D16 precision-
  floor at 100 (outside-voice override)
- TS path aliases = defer to v0.5.x
- Markdown layout = settle in `/plan-eng-review`

**Outside-voice decisions (this rewrite):**

- **D13** — Stay the course on v0.5 scope (declined the reframe
  to defer v0.5 OR enrich `find_related` instead of a new tool);
  v0.4's routing-gap is acknowledged context the coach loop
  (v0.9–11) addresses.
- **D14** — Defer the shared-parse optimisation to TODOS.md;
  keep @sivru/explain's separate walker for v0.5 to avoid mid-
  release search cache format bump.
- **D15** — Flip MCP cap sort from `mtime-desc` to **commit-
  count-asc, mtime-asc tiebreaker** (stable callers first;
  surfaces what the agent does NOT already know).
- **D16** — Hard precision floor in Go-package / Java-class
  resolution: `callers: null` + `callers_skipped_reason:
  "precision-floor"` when fan-out > 100.

**Folded findings (no separate decision):**

- #2 — `--diff` FP threshold groundable (≥10 fixtures, mean
  FP-rate ≤ 15%, asserted in CI)
- #4 — Region-level churn via `git log -L` (computed live, no
  cache layer)
- #6 — Expanded threat model (symlink-out via `realpath`,
  `mcpCap` hard ceiling)
- #9 — Cold-build acceptance budget (p95 < 6s on 2000-file TS
  repo)
- #10 — `mcpCap=0` means "use ceiling 500", not "no cap"
- #11 — In-session parse cache for `--diff` (LRU, process-
  scoped, no disk)
- #12 — `authored: []` test weakened to type check; v0.6 design
  doc reconciliation-gate is the real protection

**Deferred / dismissed:**

- #1 + #8 + #13 (strategic miscalibration → defer v0.5) —
  user chose to stay the course at D13. Recorded for the v0.5
  ship-retrospective.
- #14 (enrich `find_related` instead of new tool) — user chose
  to keep the explain tool named and separate at D13.
- #3 (two indexers drift) — deferred to TODOS at D14.

### Dashboard

| Surface | State |
|---------|-------|
| Canonical JSON shape | Specified (§1) |
| CLI surfaces | `<path>`, `<path>::<symbol>`, `--diff`, `--json`, `--since`, `--depth` |
| MCP surface | `sivru.explain({ path, symbol?, diff?, since?, depth? })` capped per §2a |
| Cache | `~/.cache/sivru/explain/...` symbol-index only; format version 1; D14 deferred |
| Threat model | path-validator + realpath + hard-ceiling clamp |
| Acceptance | cold-build < 6s/2000 files; FP-rate ≤ 15% over ≥ 10 `--diff` fixtures; D16 precision floor at 100 |
| Effort | ~5–6.5 weeks |
| Open questions | All four resolved |
| Sync prerequisites | All five CEO-plan items absorbed; no follow-up doc changes blocking implementation |

### Next steps (review chaining)

1. **`/plan-eng-review`** — architecture / package-boundary
   review against this rewritten DESIGN-0004. Specific topics
   to confirm: `@sivru/explain` package boundary (per D8);
   symbol-index cache shape; per-language resolver interface;
   the in-session parse cache contract (#11); the
   reconciliation-gate language (#12) is correctly placed for
   v0.6 to find.
2. **Implementation tasks** — write `docs/design/0004-sivru-
   explain.tasks.md` + JSONL artifact for autoplan, with per-
   task acceptance criteria, dependencies, effort.
3. **`/auto-ship`** — in a worktree on branch
   `design/sivru-explain`, after `/plan-eng-review` passes.
4. **v0.5.0 ship** — tag once CI green, CHANGELOG updated,
   bench numbers honest. Open the next bench's adoption-rate
   question alongside it (per D13: if explain adoption is
   < 20%, the v0.4 routing data was right and we should
   prioritise the coach loop earlier).

### Handoff note

DESIGN-0004 is **review-stable** as of 2026-05-20. The CEO plan
(iter-3 PASS) and the outside-voice review (iter-4, 14 issues)
have both been absorbed; every locked decision is reflected in
the §1–§7 spec, the acceptance criteria, and the test plan. The
doc is ready for `/plan-eng-review`. No further user decisions
are pending unless the eng-review surfaces new architectural
trade-offs.
