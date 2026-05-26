# CLAUDE.md — context for any Claude session in this repo

Auto-loaded by Claude Code when working under this directory. Read in
full before doing anything.

> **Read these first for strategic context** before reasoning about
> features, roadmap, or design decisions. They contain the WHY this
> file does not:
>
> - [`GOALS.md`](GOALS.md) — the north star: the goal, what's unique,
>   and the goal test every release must pass. Read this first.
> - [`ROADMAP.md`](ROADMAP.md) — version-by-version plan + the seven
>   project principles + the goal-test classification
> - [`WHY-SIVRU.md`](WHY-SIVRU.md) — the honest competitive defense of
>   search (one instrument), what sivru sees and doesn't,
>   runtime-vs-skills positioning
> - [`docs/design/`](docs/design/) — per-version design docs
>   (Stub → Draft → Accepted → Implemented)
> - [`ARCHITECTURE.md`](ARCHITECTURE.md) — system map
> - [`CHANGELOG.md`](CHANGELOG.md) — what's shipped

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
  Hono HTTP server. Hosts the v0.7 coach loop at
  `src/coach/` (`@sivru/observe/coach` subpath export) — three
  drift checks against CLAUDE.md, SKILL.md, and agent files; runs
  via the `sivru checkup` CLI command, `mcp__sivru__checkup` MCP
  tool, or `GET /api/checkup` HTTP route.
- **Observe UI:** `packages/observe-ui/` — Vite/React/Tailwind,
  dark-only. Tabs: Sessions / Checkup / Replay / Costs / Bench.
- **Benchmarks:** `benchmarks/` — NDCG@10 corpus + agent-task suite +
  perf gate.

## What's pending

See [`ROADMAP.md`](ROADMAP.md) for direction.

- Embed code only; BM25-only-index docs and configs
- Real-agent replay via the Anthropic SDK (opt-in)
- `sivru completion` + `sivru bench tthw`
- Serving authored context — surface `@sivru` blocks through
  `sivru explain` (DESIGN-0017; next planned release).
- Codebase explainer (DESIGN-0018).
- Coach loop v2 — looped-on-error (DESIGN-0006).
- Coach loop v3 — low-context-edit (DESIGN-0007).
- Block reliability follow-on (DESIGN-002X TBD) — watchable
  `revisit-if` predicate. Generated-code block-by-reference (§11 of
  DESIGN-0019) — research status until field data arrives.

(Shipped since this list was last cut: tree-sitter chunker — v0.2;
per-model chunk-windowing — v0.3; the sivru skill — v0.4;
`sivru explain` (CLI + MCP + region + --diff) — v0.5
[DESIGN-0004](docs/design/0004-sivru-explain.md); `@sivru`
annotation blocks — v0.6 [DESIGN-0016](docs/design/0016-sivru-annotation-blocks.md);
coach loop v1 / skill drift — v0.7
[DESIGN-0005](docs/design/0005-coach-loop-skill-drift.md), shipped
out of original sequence: it was retargeted v0.6 → v0.9 during
planning but claimed v0.7 at ship time since the other v0.7/v0.8
work hadn't landed yet; block reliability slots 1–4
([DESIGN-0019](docs/design/0019-block-reliability.md)) —
invariant→test linkage (E230/E231/E232), diff-scoped CI flags,
yaml-colon-in-prose / yaml-quote-context with autofix (E237/E238),
staleness (E233), cross-block graph (E234/E235/E236),
scaffolding + annotation bridges (E239/E260),
Java records/enums/package-info/sealed/inner, TS records/enums,
per-language `maxLines`, Python/Go per-symbol audits. Rust
deferred.)

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
pnpm --filter @sivru/benchmarks fetch-corpus
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
