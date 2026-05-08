# Roadmap

> **This is a plan, not a contract.** Versions ship when they're ready.
> Scope of release v(N+1) is set after v(N) lands and we've seen how
> users react. Don't expect dates; do expect the principles below to
> hold across all releases.

What's shipped, what's coming, where this is heading.
[CHANGELOG.md](CHANGELOG.md) is what shipped. Per-version design
decisions live in [`docs/design/`](docs/design/). The
[GitHub milestones page](https://github.com/sivru/sivru/milestones)
is the live tracker — only the next milestone is ever active.

## Direction

Sivru's longer-term role: **bridge the gap between AI-written code and
human comprehension.** Code creation is becoming easy; code
comprehension is becoming hard. The lag shows up in production
incidents nobody can diagnose, refactors nobody dares to start, and
security audits that find issues nobody understands the blast radius
of. Sivru sits between the agent that writes the code and the system
that has to live with it.

Today's product is search + observability. The roadmap turns that into
a coaching layer: agent context-quality signals, comprehension
primitives, then a public skill efficacy table that becomes a trusted
filter for the wider ecosystem.

## Principles

These are stable across all versions. Reviewer checklist; contributor
guide; user expectation.

1. **Small releases.** One focus per version, 1–4 weeks of work.
2. **Feedback between releases.** This roadmap is a plan. We adapt
   v(N+1) scope after v(N) ships and we've watched how users react.
3. **Depth over breadth.** Coaching signals get tuned for false-
   positive rate one at a time. Cross-tool support spans two releases
   for the same reason. We don't queue five features deep and hope.
4. **Customizable by default.** Every feature with a registry,
   ruleset, or catalog ships three layers: built-in defaults,
   declarative JSON override, code-level TS extension. See
   [CONTRIBUTING.md](CONTRIBUTING.md) for the rule.
5. **Local-first.** No telemetry, ever, default-on. The observe layer
   is statically banned from making network calls.
6. **No skipping foundation.** Tree-sitter and chunk-windowing ship
   before any coaching work because every coach signal that depends
   on chunk quality is undermined without them.
7. **Honest about scope.** Sivru sees what the agent sees — its own
   session events. It does NOT see PR reviews on GitHub, code read
   in another tool, or pair-programming discussions. Defaults
   describe what happened; user customization decides what matters.
   Sivru is the runtime; skills tell Claude when to use it. Don't
   overclaim, don't moralize.

## What shipped — 0.1.0

Search engine, CLI, MCP server, observe layer, observe-ui, hybrid
retrieval with optional cross-encoder rerank, asymmetric query
encoding, mid-session refresh, self-bench on your own data. Full
delta in [CHANGELOG `[0.1.0]`](CHANGELOG.md).

---

## Phase 1 — Foundation

### 0.2.0 — Tree-sitter chunker (~3 weeks)

**The one thing:** function-boundary chunks instead of line slices.

**Why first:** every later improvement (coach signals, hierarchical
retrieval, skill bench) sits on top of better chunks. Today's bench
numbers carry an asterisk because line-fallback splits half of every
function across two chunks.

**Issue:** [#11](https://github.com/sivru/sivru/issues/11) ·
**Design:** [DESIGN-0001](docs/design/0001-tree-sitter-chunker.md)
(in-flight on `feat/tree-sitter-chunker`)

### 0.3.0 — Per-model chunk-windowing (~2 weeks)

**The one thing:** chunks resize per embedder context window so
MiniLM (256 tok) and BGE-small (512 tok) stop silently truncating.

**Why now:** the multi-embedder promise is dishonest until this lands.

**Issue:** [#12](https://github.com/sivru/sivru/issues/12) ·
**Design:** [DESIGN-0002](docs/design/0002-per-model-chunk-windowing.md)

---

## Phase 2 — Comprehension primitives + positioning

### 0.4.0 — `@sivru/skill` package (~1 week)

**The one thing:** SKILL.md that teaches Claude when to call sivru
tools vs. Grep / Read.

**Why now:** sivru is the runtime; the skill is the playbook. Public
positioning shift from "code search MCP" to "comprehension layer
for AI-written code." Cheap, compounds well.

**Design:** [DESIGN-0003](docs/design/0003-sivru-skill-package.md)

### 0.5.0 — `sivru explain <path>` (~3 weeks)

**The one thing:** first comprehension primitive. Public API + 1-hop
call graph + churn + ownership (from local `git log`/`git blame`).
Both humans and agents call it. Descriptive only — no judgment.

**Design:** [DESIGN-0004](docs/design/0004-sivru-explain.md)

---

## Phase 3 — Coaching loop, one signal at a time

### 0.6.0 — Coach loop v1: skill drift (~3 weeks)

**The one thing:** lowest-FP-risk coaching signal — CLAUDE.md age
+ dead references. Checkup tab in observe-ui ships here.

**Design:** [DESIGN-0005](docs/design/0005-coach-loop-skill-drift.md) ·
**Inherits from:** [#17](https://github.com/sivru/sivru/issues/17)

### 0.7.0 — Coach loop v2: looped-on-error (~2 weeks)

**The one thing:** detect agent grep'd same pattern 5+ times for
5+ minutes.

**Design:** [DESIGN-0006](docs/design/0006-coach-loop-looped-on-error.md) ·
**Inherits from:** [#16](https://github.com/sivru/sivru/issues/16)

### 0.8.0 — Coach loop v3: agent low-context edit (~3 weeks)

**The one thing:** the comprehension-axis coaching signal. Agent
edited X without reading its imports / tests / callers in the same
session. AGENT context, not human review.

**Design:** [DESIGN-0007](docs/design/0007-coach-loop-low-context-edit.md)

### 0.9.0 — Skill recommender (~3 weeks)

**The one thing:** `sivru recommend skills` — repo + session aware
picker. Three-layer customization (built-in catalog, user/project
JSON, code-level matchers, remote catalogs).

**Design:** [DESIGN-0008](docs/design/0008-skill-recommender.md) ·
**Issue:** [#18](https://github.com/sivru/sivru/issues/18)

---

## Phase 4 — Performance: hierarchical retrieval

### 0.10.0 — Hierarchical retrieval (~3 weeks)

**The one thing:** file-summary embedding + two-stage retrieval.
Cuts cold-start ~10× on large repos. Adapted from the PageIndex
"navigate the structure" idea, scoped to code retrieval.

**Why now:** v0.2's tree-sitter gives clean function-level structure
to summarize file content; v0.3's per-model windowing keeps the
summary embeddable across all our models. Pre-coaching dependency
order doesn't apply — coach loop works fine on chunk-level retrieval.

**Design:** [DESIGN-0009](docs/design/0009-hierarchical-retrieval.md)

---

## Phase 5 — Cross-tool

### 0.11.0 — Cursor adapter (~2 weeks)

**The one thing:** read Cursor sessions through the same
`SessionSource` interface Claude Code uses.

**Design:** [DESIGN-0010](docs/design/0010-cursor-adapter.md)

### 0.12.0 — Codex adapter (~1 week)

**The one thing:** add Codex CLI as a third `SessionSource`.

**Design:** [DESIGN-0011](docs/design/0011-codex-adapter.md)

---

## Phase 6 — Real-agent + skill bench (the moat)

### 0.13.0 — Real-agent replay (~2 weeks)

**The one thing:** opt-in `sivru observe replay-live` — re-runs a
session through the real Anthropic API with vs. without sivru.

**Design:** [DESIGN-0012](docs/design/0012-real-agent-replay.md) ·
**Issue:** [#14](https://github.com/sivru/sivru/issues/14)

### 0.14.0 — Skill efficacy bench (~4 weeks)

**The one thing:** A/B agent task harness — skill loaded vs. not
loaded — and the first public skill efficacy table.

**Why now:** the moat play. Trusted skill curator position
compounds over the v0.4–v0.13 build-up.

**Design:** [DESIGN-0013](docs/design/0013-skill-efficacy-bench.md)

---

## Phase 7 — Map view

### 0.15.0 — Map view in observe-ui (~3 weeks)

**The one thing:** repo overview pane combining session activity
heat + git churn. Honest axes — "agent activity," not
"comprehension."

**Design:** [DESIGN-0014](docs/design/0014-map-view.md)

---

## Phase 8 — Active intervention

### 0.16.0 — Active steering, conservative (~2 weeks)

**The one thing:** PreToolUse hooks that nudge the agent on
risk-sensitive paths. Only after months of FP data from coach
loop signals.

**Design:** [DESIGN-0015](docs/design/0015-active-steering.md)

---

## 1.0.0 — Stable

After 6+ months of bug-fixes on the above. Tag v1.0 when:

- All Phase 1–8 features have field data
- Critical bugs from v0.x are fixed
- Public docs are complete
- The coaching-loop FP rate is low enough that an opt-in user
  doesn't get noise

---

## 0.x patches + community pickups

Smaller items that don't need a full version slot. Land in patch
releases or as standalone PRs:

- `sivru completion` (shell tab completion;
  [#15](https://github.com/sivru/sivru/issues/15))
- `--embed-filter=code-only` opt-in flag
  ([#13](https://github.com/sivru/sivru/issues/13))
- Additional tree-sitter grammars beyond the initial 16
- Additional coaching signals (one per release; see Phase 3 pattern)
- Additional skills A/B'd in the public efficacy table

---

## Beyond v1.0 — research direction (not committed)

Captured here so the ideas aren't lost. None of these have version
slots; they happen if + when there's clear demand and clear scope.

- **`@sivru/github` bridge package.** Opt-in, separately installed.
  Reads PR review metadata to close the human-review-depth gap that
  sivru can't see today.
- **`sivru.navigate` MCP tool.** Repo-tree walking via LLM
  reasoning (PageIndex's structural navigation idea). Expensive on
  tokens; revisit if coaching telemetry shows users hitting queries
  that don't fit search or grep.
- **Reasoning-based reranker.** LLM picks top-5 from top-50 instead
  of cross-encoder. Opt-in; trades tokens for nuance. Only for
  customers who specifically want it.
- **Vectorless mode** (PageIndex-style). Bad fit for code generally
  (identifiers need exact match). Maybe for specific subdomains
  (docs, configs); revisit only if hybrid+rerank hits a quality
  ceiling we can't tune around.
- **Team rollup** (anonymized signal aggregation across a team).
  Strategic decision; default = no. Build the anonymized export
  format first as a v0.x patch if + when B2B intent is explicit.

## Explicitly NOT on the roadmap

- IDE plugins as first-class. Sivru is MCP-first.
- Multi-tenant / server mode. Sivru runs locally per developer.
- GPU embedding throughput. CPU is the constraint; HTTP provider
  exists for hosted GPU paths.
- Telemetry or usage analytics. Privacy boundary is the product.
- Prompt engineering / LLM finetuning. Adjacent space.
