# QA — sivru search engine

A reusable QA plan for the sivru search engine, focused on the chunker.
Re-run it whenever the chunker, walker, or `buildIndex` path changes.
It is **not** a substitute for unit tests — it is the real-world,
whole-repository check that unit tests on small fixtures cannot give.

## When to run

- Before tagging any release that touches `packages/search/src/chunker/`,
  `walker/`, or `search.ts`.
- After changing a grammar, a node-type whitelist, or the cache format.
- Any time chunk output "looks wrong" in `sivru search`.

## Prerequisites

```bash
pnpm install
pnpm --filter @sivru/search build      # the harness imports the built dist
```

## The harness — `qa/chunker-qa.mjs`

Walks one or more real repositories, runs `chunkFile` over every text
file, and asserts the engine's hard invariants on each. Prints a
per-repo report and exits non-zero if any invariant fails.

```bash
# Against any local repo(s):
node qa/chunker-qa.mjs <repo-dir> [<repo-dir> ...]

# Against the bench corpus (TypeScript / Python / Java):
pnpm --filter @sivru/benchmarks fetch-corpus
node qa/chunker-qa.mjs benchmarks/corpus/*
```

### Invariants checked (hard — a failure exits non-zero)

1. **No crash.** `chunkFile` never throws on a real file.
2. **Full line coverage.** Every source line is in ≥1 chunk — no line
   is silently dropped from the index (DESIGN-0001 D3).
3. **Content fidelity.** A chunk's `content` equals its source line
   range exactly.
4. **Valid ranges.** `1 ≤ startLine ≤ endLine ≤ lineCount`.
5. **kind/nodeType consistency.** `kind: "tree-sitter"` chunks carry a
   `nodeType`; `kind: "line"` chunks do not.

### Signals reported (soft — for human judgement, not a gate)

- **Tree-sitter rate** — share of covered-language files (TS, JS,
  Python, Go, Java) that produced ≥1 AST chunk rather than falling
  back to line chunks. Should be ~100% for valid source; a low rate
  means a grammar or parse problem.
- **Symbol coverage** — share of AST chunks carrying a `symbolName`.
- **Chunk-kind split** and **chunks-per-file** — gross sanity.

## Public-repo matrix

The harness is language-agnostic; this is the recommended coverage set,
one well-known repo per supported language. The first three are the
bench corpus (already pinned in `benchmarks/repos.json`).

| Language   | Repo                  | Why |
|------------|-----------------------|-----|
| TypeScript | colinhacks/zod        | dense types, re-exports |
| Python     | psf/requests          | off-side rule, scripts |
| Java       | google/gson           | one-class-many-methods |
| JavaScript | chalk/chalk           | small, modern ESM |
| Go         | google/uuid           | structs, methods, small |

Clone the extra two into `qa/corpus/` (gitignored — never committed):

```bash
mkdir -p qa/corpus
git clone --depth 1 https://github.com/chalk/chalk qa/corpus/chalk
git clone --depth 1 https://github.com/google/uuid  qa/corpus/uuid
node qa/chunker-qa.mjs benchmarks/corpus/* qa/corpus/*
```

## Manual QA — CLI dogfood

Beyond the harness, spot-check the user-facing path:

```bash
node packages/cli/dist/index.js index <repo>
node packages/cli/dist/index.js search "where is X handled" <repo>
```

Confirm results are function-boundary chunks (a result should start at
a definition, not mid-body) and that line ranges point at real code.

## Triaging a failure

- **Crash / coverage / fidelity failure** → a chunker bug. Reduce the
  offending file to a minimal fixture under
  `packages/search/src/chunker/__fixtures__/`, add a failing unit test,
  fix, re-run.
- **Low tree-sitter rate for one language** → grammar load or parse
  problem; check the WASM is bundled and ABI-compatible.
- **Record the run.** Append a dated line to `qa/HISTORY.md` with the
  repos, the harness summary, and any bug fixed.
