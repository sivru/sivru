# DESIGN-0004: `sivru explain <path>`

**Status:** Draft
**Class:** Spine (per [GOALS.md](../../GOALS.md))
**Targets:** v0.5.0
**Issue:** filed when v0.5 work starts
**Created:** 2026-05-08
**Updated:** 2026-05-20 — promoted Stub → Draft for the v0.5.0 cycle,
now that v0.4.0 has shipped.
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
places — let me read what they expect before I touch it." That is the
edit-with-comprehension behaviour [GOALS.md](../../GOALS.md) is the
project's whole reason to exist.

## Proposal

### 1. The artifact

`sivru explain <path>` emits five sections, in this order. Every
section is **descriptive only** — no "you should refactor this", no
quality judgements (v0.9's coach loop does judgement; this does not).

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
```

Output formats: `markdown` (default), `--json` for tooling. The MCP
tool returns the JSON shape directly.

### 2. Surfaces

- **CLI:** `sivru explain <path> [--json] [--since=<N>] [--depth=1]`.
- **MCP tool:** `sivru.explain({ path, since?, depth? })` — the agent
  calls it before edits. The tool `description` is the always-on
  guidance (per the v0.4 pattern): *"Get the public API, callers,
  churn, and ownership of a file before editing it. Use after
  locating a file and before changing a symbol — it surfaces who else
  depends on what you are about to touch."*

The MCP description is the channel that actually makes the agent
reach for the tool; the SKILL.md body (from v0.4) is updated to
mention `explain` in the after-editing-locate-the-file workflow.

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
  │
  ├─ git blame <path> aggregated        → ownership (top authors %)
  │
  └─ test-file pattern match            → test hint
```

**3a. Public API** — reuses the v0.2 tree-sitter substrate. The
chunker already returns `Chunk[]` with `nodeType` + `symbolName`; the
explain layer keeps the *exported* symbols and pulls each one's
signature line range out of the same parse. No new parser, no new
grammar work. The five covered languages (TS, JS, Python, Go, Java)
are first-class; uncovered languages get an empty `public_api`
section with an honest "language not yet supported" note.

**3b. The 1-hop call graph** is the meat. It is computed against a
per-repo **symbol index** that maps, for each file:

- `exports`: name → kind (function / class / type / const) + the
  AST range, extracted via tree-sitter from the same parse the
  chunker already runs.
- `imports`: each import statement → the *resolved* path of what is
  being imported (i.e. the on-disk file the import targets).

Resolution is best-effort and language-specific:

- **TS/JS:** relative imports (`./foo`, `../bar`) resolved against
  the importing file's dir, with the usual extension probes
  (`.ts`, `.tsx`, `.js`, `index.ts`, …). `paths`/aliases from
  `tsconfig.json` are out of scope for v0.5 (follow-up).
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
output footer ("call graph is identifier-based; not type-resolved —
expect some false positives on common names").

**3c. Churn + ownership.** Local `git log --follow --since=<N> -- <path>`
for change count and last commit; `git blame --line-porcelain <path>`
aggregated by author for the ownership block. No network. The walker
already shells out to `git` for `state_id`, so this is the same
pattern.

**3d. Tests.** A filename-pattern match the chunker can derive:
`<path>.test.<ext>`, `<dir>/__tests__/<basename>.*`, `<dir>/<stem>.spec.<ext>`,
`<dir>/<stem>_test.<ext>` (Go), `test_<stem>.py` (Python). Test count
is a `grep` for `it(` / `test(` / `def test_` in the matched file —
informational, not precise.

### 4. Cache

The symbol index is the expensive piece. Build it on first
`sivru explain` against a given `(repoPath, state_id)`; cache to
`~/.cache/sivru/explain/<sha256(repoPath)>/<state_id>.json`. Reuse
verbatim on subsequent calls in the same repo state. On mtime change
to a file, re-index just that file and patch the cache (incremental,
same shape as the search engine's `refreshStale`). A
`SIVRU_EXPLAIN_CACHE_VERSION = 1` constant lives next to the search
cache's version so a format change forces a rebuild cleanly.

The cache shape is small and human-readable (JSON, one object per
file): edit-debuggable, gitignored, never published. The walker's
existing `~/.cache/sivru/indexes/` lives next door; the two are
independent.

### 5. Honest scope

What v0.5 deliberately is *not*:

- **Not an LSP.** No type resolution, no rename refactoring, no
  cross-language go-to-definition. Identifier + import is the signal;
  precision tradeoffs are stated in the output.
- **Not a quality judgement.** No "this file is too long" or "consider
  splitting." That is v0.9's coach loop, with FP-rate discipline.
- **Not regions.** v0.5 explains *files*. Sub-file regions
  (`sivru explain pkg/foo.ts::processPayment`) are a follow-up —
  the substrate (symbol ranges) is here; the surface is not.
- **Not a search replacement.** `sivru.search` finds *where*; this
  tells you *what* about a known location.

## Alternatives considered

**Full LSP-grade resolution.** Type-aware callers/callees would be
precise but require per-language type servers, far more than three
weeks. The identifier+import approach is boring by default and good
enough for human + agent comprehension. Re-evaluate if FP rate is a
real complaint.

**LLM-based summary.** Ask an LLM to "explain this file." Reads
fluent; non-deterministic, expensive per call, no token-free local
mode, and worst: it makes up callers. Rejected for the descriptive
core; an `--llm-summary` add-on could ship in a later patch.

**Re-derive on every call, no cache.** A 5000-file repo takes long
enough to re-parse that the agent would visibly wait. The search
engine already caches; explain follows the same precedent.

**Piggyback on the search index build.** Tempting — `buildIndex`
already parses every file via tree-sitter. But it makes `sivru index`
do strictly more work for users who never call `explain`. The
separate, lazily-built explain index keeps the two flows independent;
sharing the parse becomes a v0.x perf patch if measured to matter.

## Open questions

- **Region granularity.** v0.5 ships files only. The
  `path::symbol` syntax for regions is obvious enough to spec but
  doubles the test surface; settle in eng-review.
- **TS path aliases / `tsconfig.json` paths**, monorepo `paths`,
  Python `src/` layout vs flat layout. Real, fiddly, follow-up
  unless eng-review judges the FP/FN rate too high without it.
- **Go and Java cross-file precision** at v0.5. Both resolve to
  package or class, not single file — the graph is coarser there
  than for TS/JS/Python. Acceptable trade or block the release?
- **Markdown layout**: the sketch in §1 is one cut. The MCP path
  cares only about the JSON shape; the markdown is a human-facing
  surface and eng-review should rubber-stamp the section ordering.

## Acceptance criteria

- `sivru explain <path>` produces the five sections; `--json` returns
  the same shape as a stable JSON object.
- The MCP tool `sivru.explain(path)` returns the JSON artifact; its
  always-on `description` carries the routing hint.
- The symbol index is built on first call per `(repoPath, state_id)`,
  cached, and incrementally refreshed on file mtime change.
- Cross-file callers/callees work for TS, JS, Python (file-level)
  and Go, Java (package/class-level, with the limitation surfaced).
- Output footer states the resolution model honestly (identifier +
  import; not type-resolved).
- Churn + ownership computed via local `git`; no network call.
- `sivru help` lists `explain`.
- A SIVRU-Exxxx error code range is claimed in the PR description
  for the new error classes (cache load failure, unknown language,
  malformed path).

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
  + author percentages.
- **Unit — test-file detection.** Per-language naming conventions.
- **Unit — JSON shape.** The artifact's JSON object passes a schema
  check (Zod or hand-rolled assert).
- **Integration — `buildExplainIndex` over a fixture repo.** A
  small multi-file repo → index round-trips through cache; an mtime
  bump on one file → incremental refresh updates only that entry.
- **CLI smoke.** `sivru explain packages/cli/src/commands/skill.ts`
  prints all five sections; `--json` is valid JSON.
- **MCP integration.** `sivru.explain(path)` over the MCP server
  returns the expected JSON.
- **Honest-scope check.** A file with dynamic imports / runtime
  dispatch → the output's footer states the limitation, and the
  result is empty-or-best-effort, never silently wrong.

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in defaults.** All five sections enabled; markdown
   output; call-graph depth 1; churn window 90 days.
2. **Declarative override.** `~/.config/sivru/explain.json` and
   `.sivru/explain.json` accept `{ sections, callGraphDepth,
   format, sinceDays }`. Project config beats user config.
3. **Code-level extension.** `.sivru/explain/*.ts` register custom
   analyzers — punted to a v0.x patch (the interface ships
   internal-only in v0.5; the public surface lands once a real
   user wants it).

## Effort

Roadmap budget: ~3 weeks. The symbol index + per-language import
resolver is the bulk; tree-sitter (v0.2) covers parsing, `git` is
shell-out, the rest is plumbing. The honest risk: TS path-aliases /
Python flat-vs-src / Go package resolution edge cases will eat days;
the open questions section names them. If eng-review tightens that
scope, ~3 weeks holds.
