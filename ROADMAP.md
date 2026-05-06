# Roadmap

What's shipped, what's next, where this is heading. For per-feature
detail see [CHANGELOG.md](CHANGELOG.md). For the system map see
[ARCHITECTURE.md](ARCHITECTURE.md).

This file is a snapshot — the canonical "what's coming" is the
[GitHub milestones page](https://github.com/sivru/sivru/milestones).

## Now — 0.1.0

Engine + CLI + MCP server + observe + observe-ui all ship. Hybrid
BM25 + semantic retrieval, optional cross-encoder rerank, asymmetric
query encoding for instruct embedders, mid-session `refreshStale`,
self-benchmark on your own sessions.

Full delta from rc.1: [CHANGELOG `[0.1.0]`](CHANGELOG.md).

## Next — v0.2

Tracked on the [v0.2.0 milestone](https://github.com/sivru/sivru/milestone/2).
Snapshot of what's there:

- **Tree-sitter chunker** ([#11](https://github.com/sivru/sivru/issues/11))
  — function-boundary chunks instead of 50-line slices. Helps every
  embedder, especially code-tuned ones (jina-code).
- **Per-model chunk-windowing** ([#12](https://github.com/sivru/sivru/issues/12))
  — MiniLM (256 tok) and BGE-small (512 tok) currently see truncated
  chunks. Either chunk to fit the smallest context, or chunk per-model.
- **Embed code only; BM25-only-index docs and configs** ([#13](https://github.com/sivru/sivru/issues/13))
  — half the embedding budget on a typical repo goes to README / yaml /
  configs. Cuts cold-start time, improves recall on code queries.
- **Real-agent replay via the Anthropic SDK** ([#14](https://github.com/sivru/sivru/issues/14))
  — replay a session through the real API with vs. without sivru.
  Opt-in because it costs API tokens.
- **`sivru completion` + `sivru bench tthw`** ([#15](https://github.com/sivru/sivru/issues/15))
  — shell tab-completion and a time-to-hello-world benchmark.

## Later — v0.3+

Themes, not commitments. Each could become a v0.3 milestone if it
graduates from "exploring" to "scoped."

- **End-to-end task evaluation.** Real-agent replay across many
  sessions to measure task success rate, not just retrieval quality.
  Builds on the Anthropic SDK opt-in from v0.2.
- **Hierarchical retrieval.** Embed one vector per file (a summary),
  not one per chunk. BM25 candidate-picks files; chunk-level retrieval
  runs only inside the top-N candidates. Cuts cold-start ~10× and RAM
  ~5× for typical repos at little quality cost.
- **Coaching surface.** Per-session feedback in observe-ui — "you
  spent X tokens on tasks where sivru would have lifted recall by Y."
  Turns the observability layer into a teaching tool.
- **More rerankers in the catalog.** Smaller/faster cross-encoders
  for hot-path use, plus larger ones for offline rebuilds. Same
  `CrossEncoder` interface, more entries in the catalog.
- **More agent-helping tools** in the same binary. Things sivru
  could host that aren't search but rhyme with it: prompt templates,
  session-replay diff tools, MCP tool catalogs.

## Direction

The long-term goal is **helping engineers get better at using coding
agents**, and **hosting more tools that help engineers use agents
better**. Sivru's search engine is the first one. The observability
layer is the surface where coaching can land. v0.2+ is about
broadening the toolkit while keeping each piece small enough to be
read, understood, and replaced.

Concrete shapes that fits:

- More benchmarks anchored to real user behavior, not synthetic
  corpora.
- More observe insights — where the agent wastes tokens, where it
  succeeds, what changed when sivru entered the loop.
- More tools in `packages/`, all sharing the same MCP server so
  agents pick them up without extra setup.

## Not in scope

To save people the PR round-trip:

- **IDE plugins as first-class.** Sivru is MCP-first. Editors get
  it through their MCP integration. Native VS Code / JetBrains
  plugins aren't planned.
- **Multi-tenant / server mode.** Sivru runs locally per developer.
  Multi-user infra (auth, quota, isolation) doubles the scope and
  isn't where agents are heading.
- **GPU embedding throughput.** The bottleneck is cold-start and
  query latency, both CPU. GPU paths can be plugged in via the
  HTTP embedder; we don't ship GPU defaults.
- **Telemetry or usage analytics.** Privacy boundary is the product
  — `packages/observe/` makes no network calls, ever. Any future
  opt-in usage stats ship in a separately installable
  `sivru-analytics` package the user has to add explicitly.
- **Prompt engineering / LLM finetuning.** Adjacent space; not the
  problem sivru is solving. We help the agent retrieve; the agent
  still decides what to do with what it sees.
