# Contributing to sivru

Sivru is pre-1.0. Most surfaces are settled, but extension points —
chunker languages, embedding providers, cross-encoder rerankers, MCP
tools, observe-ui panels — are open for new code. This guide is the
30-minute path from clone to merged PR.

If something here is stale or unclear, that itself is a bug — open an issue
labeled `dx_feedback`.

For where the project is heading (and what's explicitly out of scope) see
[ROADMAP.md](ROADMAP.md).

---

## Clone → first PR in 30 minutes

```bash
git clone https://github.com/sivru/sivru.git
cd sivru

# pnpm 9.x is required. We don't use corepack — install directly.
npm install -g pnpm@9.15.0

pnpm install
pnpm build       # tsc emit (also typechecks)
pnpm test        # all unit tests across 5 packages
```

If those four commands all pass, your environment is ready. Total cold-cache
time: ~90 seconds on a modern laptop.

The smallest sensible PR — fix a typo, tighten an error message, add a test
for an existing function — touches one file under `packages/<pkg>/src/`,
adds or updates one `.test.ts` next to it, runs `pnpm -r test`, and is done.

---

## Where things live

```
packages/
  search/        — engine: walker, chunker, tokenizer, BM25, vector, ranking, cache
  cli/           — `sivru` binary; subcommands under src/commands/
  observe/       — session readers, normalizer, savings estimator, HTTP server
  observe-ui/    — Vite + React + Tailwind; dark-only; soft-amber accent
benchmarks/      — labeled query corpus, NDCG@10 runner, agent-task suite, perf gate
docs/
  recipes/       — one-page extension guides (add a language / swap embedder / MCP tool)
ARCHITECTURE.md  — 1-page system map (read this first)
CLAUDE.md        — instructions specific to AI agents working in this repo
```

### What to edit for common changes

| You want to…                            | Edit                                                         |
|-----------------------------------------|--------------------------------------------------------------|
| Add a chunker language                  | `packages/search/src/chunker/` — see [recipe](docs/recipes/add-a-language.md) |
| Swap or add an embedding model          | `packages/search/src/embed/` — see [recipe](docs/recipes/swap-embedder.md) |
| Add a cross-encoder reranker            | `packages/search/src/rerank/` |
| Register a new embedder/reranker name   | `packages/cli/src/lib/model-catalog.ts` |
| Add a CLI subcommand                    | `packages/cli/src/commands/` + `packages/cli/src/index.ts` (dispatcher) |
| Add an MCP tool exposed to Claude Code  | `packages/cli/src/mcp-entry.ts` — see [recipe](docs/recipes/add-mcp-tool.md) |
| Add a persistent CLI config key         | `packages/cli/src/lib/config.ts` + `packages/cli/src/commands/config.ts` |
| Tweak BM25 / cosine / RRF / signals     | `packages/search/src/{bm25,vector,search,ranking}/`         |
| Change observe HTTP API                 | `packages/observe/src/server/`                               |
| Change observe-ui look or behavior      | `packages/observe-ui/src/`                                   |
| Add a `sivru bench personal` metric     | `packages/cli/src/lib/metrics.ts` + `packages/cli/src/commands/bench-personal.ts` |
| Add a benchmark query                   | `benchmarks/annotations/<repo>.json`                         |
| Add a perf-tracked metric               | `benchmarks/src/perf.ts` + re-baseline                       |

For methodology and how-to-reproduce on the benchmarks, read [BENCHMARKS.md](BENCHMARKS.md).

---

## Conventions

### TypeScript

Strict mode with `noUncheckedIndexedAccess` + `verbatimModuleSyntax` +
`exactOptionalPropertyTypes`. ESM-only (`"type": "module"`). Imports use
the `.js` extension even for `.ts` source — this is `module: NodeNext`
behavior, not a bug.

```ts
import { buildIndex } from "./search.js";   //  yes
import { buildIndex } from "./search";      //  no — typecheck will fail
```

### Errors

Every error gets a `SIVRU-ENNN` code. Codes are stable; never renumber.
There's no central registry yet — claim the next unused code in your
PR description and reviewers will sanity-check it.

### Tests

New behavior requires a test. Vitest, ESM, no transformers. Place tests
next to the source file (`foo.ts` + `foo.test.ts`). For CLI commands the
shared pattern is `captureIO()` — see `packages/cli/src/commands/search.test.ts`.

### Comments

Default to writing none. Add one only when the *why* is non-obvious —
hidden constraints, surprising invariants, workarounds for specific bugs.
Don't restate what the code already says with good names.

### Privacy

Code under `packages/observe/` MUST NOT make network calls. There's a
static lint rule + a runtime fetch-spy test enforcing this. If your work
in `observe/` needs to talk to anything, talk to the maintainer first.

### Commits

Conventional-ish prefixes (`feat`, `fix`, `docs`, `chore`, `BREAKING:`).
Prose-first messages. **No `Co-Authored-By: Claude` trailers.** No emoji
in commits or in code (project tone is "serious devtool"). Never force-push
to `main`.

---

## Pull request flow

1. **Open an issue first** for non-trivial changes — link it from the PR.
   Trivial fixes (typo, single-line bugfix) don't need one.
2. **Tests required** for new code paths.
3. **CI must be green** across the matrix: Linux + macOS + Windows × Node 20 + 22.
4. **Perf gate** runs on every PR (`benchmarks/perf-baseline.json`). If your
   PR intentionally regresses chunks/buildMs/peakHeap, the gate output tells
   you the re-baseline command.
5. **Architecture changes get an extra round of review.** If your PR
   alters anything in `ARCHITECTURE.md`, surface it explicitly in the
   PR description.

A typical PR description:

```markdown
## What
One-line summary.

## Why
Link to the issue or quote the user-facing problem.

## How
Brief description of the approach.

## Tests
- New unit tests in `packages/foo/src/bar.test.ts`
- Manual: `sivru search "..." . --json | jq` against the demo corpus

## Risk
Anything reviewers should pay extra attention to.
```

---

## Looking for a starter task?

Issues labeled `good-first-issue` are scoped to be ~½ day with the test path
clearly identified. Issues labeled `help-wanted` are larger but have a known
shape. Issues labeled `discussion-needed` are open-ended — comment before
sending a PR.

Good starting points if no labeled issue catches your eye:

- Add a language to the chunker (line-fallback path is stable; tree-sitter
  integration is queued for v0.2 — see [recipe](docs/recipes/add-a-language.md)).
- Add an MCP tool that exposes part of the engine you want a Claude Code
  agent to be able to call (see [recipe](docs/recipes/add-mcp-tool.md)).
- Add a benchmark query to the corpus — quality wins compound.
- Improve an error message to mention the fix command (DX wins compound too).

---

## License

By contributing, you agree your contribution is licensed under the MIT License,
the same license as sivru itself.
