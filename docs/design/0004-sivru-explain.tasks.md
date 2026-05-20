# DESIGN-0004 implementation tasks (v0.5.0)

Companion to [`0004-sivru-explain.md`](0004-sivru-explain.md).
Generated 2026-05-20 from the iter-5 review-stable doc. Total
effort: **~5–6.5 weeks** (CEO plan: A1–A4 + outside-voice fixes).

Each task names its acceptance bar against the **design doc
sections / acceptance criteria it satisfies** so a reviewer can
trace tasks → spec → criteria without rereading the doc.

The JSONL companion for autoplan lives at
`~/.gstack/projects/sivru/tasks/0004-sivru-explain.jsonl` with the
same ID + acceptance metadata.

## Task list

### T1 — Package scaffold

Create `packages/explain/` with `package.json`, `tsconfig.json`,
`src/index.ts`, `vitest` test setup. Wire into the pnpm
workspace; add `typecheck`, `test`, `build` scripts so the
root-level `pnpm -r` commands cover it.

- **Effort:** 0.5 day
- **Depends on:** —
- **Acceptance:** `pnpm install && pnpm -r typecheck && pnpm -r
  test && pnpm -r build` green with the new package.
- **Covers:** §6 (cache lives here), §4 / §5 surfaces.

### T2 — Symbol-index core (TS/JS)

Per-file extractor: tree-sitter parse → `exports[]` (name, kind,
AST range) + `imports[]` (raw source). Reuses v0.2's chunker
grammars. Resolver for TS/JS: relative imports + extension
probes (`.ts`, `.tsx`, `.js`, `index.ts`, …).

- **Effort:** 3 days
- **Depends on:** T1
- **Acceptance:** Per-language fixtures (TS/JS) → expected
  exports + signatures + resolved import paths match.
- **Covers:** §3a public API, §3b TS/JS resolution rule.

### T3 — Python resolver

Adds Python resolution: relative imports → file in same
package; absolute package imports inside the repo →
`<pkg>/__init__.py` or `<pkg>.py`.

- **Effort:** 1.5 days
- **Depends on:** T2 (shares resolver interface)
- **Acceptance:** Python fixture pair (`pkg/foo.py` exports `bar`,
  `pkg/baz.py` imports `bar`) → callers of `foo.py` includes
  `baz.py`.
- **Covers:** §3b Python rule.

### T4 — Go resolver (package granularity)

Module-relative imports → directory under module root (per
`go.mod`). The graph keys at package granularity. Resolver
yields a *package directory*, not a single file.

- **Effort:** 1.5 days
- **Depends on:** T2
- **Acceptance:** Go fixture with a multi-file package; explain
  on one file in that package reports callers as importers of
  the package (file-level mapping documented in the footer).
- **Covers:** §3b Go rule.

### T5 — Java resolver (source-root + class)

`import com.example.X` → `<sourceRoot>/com/example/X.java`,
best-effort across configured source roots. Reads typical
Maven/Gradle layouts (`src/main/java`, `src/test/java`); else
falls back to `realpath`-based heuristic.

- **Effort:** 2 days
- **Depends on:** T2
- **Acceptance:** Java fixture with class import → resolver
  returns the right `.java` file; importer count matches the
  hand-curated expectation.
- **Covers:** §3b Java rule.

### T6 — Symbol-index cache (load/save/incremental)

Build symbol index on first `sivru explain` per `(repoPath,
state_id)`; cache to `~/.cache/sivru/explain/<sha256(
repoPath)>/<state_id>.json`. Patch on file mtime change.
`SIVRU_EXPLAIN_CACHE_VERSION = 1`. Atomic rename on write.

- **Effort:** 2 days
- **Depends on:** T2 (and the per-lang resolvers populate the
  index as they ship)
- **Acceptance:** Integration test — small multi-file repo →
  index round-trips through cache; mtime bump → incremental
  refresh updates only the changed entry.
- **Covers:** §6 cache.

### T7 — File-level artifact assembly

Compose `public_api`, `callers`, `callees`, `churn`, `ownership`,
`tests`, `authored: []`, `*_truncated: null`, `footer` into the
canonical JSON shape (§1). Churn = `git log --follow --since=N
-- <path>`, ownership = `git blame --line-porcelain <path>`
aggregated, tests = filename-pattern match.

- **Effort:** 2 days
- **Depends on:** T6
- **Acceptance:** JSON shape passes the schema check;
  `Array.isArray(artifact.authored)` test; footer string names
  resolution model + Go/Java granularity + relative-imports-
  only.
- **Covers:** §1, §3c (file-level), §3d, §7 acceptance.

### T8 — CLI command + markdown renderer

`sivru explain <path> [--json] [--since=N] [--depth=1]`.
Markdown renderer for the five sections + `AUTHORED (none yet
— see v0.6)`. CLI is **uncapped** (full caller/callee lists).

- **Effort:** 1.5 days
- **Depends on:** T7
- **Acceptance:** CLI smoke test prints all sections + AUTHORED
  placeholder; `--json` is valid JSON matching canonical shape;
  `sivru help` lists `explain`.
- **Covers:** §2 CLI.

### T9 — MCP tool registration

Register `sivru.explain({ path, symbol?, diff?, since?, depth? })`
on the MCP server. Always-on `description` carries the §2
routing hint. Returns canonical JSON shape.

- **Effort:** 1 day
- **Depends on:** T7
- **Acceptance:** MCP integration test — `sivru.explain(path)`
  over the stdio MCP server returns the expected JSON.
- **Covers:** §2 MCP, §2 description hint.

### T10 — MCP cap (A4 + D15 + #10)

30 callers + 30 callees independently. Sort by **commit-count
ascending, mtime ascending tiebreaker** (D15). Hard ceiling 500;
`mcpCap=0` means "use ceiling"; values above 500 clamp to 500
(#10). Env `SIVRU_EXPLAIN_MCP_CAP` + `.sivru/explain.json`
overrides. CLI uncapped. `*_truncated` markers populated.

- **Effort:** 1.5 days
- **Depends on:** T9
- **Acceptance:** Unit test on synthetic 600-caller fixture
  covering `mcpCap=30 → 30+truncated:570`, `mcpCap=1000 →
  500+truncated:100`, `mcpCap=0 → 500+truncated:100`. Sort
  order verified.
- **Covers:** §2a MCP cap.

### T11 — D16 precision floor (Go / Java)

If Go-package or Java-class call-site query yields **> 100**
candidate callers for one symbol, set `callers: null` +
`callers_skipped_reason: "precision-floor"`. The footer still
names the granularity caveat.

- **Effort:** 0.5 day
- **Depends on:** T4, T5, T7
- **Acceptance:** Java fixture with 120 importers → response
  has `callers: null`, `callers_skipped_reason: "precision-
  floor"`. Same with Go.
- **Covers:** §3b D16, §7 (D16 precision floor).

### T12 — Threat model: path-validator + realpath + symlink

CLI / MCP path arg validator: reject `..` escapes and absolute
paths. `realpath(<path>)` must be inside `realpath(repoRoot)`,
else `SIVRU-Exxxx` symlink-escape error. `mcpCap` clamp applies
to env + config + default (#6 + #10).

- **Effort:** 0.5 day
- **Depends on:** T7
- **Acceptance:** Path-validator unit tests for `../etc/passwd`,
  `/etc/passwd`; symlink fixture pointing outside the repo
  returns the symlink-escape error code; `mcpCap=10000` clamps
  to 500.
- **Covers:** §6 threat model.

### T13 — Region-level explain (`path::symbol`) (A2)

CLI: `sivru explain pkg/foo.ts::processPayment`. MCP: optional
`symbol` field. Slice from symbol-index cache at request time
(no per-symbol cache, no artifact cache). Region-level `churn`
+ `ownership` via `git log -L <start>,<end>:<path>` and
`git blame --line-porcelain -L <start>,<end> <path>` (#4).
`symbol-not-found` error path.

- **Effort:** 4 days
- **Depends on:** T7, T8, T9
- **Acceptance:** Region fixture with two exported symbols →
  `explain path::symbolA` returns only symbolA's public_api,
  callers narrowed to symbolA mentions, callees within
  symbolA's line range. `git log -L` mock path exercised.
- **Covers:** §4 region-level, §3c (region).

### T14 — `--diff` mode (A3) core

`sivru explain <path> --diff` reads working-tree diff vs
`HEAD`, detects exported-symbol REMOVALS (renames deferred to
v0.5.x), runs caller analysis against committed-state symbol
index. Adds `diff_mode: true` and `removed_symbols[]` to the
response. Cache rule: symbol index reused; diff portion fresh
per call.

- **Effort:** 4 days
- **Depends on:** T7, T8, T9
- **Acceptance:** Working-tree fixture removes one exported
  symbol → `--diff` returns the symbol's callers under
  `removed_symbols`. Rename fixture produces no
  `removed_symbols` (deferred).
- **Covers:** §5 --diff core.

### T15 — `--diff` in-session parse cache (#11)

LRU keyed by `(absPath, mtime)`, process-scoped, in-memory
only. Repeat parses within one CLI / MCP invocation are free;
new process re-parses (no disk cache by design).

- **Effort:** 0.5 day
- **Depends on:** T14
- **Acceptance:** 50-file diff invoked twice in one process →
  second invocation's parse count is 0 (LRU hit). New process
  → re-parses. Cache eviction at LRU bound verified.
- **Covers:** §5 (#11) in-session parse cache.

### T16 — `--diff` acceptance test corpus (#2)

≥ 10 ambiguous fixture cases (delete-and-re-add of same-named
symbol, cross-file shadowing, partial-export removals, etc.).
Test harness compares `--diff` output against hand-curated
"true" caller sets. CI asserts **mean FP rate ≤ 15%** AND
**corpus size ≥ 10**.

- **Effort:** 2 days
- **Depends on:** T14
- **Acceptance:** CI test fails if corpus < 10 fixtures OR mean
  FP rate > 15%. Per-fixture FP rate logged in the test output
  for debuggability.
- **Covers:** §5 (#2) groundable threshold.

### T17 — Cold-build budget acceptance test (#9)

2000-file TypeScript fixture repo. Cold `sivru explain`
measures p95 build time across N runs (N≥5). CI asserts
**p95 < 6s on Apple Silicon (M-series)**. Skips with a logged
note on other arches.

- **Effort:** 0.5 day
- **Depends on:** T6
- **Acceptance:** CI on macOS-M runner shows p95 build time
  metric + asserts < 6s. Non-M runner logs and skips. Fixture
  generator script committed for reproducibility.
- **Covers:** §6 cold-build budget.

### T18 — `authored` field reconciliation gate (#12 + A1)

`authored: []` populated in every v0.5 response. JSON-shape
test asserts only `Array.isArray(artifact.authored)` (not
`=== []`, which would be tautological). The real protection
is captured in the DESIGN-0005 (v0.6 `@sivru` blocks) PR
description: "DESIGN-0004 reconciliation" section listing the
field's v0.6 contract. v0.5 ships the field reservation; v0.6
fills it.

- **Effort:** 0.5 day (doc + test only)
- **Depends on:** T7
- **Acceptance:** JSON-shape test passes for `authored: []`
  and `authored: ["any object"]` (forward-compatible). Note
  added to DESIGN-0005 stub mentioning the reconciliation-
  gate requirement.
- **Covers:** §1 (A1) + §7 acceptance (#12).

### T19 — SKILL.md update mentioning explain

Update `packages/cli/src/skill/SKILL.md` to mention
`sivru.explain` in the after-editing-locate-the-file workflow
(per the v0.4 pattern). Keep the SKILL.md tight; the MCP tool
`description` is the always-on channel.

- **Effort:** 0.5 day
- **Depends on:** T9
- **Acceptance:** SKILL.md mentions explain at least once;
  v0.4 bench rerun confirms no regression in routing-
  correctness metrics; explain-tool routing measured (the
  outside-voice retrospective metric per D13).
- **Covers:** §2 SKILL.md update.

### T20 — CHANGELOG + bench rerun + tag

CHANGELOG entry for v0.5.0 — five-section artifact, region-
level, --diff, MCP cap, precision floor, threat-model. Rerun
the full bench suite. If explain adoption / routing correctness
moves more than ±5% from v0.4, document the delta honestly. Tag
v0.5.0 once CI green + CHANGELOG merged.

- **Effort:** 0.5 day
- **Depends on:** T1–T19 all complete
- **Acceptance:** CHANGELOG.md updated; bench numbers in PR
  description; `v0.5.0` tag pushed; main branch CI green.
- **Covers:** ship.

## Effort rollup

| Phase | Tasks | Working days |
|-------|-------|--------------|
| Core (file-level) | T1–T9 | ~15 days (~3 weeks) |
| MCP cap + precision | T10, T11 | ~2 days |
| Threat model | T12 | ~0.5 day |
| Region-level (A2) | T13 | ~4 days |
| --diff (A3) | T14, T15, T16 | ~6.5 days |
| Cold-build (#9) | T17 | ~0.5 day |
| Reconciliation (A1 + #12) | T18 | ~0.5 day |
| Ship | T19, T20 | ~1 day |
| **Total** | T1–T20 | **~28–32 days (~5–6.5 weeks)** |

## Suggested order

Critical path: T1 → T2 → T6 → T7 (the spine).

After T7, three streams can run in parallel:
- **Surfaces:** T8 (CLI) + T9 (MCP) + T19 (SKILL.md)
- **Cap/precision/threat:** T10, T11, T12
- **Per-language extensions:** T3 (Python), T4 (Go), T5 (Java)

After surfaces land: T13 (region-level), then T14 → T15 → T16
(`--diff`). Cold-build T17 lands once T6 is stable.

T18 (reconciliation) is doc work; do it any time. T20 is the
last step before tag.
