import { describe, expect, it } from "vitest";
import { _internals, computeSearchProvenance } from "./search-provenance";
import type { SivruEvent } from "./types";

function ev(
  index: number,
  kind: SivruEvent["kind"],
  extra: Partial<SivruEvent> = {},
): SivruEvent {
  return {
    sessionId: "s",
    index,
    kind,
    raw: {},
    ts: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    ...extra,
  };
}

const SEARCH_RESULTS_OUTPUT = JSON.stringify({
  results: [
    { filePath: "src/auth/middleware.ts", startLine: 42, endLine: 78, score: 0.91 },
    { filePath: "src/auth/jwt.ts", startLine: 88, endLine: 115, score: 0.74 },
    { filePath: "src/server/routes.ts", startLine: 12, endLine: 30, score: 0.62 },
  ],
});

describe("computeSearchProvenance", () => {
  it("links a Read of a recommended file back to the search", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "fix auth" }),
      ev(1, "tool_use", { tool: "mcp__sivru__search", input: { query: "auth" } }),
      ev(2, "tool_result", { tool: "mcp__sivru__search", output: SEARCH_RESULTS_OUTPUT }),
      ev(3, "tool_use", { tool: "Read", input: { file_path: "src/auth/middleware.ts" } }),
    ];
    const out = computeSearchProvenance(events);

    const linked = out.consumerByEvent.get(3);
    expect(linked).toBeDefined();
    expect(linked?.searchEventIndex).toBe(1);
    expect(linked?.chunkIndex).toBe(0);
    expect(linked?.filePath).toBe("src/auth/middleware.ts");
    expect(linked?.startLine).toBe(42);
  });

  it("indexes the reverse direction: search → list of consumer events", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "fix auth" }),
      ev(1, "tool_use", { tool: "mcp__sivru__search" }),
      ev(2, "tool_result", { tool: "mcp__sivru__search", output: SEARCH_RESULTS_OUTPUT }),
      ev(3, "tool_use", { tool: "Read", input: { file_path: "src/auth/middleware.ts" } }),
      ev(4, "tool_use", { tool: "Edit", input: { file_path: "src/auth/jwt.ts" } }),
    ];
    const out = computeSearchProvenance(events);

    const consumers = out.consumersBySearch.get(1);
    expect(consumers).toEqual([3, 4]);

    const usedChunks = out.usedChunksBySearch.get(1);
    expect(usedChunks?.has(0)).toBe(true); // middleware.ts
    expect(usedChunks?.has(1)).toBe(true); // jwt.ts
    // routes.ts (chunk 2) was returned but not consumed.
    expect(usedChunks?.has(2)).toBe(false);
  });

  it("doesn't link Reads of files that weren't in the search results", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "mcp__sivru__search" }),
      ev(2, "tool_result", { tool: "mcp__sivru__search", output: SEARCH_RESULTS_OUTPUT }),
      ev(3, "tool_use", { tool: "Read", input: { file_path: "src/unrelated.ts" } }),
    ];
    const out = computeSearchProvenance(events);
    expect(out.consumerByEvent.has(3)).toBe(false);
  });

  it("doesn't link a Read that happened BEFORE the search", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "Read", input: { file_path: "src/auth/middleware.ts" } }),
      ev(2, "tool_use", { tool: "mcp__sivru__search" }),
      ev(3, "tool_result", { tool: "mcp__sivru__search", output: SEARCH_RESULTS_OUTPUT }),
    ];
    const out = computeSearchProvenance(events);
    expect(out.consumerByEvent.has(1)).toBe(false);
  });

  it("does cross-turn linking — the user reads in turn 2 what was searched in turn 1", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "find auth" }),
      ev(1, "tool_use", { tool: "mcp__sivru__search" }),
      ev(2, "tool_result", { tool: "mcp__sivru__search", output: SEARCH_RESULTS_OUTPUT }),
      ev(3, "user_message", { text: "now read it" }),
      ev(4, "tool_use", { tool: "Read", input: { file_path: "src/auth/middleware.ts" } }),
    ];
    const out = computeSearchProvenance(events);
    const linked = out.consumerByEvent.get(4);
    expect(linked?.searchEventIndex).toBe(1);
  });

  it("uses the most recent search when multiple cover the same file", () => {
    const FIRST = JSON.stringify({
      results: [{ filePath: "a.ts", startLine: 1, endLine: 10 }],
    });
    const SECOND = JSON.stringify({
      results: [{ filePath: "a.ts", startLine: 50, endLine: 60 }],
    });
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "mcp__sivru__search" }),
      ev(2, "tool_result", { tool: "mcp__sivru__search", output: FIRST }),
      ev(3, "tool_use", { tool: "mcp__sivru__search" }),
      ev(4, "tool_result", { tool: "mcp__sivru__search", output: SECOND }),
      ev(5, "tool_use", { tool: "Read", input: { file_path: "a.ts" } }),
    ];
    const out = computeSearchProvenance(events);
    const linked = out.consumerByEvent.get(5);
    expect(linked?.searchEventIndex).toBe(3); // the SECOND search
    expect(linked?.startLine).toBe(50);
  });

  it("attributes Edit / MultiEdit / Write the same way as Read", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "mcp__sivru__search" }),
      ev(2, "tool_result", { tool: "mcp__sivru__search", output: SEARCH_RESULTS_OUTPUT }),
      ev(3, "tool_use", { tool: "Edit", input: { file_path: "src/auth/middleware.ts" } }),
      ev(4, "tool_use", { tool: "MultiEdit", input: { filePath: "src/auth/jwt.ts" } }),
      ev(5, "tool_use", { tool: "Write", input: { file_path: "src/auth/middleware.ts" } }),
    ];
    const out = computeSearchProvenance(events);
    expect(out.consumerByEvent.has(3)).toBe(true);
    expect(out.consumerByEvent.has(4)).toBe(true);
    expect(out.consumerByEvent.has(5)).toBe(true);
  });

  it("does not falsely link Bash / Grep events", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "mcp__sivru__search" }),
      ev(2, "tool_result", { tool: "mcp__sivru__search", output: SEARCH_RESULTS_OUTPUT }),
      ev(3, "tool_use", { tool: "Bash", input: { command: "cat src/auth/middleware.ts" } }),
      ev(4, "tool_use", { tool: "Grep", input: { pattern: "auth" } }),
    ];
    const out = computeSearchProvenance(events);
    expect(out.consumerByEvent.has(3)).toBe(false);
    expect(out.consumerByEvent.has(4)).toBe(false);
  });
});

describe("pathsMatch (suffix overlap heuristic)", () => {
  const m = _internals.pathsMatch;

  it("matches identical strings", () => {
    expect(m("a/b/c.ts", "a/b/c.ts")).toBe(true);
  });

  it("matches Windows-style backslashes against forward slashes", () => {
    expect(m("src\\auth\\middleware.ts", "src/auth/middleware.ts")).toBe(true);
  });

  it("matches when one is a tail of the other", () => {
    expect(m("/Users/x/repo/src/auth.ts", "src/auth.ts")).toBe(true);
    expect(m("src/auth.ts", "/Users/x/repo/src/auth.ts")).toBe(true);
  });

  // The CRITICAL false-positive guard: same basename, different parents.
  it("does NOT match when only the basename overlaps", () => {
    expect(m("packages/a/utils.ts", "packages/b/utils.ts")).toBe(false);
  });

  it("requires at least 2 path segments to overlap", () => {
    expect(m("foo.ts", "bar/foo.ts")).toBe(false);
  });
});
