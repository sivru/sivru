# DESIGN-0004: `sivru explain <path>`

**Status:** Stub
**Targets:** v0.5.0
**Issue:** filed when v0.5 becomes next release
**Created:** 2026-05-08

## Problem

The agent writes code at high velocity. Humans struggle to read at
that pace. When you (or your agent) is about to edit a file you
haven't touched in months, there's no quick way to refresh the
mental model: what does this file expose? Who calls it? How often
does it change? Who last touched it?

You can find that info today by reading the file, running
`git log`, running `git blame`, running `grep` for callers — five
commands, each parsing different output. `sivru explain <path>`
collapses that into one structured artifact: public API, 1-hop call
graph, churn, ownership.

The MCP version of this tool (`mcp__sivru__explain`) lets the agent
self-narrate before editing — "I'm about to change function `foo`,
which is called by 12 places; let me check what they expect."

## Acceptance (from ROADMAP.md v0.5)

- `sivru explain <path>` outputs a structured artifact:
  - Public API surface (exports, function signatures)
  - 1-hop call graph (callers + callees within the repo)
  - Recent change frequency (commits in last N days)
  - Ownership (last author, top contributors via `git blame`)
  - Test coverage hint (presence of test files matching the pattern)
- Output formats: markdown (default), JSON
- MCP tool: `mcp__sivru__explain(path)` returns the same artifact
- Uses tree-sitter from v0.2 + local git data — no network
- Descriptive only: no "you should refactor this" framing

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** all five sections enabled; markdown output;
   call-graph depth 1.
2. **Declarative override:** `~/.config/sivru/explain.json` and
   `.sivru/explain.json` accept `{ "sections": [...],
   "callGraphDepth": 3, "format": "json" }`.
3. **Code-level extension:** `.sivru/explain/*.ts` files
   register additional analyzers (e.g., "for files in `src/db/`,
   include a 'database tables touched' section").

## Open questions

- Call graph: how to handle dynamic dispatch / runtime-resolved
  imports / dynamically-built strings? Best-effort static analysis;
  document the limitation.
- Should the tool work on regions (e.g., specific functions) or
  only whole files? Regions are more useful but harder to scope;
  start with files in v0.5, regions in a follow-up.
- Performance: for a 5000-file repo, computing call graphs for
  every file on demand might be slow. Build an index? Compute
  lazily? Cache? Probably cache after first compute, invalidate
  on file mtime.

## Status note

This is a Stub. Full design lands when v0.5 becomes the next
release.
