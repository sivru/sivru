# Architecture

One-page system map. Code paths, package boundaries, data flow.

## Two products + a comprehension layer, one binary

```
                    ┌─────────────────────────────────────────────────┐
                    │                 sivru CLI / MCP                  │
                    │  search · index · from-git · mcp · session ·     │
   coding agent ─►  │  observe · doctor · explain · feedback · block · │  ◄─ developer
   (Claude Code)    │  checkup                                         │     (terminal)
                    └──────┬───────────────┬───────────────┬──────────┘
                           │               │               │
                    ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
                    │   search    │ │ explainer + │ │   observe   │
                    │  (engine)   │ │  @sivru     │ │ (sessions + │
                    │  + symbol   │─▶│  blocks +   │ │   savings + │
                    │   index     │ │  feedback   │ │   coach)    │
                    └─────────────┘ └─────────────┘ └──────┬──────┘
                                                           │
                                                   ┌───────▼───────┐
                                                   │  observe-ui   │
                                                   │  (dark, 6-tab │
                                                   │   localhost)  │
                                                   └───────────────┘
```

**Product 1 — Code search for agents.** A coding agent (Claude Code, via the
MCP server) calls `sivru.search(query, top_k)` and gets back ranked code
chunks with `(file_path, start_line, end_line, score)`. Cheaper and more
precise than `ripgrep` + multiple `Read` calls (the path Claude Code's
`Grep` tool actually takes today).

**Comprehension layer — authored context + the explainer.** `@sivru` blocks
record a symbol's role/responsibility/invariants/decisions in source, with
reliability checks (drift, staleness, invariant→test linkage, a cross-block
graph) under `sivru block`. `sivru explain` serves that intent per file/region;
`sivru explain --project`/`--html` projects the whole repo into the
System→Module→Package→Symbol model and renders an offline HTML map;
`sivru explain --project --diff [--gate]` diffs that model across a change and
reports (or gates on) the architectural delta — new cycles, new coupling, and
broken `@sivru` invariant→test linkages; and `sivru feedback apply` writes a
reader's corrections back to the block in source. Built on the search engine's
symbol index. (DESIGN-0016/0018/0019/0023.)

The shared artifact under all of that is the **ExplainerModel** (`explainer/model.ts`):
one deterministic, tree-sitter-built tree — System → Module → Package → Symbol —
with three layers hung off every node. **Structure:** exports + `depEdges` (the
module/package import graph, i.e. the blast radius). **Authored intent:** the
`@sivru` block (role / responsibility / invariants / decisions / `enforced-by`)
when a human wrote one. **Health:** `churn`, `hotScore` (churn × coupling), cycle
membership, and broken-linkage drift. It is a *projection of facts* (parser + git
+ human-written text), never an AI generation — which is why the one model can
serve onboarding (`--html`), the PR gate (`--diff --gate`), and the planned agent
map (DESIGN-0024) without inventing anything.

**Product 2 — Agent session observability.** Reads the JSONL session files
that Claude Code already writes to `~/.claude/projects/<cwd>/<uuid>.jsonl`,
normalizes them to a stable `SivruEvent` shape, exposes a localhost-only
HTTP API, and ships a six-tab web UI (Sessions / Checkup / Blocks / Replay /
Costs / Bench). The coach loop (`@sivru/observe/coach`, `sivru checkup`)
surfaces drift in CLAUDE.md / SKILL.md / agent files. Counterfactual savings
analysis (`sivru observe replay`/`costs`) is offline and zero-API-cost.

Strict privacy boundary: `packages/observe/` makes no network calls,
ever. Enforced by a static lint rule and a runtime `fetch` spy.

## The four packages

```
packages/
├── search/         → @sivru/search       (engine; library + workers)
├── cli/            → sivru               (CLI binary + MCP entry)
├── observe/        → @sivru/observe      (session readers, HTTP server)
└── observe-ui/     → @sivru/observe-ui   (Vite + React + Tailwind shell)
```

### `@sivru/search`

```
walk → chunk → tokenize → BM25 index ┐
                                     │
              embed → cosine matrix ─┴─► RRF fusion → signals
                                                          │
                                            ┌─────────────┘
                                            ▼
                                  optional cross-encoder rerank
                                            │
                                            ▼
                                       top-K hits
```

- **Walker** (`src/walker/`) — async; respects nested `.gitignore` with
  negations; bounded against symlink loops; emits files in a stable order.
- **Chunker** (`src/chunker/`) — tree-sitter function-boundary chunks for
  16 grammars (shipped v0.2), with per-model chunk-windowing (v0.3); falls
  back to 50-line windows / 5-line overlap for unparsed files, all behind the
  same `chunkFile()` facade. Also hosts the `@sivru` block extractor + symbol
  index that the explainer and `sivru explain` build on.
- **Tokenizer** (`src/bm25/tokenize.ts`) — splits on whitespace + punct,
  preserves dotted names (`requests.get`), splits camelCase + snake_case +
  kebab-case.
- **BM25** (`src/bm25/`) — Lucene-style; configurable `k1` and `b`.
  Default-on reranking signals (definition boost, multi-chunk file boost,
  path penalties, identifier-stem matching).
- **Vector** (`src/vector/`) — flat `Float32Array` matrix. Cosine top-K
  via dot product (vectors are L2-normalized at insert time).
- **Embed** (`src/embed/`) — pluggable `EmbeddingProvider`: mock,
  Transformers.js, Model2Vec (potion), OpenAI-compatible HTTP.
  Optional `embedQuery` for asymmetric instruct embedders (BGE, Nomic, E5).
- **Hybrid** (`src/search.ts`) — Reciprocal Rank Fusion over BM25 and
  semantic rankings (§4.5). `refreshStale()` re-walks and re-embeds only
  modified files for mid-session edits.
- **Rerank** (`src/rerank/`) — optional `CrossEncoder` stage applied
  after fusion: BM25⊕embed → top-N candidates → cross-encoder rescore →
  top-K. Transformers.js implementation defaults to
  `Xenova/ms-marco-MiniLM-L-6-v2`.
- **Cache** (`src/cache/`) — on-disk per-repo, keyed by `(repo_path, state_id)`.
  Atomic-rename writes; filename sanitization for Windows.

### `sivru` CLI / MCP

```
src/
├── index.ts                  → top-level dispatcher
├── mcp-entry.ts              → @modelcontextprotocol/sdk server
├── skill-asset.ts            → resolve + read the bundled SKILL.md
├── smoke/                    → §5 routing-efficacy testbench (corpus, parser, runner)
├── lib/
│   ├── model-catalog.ts      → registered embedders + rerankers (with hf:* escape)
│   ├── config.ts             → ~/.config/sivru/config.json (atomic-rename writes)
│   ├── ground-truth.ts       → derive (query → edited files) from session events
│   ├── metrics.ts            → recall@k, MRR, median, bootstrap CI
│   ├── progress.ts           → BuildIndexProgress reporter w/ cold-start heartbeat
│   └── prompt.ts             → raw-mode TTY checkbox prompt
├── explainer/               → the codebase explainer (DESIGN-0018) + diff/gate (DESIGN-0023)
│   ├── model.ts             → buildExplainerModel: System→Module→Package→Symbol
│   ├── levels.ts            → dir→level mapping; model-cache.ts; narrative.ts
│   └── html/                → SSR renderer (views, svg, routes, search, render + the client shim)
├── feedback/                → the write-back loop (DESIGN-0018 Slice 3)
│   ├── apply.ts             → patch → @sivru block in source (hash-gated, never corrupts)
│   ├── patch.ts             → the patch contract + parse/validate (SIVRU-E2012)
│   └── narrative.ts, notes.ts → .sivru/explainer.md + .sivru/feedback-notes.md writers
└── commands/
    ├── search.ts
    ├── index-cmd.ts
    ├── from-git.ts
    ├── session.ts
    ├── observe.ts            (server + replay + costs + init)
    ├── bench-personal.ts     (recall@5 / MRR / tokens-saved on YOUR sessions)
    ├── bench-models.ts       (catalog list)
    ├── config.ts             (sivru config get/set/unset/list/path)
    ├── doctor.ts
    ├── skill.ts               (skill install/uninstall — writes the bundled SKILL.md)
    ├── explain.ts            (file/region · --project · --html · --diff)
    ├── feedback.ts           (feedback apply <patch.json>)
    ├── block.ts              (validate / extract / staleness / graph / check-enforcement / init)
    ├── checkup.ts            (coach-loop drift report)
    ├── version.ts
    └── help.ts
```

The bundled routing skill (`SKILL.md`) ships at the package root, not
under `src/` — `sivru skill install` writes it into a Claude Code
skills directory; `skill-asset.ts` resolves and reads it.

The CLI is a thin dispatcher. Each subcommand exports `run<Name>(argv): Promise<number>`
returning the exit code. The MCP server (`mcp-entry.ts`) exposes eight tools
to Claude Code: read-only `mcp__sivru__search`, `find_related`, `explain`,
`checkup`; and four writable ones gated behind `--writable` —
`block_autofix`, `block_acknowledge`, `feedback_read`, `feedback_append` (so
an agent can maintain authored context, not just read it). The MCP search
response is a JSON
envelope with measured `latencyMs` / `refreshMs` / per-result `score` /
line range; the index is refreshed on every search via `refreshStale()`.
Since v0.4 the two tool `description` strings also carry a one-line
routing hint (when to prefer `sivru.search` over grep) — the always-on
guidance channel; the fuller policy is the bundled `SKILL.md`.

### `@sivru/observe`

```
src/
├── sources/jsonl/            → walks ~/.claude/projects/<cwd>/<uuid>.jsonl,
│                               normalizes events, resolves git worktree info
├── cost/                     → Layer 1 token + dollar savings estimator
├── replay/                   → Layer 2 offline counterfactual analysis
└── server/                   → Hono v4; localhost-only by default; CORS allowlist
```

Server endpoints:

```
GET /api/health
GET /api/sessions                              # session list
GET /api/sessions/:id/events?limit=N           # normalized events
GET /api/sessions/:id/stream                   # SSE live tail
GET /api/sessions/:id/savings                  # Layer 1 estimate
GET /api/sessions/:id/replay                   # Layer 2 counterfactual
GET /api/savings?since=N                       # rollup across sessions
GET /api/bench-history                         # past `sivru bench personal` runs
GET /api/bench-history/:id                     # one run, full detail
GET /api/checkup                               # coach-loop drift report (v0.7)
GET /api/blocks                                # @sivru blocks across the repo (v0.9)
GET /api/blocks/:filePath/:symbol              # one block + diagnostics
GET /api/blocks/stream                         # SSE re-scan on file change
POST /api/blocks/autofix | /edit | /acknowledge  # writable surface (--writable)
GET|POST /api/feedback                          # read / append .sivru feedback records
GET /api/metrics                               # block-reliability rollup
```

When mounted with `uiDistDir`, the server also serves the observe-ui
SPA with a path-traversal guard.

### `@sivru/observe-ui`

Vite + React 18 + Tailwind v3. Dark-only; soft-amber accent. Tabs:

- **Sessions** — sessions sidebar / event timeline / inspector. Keyboard-first.
- **Checkup** — coach-loop drift across CLAUDE.md / SKILL.md / agent files.
- **Blocks** — `@sivru` authored-context blocks across the repo, with the
  writable surface (autofix / edit / acknowledge) and reliability diagnostics.
- **Replay** — turn-by-turn counterfactual scoreboard.
- **Costs** — token + $ rollup over a configurable window.
- **Bench** — past `sivru bench personal` runs with recall@5 / MRR /
  tokens-saved bars and bootstrap CI bands.

Talks only to its own backend (the `@sivru/observe` server) — no
third-party network calls.

## Data flow — a single search

```
1. Agent calls   mcp__sivru__search({ query, top_k })
2. CLI MCP       loads or builds the index for the repo (rehydrates from
                 cache if state_id matches; otherwise walks + chunks +
                 embeds). refreshStale() picks up any mid-session edits.
3. Engine        runs BM25 + cosine, fuses via RRF, applies reranking
                 signals, optionally cross-encoder reranks the top-N.
4. Engine        returns top_k hits.
5. MCP           wraps as a JSON envelope with latencyMs + per-result
                 score + line range. Agent receives ~5 KB instead of
                 reading whole files.
```

Numbers are in [BENCHMARKS.md](BENCHMARKS.md).

## Data flow — a single observe session view

```
1. Browser  GET /api/sessions             → list of session metadata
            GET /api/sessions/:id         → metadata + savings rollup
            GET /api/sessions/:id/events  → normalized event stream
            GET /api/sessions/:id/stream  → SSE live tail (live sessions only)

2. Server   reads ~/.claude/projects/<cwd>/<uuid>.jsonl line-by-line
            → normalize/                  → stable SivruEvent shape
            → savings/                    → per-event token + $ savings estimate
            → JSON response
```

No mutations, no network egress, no cross-session writes. Read-only over a
file format Claude Code already produces.

## Where each topic lives in code

| Topic | Code path |
|---|---|
| Walker | `packages/search/src/walker/` |
| Chunker (line + tree-sitter) | `packages/search/src/chunker/` |
| Tokenizer | `packages/search/src/bm25/tokenize.ts` |
| BM25 + cosine | `packages/search/src/{bm25,vector}/` |
| Reranking signals | `packages/search/src/ranking/` |
| Hybrid (RRF) | `packages/search/src/search.ts` |
| Cross-encoder rerank | `packages/search/src/rerank/` |
| Embedding providers + asymmetric query encoding | `packages/search/src/embed/` |
| `@sivru` block extract / serialize / hash / autofix | `packages/search/src/block/` |
| Symbol index (drives explain + the explainer) | `packages/search/src/explain/` |
| Codebase explainer (model + HTML) | `packages/cli/src/explainer/` |
| Feedback write-back loop | `packages/cli/src/feedback/` |
| Coach loop (drift checks) | `packages/observe/src/coach/` |
| Blocks UI + writable API | `packages/observe-ui/` + `packages/observe/src/server/` |
| Privacy boundary | `packages/observe/src/server/` + lint rule |
| Observe sources (jsonl) | `packages/observe/src/sources/` |
| Cost / savings estimator | `packages/observe/src/cost/` |
| Counterfactual replay | `packages/observe/src/replay/` |
| CLI surface | `packages/cli/src/` |
| Persistent CLI config + model catalog | `packages/cli/src/lib/` |
| Test plan | `*.test.ts` next to source |
| Error codes (`SIVRU-ENNN`) | inline `throw new Error("SIVRU-Exxx: …")` |

## Extension points

The points the engine intentionally exposes for plugin code:

1. **`EmbeddingProvider`** — `{ dim, embed }` plus optional `embedBatch`
   and optional `embedQuery` (for instruct embedders). See
   [recipe](docs/recipes/swap-embedder.md).
2. **`CrossEncoder`** — one method (`score(query, docs)`). Drop in any
   reranker model. Implementation in `packages/search/src/rerank/`.
3. **Chunker languages** — extension → language-id map plus an optional
   tree-sitter grammar in v0.2. See [recipe](docs/recipes/add-a-language.md).
4. **MCP tools** — single source of truth in `packages/cli/src/mcp-entry.ts`;
   add a `server.tool()` registration. See [recipe](docs/recipes/add-mcp-tool.md).
5. **Reranking signals** — `applySignals()` in `packages/search/src/ranking/signals.ts`.
6. **Model catalog entries** — `packages/cli/src/lib/model-catalog.ts`
   registers embedders and rerankers users can pick by short name.

If your plugin point isn't on this list, propose it on an issue first.
We'd rather decide once than maintain ad-hoc seams.

