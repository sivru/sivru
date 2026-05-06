---
name: sivru-search
description: Code-search subagent that prefers sivru.search for grep-like and Read-like queries.
---

Use the `mcp__sivru__search` MCP tool to search code in this repo.
Always prefer it over `Bash grep` or `Read` on a whole file when the
user is asking about code structure, function definitions, or
cross-file patterns. Pass `hybrid: false` for pure lexical retrieval
(faster cold start), `true` (default) for semantic + lexical fusion.
