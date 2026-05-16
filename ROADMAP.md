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

> The goal, the uniqueness, and the test every release must pass live
> in [GOALS.md](GOALS.md). This section is the short version.

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

The first concrete comprehension primitive is **authored context**:
structured, in-repo annotations that record not just what a symbol
does but the decisions behind it and the conditions under which those
decisions should be revisited. An agent that can read why the code is
shaped this way — and when that reasoning expires — makes a judgment
call instead of a blind edit. That layer (v0.6–v0.8) is what the
explainer projects, and what the coaching loop later checks for drift.

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

## How to read this roadmap — the goal test

Every version is one of four classes (defined in [GOALS.md](GOALS.md)):

- **Foundation** — the floor the rest stands on.
- **Spine** — *is* the goal: builds, delivers, or maintains the
  comprehension layer.
- **Supporting** — improves an instrument (search) or extends reach.
- **Proof** — demonstrates the value to the outside world.

Before anything earns a slot it must answer one question: *how does
this make the codebase more comprehensible, or keep comprehension
honest?* When versions compete for execution priority, Spine wins.

| Version | Focus | Class |
|---|---|---|
| 0.2.0 | Tree-sitter chunker | Foundation |
| 0.3.0 | Per-model chunk-windowing | Foundation |
| 0.4.0 | `@sivru/skill` package | Spine |
| 0.5.0 | `sivru explain <path>` | Spine |
| 0.6.0 | `@sivru` annotation blocks | Spine |
| 0.7.0 | Serving authored context | Spine |
| 0.8.0 | Codebase explainer | Spine |
| 0.9.0 | Coach loop: skill drift | Spine |
| 0.10.0 | Coach loop: looped-on-error | Spine |
| 0.11.0 | Coach loop: low-context edit | Spine |
| 0.12.0 | Skill recommender | Supporting |
| 0.13.0 | Cursor adapter | Supporting |
| 0.14.0 | Codex adapter | Supporting |
| 0.15.0 | Real-agent replay | Proof |
| 0.16.0 | Skill efficacy bench | Proof |
| 0.17.0 | Map view | Supporting |
| 0.18.0 | Active steering | Spine |
| 0.19.0 | Hierarchical retrieval | Supporting |

Nine of eighteen versions are Spine. The Supporting and Proof items
are honest — none fails the goal test — but they serve the goal, they
are not it.

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

### 0.6.0 — `@sivru` annotation blocks (~3 weeks)

**The one thing:** a language-neutral, structured block of authored
context — role, invariants, and time-bounded decisions
(`chose / because / valid-while / revisit-if`) — carried in the
code's own doc comments and extracted via tree-sitter.

**Why now:** v0.5's `sivru explain` is descriptive only — derived
facts, no judgment. The judgment an agent needs ("why is it built
this way, and is that still true?") is exactly what no derived
signal can recover; it has to be authored. Tree-sitter (v0.2) makes
per-language extraction a small comment-locator instead of five
separate parsers.

**Design:** [DESIGN-0016](docs/design/0016-sivru-annotation-blocks.md)

### 0.7.0 — Serving authored context (~2 weeks)

**The one thing:** `sivru explain` surfaces `@sivru` blocks
alongside its derived facts, and `sivru block check` detects drift —
broken collaborator references, stale blocks, missing required
fields.

**Why now:** an extracted block nobody can read is dead weight, and
an authored block with no drift signal rots silently. Surfacing and
drift-checking ship together or the layer isn't trustworthy.

**Design:** [DESIGN-0017](docs/design/0017-serving-authored-context.md)

### 0.8.0 — Codebase explainer (~3 weeks)

**The one thing:** `sivru explain --project --html` — a whole-repo,
hash-routed drill-down explainer (System → Module → Package →
Symbol) that fuses derived facts with authored blocks, plus an
in-place feedback loop that writes corrections back to the blocks,
not the artifact.

**Why now:** onboarding starts at the system, not a file. This is
the human-facing payoff of v0.6–v0.7, and its feedback loop is what
keeps the authored layer honest as the code evolves.

**Design:** [DESIGN-0018](docs/design/0018-codebase-explainer.md)

---

## Phase 3 — Coaching loop, one signal at a time

### 0.9.0 — Coach loop v1: skill drift (~3 weeks)

**The one thing:** lowest-FP-risk coaching signal — CLAUDE.md age
+ dead references. Checkup tab in observe-ui ships here.

**Design:** [DESIGN-0005](docs/design/0005-coach-loop-skill-drift.md) ·
**Inherits from:** [#17](https://github.com/sivru/sivru/issues/17)

### 0.10.0 — Coach loop v2: looped-on-error (~2 weeks)

**The one thing:** detect agent grep'd same pattern 5+ times for
5+ minutes.

**Design:** [DESIGN-0006](docs/design/0006-coach-loop-looped-on-error.md) ·
**Inherits from:** [#16](https://github.com/sivru/sivru/issues/16)

### 0.11.0 — Coach loop v3: agent low-context edit (~3 weeks)

**The one thing:** the comprehension-axis coaching signal. Agent
edited X without reading its imports / tests / callers in the same
session. AGENT context, not human review.

**Design:** [DESIGN-0007](docs/design/0007-coach-loop-low-context-edit.md)

### 0.12.0 — Skill recommender (~3 weeks)

**The one thing:** `sivru recommend skills` — repo + session aware
picker. Three-layer customization (built-in catalog, user/project
JSON, code-level matchers, remote catalogs).

**Design:** [DESIGN-0008](docs/design/0008-skill-recommender.md) ·
**Issue:** [#18](https://github.com/sivru/sivru/issues/18)

---

## Phase 4 — Cross-tool

### 0.13.0 — Cursor adapter (~2 weeks)

**The one thing:** read Cursor sessions through the same
`SessionSource` interface Claude Code uses.

**Design:** [DESIGN-0010](docs/design/0010-cursor-adapter.md)

### 0.14.0 — Codex adapter (~1 week)

**The one thing:** add Codex CLI as a third `SessionSource`.

**Design:** [DESIGN-0011](docs/design/0011-codex-adapter.md)

---

## Phase 5 — Real-agent + skill bench (the moat)

### 0.15.0 — Real-agent replay (~2 weeks)

**The one thing:** opt-in `sivru observe replay-live` — re-runs a
session through the real Anthropic API with vs. without sivru.

**Design:** [DESIGN-0012](docs/design/0012-real-agent-replay.md) ·
**Issue:** [#14](https://github.com/sivru/sivru/issues/14)

### 0.16.0 — Skill efficacy bench (~4 weeks)

**The one thing:** A/B agent task harness — skill loaded vs. not
loaded — and the first public skill efficacy table.

**Why now:** the moat play. Trusted skill curator position
compounds over the v0.4–v0.15 build-up.

**Design:** [DESIGN-0013](docs/design/0013-skill-efficacy-bench.md)

---

## Phase 6 — Map view

### 0.17.0 — Map view in observe-ui (~3 weeks)

**The one thing:** repo overview pane combining session activity
heat + git churn. Honest axes — "agent activity," not
"comprehension."

**Design:** [DESIGN-0014](docs/design/0014-map-view.md)

---

## Phase 7 — Active intervention

### 0.18.0 — Active steering, conservative (~2 weeks)

**The one thing:** PreToolUse hooks that nudge the agent on
risk-sensitive paths. Only after months of FP data from coach
loop signals.

**Design:** [DESIGN-0015](docs/design/0015-active-steering.md)

---

## Phase 8 — Search performance

### 0.19.0 — Hierarchical retrieval (~3 weeks)

**The one thing:** file-summary embedding + two-stage retrieval.
Cuts cold-start ~10× on large repos. Adapted from the PageIndex
"navigate the structure" idea, scoped to code retrieval.

**Class:** Supporting. It improves the search instrument's
cold-start — a cost a user pays once per repo. Nothing on the spine
depends on it; the coach loop works fine on chunk-level retrieval,
and it is dependency-ready from v0.3 on.

**Why last — and demand-gated (principle 2).** Three weeks of
search-performance polish does not belong inside the comprehension
spine, so it sits at the end of the plan by default. But the slot
is held loosely: if cold-start feedback shows users hitting the wall
on large repos, this pulls forward ahead of the Supporting and Proof
releases. The number marks sequence intent, not a commitment.

**Design:** [DESIGN-0009](docs/design/0009-hierarchical-retrieval.md)

---

> **Sequencing notes.** Two deliberate moves shaped the numbers above.
> (1) Phase 2 gained three versions (0.6–0.8 — the
> authored-comprehension layer:
> [DESIGN-0016](docs/design/0016-sivru-annotation-blocks.md),
> [DESIGN-0017](docs/design/0017-serving-authored-context.md),
> [DESIGN-0018](docs/design/0018-codebase-explainer.md)).
> (2) Hierarchical retrieval moved to the end (0.19): it is
> Supporting and demand-gated, and should not interrupt the
> comprehension spine. Design-doc numbers are stable and did not
> change; only version numbers did. Each older design doc's
> `Targets:` field is reconciled when its milestone becomes active —
> per principle 2, only the next milestone is ever firm.

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
- **Decision-graph queries.** Once `@sivru` blocks carry decisions
  at scale, "show every decision whose `revisit-if` is now true" is
  a cross-repo comprehension query worth a dedicated surface.

## Explicitly NOT on the roadmap

- IDE plugins as first-class. Sivru is MCP-first.
- Multi-tenant / server mode. Sivru runs locally per developer.
- GPU embedding throughput. CPU is the constraint; HTTP provider
  exists for hosted GPU paths.
- Telemetry or usage analytics. Privacy boundary is the product.
- Prompt engineering / LLM finetuning. Adjacent space.
