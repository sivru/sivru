# sivru

**Code search and session observability for coding agents — both local, both MCP-native.**

- **Search** — agents call sivru via MCP and get ranked code chunks back in milliseconds, instead of looping through `ripgrep + Read`. Hybrid BM25 + semantic + optional cross-encoder rerank.
- **Observe + self-benchmark** — reads your Claude Code session history, shows what the agent's actually doing, and lets you benchmark embedders + rerankers on YOUR repos.

> **Status: 0.1.0.** Engine, CLI, MCP server, and observe-ui ship end-to-end. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it's built and [`CHANGELOG.md`](CHANGELOG.md) for what's in.

> **"Anthropic chose not to use RAG for code search. Why does this exist?"**
> Sivru is designed to complement agentic search, not replace it — read [`WHY-SIVRU.md`](WHY-SIVRU.md) for the honest argument and where this is and isn't the right tool.

---

## What's here

| Package | What it does |
|---|---|
| `@sivru/search` | Engine. Walker → chunker → BM25 + cosine + RRF → optional cross-encoder rerank. Pluggable embedders (Model2Vec, Transformers.js, OpenAI-compatible HTTP) with asymmetric query encoding for BGE / Nomic / E5. On-disk cache + mid-session `refreshStale()`. |
| `sivru` (CLI) | `search`, `index`, `from-git`, `mcp`, `observe`, `session`, `bench personal`, `bench models`, `config`, `doctor`. Persistent embedder + reranker via `sivru config`. |
| `@sivru/observe` | Reads Claude Code's `~/.claude/projects/*.jsonl`, normalizes events, runs a localhost Hono HTTP server. Ships token + dollar savings estimator and offline counterfactual replay. No network egress, ever — enforced by lint rule + runtime fetch spy. |
| `@sivru/observe-ui` | React + Tailwind dashboard. Tabs: Sessions / Replay / Costs / Bench. Dark-only. |
| `benchmarks/` | NDCG@10, agent-task token economy, perf gate. Raw data committed; see [BENCHMARKS.md](BENCHMARKS.md). |

## Numbers

Three benches. Each measures one thing. Full methodology + raw data:
[BENCHMARKS.md](BENCHMARKS.md).

**Token economy** (sivru vs ripgrep + Read on agent tasks)

| Corpus | Mean saved | Median saved | Recall@3 |
|---|---:|---:|---:|
| Labeled (zod / requests / gson, 20 tasks) | **57.7%** (44–70%) | 63.5% | 65% sivru vs 15% baseline |
| Real-world (vitest, 178k LOC, 10 tasks) | **78.7%** (74–83%) | 79.9% | n/a (unlabeled) |

**Retrieval quality** (NDCG@10 on 60 labeled queries — `pnpm bench`)

| Mode | NDCG@10 | Cold-start (16k chunks) |
|---|---:|---:|
| BM25 + signals | 0.5933 | n/a |
| Hybrid · Model2Vec (default) | 0.6013 | ~30 s |
| Hybrid · Transformers.js MiniLM | 0.6601 | ~10–15 min on CPU |

## Benchmark sivru on your own code

Don't trust the numbers above? Run the same methodology on YOUR Claude
Code sessions and YOUR repos. (Requires install — see below.)

```bash
sivru bench personal                                                # interactive picker
sivru bench personal --models bm25,potion,jina-code
sivru bench personal --models potion --rerank=ms-marco-minilm
```

What you get back per model:

- **Recall@5** — of the files the agent actually edited after each
  query in your sessions, how many appear in sivru's top 5?
- **MRR** — rank of the first relevant file (1.0 = always at rank 1).
- **Tokens saved** — vs. a windowed `ripgrep + Read` baseline.
- **Bootstrap 90% CIs** on every metric so "model A beats model B"
  has to clear the noise floor.

**Ground truth** comes from the files the agent actually edited or read
after each query in your jsonl session files. No labels needed — sivru
derives them from the session itself.

Past runs persist to `~/.cache/sivru/bench-history/<iso>.json` and render
in the **Bench** tab of `sivru observe`. Full methodology, how to add
custom queries, and what to do when ground truth is sparse:
[BENCHMARKS.md §Benchmark 3](BENCHMARKS.md#benchmark-3--personal-bench-your-data).

## 60-second install

```bash
git clone https://github.com/sivru/sivru.git
cd sivru

# pnpm 9.x is required. We don't use corepack — install directly:
npm install -g pnpm@9.15.0    # one-time

pnpm install
pnpm build

# Optional: put `sivru` on your PATH so you can run it from any directory.
# `~/Library/pnpm` is already on PATH if you ran `pnpm setup` once.
chmod +x packages/cli/dist/index.js
ln -sf "$PWD/packages/cli/dist/index.js" ~/Library/pnpm/sivru
sivru version    # → sivru 0.1.0

# Hook into Claude Code
claude mcp add sivru -s user -- node $PWD/packages/cli/dist/index.js mcp
```

The rest of this README assumes the symlink. Drop `sivru` and use `node $PWD/packages/cli/dist/index.js …` if you skipped that step.

## Search a repo

```bash
# Default = hybrid (BM25 + semantic) using the Model2Vec static embedder
# (potion-retrieval-32M). First run downloads ~129 MB to
# ~/.cache/sivru/models/ once; subsequent runs are sub-second.
sivru search "where do we sign requests" /path/to/repo
sivru search "websocket reconnect" . --top=3 --json | jq

# --bm25: skip embeddings entirely (still indexes everything via BM25).
sivru search "AuthFilter authenticate jwt" . --bm25

# Pick any catalog embedder by short name, or any HF model via hf:owner/model.
# `sivru bench models` prints the full list with size / RAM / cold-start.
sivru search "where do we sign requests" . --embed=jina-code
sivru search "where do we sign requests" . --embed=hf:Xenova/bge-small-en-v1.5

# Layer a cross-encoder reranker on top — BM25⊕embed retrieves top-50
# candidates, cross-encoder rescores them, top-K returned. Lifts
# recall@5 / NDCG@10 by 5–15% at the cost of ~100 ms / query.
sivru search "websocket reconnect" . --rerank=ms-marco-minilm
sivru search "websocket reconnect" . --rerank=bge-reranker-base   # stronger, ~5× slower

# Persist a default embedder + reranker so the MCP server picks them up.
sivru config set embedder jina-code
sivru config set reranker ms-marco-minilm

sivru index .                                              # walk + chunk + index, print stats
sivru from-git https://github.com/owner/repo               # depth=1 clone, cached + indexed
sivru bench models                                         # registered embedders + rerankers
```

## See what your agent is doing

```bash
sivru session list                       # 20 most recent Claude Code sessions
sivru session show <id-prefix>           # event-by-event replay in the terminal

sivru observe                            # localhost web UI on http://127.0.0.1:7676

# Counterfactual analytics — zero API cost, runs on your existing sessions:
sivru observe replay <id-prefix>         # one-session "what if sivru had been here?" table
sivru observe costs --since=7            # weekly rollup: tokens used vs estimated saved
sivru observe costs --since=7 --json     # same, machine-readable
```

→ The web UI: sessions sidebar / event timeline / inspector pane. Estimated tokens **and dollars** saved per session, derived from your live Claude Code session log via the same counterfactual engine the `costs` CLI uses. Strictly local — no telemetry, no network egress, ever.

## Pluggable embedding providers

```ts
import { buildIndex, createTransformersProvider, createHttpEmbeddingProvider } from "@sivru/search";

// Default: Xenova/all-MiniLM-L6-v2 (384-dim)
const idx = await buildIndex("./repo", { embed: { provider: createTransformersProvider() } });

// Swap to any HF model that supports the feature-extraction pipeline
createTransformersProvider({ model: "Xenova/bge-small-en-v1.5" });

// Or any OpenAI-compatible service
createHttpEmbeddingProvider({
  url: "https://api.openai.com/v1/embeddings",
  model: "text-embedding-3-small",
  dim: 1536,
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
});

// Or local Ollama
createHttpEmbeddingProvider({
  url: "http://localhost:11434/api/embeddings",
  model: "nomic-embed-text",
  dim: 768,
  shape: "ollama",
});
```

`EmbeddingProvider` is two methods (`{ dim, embed }` plus optional `embedBatch`) — drop in any model you can run.

## Roadmap

**0.1.0** ships today. **v0.2** is on the [milestone](https://github.com/sivru/sivru/milestone/2).
Long-term direction (coaching + platform), v0.3+ themes, and what's
explicitly out of scope: [ROADMAP.md](ROADMAP.md).

## Contributing

Sivru is pre-1.0 — this is the moment to influence the surface. PRs welcome.

- Path from clone to merged PR: [`CONTRIBUTING.md`](CONTRIBUTING.md) (30-minute walkthrough).
- 30,000-foot system diagram + per-package map: [`ARCHITECTURE.md`](ARCHITECTURE.md).
- Three benchmarks, methodology, raw data: [`BENCHMARKS.md`](BENCHMARKS.md).
- Why this exists when Anthropic chose grep + Read: [`WHY-SIVRU.md`](WHY-SIVRU.md).
- Recipes:
  - [Add a language to the chunker](docs/recipes/add-a-language.md)
  - [Plug in a custom embedding model](docs/recipes/swap-embedder.md)
  - [Add an MCP tool](docs/recipes/add-mcp-tool.md)

Got a question that isn't answered above? Open an issue with the `dx_feedback` label — those go to the front of the queue.

## License

MIT — see [LICENSE](LICENSE).
