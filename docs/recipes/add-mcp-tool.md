# Recipe: add an MCP tool

The MCP server exposes sivru capabilities to coding agents (Claude Code
first). Two tools ship today — `search` and `find_related`. This recipe
walks adding a third.

## Where things live

```
packages/cli/src/
├── mcp-entry.ts                — MCP server: tool registration + dispatcher
├── commands/                   — CLI subcommands (separate; same engine calls)
└── ...
```

The MCP server is one file. Add a tool by appending three things to it:
a JSON Schema for the input, a name + description constant, and a handler.

## The 3-step shape

Open `packages/cli/src/mcp-entry.ts`. You'll see the existing `search` and
`find_related` tools. Mirror their pattern.

### 1. Declare the tool

```ts
const COUNT_TOKENS_TOOL_NAME = "count_tokens";
const COUNT_TOKENS_TOOL_DESCRIPTION =
  "Estimate the token cost of a chunk of source code. Useful before " +
  "deciding whether to read a file vs. search for a region.";
const COUNT_TOKENS_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    text: { type: "string", minLength: 1 },
    model: {
      type: "string",
      description: "Model id for tokenizer choice. Defaults to claude-3-5-sonnet.",
      default: "claude-3-5-sonnet-20241022",
    },
  },
  required: ["text"],
};
```

### 2. Register it in the `ListToolsRequest` handler

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: SEARCH_TOOL_NAME, description: SEARCH_TOOL_DESCRIPTION,
      inputSchema: SEARCH_INPUT_SCHEMA },
    { name: FIND_RELATED_TOOL_NAME, description: FIND_RELATED_TOOL_DESCRIPTION,
      inputSchema: FIND_RELATED_INPUT_SCHEMA },
    // ↓ add me ↓
    { name: COUNT_TOKENS_TOOL_NAME, description: COUNT_TOKENS_TOOL_DESCRIPTION,
      inputSchema: COUNT_TOKENS_INPUT_SCHEMA },
  ],
}));
```

### 3. Handle it in `CallToolRequest`

```ts
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};

  if (req.params.name === COUNT_TOKENS_TOOL_NAME) {
    const text = args.text;
    if (typeof text !== "string" || text.length === 0) {
      return fail("count_tokens: `text` must be a non-empty string");
    }
    const tokens = Math.round(text.length / 4); // bytes/4 approximation
    return ok(JSON.stringify({ tokens, chars: text.length }, null, 2));
  }

  // ... existing search and find_related branches ...
});
```

That's the whole tool. Return `ok(string)` on success, `fail(string)` on
input error. The `string` is what the agent sees as the tool result —
JSON-stringify your structured output yourself.

## Naming convention

Claude Code namespaces every MCP tool as `mcp__<server>__<tool>`. So
`count_tokens` becomes `mcp__sivru__count_tokens` from the agent's
perspective. Use `snake_case` for tool names and stay terse — agents
choose tools partly by name.

## Validate inputs manually

The MCP SDK accepts a JSON Schema in `inputSchema` but does **not**
validate against it. Hand-write your validation in the handler:

```ts
if (typeof args.path !== "string") return fail("count_tokens: `path` must be a string");
```

The existing `search` handler shows the full pattern. Validation lives in
the handler so we can give actionable error messages — `SIVRU-Exxx` codes.

## Reuse the engine, don't fork it

The CLI subcommands (`packages/cli/src/commands/`) and MCP tools should
both call the same `@sivru/search` library functions. If you find yourself
implementing the same logic twice, lift it into a shared module.

```ts
// good: both paths call the same library function
import { findRelated } from "@sivru/search";

// bad: tool handler reimplements rank fusion
```

## Test it

Spawn the MCP server in a child process and round-trip a real
`tools/call` request. Pattern from `packages/cli/src/mcp-entry.test.ts`:

```ts
const { server, transport } = await spawnTestMcp();
const result = await transport.callTool("count_tokens", { text: "hello" });
expect(JSON.parse(result.content[0].text).tokens).toBe(2);
await server.close();
```

The shared test harness handles transport setup. Look at the existing
`search` tool tests for the full pattern.

## Dogfood it

Restart Claude Code (the MCP server is loaded at startup). Then ask
the agent something that should trigger your tool. It'll show up as:

```
<turn>
  Tool use: mcp__sivru__count_tokens
  Input:    { "text": "..." }
  Output:   { "tokens": 142, "chars": 568 }
</turn>
```

If the agent never picks your tool, the issue is almost always the
description. Iterate on the description, not the schema.

## What to think about

- **Determinism vs. cost.** Tools that hit the network or read large
  files raise the agent's per-call cost. Surface that in the description
  so the agent can choose accordingly.
- **Output size.** Sivru's `search` returns ~5 KB on average. Tools that
  return 50 KB+ are a regression — defeat the entire point of saving
  tokens. Cap your output.
- **Side effects.** MCP tools can in principle write files. Sivru's tools
  are read-only by design. If you're adding a tool that writes, propose
  it on an issue first — it changes the trust model.
- **Schema discoverability.** Some MCP clients expose the `inputSchema`
  to users; some don't. Don't rely on schema-level constraints (`minLength`,
  `enum`) being enforced — re-validate in the handler.

Got a tool idea but not sure if it fits? File an issue with `dx_feedback`
and a one-paragraph "agent prompt → tool call → result" walkthrough.
