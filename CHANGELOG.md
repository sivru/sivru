# Changelog

All notable changes to sivru will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: pre-1.0 semver. Any breaking change in 0.x.y bumps `x`. Patches `y` are bug-fix only.
Breaking changes are prefixed `BREAKING:` per DESIGN.md §21.10.

## [Unreleased]

Targeting **0.2.0 — Tree-sitter chunker**. See
[ROADMAP.md](ROADMAP.md) and
[DESIGN-0001](docs/design/0001-tree-sitter-chunker.md).

### Added

- **Tree-sitter chunker** (`@sivru/search`). Files in TypeScript,
  JavaScript, Python, Go, and Java (7 language ids incl. tsx/jsx) are
  chunked on function / class / method boundaries instead of fixed
  50-line windows. The AST view is the substrate the v0.6–0.8
  authored-context layer extracts from; the retrieval gain ships with
  it. Every other language keeps the line-window chunker.
- `Chunk` gains `nodeType` (the AST node that produced the chunk) and
  `symbolName` (its identifier) — populated by the tree-sitter path,
  `undefined` for line/gap chunks.
- The 6 grammar WASM files are bundled in the package; no runtime
  download. `web-tree-sitter` and `tree-sitter-wasms` pinned exact.
- `windowLines()` — a range-aware line-window primitive reused for
  gap-fill and oversized-node splitting.

### Changed

- **BREAKING: `chunkFile()` is now async** (`Promise<Chunk[]>`). It
  awaits grammar load (memoised after first use). Internal callers
  already awaited; external callers must add `await`.
- Chunking runs on the main thread — the `worker_threads` pool is
  removed (`BuildIndexOptions.workers`, `WORKER_FILE_THRESHOLD`).
  Tree-sitter parses in milliseconds per file and a worker pool cannot
  share loaded grammars; one `Parser` is simpler and uses less memory.
- `CACHE_FORMAT_VERSION` 1 → 2 — v0.1 indexes rebuild once on upgrade.
- A tree-sitter file is always fully indexed: AST node chunks plus
  line-fallback "gap" chunks over every range no node covers, so no
  line is silently dropped. Oversized nodes are line-windowed.
- Bench re-baselined on the 3-repo / 60-query corpus. BM25 NDCG@10
  0.5933 → 0.6168 (**+0.024**). Hybrid 0.6013 → 0.5908 (**−0.011** —
  within point-estimate noise on a small-function corpus; see the
  bench-corpus TODO). Perf: 993 → 3531 chunks at flat build time
  (570 → 585 ms) — tree-sitter parsing is not the bottleneck.

## [0.1.0] — 2026-05-05

First public release. The 0.1.0-rc.1 work that landed during dogfooding
is folded in below; this is what actually ships to npm.

### Added

**Retrieval quality**
- Cross-encoder reranker primitive (`CrossEncoder` interface +
  Transformers.js implementation) plumbed via
  `BuildIndexOptions.rerank` into both `searchBM25` and `searchHybrid`.
  Pipeline: BM25⊕embedding fuse → top-N candidates (default 50) →
  cross-encoder rescore → top-K. Default
  `Xenova/ms-marco-MiniLM-L-6-v2` (~100 ms / 50 pairs CPU);
  `Xenova/bge-reranker-base` available for ~5× the latency and
  stronger quality. Mock cross-encoder for tests.
- Asymmetric query encoding via optional `embedQuery(text)` on
  `EmbeddingProvider`. Transformers provider auto-applies
  model-specific instruction prefixes for BGE
  (`"Represent this sentence for searching relevant passages: "`),
  Nomic (`"search_query: "` / `"search_document: "`), and E5
  (`"query: "` / `"passage: "`). Without this, those models retrieved
  at sub-optimal capacity. Symmetric encoders (potion, MiniLM,
  jina-code) get empty prefixes; behavior unchanged.
- `SivruIndex.refreshStale()` — mid-session embedding refresh on
  file changes. Per-file mtime tracking + content-hash dedup so
  unchanged chunks reuse old embeddings. The MCP server calls this
  before every search.
- `createPotionProvider()` — Model2Vec static embedder runtime.
  Default model `minishlab/potion-retrieval-32M`. No transformer
  inference: tokenize → row lookup → mean-pool → L2-normalize.
  ~32 µs / embed CPU. Hand-rolled safetensors parser + HF Hub
  fetcher with on-disk cache.

**CLI**
- `sivru bench personal` — benchmark embedders + rerankers on YOUR
  Claude Code sessions + repos. Auto-discovers projects from
  `~/.claude/projects/`, derives ground truth from session edits,
  computes file-level recall@5 + MRR + tokens-saved with bootstrap
  90% CIs. Honest baseline reads narrow context windows around grep
  hits (not full files). Run history persisted to
  `~/.cache/sivru/bench-history/`.
- `sivru bench models` — catalog of registered embedders +
  rerankers with size / RAM / latency / license / cold-start.
- `sivru config get / set / unset / list / path` — persistent
  embedder choice in `$XDG_CONFIG_HOME/sivru/config.json`. Atomic
  rename writes, parse-failure-tolerant. The MCP server reads it
  on startup.
- `sivru search --rerank=<name>` and `--rerank-top-n=<n>`.
- `sivru search --embed=<name>` accepts every catalog short name
  (`bm25`, `potion`, `minilm`, `bge-small`, `jina-code`,
  `nomic-embed`) plus `hf:owner/model-name`.
- Interactive raw-mode checkbox picker when `bench personal` runs
  without `--models`. Arrow keys, space-toggle, `a` for all, digit
  shortcuts (1–9), esc/q to cancel.
- Build-progress reporter with cold-start heartbeat — fires every
  30 s during the chunked → first-embed gap so the user knows
  whether MiniLM / BGE is downloading or hung.
- `sivru observe replay <id>` and `sivru observe costs --since=N`
  — counterfactual replay (Layer 2) over existing sessions. Zero
  API cost; runs offline against the model pricing table.
- `sivru observe init` — emits a `~/.claude/agents/sivru-search.md`
  subagent file scoped to retrieval queries.

**Observe + UI**
- Worktree-aware project grouping. `inferred-prefix` heuristic
  surfaces deleted worktrees under their parent project.
- Per-turn coaching signal on the timeline (missed-opportunity
  badge + sivru.search → consumer linking).
- Replay-diff view (DESIGN.md §6.5) — turn-by-turn counterfactual
  scoreboard.
- "Bench" tab — past `sivru bench personal` runs surfaced via
  `GET /api/bench-history` + `/api/bench-history/:id`. Dual-fill
  bar: solid p50 + faded p05–p95 90% CI band, for both recall@5
  and tokens-saved.
- Project switcher, live pulse indicator, costs view, sessions
  list refinement, robustness banners.

**MCP**
- Search response is now a JSON envelope with `latencyMs` /
  `refreshMs` / `refreshDelta` / per-result
  `score` / `source` / line range.
- Refreshes the index on every search via `refreshStale()`.

### Changed
- **`bench personal` primary metric is file-level recall@5 + MRR**
  (ground truth derived from session edits). Tokens-saved becomes
  secondary. Reason: a retriever returning empty / random short
  chunks "saved" the most tokens with the old framing — the metric
  scored compactness, not retrieval correctness.
- **Honest bench baseline.** Reads narrow context windows (~30
  lines) around grep hits, not 3 full files. The previous "% saved"
  headline was inflated by 30+ percentage points; the new number is
  defensible.
- Bench passes `signals: false` to BOTH BM25 and hybrid runs so the
  retriever-vs-retriever comparison is apples-to-apples (production
  defaults differ — that's the live-product question, not the
  bench question).
- Default hybrid embedder is `createPotionProvider()`. Cold-start
  indexing on a 16k-chunk repo drops from ~10–15 min to ~30 s.
  Quality hit on the W2 bench is -0.059 NDCG@10 (0.6601 → 0.6013).
- `searchBM25` is now async (was sync) so cross-encoder reranking
  can apply uniformly. Existing callers that awaited the conditional
  `... ? hybrid : bm25` continue to work; in-process callers that
  used the result synchronously need an `await`.

### Fixed
- onnxruntime-node `mutex lock failed: Invalid argument` crash when
  worker_threads + transformers ran together on Node < 22.11.
  `buildIndex` now defaults to single-threaded chunking when
  `embed` is enabled.
- `buildIndex` cache persists embeddings on partial-cache-hit
  upgrades (chunks loaded from cache, embeddings computed this
  run); fixes a bug where second-time hybrid runs kept re-embedding.
- Per-session % saved was using the wrong denominator in observe-ui
  (could exceed 100%).
- Lossy decode of project directory names — observe now reads `cwd`
  from jsonl events directly so worktree grouping is reliable.
- Search-result share clamp + replay-view chip clarity
  (code-review follow-through).

### Performance
- 7-phase observe-ui sprint targeting long-session render: SSE
  batching (50 ms windows), React.memo on TimelineEvent /
  TurnHeader / SessionRow with custom equality functions,
  `useDeferredValue` for the filter input, per-turn render cap
  (500 events with a "show all" footer), Inspector pre-block cap
  (50 000 chars). On a 5 000-event session, scroll latency drops
  from ~600 ms to ~40 ms.

## [0.1.0-rc.1] — 2026-05-04

### Added

**Engine (`@sivru/search`)**
- Gitignore-aware async walker (`walk()`) with nested `.gitignore` + negations, symlink-loop bounds, binary skip, size cap, typed skip reasons.
- Line-fallback chunker (50 lines, 5 overlap per DESIGN.md §4.1) with extension-driven language detection for the 16 grammars in scope.
- Identifier-aware BM25 tokenizer (`tokenize`) — splits camelCase / snake_case / kebab-case, preserves dotted identifiers.
- Lucene-style BM25 (`createBm25Index`) over a sparse posting list. Hand-computed scoring reference verified to 1e-6.
- Float32Array flat-matrix cosine top-k (`cosineTopK`, `packMatrix`).
- Reciprocal Rank Fusion (`reciprocalRankFusion`).
- Reranking signals (`applySignals`): definition boost / multi-chunk file boost / path penalties / identifier-stem matching. Default-on for BM25; off in hybrid (RRF over-double-counts).
- Pluggable `EmbeddingProvider` interface + three implementations: deterministic mock for tests, `@huggingface/transformers` (default `Xenova/all-MiniLM-L6-v2`), OpenAI-compatible HTTP (works with OpenAI / Voyage / Ollama / vLLM / LM Studio).
- `worker_threads` pool (`min(8, cpus)`) for parallel chunking.
- On-disk index cache keyed by `(repo_path, state_id)` with atomic-rename writes (Windows-safe rename retry + filename sanitization), format-version + corruption tolerance, embeddings rehydration when the provider's `dim` matches.
- `SivruIndex.fromPath()` facade tying everything together: `searchBM25(query, k)` and `searchHybrid(query, k)`.

**CLI (`sivru`)**
- `sivru search <query> [path]` with `--top=N`, `--hybrid`, `--json`. Cache opt-in by default — second runs in the same repo are sub-second.
- `sivru index <path>` with `--json`. Reports `cacheHit: true|false`.
- `sivru mcp` — stdio MCP server using `@modelcontextprotocol/sdk`. Two tools: `search` (full retrieval), `find_related` (placeholder, lands W3+).
- `sivru from-git <url> [-r <ref>]` — depth=1 clone, SSRF guard (default-block private IPs / localhost / `file://`), cached by `(url, ref)` hash in `~/.cache/sivru/git/`.
- `sivru session list` / `sivru session show <id-prefix>` — read Claude Code's `~/.claude/projects/<cwd>/<uuid>.jsonl` session files, with `--json` for ndjson output.
- `sivru observe` — boots the Hono HTTP server on `127.0.0.1:7676` (default) and serves the built observe-ui on `/`. SIGINT-aware shutdown.
- `sivru version` / `sivru help`.

**Observe (`@sivru/observe`)**
- Jsonl source: `listSessions`, `readSession`, `createJsonlSource` — full normalizer for the real Claude Code on-disk format (handles user/assistant entries with content as plain string OR array of text/tool_use/tool_result/thinking blocks; tool_results inside user entries; system events).
- Hono v4 HTTP server: `GET /api/health`, `/api/sessions`, `/api/sessions/:id/events?limit=N`. CORS allowlist restricted to `http://localhost:*` and `127.0.0.1:*`. Optional static UI mount with SPA fallback + path-traversal guard.
- Layer 1 savings estimator (`estimateSavings` per DESIGN.md §20.1) — counterfactual K=5 grep+read baseline, per-call chunk count from tool_result output shape, configurable via `SavingsOptions`.
- Layer 2 cost analytics (`pricing.ts`) — known-Claude-model pricing table, `turnCostUsd`, `blendedRateUsdPerMTok`, `dollarsConsumed` / `dollarsSaved` / `percentDollars` / `turns[]` fields on `SavingsEstimate`.
- Privacy boundary (DESIGN.md §5.5) enforced statically (data-layer files banned from importing `node:http`/`node:https`/`node:net`/`node:tls`/`undici` — `src/server/` excepted as the inbound listener) and at runtime (fetch spy throws on call during representative reads).

**Observe UI (`@sivru/observe-ui`)**
- Vite + React 18 + Tailwind v3, dark-only, soft-amber accent per DESIGN.md §6.7 tokens.
- Three-pane layout: sessions sidebar / event timeline / inspector. Sticky panel headers.
- Keyboard nav: J/K (or ↓/↑) cycle events, Enter inspect, Esc clear, Cmd/Ctrl+K focus quick-filter.
- Zero-search nudge banner (DESIGN.md §6.6) when no `sivru.search` calls in the selected session.
- Inspector renders user/assistant text, tool_use input as JSON, tool_result output (red border on `isError`), raw event JSON expander.
- Build output ~150 KB raw / 48 KB gzipped JS.

**Benchmarks (`benchmarks/`)**
- 3 pinned OSS repos (zod / requests / gson) cloned by `pnpm fetch-corpus`.
- 60 hand-labeled queries spanning architecture / behavior / error-path / api / data-flow.
- `runner.ts` adapter-driven NDCG@10 with `--hybrid` and `--json` flags.
- `baseline.json` (BM25 + signals): 0.5933.
- `baseline-hybrid.json`: 0.6601.

**CI**
- 6-cell matrix (ubuntu / macos / windows × Node 20 / 22). Build → typecheck → test order so cross-package imports resolve.

### Notes
- The W4 issue's `doctor`, `find-related` (real impl), and `model` commands are scoped out of `0.1.0-rc.1`. Track on https://github.com/sivru/sivru.
- Layer 2 replay/compare and the 20-task agent-task benchmark are W8 follow-ups.

## [0.0.0]
- Pre-release scaffold. No engine yet. See DESIGN.md §12 for the W0–W8 roadmap.
