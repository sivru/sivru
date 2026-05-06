# CLAUDE.md — context for any Claude session in this repo

Auto-loaded by Claude Code when working under this directory. Read in
full before doing anything.

## What sivru is

Code search and session observability for coding agents. Two products
in one npm package; one MCP server. Public pitch in
[`README.md`](README.md); system map in
[`ARCHITECTURE.md`](ARCHITECTURE.md); roadmap in
[`ROADMAP.md`](ROADMAP.md); per-feature history in
[`CHANGELOG.md`](CHANGELOG.md).

## Hard rules — do not violate

1. **Standalone framing.** Sivru is a fully standalone product. No
   NOTICE file. No "TS port of …" framing. No references to any
   upstream / predecessor project by name in code, docs, comments, or
   commits. The product stands on its own.
2. **Privacy boundary.** `packages/observe/` MUST NOT make network
   calls. ESLint rule + runtime test enforce this. No telemetry, ever,
   default-on. Any future opt-in usage analytics ship in a separately
   installable `sivru-analytics` package the user adds explicitly.
3. **No emoji** in code or commits unless explicitly asked. Serious-
   devtool tone.
4. **No `git add -A` / `git add .`.** Stage files explicitly by name.
   Avoids accidentally committing `.env`, secrets, or local reference
   directories.
5. **No `Co-Authored-By: Claude …` trailer** on any commit. User does
   not want Claude in the public commit history.

## Conventions

- **Package manager:** pnpm 9. Install directly
  (`npm install -g pnpm@9.15.0`); we don't use corepack. CI pins the
  same version in `pnpm/action-setup@v4`.
- **Tests:** vitest. New behavior requires a test. Place `.test.ts`
  next to source.
- **Errors:** every error gets a `SIVRU-ENNN` code. Codes are stable —
  never renumber. No central registry yet; claim the next unused code
  in your PR description.
- **Commits:** prose-first messages. Conventional-ish prefix optional.
  Use heredoc to preserve formatting:
  ```
  git commit -m "$(cat <<'EOF'
  message body
  EOF
  )"
  ```
- **CI:** any new package needs `typecheck` + `test` + `build` scripts
  so `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` all light up.
- **Privacy code:** when adding code under `packages/observe/`, do not
  import `fetch`, `node:http`, `node:https`, or `node:net`.

## Where things live

- **Engine:** `packages/search/` — walker, chunker, embed, bm25,
  vector, ranking, rerank, cache.
- **CLI + MCP entry:** `packages/cli/` — `sivru` binary + MCP server
  via `@modelcontextprotocol/sdk`. Subcommands in `src/commands/`;
  shared helpers (model catalog, config, ground-truth, metrics,
  prompt, progress) in `src/lib/`.
- **Observe:** `packages/observe/` — session readers (jsonl), event
  normalizer, cost / savings estimator, counterfactual replay,
  Hono HTTP server.
- **Observe UI:** `packages/observe-ui/` — Vite/React/Tailwind,
  dark-only. Tabs: Sessions / Replay / Costs / Bench.
- **Benchmarks:** `benchmarks/` — NDCG@10 corpus + agent-task suite +
  perf gate.

## What's pending

See [`ROADMAP.md`](ROADMAP.md) for direction. Open work tracked on
the [v0.2.0 milestone](https://github.com/sivru/sivru/milestone/2):

- Tree-sitter chunker (line-fallback ships today)
- Per-model chunk-windowing (stop silent truncation on short-context
  embedders)
- Embed code only; BM25-only-index docs and configs
- Real-agent replay via the Anthropic SDK (opt-in)
- `sivru completion` + `sivru bench tthw`

## Don't do without asking

- Add a dependency that isn't already there.
- Modify `LICENSE` or anything touching IP / attribution.
- Run `git push --force` / `--force-with-lease` to `main`.
- Delete or move files outside `packages/` and `benchmarks/`.
- Touch the privacy boundary in `packages/observe/`.

## Useful commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test

# Public benchmarks
pnpm --filter @sivrujs/benchmarks fetch-corpus
pnpm bench                 # BM25 + signals
pnpm bench --hybrid        # downloads embedder model on first run

# CLI dogfood
node packages/cli/dist/index.js help
node packages/cli/dist/index.js search "query" /path/to/repo
node packages/cli/dist/index.js index ./packages/search/src
node packages/cli/dist/index.js bench models
node packages/cli/dist/index.js bench personal
node packages/cli/dist/index.js observe        # localhost UI on :7676
node packages/cli/dist/index.js mcp            # stdio MCP server

# CI / issues
gh run list --repo sivru/sivru --limit 3
gh issue list --repo sivru/sivru --milestone v0.2.0
```
