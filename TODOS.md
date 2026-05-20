# TODOS

Deferred work that doesn't need a full version slot. Each item has
enough context that someone picking it up months later understands
the motivation and where to start.

## Bench corpus representativeness audit

**What:** Audit whether the bench corpus (3 repos — zod, requests,
gson — 60 hand-labeled queries) contains large functions and mixed
top-level/function files representative of real codebases. Add
labeled queries that exercise function-boundary chunking and
oversized-node behavior.

**Why:** DESIGN-0001 (tree-sitter chunker) claims a +0.05–0.10
hybrid NDCG gain from function-boundary chunking. That gain is only
measurable if the corpus actually contains functions that
line-fallback was splitting. If the 3 repos are mostly small
functions, the bench shows a flat number and the release's headline
claim — plus any future chunker change — can't be validated. The
oversized-node cap has the same blind spot.

**Pros:** the bench becomes a trustworthy gate for chunker work.
**Cons:** adding a corpus repo + hand-labeling queries is real work
and shifts every baseline.

**Context:** Corpus + baselines live in `benchmarks/`. Surfaced in
the v0.2.0 engineering review (decision D6, D10).

**Depends on:** v0.2.0 landing first, so the audit baseline is the
tree-sitter baseline, not the line-fallback one.

## Streaming buildIndex — bound peak memory

**What:** `buildIndex`'s cold path (`packages/search/src/search.ts`,
~lines 360–385) walks the repo and pushes every file's full text into
a `files[]` array, then chunks the whole array. The entire repo's
source is resident in RAM at once. Refactor toward a streaming shape:
walk → read → chunk → discard each file's content before the next.

**Why:** latent memory ceiling on very large monorepos — the
large-repo users the roadmap cares about. Not introduced by any
recent change; pre-existing.

**Pros:** lower peak memory on big repos.
**Cons:** touches the `buildIndex` cold path and the cache-save path,
which currently consume the full chunk array.

**Context:** Surfaced in the v0.2.0 engineering review, Section 4
(decision D11). Explicitly kept out of v0.2.0 scope — unrelated to
chunking.

**Depends on:** nothing.

## Chunk size vs. hybrid retrieval quality

**What:** Smaller chunks consistently cost hybrid NDCG on the bench.
v0.2's tree-sitter chunker cost potion hybrid −0.011; v0.3's per-model
windowing cost MiniLM hybrid −0.021 (windowed 0.611 vs un-windowed
0.632, all three repos). Investigate the retrieval architecture: how
chunk scores aggregate to a file rank, RRF fusion behaviour when one
file has many small chunks, and whether the file-level NDCG metric
itself rewards few-large chunks. Decide a fix — chunk→file score
aggregation, fusion tuning — or pull hierarchical retrieval (v0.19)
forward.

**Why:** two releases running, a chunking improvement that is correct
(function boundaries; no silent truncation) has *lowered* hybrid
retrieval quality. The pattern is now bigger than any one release. If
sivru's chunks keep getting smaller (the comprehension layer wants
symbol-level granularity) while hybrid retrieval keeps paying for it,
the search instrument quietly degrades release over release.

**Pros:** removes a recurring hidden tax on every chunker improvement;
makes function-boundary chunking a retrieval win, not just a
correctness one.
**Cons:** likely a real retrieval-architecture change, not a tweak.

**Context:** Surfaced by the v0.3.0 MiniLM bench A/B (see
`CHANGELOG.md` `[0.3.0]` → Benchmarks). Related to the corpus-audit
item above — confirm the effect is real signal, not a metric
artifact, before committing to an architecture change.

**Depends on:** nothing; should precede or absorb v0.19 (hierarchical
retrieval).

## Tool-neutral routing rules — Cursor + Codex

**What:** Extend `sivru skill install` to also emit per-tool routing
rule files from the same canonical policy — a Cursor `.cursor/rules`
entry and a Codex `AGENTS.md` fragment — alongside the Claude Code
`SKILL.md`.

**Why:** GOALS.md sells tool-neutrality as part of sivru's core
uniqueness ("outlives any single agent tool — Claude Code, Cursor,
Codex all come and go"). The MCP tool descriptions are already
tool-neutral — every MCP client sees them. But the deep routing policy
(find_related-after-edit workflow, the `observe` pointer, and from v0.6
`@sivru`-block authoring) ships only as a Claude Code `SKILL.md`. A
Cursor or Codex user gets the always-on floor and none of the depth.

**Pros:** delivers on the tool-neutrality claim for the deep layer, not
just the MCP floor; widens reach beyond Claude Code.
**Cons:** more install surface to keep in sync per target; the v0.4
efficacy smoke test is Claude-specific, so the other targets ship
unverified until their own efficacy is checked.

**Context:** Surfaced in the /plan-ceo-review of DESIGN-0003
(2026-05-19) as expansion Candidate 1; deferred so the Claude routing
efficacy is proven first (v0.4 smoke test, v0.16 skill-efficacy bench).
The deferred work is the per-tool deep-policy emit plus its
install-safety surface — it should reuse whatever edit-safety subsystem
DESIGN-0003's §3 work lands in v0.6.

**Effort estimate:** M (human ~3-4 days) → with CC+gstack: ~3-4 hours.
**Priority:** P3.
**Depends on:** v0.4 (the canonical `SKILL.md` and the routing policy);
ideally the v0.6 install edit-safety subsystem so the multi-target
emit reuses one update-safety mechanism rather than three.
