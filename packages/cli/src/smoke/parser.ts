// Parser for `claude` CLI stream-json output: extracts which tools an agent
// invoked, so the §5 smoke runner can score routing correctness.
//
// SCHEMA ASSUMPTION — verify against the live `claude` CLI before trusting
// any numbers (DESIGN-0003 §5: the harness is feasibility-risky):
//   `claude -p <prompt> --output-format stream-json` emits newline-delimited
//   JSON events. Assistant turns carry `message.content`, an array that may
//   include `{ "type": "tool_use", "name": "<tool>" }` blocks. Claude Code's
//   built-in grep tool is `Grep`; MCP tools are namespaced
//   `mcp__<server>__<tool>` (so sivru's search is `mcp__sivru__search`).
//
// The parser tolerates non-JSON lines so a stray log line cannot crash it.

export type ToolChoice = "sivru-search" | "grep" | "other" | "none";

type ContentBlock = { type?: string; name?: string };
type StreamEvent = { type?: string; message?: { content?: ContentBlock[] } };

/** Ordered list of every `tool_use` name across all assistant events. */
export function parseToolUses(streamJson: string): string[] {
  const names: string[] = [];
  for (const line of streamJson.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue; // tolerate non-JSON noise on the stream
    }
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        names.push(block.name);
      }
    }
  }
  return names;
}

/** Classify one tool name into a routing category. */
export function classifyTool(name: string): ToolChoice {
  const lower = name.toLowerCase();
  if (lower.includes("sivru") && lower.includes("search")) {
    return "sivru-search";
  }
  if (lower === "grep" || lower.includes("ripgrep")) {
    return "grep";
  }
  return "other";
}

/**
 * The first routing-relevant tool (sivru-search or grep) the agent used.
 * `other` tools (Read, Bash, …) are skipped; `none` means the agent picked
 * no routing-relevant tool at all.
 */
export function firstRoutingChoice(toolNames: readonly string[]): ToolChoice {
  for (const name of toolNames) {
    const choice = classifyTool(name);
    if (choice === "sivru-search" || choice === "grep") return choice;
  }
  return "none";
}
