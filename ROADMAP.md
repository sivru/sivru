# Roadmap

What's shipped, what's coming, where this is heading.

This file is the plan; [CHANGELOG.md](CHANGELOG.md) is what shipped.
The [GitHub milestones page](https://github.com/sivru/sivru/milestones)
is the live tracker — only the next milestone is ever active; we don't
pre-create five releases ahead.

## Direction

The long-term goal: **help engineers get better at using coding
agents**, and **host more tools that help them do it**. Sivru's search
engine is the first such tool. The observability layer is the surface
where coaching can land. Future releases broaden the toolkit while
keeping each piece small enough to be read, understood, and replaced.

## Principles

1. **Small releases.** Each version is one focus, 1–4 weeks of work,
   shippable on its own.
2. **Feedback between releases.** This roadmap is a plan, not a
   contract. Ship → see how it lands → adapt the next release's scope
   before starting it.
3. **Depth over breadth.** One coaching signal at a time, tuned for
   false-positive rate, before adding the next. Cross-tool support
   spans two releases for the same reason.
4. **Customizable by default.** Every feature with a registry,
   ruleset, or catalog ships three layers: built-in defaults,
   declarative JSON override, code-level extension. Today this applies
   to embedders + rerankers; the same shape applies to every future
   feature. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rule.
5. **Local-first.** No telemetry, ever, default-on. The observe layer
   is statically banned from making network calls. New features inherit
   that constraint.
6. **No skipping foundation.** Tree-sitter and chunk-windowing ship
   before coaching work because every coach signal that depends on
   chunk quality is undermined without them.

## What shipped — 0.1.0

Search engine, CLI, MCP server, observe layer, observe-ui, hybrid
retrieval with optional cross-encoder rerank, asymmetric query
encoding, mid-session refresh, self-bench on your own data. Full delta
in [CHANGELOG `[0.1.0]`](CHANGELOG.md).

---

## Phase 1 — Fix the foundation

### 0.2.0 — Tree-sitter chunker (~3 weeks)

**The one thing:** function-boundary chunks instead of line slices.

**Why first:** every later improvement (coach signals, skill bench,
cross-tool support) sits on top of better chunks. Today's bench
numbers carry an asterisk because of line-fallback splitting half of
every function across two chunks.

**Issue:** [#11](https://github.com/sivru/sivru/issues/11)

**Done when:** 16 grammars covered; line-fallback stays as the safety
net so unknown languages still chunk; bench is re-baselined and
republished.

### 0.3.0 — Per-model chunk-windowing (~2 weeks)

**The one thing:** chunks resize per embedder context window so MiniLM
(256 tok) and BGE-small (512 tok) stop silently truncating.

**Why now:** the multi-embedder promise is dishonest until this lands.
Pairs naturally with v0.2's tree-sitter chunks.

**Issue:** [#12](https://github.com/sivru/sivru/issues/12)

**Done when:** instruct embedders show their real performance in the
re-published bench.

---

## Phase 2 — Coaching loop, one signal at a time

### 0.4.0 — Coach loop v1: skill drift (~3 weeks)

**The one thing:** ONE coaching signal in observe-ui — stale CLAUDE.md
detection — surfaced in a new "Checkup" tab.

**Scope:** subset of issue [#17](https://github.com/sivru/sivru/issues/17).
Two checks ship: file-age and dead-references. Three-layer
customization: built-in checks, JSON override at
`~/.config/sivru/memory-audit.json` and `.sivru/memory-audit.json`, TS
extensions at `.sivru/memory-audit/*.ts`.

**Why one signal:** false-positive rate is what makes or breaks
coaching. Prove the loop works on one signal before broadening.

**Done when:** signal fires correctly on 5 real test sessions
(manually verified); FP rate < 10% on a labeled set; Checkup tab UX
shipped end-to-end.

### 0.5.0 — Coach loop v2: looped-on-error (~2 weeks)

**The one thing:** a second signal — agent grep'd same pattern 5+
times for 5+ minutes (subset of issue
[#16](https://github.com/sivru/sivru/issues/16)).

**Why now:** v0.4 field feedback is in. Broaden the loop while tuning
both signals' FP rates together.

**Done when:** new signal fires; skill-drift hasn't regressed;
combined FP rate < 15%.

### 0.6.0 — Skill recommender (~3 weeks)

**The one thing:** `sivru recommend skills` — repo + session-aware
picker (issue [#18](https://github.com/sivru/sivru/issues/18)).

**Why now:** coach loop has surfaced "you're missing skill X"
signals; this turns them into action. Three-layer customization
applies: built-in catalog of ~30 entries, user/project JSON catalogs,
remote catalog support for company-shared skill lists.

**Done when:** built-in catalog ships; user/project overrides work;
remote catalog support shipped.

---

## Phase 3 — Expand the audience

### 0.7.0 — Cursor adapter (~2 weeks)

**The one thing:** read Cursor sessions through the same
`SessionSource` interface Claude Code uses.

**Why now:** coach loop is proven on Claude Code; cross-tool support
unlocks the "agent cockpit" framing instead of "Claude Code accessory."

**Done when:** `sivru observe` lists Cursor sessions; coach signals
fire on Cursor sessions same as Claude Code.

### 0.8.0 — Codex adapter (~1 week)

**The one thing:** add Codex CLI as a third `SessionSource`.

**Why now:** the adapter pattern is established; cross-tool story is
"all three" or it's incomplete.

**Done when:** all coach signals fire on Codex sessions same as
Claude / Cursor.

---

## Phase 4 — The moat

### 0.9.0 — Real-agent replay (~2 weeks)

**The one thing:** opt-in `sivru observe replay-live` — re-runs a
session through the real Anthropic API with vs. without sivru
(issue [#14](https://github.com/sivru/sivru/issues/14)).

**Why now:** offline replay (Layer 2) has gone as far as it can. For
the v0.10 skill bench we need real API runs.

**Done when:** API key handling, retries, idempotency, and token
counting all work; clear "this costs API tokens" warning before any
run; opt-in flag.

### 0.10.0 — Skill efficacy bench (~4 weeks)

**The one thing:** A/B agent task harness — skill loaded vs. not
loaded — and the first public skill efficacy table.

**Why now:** This is the moat play. Whoever publishes the trusted
table first becomes the curator of the skill ecosystem. The agent
practitioner literature has been demanding this for a year (4 of 5
popular security skills don't change Claude's reasoning, etc.).

**Done when:** harness shipped in `benchmarks/`; first 10 skills
A/B'd; results published in `BENCHMARKS.md` and the Bench tab;
methodology fully open-source.

---

## Phase 5 — Active intervention (slow + careful)

### 0.11.0 — Active steering, conservative (~2 weeks)

**The one thing:** PreToolUse hooks that nudge the agent when about
to edit risk-sensitive files (`auth/`, `payments/`, etc.) AND no
security-review skill is loaded.

**Why now:** months of false-positive data from the coach loop
(v0.4–v0.6) have shown which signals are precise enough for a hook to
fire on without annoying the user.

**Done when:** opt-in flag; FP rate < 5% on a labeled set; nudges fire
BEFORE the edit, not after; user can disable per-pattern.

---

## 0.12+ — Polish + new signals one at a time

- `sivru completion` (shell tab completion; trivial PR — anyone can pick this up)
- `--embed-filter=code-only` opt-in flag (issue
  [#13](https://github.com/sivru/sivru/issues/13))
- More coaching signals, one per release
- More skills A/B'd in the public efficacy table
- More `SessionSource` adapters as the community asks
- v1.0 when everything above is stable + has 6 months of bug-fixes

---

## Explicitly NOT on the roadmap

- **Team rollup / B2B aggregation.** Strategic decision deferred. If
  the answer becomes "yes" later, build the anonymized export format
  first as a v0.x release, ship the rollup tool separately.
- **`bench tthw` (time-to-hello-world)** — internal tooling. Lands if
  needed for a regression hunt.
- **IDE plugins as first-class.** Sivru is MCP-first. Editors get it
  through their MCP integration.
- **Multi-tenant / server mode.** Sivru runs locally per developer.
- **GPU embedding throughput.** CPU is the constraint; HTTP provider
  exists for hosted GPU paths.
- **Telemetry or usage analytics.** Privacy boundary is the product.
  Any future opt-in usage stats ship in a separately installable
  `sivru-analytics` package the user adds explicitly.
- **Prompt engineering / LLM finetuning.** Adjacent space; not what
  sivru is solving.
