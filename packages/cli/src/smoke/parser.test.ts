import { describe, expect, it } from "vitest";

import { classifyTool, firstRoutingChoice, parseToolUses } from "./parser.js";

// Recorded `claude` stream-json fixtures (the assumed schema — see parser.ts).
// Newline-delimited JSON events; assistant turns carry message.content.

const SIVRU_SEARCH_TRANSCRIPT = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Let me search for that." },
        {
          type: "tool_use",
          name: "mcp__sivru__search",
          input: { query: "auth refresh" },
        },
      ],
    },
  }),
  JSON.stringify({ type: "result", subtype: "success" }),
].join("\n");

const GREP_TRANSCRIPT = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Grep", input: { pattern: "parseConfig" } }],
    },
  }),
].join("\n");

const FIND_RELATED_TRANSCRIPT = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "mcp__sivru__find_related",
          input: { filePath: "src/x.ts", startLine: 1, endLine: 20 },
        },
      ],
    },
  }),
].join("\n");

const NO_TOOL_TRANSCRIPT = [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
  "this line is not json and must be tolerated",
  JSON.stringify({ type: "result", subtype: "success" }),
].join("\n");

describe("smoke parser — parseToolUses", () => {
  it("extracts an MCP tool_use name", () => {
    expect(parseToolUses(SIVRU_SEARCH_TRANSCRIPT)).toEqual([
      "mcp__sivru__search",
    ]);
  });

  it("extracts a built-in tool_use name", () => {
    expect(parseToolUses(GREP_TRANSCRIPT)).toEqual(["Grep"]);
  });

  it("returns no names and tolerates non-JSON lines", () => {
    expect(parseToolUses(NO_TOOL_TRANSCRIPT)).toEqual([]);
  });

  it("returns no names for empty input", () => {
    expect(parseToolUses("")).toEqual([]);
  });
});

describe("smoke parser — classifyTool", () => {
  it("classifies the sivru MCP search tool", () => {
    expect(classifyTool("mcp__sivru__search")).toBe("sivru-search");
  });

  it("classifies the built-in Grep tool", () => {
    expect(classifyTool("Grep")).toBe("grep");
  });

  it("classifies the sivru find_related tool", () => {
    expect(classifyTool("mcp__sivru__find_related")).toBe("find-related");
  });

  it("classifies unrelated tools as other", () => {
    expect(classifyTool("Read")).toBe("other");
    expect(classifyTool("Bash")).toBe("other");
    expect(classifyTool("Glob")).toBe("other");
  });
});

describe("smoke parser — firstRoutingChoice", () => {
  it("reports sivru-search when the agent searched", () => {
    expect(firstRoutingChoice(parseToolUses(SIVRU_SEARCH_TRANSCRIPT))).toBe(
      "sivru-search",
    );
  });

  it("reports grep when the agent grepped", () => {
    expect(firstRoutingChoice(parseToolUses(GREP_TRANSCRIPT))).toBe("grep");
  });

  it("reports find-related when the agent used find_related", () => {
    expect(firstRoutingChoice(parseToolUses(FIND_RELATED_TRANSCRIPT))).toBe(
      "find-related",
    );
  });

  it("skips non-routing tools and reports the first routing one", () => {
    expect(firstRoutingChoice(["Read", "Bash", "Grep"])).toBe("grep");
    expect(firstRoutingChoice(["Read", "mcp__sivru__find_related"])).toBe(
      "find-related",
    );
  });

  it("reports none when no routing tool was used", () => {
    expect(firstRoutingChoice(["Read", "Bash"])).toBe("none");
    expect(firstRoutingChoice([])).toBe("none");
  });
});
