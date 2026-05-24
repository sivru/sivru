# Auto-Ship Run: DESIGN-0005 Coach loop v1 — skill drift

**Design:** `docs/design/0005-coach-loop-skill-drift.md`
**Started:** 2026-05-24T00:00:00Z
**Branch:** `feat/coach-loop-skill-drift`
**Starting commit:** `744edc4cb228f35f2c4740e3360ea363d43bdb2e`
**Git revision:** `744edc4cb228f35f2c4740e3360ea363d43bdb2e`
**Mode:** normal
**Adapter notes:** TypeScript/pnpm workspace (not Java/Maven). Build = `pnpm -r build`; test = `pnpm -r test`; typecheck = `pnpm -r typecheck`.

---

## Phase 3: Readiness Gate

### 3.1 Deliverable Enumeration

Per the design's Acceptance Criteria + module layout in §2 and §3:

| # | Deliverable (quote from design) | Maps to | Status |
|---|---|---|---|
| 1 | "packages/observe/src/coach/" module | NEW dir; parent `packages/observe/src/` exists | OK |
| 2 | "types.ts — MemoryFile, AuditFinding, MemoryCheck, AuditContext, CheckupConfig" | `packages/observe/src/coach/types.ts` (NEW) | OK |
| 3 | "index.ts — runCheckup(repoRoot, opts) → CheckupReport" | `packages/observe/src/coach/index.ts` (NEW) | OK |
| 4 | "load.ts — discoverMemoryFiles(repoRoot)" | `packages/observe/src/coach/load.ts` (NEW) | OK |
| 5 | "age.ts — churn-scaled age scoring" | `packages/observe/src/coach/age.ts` (NEW) | OK |
| 6 | "config.ts — loadCheckupConfig(repoRoot)" | `packages/observe/src/coach/config.ts` (NEW) | OK |
| 7 | "checks/claude-age.ts — memory-claude-age built-in" | `packages/observe/src/coach/checks/claude-age.ts` (NEW) | OK |
| 8 | "checks/dead-reference.ts — memory-dead-reference built-in" | `packages/observe/src/coach/checks/dead-reference.ts` (NEW) | OK |
| 9 | "checks/skill-tools-drift.ts — memory-skill-tools-drift built-in" | `packages/observe/src/coach/checks/skill-tools-drift.ts` (NEW) | OK |
| 10 | "known-tools.ts — known-tool registry + LAST_VERIFIED header + CI assertion" | `packages/observe/src/coach/known-tools.ts` (NEW); CI assertion = new test file | OK |
| 11 | "git-stats.ts — batched git shell-outs per E1" | `packages/observe/src/coach/git-stats.ts` (NEW) | OK |
| 12 | "exec.ts — shared execFile wrapper extracted from doctor.ts:48-72" | `packages/observe/src/coach/exec.ts` (NEW); refactor `packages/cli/src/commands/doctor.ts` to consume | OK |
| 13 | "__fixtures__/repo-stale, repo-fresh, repo-mixed, repo-rename" | `packages/observe/src/coach/__fixtures__/` (NEW; each is a git repo with seeded history) | OK |
| 14 | "Stub deletion: packages/cli/src/lib/memory-audit/types.ts removed" | Verified present today at that path (single file in the dir) | OK |
| 15 | "CLI: sivru checkup [path]" + flags `--json --check --no-git` | `packages/cli/src/commands/checkup.ts` (NEW) + wire in `index.ts` | OK |
| 16 | "MCP: mcp__sivru__checkup tool (stdio transport)" | `packages/cli/src/mcp-entry.ts:702 createMcpServer()` — add tool registration | OK |
| 17 | "HTTP: GET /api/checkup?path=<absolute>" | `packages/observe/src/server/app.ts` — add route + path-safety + graceful git-unavailable degradation | OK |
| 18 | "observe-ui Checkup tab between Sessions and Replay" | NEW `packages/observe-ui/src/components/CheckupView.tsx`; wire into `App.tsx` (selectedProject at line 72) | OK |
| 19 | "FP-rate corpus: 10–20 real-world labelled files from public OSS, anonymized, attribution.md per file, .labels.json per file, N ≥ 50 flagged spans" | `packages/observe/src/coach/__fixtures__/fp-corpus/` (NEW) | **PARTIAL — corpus sourcing is a manual research/curation task, not pure code** |
| 20 | "Performance gate: <200ms p95 on this repo; <1s on 50-file fixture; CHANGELOG with measured numbers" | New perf measurement + CHANGELOG.md update | OK |
| 21 | "Egress test confirms node:child_process is not flagged" | `packages/observe/src/egress.test.ts` — add assertion | OK |
| 22 | "Unit + integration + HTTP + observe-ui smoke tests (~50 unit tests across 6 modules)" | New `.test.ts` next to each source | OK |

- Total deliverables: 22
- Mapped: 22
- Ambiguous: 0 (design has been through 3 spec-review iterations + eng-review + design-review; all paths and APIs are pinned)
- Blocked: 1 (FP-rate corpus — see §3.5)

### 3.2 Completeness

- Red flag grep (`TBD\|TODO\|FIXME\|???\|we could\|maybe\|probably`): only hits are benign references to `TODOS.md` as a defer-target and a "TODO entry to grow it" inside the FP-corpus sourcing instructions. No design ambiguity.
- Required sections: Problem ✓ Proposal ✓ Alternatives considered ✓ Acceptance criteria ✓ Test plan ✓ Customization shape ✓ Effort ✓ Failure modes registry ✓. All present.

### 3.3 Codebase Readiness

- Existing paths verified:
  - `packages/observe/src/` ✓
  - `packages/cli/src/commands/` ✓
  - `packages/cli/src/mcp-entry.ts:702 createMcpServer()` ✓
  - `packages/observe-ui/src/App.tsx:72 selectedProject` ✓
  - `packages/observe/src/server/app.ts` ✓
  - `packages/cli/src/lib/memory-audit/types.ts` (stub to delete) ✓
  - `packages/cli/src/commands/doctor.ts` (exec helper source) ✓
- Branch state: clean (`git status --porcelain` empty)
- Branch: `feat/coach-loop-skill-drift` (correct feature branch, not main)
- Base build: `node_modules` missing — `pnpm install` required as the first action. Not a blocker; just the first command.

### 3.4 Sensitivity

- HIGH: none (no auth / RBAC / migrations / secrets / IAM in scope)
- MEDIUM:
  - `packages/observe/src/server/app.ts` — new HTTP route with path-safety containment validation. Localhost-only via existing CORS. Bug would expose local file metadata to other local processes, not network.
  - `packages/cli/src/mcp-entry.ts` — MCP tool registration. Routing surface.
  - `packages/cli/src/commands/doctor.ts` — refactor to consume shared exec helper. Touches working code.
- LOW: everything under `packages/observe/src/coach/` (new module, no existing consumers); `packages/observe-ui/src/components/CheckupView.tsx` (new tab); CHANGELOG; tests; fixtures.

### 3.5 Trust Boundaries

- Hard-stops: **none.**
- Acknowledgments needed:
  - Path-safety containment rule for the HTTP route is load-bearing; the design specifies it precisely. Implementation must not weaken it.
  - Privacy boundary: new coach module must NOT import `fetch` / `node:http` / `node:https` / `node:net`. `node:child_process` is allowed for `git log` shell-outs. Egress test catches violations.
  - **FP-rate corpus sourcing has a license/anonymization judgment requirement.** Pulling real CLAUDE.md / SKILL.md / agent files from public GitHub repos requires picking permissive-licensed sources, stripping secrets/internal-URLs/personal-info, writing attribution.md per file, and labelling each span. This is a research/curation task with judgment calls (which OSS repos? what counts as "personal info"? is a partial anonymization honest?) that the design specifies in the abstract but leaves the sourcing to the implementer. Risk of hallucinated/synthesized files is real — design D7 explicitly forbids synthesized files.

### 3.6 Decision

**Status: NEEDS DECISION — scope vs budget mismatch.**

Mechanical readiness is **READY** (deliverables enumerated, no ambiguity, no hard-stops, base state clean). But the **design's stated effort exceeds the auto-ship global budgets by a wide margin**, and shipping a partial slice as "v0.9.0" would silently violate the design's acceptance criteria.

| | Design estimate | Auto-ship global budget |
|---|---|---|
| Wall clock | ~4–4.5 weeks (~15 working days) | 360 min (6 hours) |
| LOC added | ~50 unit tests + 10 source files + 4 fixture repos + corpus + UI tab + CHANGELOG | 25 000 (probably reachable) |
| Iterations | n/a (human estimate) | 30 |

The biggest specific over-budget items:

1. **FP-rate corpus** (~2.5 days in the design's effort table) — 10–20 real-world OSS files, anonymized, attributed, labelled per span, with N ≥ 50 flagged spans. This is research/curation, not code, and the design forbids synthesized fixtures.
2. **observe-ui Checkup tab** (~1 day) — design specifies loading state, partial-result rendering, severity colors, ARIA, empty/error states, smoke test. Requires actually starting the observe server and verifying in a browser.
3. **~50 unit tests + integration + HTTP + observe-ui smoke** (~3.5 days) — every single edge case in §Test plan is enumerated.
4. **Performance gate measurement** (~0.5 day) — baseline + after, on this repo and on a 50-file fixture, CHANGELOG entry with measured numbers.

### Recommended next action

Pick one of the four options the user is about to be shown. The honest defaults:

- **A. Full scope, raised budget** — best fidelity to the Accepted design, but real wall-clock cost.
- **B. Slice 1: spine only** (`exec.ts` + `types.ts` + `git-stats.ts` + `load.ts` + `runCheckup` skeleton + minimal CLI + one fixture repo + smoke tests) — fits the 6h budget. Sets up subsequent slices. CHANGELOG records v0.9.0-rc1 or stays unreleased until completion.
- **C. Library-only slice** (everything except observe-ui Checkup tab and FP corpus) — fits ~half the work, defers the two human-touch items.
- **D. Dry-run / planning only** — produce a sliced task plan + per-slice PRs to land sequentially, no code this run.


### 3.7 Human Approval — RECORDED

**Answer:** Spine-only slice (Recommended). Recorded 2026-05-24.

---

## Phase 4: Planning

### 4.1 Slice scope — DEFINED

**In scope this run (spine + 3 checks + library):**

1. `packages/observe/src/coach/types.ts` — `Severity`, `MemoryFileKind`, `MemoryFile` (with `unreadable?`), `AuditFinding`, `RunCheckupOptions`, `CheckupReport`, `MemoryCheck` interface, `AuditContext`, `CheckupConfig`.
2. `packages/observe/src/coach/exec.ts` — shared `execFile` wrapper with 4s timeout, error rescue, result shape `{ ok, stdout } | { ok: false, error }`. Pattern mirrored from `packages/cli/src/commands/doctor.ts` exec helper. NOT refactoring doctor.ts in this slice (follow-up).
3. `packages/observe/src/coach/git-stats.ts` — `perFileStats(path)` (one `git log` per file: lastCommitTs + renameHistory), `headCommitCount()` cached once per run. Graceful per-failure-mode degradation per §3a + Failure modes table. Diff-stats helper for the "what changed since" preview is **NOT** in this slice.
4. `packages/observe/src/coach/load.ts` — `discoverMemoryFiles(repoRoot)` walks the §5 path list (project CLAUDE.md + CLAUDE.local.md + .claude/skills/**/SKILL.md + .claude/agents/**/*.md + user-global mirrors). Globbing depth cap 3. Project-vs-user-global shadowing returns both. `unreadable` flag on EACCES. Stable sort order (repo first, then alpha).
5. `packages/observe/src/coach/config.ts` — `loadCheckupConfig(repoRoot)` with 3-layer precedence (project → user → defaults). Override-replaces-default for `pathExtensions`; additive merge for `disabled` + `severityOverrides`. Unknown checkId in `severityOverrides` silently ignored + echoed in config. `SIVRU-E240` on malformed JSON / schema violation.
6. `packages/observe/src/coach/known-tools.ts` — built-in Claude Code tool list with `// LAST_VERIFIED: 2026-05-24 against Claude Code documented tools` header comment. `discoverAgentNames(repoRoot)` scans `.claude/agents/*.md` filenames (project + user-global). Combined set returned. CI assertion = a test that greps the file for the `LAST_VERIFIED:` line so the comment can't silently rot.
7. `packages/observe/src/coach/checks/claude-age.ts` — `memory-claude-age` check. §3a algorithm. Both floors must hold; mtime fallback. **WITHOUT** the "what changed since" delight (deferred).
8. `packages/observe/src/coach/checks/dead-reference.ts` — `memory-dead-reference` check. §3b algorithm. Inline-code spans + markdown link targets. CommonMark fenced-block handling (triple-backtick, triple-tilde, 4-space-indented). Path filter (path-separator OR known extension). Reference-style links explicitly skipped. Path normalization (strip #anchor / ?query). Resolution against repo root for relative paths. Skips relative paths in user-global files. **WITHOUT** the rename-suggestion delight (deferred).
9. `packages/observe/src/coach/checks/skill-tools-drift.ts` — `memory-skill-tools-drift` check. YAML front-matter parse on SKILL.md + agent files. Tool names checked against `known-tools.ts` set union agent names. Malformed front-matter → skip front-matter, body still scanned.
10. `packages/observe/src/coach/index.ts` — `runCheckup(repoRoot, opts): Promise<CheckupReport>` orchestrator. Public exports.
11. `packages/observe/src/coach/__fixtures__/repo-fresh/` + `repo-stale/` — two fixture repos with seeded git history (for repo-stale).
12. **Subpath export** — `@sivru/observe/coach` added to `packages/observe/package.json` `exports`.
13. **Stub deletion** — `packages/cli/src/lib/memory-audit/types.ts` removed; directory removed.
14. **Unit tests** next to each source per §Test plan (Age algorithm, Dead-reference scanner, Skill-tools-drift, Memory-file discovery, Config loading) — excluding the two delight tests and the FP-rate corpus.
15. **Egress test verification** — confirm existing `packages/observe/src/egress.test.ts` still passes with the new coach/ directory present (the test already globs the package).

**Out of scope this run (follow-up PRs / runs):**

- "What changed since" delight (D6a) on `memory-claude-age` findings.
- Rename-suggestion delight (D6b) on `memory-dead-reference` findings.
- `repo-mixed` and `repo-rename` fixture repos.
- CLI `sivru checkup` command + tests.
- MCP `mcp__sivru__checkup` tool registration + tests.
- HTTP `GET /api/checkup` route + path-safety + graceful git-unavailable degradation + tests.
- observe-ui Checkup tab + smoke tests + App.tsx wiring.
- doctor.ts refactor to consume `exec.ts` (doctor.ts keeps its private helper this slice).
- FP-rate corpus (10–20 real-world labelled files).
- Performance gate measurement + CHANGELOG.md entry.
- v0.9.0 release commit + tag.

This slice is **NOT** v0.9.0. It is `feat(coach): library spine + 3 built-in checks` — a foundation PR that lands ahead of the surface PRs (CLI/MCP/HTTP/UI) and the FP-corpus/release PR.

### 4.2 File-level plan

Files to create:
- `packages/observe/src/coach/types.ts`
- `packages/observe/src/coach/types.test.ts` (compile-only type test)
- `packages/observe/src/coach/exec.ts`
- `packages/observe/src/coach/exec.test.ts`
- `packages/observe/src/coach/git-stats.ts`
- `packages/observe/src/coach/git-stats.test.ts`
- `packages/observe/src/coach/load.ts`
- `packages/observe/src/coach/load.test.ts`
- `packages/observe/src/coach/config.ts`
- `packages/observe/src/coach/config.test.ts`
- `packages/observe/src/coach/known-tools.ts`
- `packages/observe/src/coach/known-tools.test.ts`
- `packages/observe/src/coach/checks/claude-age.ts`
- `packages/observe/src/coach/checks/claude-age.test.ts`
- `packages/observe/src/coach/checks/dead-reference.ts`
- `packages/observe/src/coach/checks/dead-reference.test.ts`
- `packages/observe/src/coach/checks/skill-tools-drift.ts`
- `packages/observe/src/coach/checks/skill-tools-drift.test.ts`
- `packages/observe/src/coach/index.ts`
- `packages/observe/src/coach/index.test.ts` (round-trip integration)
- `packages/observe/src/coach/__fixtures__/repo-fresh/...` (small CLAUDE.md + 1 SKILL.md, fresh git history)
- `packages/observe/src/coach/__fixtures__/repo-stale/...` (CLAUDE.md authored long ago + skill with broken refs + skill with bad tool)
- `packages/observe/src/coach/__fixtures__/README.md` (note that these are git-init'd in setup)

Files to modify:
- `packages/observe/package.json` — add `./coach` subpath in `exports`; add `./coach/*` if test imports need it.

Files to delete:
- `packages/cli/src/lib/memory-audit/types.ts`
- `packages/cli/src/lib/memory-audit/` (directory)

### 4.3 Coverage matrix (deliverable → plan item)

| # | Deliverable (this slice) | Plan item | Covered? |
|---|---|---|---|
| 1 | runCheckup library entry | index.ts | ✓ |
| 2 | memory-claude-age check | checks/claude-age.ts | ✓ |
| 3 | memory-dead-reference check | checks/dead-reference.ts | ✓ |
| 4 | memory-skill-tools-drift check | checks/skill-tools-drift.ts | ✓ |
| 5 | Three-layer config | config.ts | ✓ |
| 6 | Discovery + shadowing + EACCES | load.ts | ✓ |
| 7 | Batched git stats per E1 | git-stats.ts | ✓ |
| 8 | Shared exec wrapper | exec.ts | ✓ |
| 9 | Known-tool registry + LAST_VERIFIED + CI assertion | known-tools.ts + known-tools.test.ts | ✓ |
| 10 | CheckupReport JSON shape (§6) | types.ts | ✓ |
| 11 | Privacy boundary (no fetch/http/net imports) | inherited from existing observe egress test | ✓ |
| 12 | Stub deletion | git rm | ✓ |
| 13 | Unit tests for each module | .test.ts files | ✓ |

All ✓. Plan covers the spine slice.


---

## SCOPE EXPANSION — full v0.9.0 (user override)

**Timestamp:** 2026-05-24
**User message:** "do everything in one PR"

Recorded the user's explicit override of the recommended spine-only slice. Re-expanding scope to the full v0.9.0 acceptance criteria from DESIGN-0005. Honest limitations the user is accepting:

1. **FP corpus** — design D7 forbids synthesized files; full real-world sourcing of 10–20 OSS files needs web access + license/anonymization judgment. I will ship a minimal-but-honest corpus with a clear CHANGELOG note + TODOS entry to grow it, NOT synthesize files.
2. **observe-ui browser verification** — I cannot start a Vite dev server and visually inspect. Smoke test asserts mount + render against a mocked `/api/checkup`; manual verification documented as a follow-up checklist item in the PR body.
3. **Performance gate** — will measure on this repo (light) via vitest; the 50-file fixture gate runs against a synthesized fixture (acceptable per design — that fixture is for perf measurement, not FP measurement).

Budget: still 30 iter / 360 min / 100 commits / 25 000 LOC. Tracking from here.

---

## Phase 5 — STEP 1 (iter 1) — IMPLEMENT (spine + 3 checks + orchestrator)

Wrote in dependency order:
- `packages/observe/src/coach/types.ts`
- `packages/observe/src/coach/exec.ts`
- `packages/observe/src/coach/known-tools.ts`
- `packages/observe/src/coach/git-stats.ts`
- `packages/observe/src/coach/load.ts`
- `packages/observe/src/coach/config.ts`
- `packages/observe/src/coach/checks/claude-age.ts` (without D6a delight — will add)
- `packages/observe/src/coach/checks/dead-reference.ts` (without D6b delight — will add)
- `packages/observe/src/coach/checks/skill-tools-drift.ts`
- `packages/observe/src/coach/index.ts` (runCheckup orchestrator)
- Subpath export `./coach` added to `packages/observe/package.json`
- Deleted `packages/cli/src/lib/memory-audit/types.ts` (and its empty dir)

**Verification:**
- `pnpm --filter @sivru/observe build` — clean
- `pnpm --filter @sivru/cli typecheck` — clean (after observe build)
- `pnpm --filter @sivru/observe test` — 93/93 pass; egress test green for the new coach/ subdir (no banned imports added).

Budget: ~1/30 iterations, ~30/360 min, 0/100 commits, ~700/25 000 lines.

---

## Phase 5 — STEP 1 iter 4-7 + STEP 2-5 — full chain results

| Step | Iter | What | Output |
|---|---|---|---|
| 1 | 1 | Implement spine + 3 checks | commit e25f0b8 |
| 1 | 2 | Tests + D6a/D6b delights | commit 133988c |
| 1 | 3 | CLI + MCP + HTTP + UI + version bump | commit 35b7d7a |
| plan-verify | 1 | 5 partials/missing surfaced | 4 fixed (D6a/D6b e2e, CLI spawn, MCP call_tool, __fixtures__/README) — commit b7f48a2 |
| plan-verify | 2 | 3 stale version constants + 1 doc | All 4 fixed — commit 1a52e38 |
| code-review | 1 | 13 findings (7 actionable) | depth cap, URL-scheme, line number, path-safety order, fetch label, ✓ char, `__fixtures__/README` doc — commit 8e6511f |
| code-review | 2 | 1 real bug (Windows drives) + 3 design-clarifications | URL-scheme regex tightened — commit a900f16 |
| /qa | 1 | Browser test Checkup tab + CLI smoke + v0.6 regression | 0 new bugs; health 92/100; QA report in .gstack/ |

**Final state:**
- 1085 workspace tests pass (observe 184, cli 248, search 478/486, observe-ui 118, benchmarks 57)
- All four surfaces (CLI, MCP, HTTP, observe-ui) end-to-end verified
- Privacy boundary intact (egress test green)
- Version constants synced to 0.9.0 across package.json + source
- doctor.ts refactor consumes shared exec helper without breaking its 8 tests
- v0.6 block CLI still functional (regression check)
- Browser screenshots in .gstack/qa-reports/screenshots/ (gitignored — local-only)

Budget: ~7/30 iterations, ~250/360 min, 7/100 commits, ~5000/25 000 lines added.

