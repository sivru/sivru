# DESIGN-0004 implementation tasks (v0.5.0)

Companion to [`0004-sivru-explain.md`](0004-sivru-explain.md).
Generated 2026-05-20 from the iter-6 eng-review-PASS doc (now
Accepted). Total effort: **~5–6.5 weeks** (CEO plan A1–A4 +
outside-voice iter-4 fixes + eng-review iter-6 fixes).

Each task names its acceptance bar against the **design doc
sections / acceptance criteria it satisfies** so a reviewer can
trace tasks → spec → criteria without rereading the doc.

The JSONL companion for autoplan lives at
`~/.gstack/projects/sivru/tasks/0004-sivru-explain.jsonl` with the
same ID + acceptance metadata.

## Task list

### T1 — Subdir scaffold (per D1; overturns CEO-plan D8)

Create `packages/search/src/explain/` with the module structure in
§6 of the design doc: `types.ts`, `index.ts`, `cache.ts`,
`symbol-index.ts`, `resolvers/`, `artifact.ts`, `region.ts`,
`diff.ts`, `parse-cache.ts`. Export public surface from
`@sivru/search` `index.ts`. No new package. No new pnpm workspace
entry.

- **Effort:** 0.5 day
- **Depends on:** —
- **Acceptance:** `pnpm install && pnpm -r typecheck && pnpm -r
  test && pnpm -r build` green. New explain module compiles and
  exports the public surface from `@sivru/search`.
- **Covers:** §6 module layout, D1.

### T2 — Symbol-index core (TS/JS) with `Resolver` interface

Per-file extractor + the `Resolver` interface (§3b). TS/JS
resolver: relative imports + extension probes. Read exports from
the in-process `SivruIndex.Chunk[]` filtered by `symbolName` +
`nodeType` (warm path, §3a). Fresh tree-sitter parse for cold-
path or files outside the index.

- **Effort:** 3 days
- **Depends on:** T1
- **Acceptance:** `Resolver` interface satisfied (compile check).
  Per-language fixtures (TS/JS) yield expected exports +
  signatures + resolved import paths. Warm-path test: when a
  `SivruIndex` already covers the file, `treeSitterChunks` is not
  re-invoked.
- **Covers:** §3a public API, §3b TS/JS resolution, Resolver
  interface, D1 warm-path Chunk[] reuse.

### T3 — Python resolver

Adds Python resolution: relative imports → file in same
package; absolute package imports inside the repo →
`<pkg>/__init__.py` or `<pkg>.py`. Implements the `Resolver`
interface.

- **Effort:** 1.5 days
- **Depends on:** T2 (Resolver interface)
- **Acceptance:** Python fixture pair callers + callees resolve
  correctly. Conformance test passes.
- **Covers:** §3b Python rule.

### T4 — Go resolver (package granularity)

Module-relative imports → directory under module root (per
`go.mod`). The graph keys at package granularity. Implements the
`Resolver` interface.

- **Effort:** 1.5 days
- **Depends on:** T2
- **Acceptance:** Go fixture with a multi-file package; explain
  on one file in that package reports callers as importers of
  the package. Conformance test passes.
- **Covers:** §3b Go rule.

### T5 — Java resolver (source-root + class)

`import com.example.X` → `<sourceRoot>/com/example/X.java`,
best-effort across configured source roots. Reads typical
Maven/Gradle layouts (`src/main/java`, `src/test/java`).
Implements the `Resolver` interface.

- **Effort:** 2 days
- **Depends on:** T2
- **Acceptance:** Java fixture with class import → resolver
  returns the right `.java` file; importer count matches.
  Conformance test passes.
- **Covers:** §3b Java rule.

### T6 — Symbol-index cache (load/save/incremental)

Build symbol index on first `sivru explain` per `(repoPath,
state_id)`; cache to `~/.cache/sivru/explain/<sha256(
repoPath)>/<state_id>.json`. Patch on file mtime change.
`SIVRU_EXPLAIN_CACHE_VERSION = 1`. Atomic rename on write.
Per-file entry includes `exports`, `imports`, `commitCount`,
`mtimeMs` (see §6).

- **Effort:** 2 days
- **Depends on:** T2 (resolvers populate the entry shape)
- **Acceptance:** Integration test — small multi-file repo →
  index round-trips through cache; mtime bump → incremental
  refresh updates only changed entry. Atomic rename verified
  (tmp file is never visible mid-write).
- **Covers:** §6 cache.

### T7 — Per-file `commitCount` cache (D2)

At symbol-index build, run one `git log --name-only
--pretty=format: --no-renames HEAD` walk; parse into
`Map<file, count>`; apply to every per-file index entry as the
`commitCount` field. Invalidation is automatic via state_id.

- **Effort:** 1 day
- **Depends on:** T6
- **Acceptance:** Fixture repo with 5 files of varying commit
  counts → cached commitCount matches `git log --oneline --
  <file> | wc -l` for each file. State_id change forces
  recompute. Build adds < 1 second on a 2000-file repo (D3
  budget unaffected).
- **Covers:** §6 commitCount cache, D2.

### T8 — File-level artifact assembly + footer

Compose `public_api`, `callers`, `callees`, `churn`, `ownership`,
`tests`, `authored: []`, `*_truncated: null`,
`callers_skipped_reason: null`, `footer` into the canonical JSON
shape (§1). Churn = `git log --follow --since=N -- <path>`.
**Ownership = `git shortlog -ns -- <path>`** (file-level, not
`git blame`). Tests = filename-pattern match with realpath
validation. Footer string reports resolution model + Go/Java
granularity + relative-imports-only + chosen precision floor.

- **Effort:** 2 days
- **Depends on:** T6, T7
- **Acceptance:** JSON shape passes the hand-rolled schema check
  (no zod); `Array.isArray(artifact.authored)`; footer string
  reports actual floor value; ownership uses `git shortlog`
  not `git blame` (asserted by mocking).
- **Covers:** §1, §3c file-level, §3d, §7.

### T9 — CLI command + markdown renderer

`sivru explain <path> [--json] [--since=N] [--depth=1]`.
Markdown renderer for the five sections + `AUTHORED (none yet —
see v0.6)`. CLI is **uncapped** (full caller/callee lists).
Argument parsing hand-rolled.

- **Effort:** 1.5 days
- **Depends on:** T8
- **Acceptance:** CLI smoke test prints all sections + AUTHORED
  placeholder; `--json` is valid JSON matching canonical
  artifact shape; `sivru help` lists `explain`. Footer reports
  floor value.
- **Covers:** §2 CLI.

### T10 — MCP tool + envelope shape

Register `sivru.explain({ path, symbol?, diff?, since?, depth? })`
in `mcp-entry.ts`. Always-on `description` carries the §2
routing hint. Response uses the **envelope shape** in §1
(`tool`, `path`, `latencyMs`, `refreshMs`, `refreshDelta`,
`artifact`) matching `formatSearchResultEnvelope`. Argument
validation via hand-rolled `parseExplainArgs` (no zod).
**Invokes `index.refreshStale()`** before assembling the
artifact, matching the staleness invariant `searchTool` /
`findRelatedTool` already enforce.

- **Effort:** 1.5 days
- **Depends on:** T8
- **Acceptance:** MCP integration test — `sivru.explain(path)`
  returns envelope-wrapped JSON; envelope fields match the
  search/find_related shape; argument parsing rejects bad inputs
  with proper messages.
- **Covers:** §2 MCP, §2 description hint, envelope shape.

### T11 — MCP cap with D2 + D15 + #10

30 callers + 30 callees independently. Sort by **`commitCount`
ascending** (D15 — from the T7 cache, zero git invocations per
request), ties broken by mtime **ascending**. Hard ceiling 500;
`mcpCap=0` means "use ceiling"; values above 500 clamp to 500
(#10). Env `SIVRU_EXPLAIN_MCP_CAP` + `.sivru/explain.json`
overrides. CLI uncapped. `*_truncated` markers populated.

- **Effort:** 1.5 days
- **Depends on:** T7, T10
- **Acceptance:** 600-caller fixture: `mcpCap=30 → 30+truncated:570`;
  `mcpCap=1000 → 500+truncated:100`; `mcpCap=0 → 500+truncated:100`.
  Sort verified as commitCount-asc, mtime-asc tiebreaker. **Zero
  git invocations during cap sort** (asserted by mocking
  `execFile`).
- **Covers:** §2a MCP cap, D2 + D15 + #10.

### T12 — D16 + D4 scaled precision floor

If Go-package or Java-class call-site query yields **> max(100,
repoFileCount * 0.05)** candidate callers for one symbol, set
`callers: null` + `callers_skipped_reason: "precision-floor"`.
Footer string reports the actual chosen floor value.

- **Effort:** 0.5 day
- **Depends on:** T4, T5, T8
- **Acceptance:** Java fixture `repoFileCount=200, fanout=80` →
  callers returned (under floor 100). `repoFileCount=5000,
  fanout=280` → callers returned (under floor 250). `Go fanout
  300, repoFileCount=5000` → `callers: null` +
  `callers_skipped_reason: "precision-floor"`. Footer string
  asserts the chosen floor.
- **Covers:** §3b D16 + D4, §7 honest scope.

### T13 — Threat model: path-validator + realpath + symlink

CLI / MCP path arg validator: reject `..` escapes and absolute
paths. `realpath(<path>)` must be inside `realpath(repoRoot)`,
else `SIVRU-Exxxx` symlink-escape error. `mcpCap` clamp applies
to env + config + default. Test-pattern matching is also
realpath-validated.

- **Effort:** 0.5 day
- **Depends on:** T8
- **Acceptance:** Path-validator unit tests for `../etc/passwd`,
  `/etc/passwd`; symlink fixture pointing outside the repo
  returns the symlink-escape error code; `mcpCap=10000` clamps
  to 500; symlinked test path outside repo refuses to read.
- **Covers:** §6 threat model.

### T14 — Region-level explain (`path::symbol`) (A2)

CLI: `sivru explain pkg/foo.ts::processPayment`. MCP: optional
`symbol` field. Slice from symbol-index cache at request time
(no per-symbol cache, no artifact cache). Region-level `churn`
+ `ownership` via `git log -L <start>,<end>:<path>` and
`git blame --line-porcelain -L <start>,<end> <path>` (#4).
`symbol-not-found` error path.

- **Effort:** 4 days
- **Depends on:** T8, T9, T10
- **Acceptance:** Region fixture with two exported symbols →
  `explain path::symbolA` returns only symbolA's public_api,
  callers narrowed to symbolA mentions, callees within
  symbolA's line range. `git log -L` mock path exercised.
- **Covers:** §4 region-level, §3c region.

### T15 — `--diff` mode (A3) core

`sivru explain <path> --diff` reads working-tree diff vs
`HEAD`, detects exported-symbol REMOVALS (renames deferred to
v0.5.x), runs caller analysis against committed-state symbol
index. Adds `diff_mode: true` and `removed_symbols[]` to the
response. Cache rule: symbol index reused; diff portion fresh
per call.

- **Effort:** 4 days
- **Depends on:** T8, T9, T10
- **Acceptance:** Working-tree fixture removes one exported
  symbol → `--diff` returns the symbol's callers under
  `removed_symbols`. Rename fixture produces no
  `removed_symbols` (deferred).
- **Covers:** §5 --diff core.

### T16 — `--diff` in-session parse cache (#11)

LRU keyed by `(absPath, mtime)`, process-scoped, in-memory
only. Repeat parses within one CLI / MCP invocation are free;
new process re-parses (no disk cache by design).

- **Effort:** 0.5 day
- **Depends on:** T15
- **Acceptance:** 50-file diff invoked twice in one process →
  second invocation's parse count is 0 (LRU hit). New process
  → re-parses. Cache eviction at LRU bound verified.
- **Covers:** §5 (#11) in-session parse cache.

### T17 — `--diff` acceptance test corpus (#2)

≥ 10 ambiguous fixture cases (delete-and-re-add of same-named
symbol, cross-file shadowing, partial-export removals, etc.).
Test harness compares `--diff` output against hand-curated
"true" caller sets. CI asserts **mean FP rate ≤ 15%** AND
**corpus size ≥ 10**.

- **Effort:** 2 days
- **Depends on:** T15
- **Acceptance:** CI fails if corpus < 10 fixtures OR mean FP
  rate > 15%. Per-fixture FP rate logged in the test output.
- **Covers:** §5 (#2) groundable threshold.

### T18 — Cold-build budget acceptance test (D3 two-tier)

2000-file TypeScript fixture repo. Cold `sivru explain`
measures p95 build time across N≥5 runs. **CI on macos-latest
asserts p95 < 15s** (the gate). Developer-machine test detects
Apple Silicon M-series and logs a warning if p95 > 6s without
failing the build (quality bar, not gate). Documented in
CHANGELOG.

- **Effort:** 1 day
- **Depends on:** T6
- **Acceptance:** CI on macos-latest fails if p95 ≥ 15s.
  Apple-Silicon test logs a warning but does not gate.
  Fixture-generator script committed for reproducibility.
- **Covers:** §6 cold-build budget, D3.

### T19 — `refreshStale`-after-edit MCP integration test

Build the symbol index via the MCP server (`sivru.explain` on
some file in a fixture repo). Then modify another file's
exports on disk. Then call `sivru.explain` on that modified
file via the MCP server. Assert: response artifact reflects
the new exports (the `refreshStale` invariant matches
`searchTool` / `findRelatedTool` at mcp-entry.ts:391-397).

- **Effort:** 0.5 day
- **Depends on:** T10
- **Acceptance:** Integration test green; response artifact's
  `public_api` matches the modified state, not the indexed-then-
  stale state.
- **Covers:** §"refreshStale after edit" acceptance criterion.

### T20 — `authored` field reconciliation gate (#12 + A1)

`authored: []` populated in every v0.5 response. JSON-shape
test asserts only `Array.isArray(artifact.authored)` (not
`=== []`, which would be tautological). DESIGN-0016 stub has
the "DESIGN-0004 reconciliation gate" section (already shipped
in this eng-review). v0.6 PR description MUST include the named
reconciliation section.

- **Effort:** 0.5 day (doc + test only)
- **Depends on:** T8
- **Acceptance:** JSON-shape test passes for `authored: []`
  and `authored: [{...}]` (forward-compatible). DESIGN-0016
  stub contains the reconciliation-gate heading (already true).
- **Covers:** §1 (A1) + §7 acceptance (#12).

### T21 — SKILL.md update mentioning explain

Update `packages/cli/src/skill/SKILL.md` to mention
`sivru.explain` in the after-editing-locate-the-file workflow
(per the v0.4 pattern). Keep the SKILL.md tight; the MCP tool
`description` is the always-on channel.

- **Effort:** 0.5 day
- **Depends on:** T10
- **Acceptance:** SKILL.md mentions explain at least once;
  v0.4 bench rerun confirms no regression in routing-
  correctness metrics; explain-tool routing measured (the
  outside-voice retrospective metric per D13).
- **Covers:** §2 SKILL.md update.

### T22 — CHANGELOG + bench rerun + tag

CHANGELOG entry for v0.5.0 — five-section artifact, region-
level, --diff, MCP cap, scaled precision floor, threat-model,
two-tier cold-build budget. Rerun the full bench suite.
Document explain-tool routing percentage; if it moves more than
±5% from v0.4, note honestly. Tag v0.5.0 once CI green +
CHANGELOG merged.

- **Effort:** 0.5 day
- **Depends on:** T1–T21 all complete
- **Acceptance:** CHANGELOG.md updated; bench numbers in PR
  description; `v0.5.0` tag pushed; main branch CI green.
- **Covers:** ship.

## Effort rollup

| Phase | Tasks | Working days |
|-------|-------|--------------|
| Subdir scaffold (D1) | T1 | ~0.5 day |
| Core resolvers + Resolver interface | T2–T5 | ~8 days |
| Cache (+ commitCount D2) | T6, T7 | ~3 days |
| Artifact assembly + footer | T8 | ~2 days |
| Surfaces (CLI + MCP envelope) | T9, T10 | ~3 days |
| Cap + precision floor + threat | T11, T12, T13 | ~2.5 days |
| Region-level (A2) | T14 | ~4 days |
| `--diff` (A3 + #11 + #2) | T15, T16, T17 | ~6.5 days |
| Cold-build (D3) | T18 | ~1 day |
| refreshStale invariant | T19 | ~0.5 day |
| Reconciliation (A1 + #12) | T20 | ~0.5 day |
| Ship | T21, T22 | ~1 day |
| **Total** | T1–T22 | **~32 days (~5–6.5 weeks)** |

## Suggested order

Critical path: T1 → T2 → T6 → T7 → T8 (the spine).

After T8, three streams can run in parallel:
- **Surfaces:** T9 (CLI) + T10 (MCP envelope) + T19 (refreshStale
  test) + T21 (SKILL.md)
- **Cap/precision/threat:** T11, T12, T13
- **Per-language extensions:** T3 (Python), T4 (Go), T5 (Java)

After surfaces land: T14 (region-level), then T15 → T16 → T17
(`--diff`). Cold-build T18 lands once T6 is stable.

T20 (reconciliation) is doc work; do it any time. T22 is the
last step before tag.
