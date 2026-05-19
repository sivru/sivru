// Parser for `claude` CLI stream-json output: extracts which tools an agent
// invoked, so the §5 smoke runner can score routing correctness.
//
// SCHEMA — verified against `claude` 2.1.144 (2026-05-19):
//   `claude -p <prompt> --output-format stream-json --verbose` emits
//   newline-delimited JSON events. Assistant turns are `{ "type":
//   "assistant", "message": { "role": "assistant", "content": [...] } }`,
//   where `content` may include `{ "type": "tool_use", "name": "<tool>" }`
//   blocks. Claude Code's grep tool is `Grep`; MCP tools are namespaced
//   `mcp__<server>__<tool>`, so sivru's are `mcp__sivru__search` and
//   `mcp__sivru__find_related`.
//
// Re-verify this schema if the harness is run against a much newer `claude`.
// The parser tolerates non-JSON lines so a stray log line cannot crash it.

export type ToolChoice =
  | "sivru-search"
  | "find-related"
  | "grep"
  | "other"
  | "none";

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
  if (lower.includes("sivru")) {
    if (lower.includes("find_related") || lower.includes("find-related")) {
      return "find-related";
    }
    if (lower.includes("search")) return "sivru-search";
  }
  if (lower === "grep" || lower.includes("ripgrep")) {
    return "grep";
  }
  return "other";
}

/**
 * The first routing-relevant tool the agent used: `sivru-search`, `grep`, or
 * `find-related`. Non-routing tools (Read, Bash, …) are skipped; `none` means
 * the agent picked no routing-relevant tool at all.
 */
export function firstRoutingChoice(toolNames: readonly string[]): ToolChoice {
  for (const name of toolNames) {
    const choice = classifyTool(name);
    if (
      choice === "sivru-search" ||
      choice === "grep" ||
      choice === "find-related"
    ) {
      return choice;
    }
  }
  return "none";
}
