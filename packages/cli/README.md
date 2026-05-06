# sivru

**Hybrid code search MCP server + CLI for coding agents** (Claude Code first).

Code search and session observability for coding agents. Two products in one
binary; one MCP server. Both local. Both MCP-native.

## Install

```bash
npm install -g sivru
```

Or run without installing:

```bash
npx -y sivru help
```

## Wire into Claude Code

```bash
claude mcp add sivru -s user -- npx -y sivru mcp
```

The agent can now call `mcp__sivru__search` and `mcp__sivru__find_related`
when grep + Read is the wrong shape for the question.

## Common commands

```bash
sivru search "where do we sign requests" /path/to/repo    # one-shot search
sivru index ./packages/search/src                          # walk + chunk + index
sivru from-git https://github.com/owner/repo               # clone + index
sivru observe                                              # localhost UI on :7676
sivru bench personal                                       # benchmark on your sessions
sivru bench models                                         # registered embedders + rerankers
sivru config set embedder jina-code                        # persist for the MCP server
sivru mcp                                                  # stdio MCP server
```

## Why this exists

Anthropic's Claude Code team chose **not** to use RAG for code search.
Sivru is the argument that there's a narrow class of query — natural-
language, behavioral, common-token noise, renamed code — where agentic
grep + Read isn't the right tool. The agent calls sivru via MCP for
those queries; it still calls `Grep` and `Read` for everything else.

Honest case for/against:
[WHY-SIVRU.md](https://github.com/sivru/sivru/blob/main/WHY-SIVRU.md)

## Full docs

- Repo + design + benchmarks: https://github.com/sivru/sivru
- Architecture: [ARCHITECTURE.md](https://github.com/sivru/sivru/blob/main/ARCHITECTURE.md)
- Roadmap: [ROADMAP.md](https://github.com/sivru/sivru/blob/main/ROADMAP.md)
- Methodology: [BENCHMARKS.md](https://github.com/sivru/sivru/blob/main/BENCHMARKS.md)
- Changelog: [CHANGELOG.md](https://github.com/sivru/sivru/blob/main/CHANGELOG.md)

## License

MIT
