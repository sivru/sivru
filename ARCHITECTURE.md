# Architecture

One-page system map. Code paths, package boundaries, data flow.

## Two products, one binary

```
                    ┌─────────────────────────────────────────────┐
                    │              sivru CLI / MCP                │
                    │                                             │
   coding agent ─►  │  search · index · from-git · mcp · session  │  ◄─ developer
   (Claude Code)    │             observe · doctor                │     (terminal)
                    └────────────┬────────────────────┬───────────┘
                                 │                    │
                          ┌──────▼──────┐      ┌──────▼──────┐
                          │   search    │      │   observe   │
                          │  (engine)   │      │ (sessions + │
                          │             │      │   savings)  │
                          └─────────────┘      └──────┬──────┘
                                                      │
                                              ┌───────▼───────┐
                                              │  observe-ui   │
                                              │  (dark, 3-pane│
                                              │   localhost)  │
                                              └───────────────┘
```

**Product 1 — Code search for agents.** A coding agent (Claude Code, via the
MCP server) calls `sivru.search(query, top_k)` and gets back ranked code
chunks with `(file_path, start_line, end_line, score)`. Cheaper and more
precise than `ripgrep` + multiple `Read` calls (the path Claude Code's
`Grep` tool actually takes today).

**Product 2 — Agent session observability.** Reads the JSONL session files
that Claude Code already writes to `~/.claude/projects/<cwd>/<uuid>.jsonl`,
normalizes them to a stable `SivruEvent` shape, exposes a localhost-only
HTTP API, and ships a four-tab web UI (Sessions / Replay / Costs / Bench).
Counterfactual savings analysis (`sivru observe replay`/`costs`) is
offline and zero-API-cost.

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
- **Chunker** (`src/chunker/`) — line-fallback today (50-line windows,
  5-line overlap). Tree-sitter for 16 grammars is queued for v0.2 behind
  the same `chunkFile()` facade.
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
├── lib/
│   ├── model-catalog.ts      → registered embedders + rerankers (with hf:* escape)
│   ├── config.ts             → ~/.config/sivru/config.json (atomic-rename writes)
│   ├── ground-truth.ts       → derive (query → edited files) from session events
│   ├── metrics.ts            → recall@k, MRR, median, bootstrap CI
│   ├── progress.ts           → BuildIndexProgress reporter w/ cold-start heartbeat
│   └── prompt.ts             → raw-mode TTY checkbox prompt
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
    ├── version.ts
    └── help.ts
```

The CLI is a thin dispatcher. Each subcommand exports `run<Name>(argv): Promise<number>`
returning the exit code. The MCP server (`mcp-entry.ts`) wraps the same
search functions and exposes them to Claude Code as `mcp__sivru__search`
and `mcp__sivru__find_related`. The MCP search response is a JSON
envelope with measured `latencyMs` / `refreshMs` / per-result `score` /
line range; the index is refreshed on every search via `refreshStale()`.

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
```

When mounted with `uiDistDir`, the server also serves the observe-ui
SPA with a path-traversal guard.

### `@sivru/observe-ui`

Vite + React 18 + Tailwind v3. Dark-only; soft-amber accent. Tabs:

- **Sessions** — sessions sidebar / event timeline / inspector. Keyboard-first.
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

