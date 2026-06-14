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

## Source-of-truth for the CLI version constants

**What:** Replace the hand-synced `SIVRU_VERSION` constant in
`packages/cli/src/commands/version.ts:6` and `SERVER_VERSION` in
`packages/cli/src/mcp-entry.ts:48` with a single value read from
`packages/cli/package.json` at module load. Standard Node-CLI
pattern: a small helper `readFileSync`s the `package.json` that
sits alongside `dist/` (npm always publishes it next to the
`files[]` outputs) and parses `.version`; both constants source
from that helper.

**Why:** The hand-synced pattern caused `SIVRU_VERSION` to lie
about the version across four releases (stuck at `0.1.0` from
the initial release through v0.5.0). The v0.4.0 release commit
(0722d80) bumped the four `package.json` files plus
`SIVRU_SEARCH_VERSION` but missed both CLI-side constants. Every
user who ran `sivru version` got `0.1.0` while their installed
binary was actually shipping v0.4 features. `SERVER_VERSION`
(reported to MCP clients) was even worse — stuck at `0.0.0`
since inception. Both fixed manually for v0.5.0 (commit
76fcf82), but the mechanism that allowed four releases of drift
is still there.

**Pros:** one source of truth (package.json); release commits
only touch the four `package.json` files (or fewer with
workspace-version inheritance), not six spots; the drift class
is structurally impossible.
**Cons:** one extra `readFileSync` at CLI startup (~one syscall,
negligible). The build needs a regression test asserting the
runtime-read version matches `package.json`.

**Context:** Surfaced at the v0.5.0 release-finalize (commit
76fcf82). The longstanding `SIVRU_VERSION = "0.1.0"` was the
most visible drift; `SERVER_VERSION = "0.0.0"` reported to MCP
clients was the quieter one. The mcp-entry test
(`packages/cli/src/mcp-entry.test.ts`) already exercises the
server-init path — extending it to assert version equality with
`package.json` is a few lines.

**Effort estimate:** XS (human ~30 min) → with CC+gstack: ~10 min.
**Priority:** P3 — low impact unless drift recurs at v0.6+.
**Depends on:** nothing.

## Agent-assisted @sivru authoring (provenance-aware)

**What:** Let an agent draft an `@sivru` block, but mark provenance
(`source: agent-drafted`) and require a human-confirm before it counts as
authored intent.
**Why:** DESIGN-0024's CEO review cut the "map hands the agent a fill-in stub"
expansion (T2) — machine-authored intent that looks human-authored after commit
erodes sivru's human-authored trust layer. The honest version needs provenance +
a confirm step, which is its own design.
**Context:** Surfaced cutting DESIGN-0024 E3. `map` will still surface the GAP
("no `@sivru` here"); this TODO is the authoring half done safely.
**Effort:** M (human ~2 days) → with CC+gstack: ~M. **Priority:** P3.
**Depends on:** DESIGN-0024 (map) shipping the surface-the-gap hint.

## Cross-agent reach proof for the map tool (Cursor / Codex)

**What:** Verify `mcp__sivru__map` serves correctly to a non-Claude MCP client.
**Why:** DESIGN-0024's value (M-C platform reach) is only proven when a second
agent harness consumes it; deferred from the CEO review (E4) as adapter work.
**Context:** Ties to DESIGN-0010 (Cursor) / DESIGN-0011 (Codex) and the
consumption precondition in DESIGN-0024. The MCP tool is already client-neutral.
**Effort:** M (human ~1 day) → with CC+gstack: ~S. **Priority:** P2.
**Depends on:** DESIGN-0024 Slice 1.

## Post-ship usage metric for the map tool

**What:** After `map` ships, measure whether agents actually call it pre-edit and
whether it completes the locate → orient → inspect → edit → `find_related` arc.
**Why:** DESIGN-0024's DX review (Pass 8) noted the Slice 0 consumption signal
measures *demand before* build, but nothing measures `map`'s *own* uptake after.
Supply without measured uptake is the failure mode the precondition warned about.
**Context:** MCP call logging already exists; track map call-rate + arc completion.
Ties to the efficacy bench (DESIGN-0013). A wrong answer here ("agents ignore it")
should feed the harness-hook / SKILL-workflow follow-on, not another tool.
**Effort:** S (human ~half day) → with CC+gstack: ~XS. **Priority:** P3.
**Depends on:** DESIGN-0024 Slice 1 shipping; DESIGN-0013 (efficacy bench).
