# sivru

[![npm](https://img.shields.io/npm/v/@sivru/cli)](https://www.npmjs.com/package/@sivru/cli) [![CI](https://github.com/sivru/sivru/actions/workflows/ci.yml/badge.svg)](https://github.com/sivru/sivru/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/github/license/sivru/sivru)](LICENSE) ![local-first](https://img.shields.io/badge/network%20egress-none-success) ![MCP](https://img.shields.io/badge/MCP-native-blue)

**The comprehension layer for AI-written code.**

> Your agent just confidently broke something it didn't understand. sivru is the
> layer that remembers *why* your code is the way it is — and blocks the PR that breaks it.

<!-- DEMO GIF — the map → gate, ~20s. Record it with marketing/demo/STORYBOARD.md,
     drop it at docs/assets/demo.gif, then this image goes live. Do not merge the
     README to main until the gif exists (avoids a broken image). -->
<p align="center">
  <img src="docs/assets/demo.gif" width="760"
       alt="sivru maps a repo's authored intent, then blocks a PR where an agent's refactor deleted the test guarding a security decision">
</p>

```sh
npm install -g @sivru/cli

# Gate a PR on intent drift — exits non-zero when an agent's change breaks the
# test guarding an authored @sivru decision (or introduces a dependency cycle):
sivru explain --project --diff --gate --base=main

# Or just read the repo: the whole-repo map as one offline HTML file.
sivru explain --html --out=map.html
```

Code creation is becoming cheap. Code comprehension is becoming
expensive — and as agents write more of every codebase, the gap shows
up as incidents nobody can diagnose, refactors nobody dares start, and
agents confidently "fixing" things that were deliberate.

Every coding tool *produces* code fast. None of them owns the question
that velocity creates: **does anyone still understand this?** Sivru
claims that question. It keeps a codebase comprehensible — to the
agents writing it and the humans accountable for it — by making
comprehension a durable, queryable asset of the repo itself: it records
*why* the code is the way it is, keeps that record current as the code
changes, and serves it at the moment it matters — the edit. The goal and
the test every release must pass: [`GOALS.md`](GOALS.md); how it's
positioned and described: [`POSITIONING.md`](POSITIONING.md).

**Today** the comprehension layer ships end-to-end:

- **Search** — agents call sivru via MCP and get ranked code chunks
  back in milliseconds instead of looping through `ripgrep + Read`.
  Hybrid BM25 + semantic + optional cross-encoder rerank. On how this
  squares with Anthropic's "agentic search wins for code" —
  [`WHY-SIVRU.md`](WHY-SIVRU.md), the honest defense of one
  instrument.
- **Authored context** — `@sivru` blocks record a symbol's role,
  responsibility, invariants, and decisions *in the source*, with a
  lifetime and reliability checks (drift, staleness, invariant→test
  linkage, a cross-block graph). `sivru explain` serves that intent at
  the file/region level; `sivru checkup` coaches against drift in
  CLAUDE.md / SKILL.md / agent files.
- **The codebase explainer** — `sivru explain --project` projects the
  whole repo into a System → Module → Package → Symbol model;
  `sivru explain --html` renders it as one self-contained, offline HTML
  map. Its **feedback loop** (`sivru feedback apply`) writes a reader's
  corrections straight back to the `@sivru` block in source, so
  understanding compounds in the repo instead of evaporating in a chat.
- **The architectural diff + gate** — `sivru explain --project --diff`
  diffs the model across a change and reports what it did to the
  architecture: new cross-module edges, new dependency cycles, `@sivru`
  authored-intent changes, the added surface area, and the touched hot
  spots. `--gate` exits non-zero on a regression worth blocking a PR on (a
  new cycle, or a broken `@sivru` invariant→test linkage), with a
  `.sivru/gate-allowlist` escape hatch. Runs on every PR, not just at
  onboarding.
- **Observe + self-benchmark** — reads your Claude Code session
  history, shows what the agent is actually doing, surfaces authored
  blocks in a Blocks tab, and benchmarks embedders + rerankers on YOUR
  repos.

What's next builds on this spine: the agent's working map — the same
model served to any coding agent over MCP, so it orients on the
architecture before it edits ([`DESIGN-0024`](docs/design/0024-agent-map-mcp.md)).
See [`ROADMAP.md`](ROADMAP.md) and [`docs/design/`](docs/design/).

> **Status: 0.14.0.** Engine, CLI, MCP server (8 tools), observe-ui, and the architectural diff + drift gate (`explain --project --diff [--gate]`) ship end-to-end. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it's built and [`CHANGELOG.md`](CHANGELOG.md) for what's in.

---

## The map sivru holds

Everything above — `explain`, the HTML view, the diff, the gate — serves one
artifact: a single map of your whole repo, built by parsing the code (tree-sitter,
the same parsers editors use), not by asking an AI. It's the **ExplainerModel**.

**It's a four-level tree.** Every node is one of these, nested:

```
System    the whole repo
└─ Module    a top-level package / workspace dir   (e.g. @sivru/search)
   └─ Package    a source subdir                    (e.g. src/block)
      └─ Symbol    a load-bearing export            (e.g. the buildIndex function)
```

**Each node carries three layers of truth:**

1. **Structure** — what it exports, and its **dependency edges**: which other
   modules/packages it imports from. That's the wiring diagram — the arrows
   between the boxes, and (read the other way) the blast radius of a change.
2. **Authored intent** — the `@sivru` block a human wrote *in the source*, when
   there is one: the symbol's role, responsibility, invariants ("this must always
   hold"), decisions ("we chose X because Y"), and the `enforced-by` link to the
   test that guards each invariant.
3. **Health** — `churn` (how often it changes), `hotScore` (churn × coupling —
   where change meets connectivity, i.e. where bugs cluster), whether it sits in a
   **dependency cycle**, and whether an invariant's guard test has gone missing
   (**drift**).

**The one rule that makes it trustworthy: it is a *projection of facts*, never a
generation.** Structure comes from the parser, churn from git history, intent from
text a human actually wrote. sivru never invents an explanation it can't trace to
something in your repo. That's why the same map can drive a human's onboarding
(`--html`), block a regression on a PR (`--diff --gate`), and — next — orient any
coding agent before it edits (the agent map, [DESIGN-0024](docs/design/0024-agent-map-mcp.md)).

---

## What's here

| Package | What it does |
|---|---|
| `@sivru/search` | Engine. Walker → chunker → BM25 + cosine + RRF → optional cross-encoder rerank. Pluggable embedders (Model2Vec, Transformers.js, OpenAI-compatible HTTP) with asymmetric query encoding for BGE / Nomic / E5. On-disk cache + mid-session `refreshStale()`. |
| `sivru` (CLI) | `search`, `index`, `from-git`, `mcp`, `observe`, `session`, `bench personal`, `bench models`, `config`, `doctor`, `skill`; `explain` (file/region, `--project`, `--html`, `--diff`); `feedback apply` (write authored-intent corrections back to source); `block` (validate / extract / staleness / graph / check-enforcement / init); `checkup` (coach-loop drift). Persistent embedder + reranker via `sivru config`. |
| `@sivru/observe` | Reads Claude Code's `~/.claude/projects/*.jsonl`, normalizes events, runs a localhost Hono HTTP server. Ships token + dollar savings estimator and offline counterfactual replay. Hosts the coach loop (`@sivru/observe/coach`) that surfaces drift in CLAUDE.md / SKILL.md / agent files, plus the authored-context read/write surface (`sivru mcp --writable`). No network egress, ever — enforced by lint rule + runtime fetch spy. |
| `@sivru/observe-ui` | React + Tailwind dashboard. Tabs: Sessions / Checkup / Blocks / Replay / Costs / Bench. Dark-only. |
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

## Install

### From npm (recommended)

```bash
# Install the CLI globally:
npm install -g @sivru/cli
sivru version    # → sivru 0.13.0

# Or run without installing:
npx -y @sivru/cli help
```

The package on npm is `@sivru/cli`; the binary it installs is
`sivru`. The rest of this README assumes the global install (or
`npx -y @sivru/cli` for one-off invocations).

### Wire into Claude Code

```bash
claude mcp add sivru -s user -- npx -y @sivru/cli mcp
```

Restart Claude Code. The agent now has eight `mcp__sivru__*` tools
alongside `Grep` / `Read`: `search`, `find_related`, `explain`, and
`checkup` (read-only). Four more — `block_autofix`, `block_acknowledge`,
`feedback_read`, `feedback_append` — let the agent maintain authored
context and are gated behind `sivru mcp --writable`.

### Install the routing skill

The MCP tools give the agent the *capability*. The skill gives it the
*policy* — when to reach for `sivru.search` versus `grep`, and when to
run `find_related` after an edit:

```bash
sivru skill install              # ~/.claude/skills/sivru/SKILL.md
sivru skill install --project    # or <repo>/.claude/skills/sivru/
```

The installed `SKILL.md` is the canonical routing policy — read or edit
it at [`packages/cli/SKILL.md`](packages/cli/SKILL.md). `sivru skill
uninstall` removes it.

### From source (hacking on sivru)

If you want to read or modify the source, run a local build, and have
Claude Code (or your shell) use that local build:

```bash
git clone https://github.com/sivru/sivru.git
cd sivru

# pnpm 9.x is required (we don't use corepack):
npm install -g pnpm@9.15.0

# Install + build all packages:
pnpm install
pnpm build

# Expose the local build as the global `sivru` command:
pnpm --filter @sivru/cli link --global

# Verify — should print the version AND show the path to YOUR local build:
sivru version
which sivru     # …/sivru/packages/cli/dist/index.js (your local path, not npm)
```

If `sivru` isn't on `PATH` after the link, run `pnpm setup` once
(adds pnpm's global bin dir to your shell startup file), then open a
new shell.

#### Claude Code with a local build

Use the linked `sivru` directly — **don't use `npx -y @sivru/cli`**, that
would fetch from npm and bypass your local build:

```bash
claude mcp add sivru -s user -- sivru mcp
```

#### Iterating

After every change, rebuild the affected package:

```bash
pnpm --filter @sivru/cli build      # if you touched packages/cli/
pnpm build                          # if you touched any of search / observe
```

The global `sivru` command picks up the change automatically (the link
points at `packages/cli/dist/`).

#### Unlink later

```bash
pnpm --filter @sivru/cli unlink --global
```

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

## Explain a codebase (and correct it)

```bash
# Authored intent for one file or symbol — role, public API, callers,
# callees, churn, ownership, attached @sivru blocks. --diff scopes it
# to what changed.
sivru explain packages/search/src/rank.ts
sivru explain "packages/search/src/rank.ts::rankResults"

# Project the WHOLE repo into a System → Module → Package → Symbol model,
# then render it as one self-contained, offline HTML file you can open or
# email — no server, no build step.
sivru explain --project --repo=/path/to/repo            # the model as JSON
sivru explain --html --repo=/path/to/repo --out=map.html

# Diff the architecture across a change, and gate a PR on regressions.
sivru explain --project --diff --base=main              # the delta (text)
sivru explain --project --diff --format=github          # a PR-comment body
sivru explain --project --diff --html                   # the delta as a page
sivru explain --project --diff --gate --base=main       # exit 1 on a regression
```

The HTML map has a **feedback mode**: toggle it on, then edit a block's
role/responsibility/collaborators, author a new `@sivru` block on an
un-annotated symbol, suggest the system narrative, or leave a note.
Export downloads a `patch.json`; `sivru feedback apply` writes it back to
the `@sivru` block in source — deterministically, never corrupting it.

```bash
sivru feedback apply patch.json --dry-run    # preview the per-block diff
sivru feedback apply patch.json              # write it back to source
```

A correction made while reading the map lands where the truth lives, so
the next `sivru explain` reflects it for everyone. See
[DESIGN-0018](docs/design/0018-codebase-explainer.md).

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

**v0.13.0** ships the codebase explainer + feedback loop. Next up: drift +
hot spots + a PR-diff CI gate, and an agent-facing model slice over MCP
([DESIGN-0022](docs/design/0022-explainer-reasoning-surface.md)).
Long-term direction (coaching + platform) and what's explicitly out of
scope: [ROADMAP.md](ROADMAP.md).

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
