import { describe, expect, it } from "vitest";
import {
  computeTurns,
  defaultExpansion,
  estimateTurnSavedTokens,
  formatBytesAsTokens,
  formatDuration,
  formatTokenCount,
} from "./turns";
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

describe("computeTurns", () => {
  it("returns no turns for an empty list", () => {
    expect(computeTurns([])).toEqual([]);
  });

  it("starts a synthetic turn 0 when there is no user_message", () => {
    const turns = computeTurns([
      ev(0, "tool_use", { tool: "Read" }),
      ev(1, "tool_result"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.index).toBe(0);
    expect(turns[0]?.prompt).toBeNull();
    expect(turns[0]?.tools).toEqual(["Read"]);
  });

  it("groups events between user_message boundaries", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "fix auth" }),
      ev(1, "assistant_message", { text: "ok" }),
      ev(2, "tool_use", { tool: "Read" }),
      ev(3, "tool_result"),
      ev(4, "user_message", { text: "now write tests" }),
      ev(5, "tool_use", { tool: "Edit" }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.prompt).toBe("fix auth");
    expect(turns[0]?.events).toHaveLength(4);
    expect(turns[1]?.prompt).toBe("now write tests");
    expect(turns[1]?.events).toHaveLength(2);
  });

  it("flags an interrupted turn (unmatched tool_use)", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "do stuff" }),
      ev(1, "tool_use", { tool: "Bash" }),
      // no tool_result — the agent died mid-call
    ]);
    expect(turns[0]?.interrupted).toBe(true);
  });

  it("does not flag a turn with matched tool_use/result pair", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "Bash" }),
      ev(2, "tool_result"),
    ]);
    expect(turns[0]?.interrupted).toBe(false);
  });

  it("propagates isError to the turn level", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "Bash" }),
      ev(2, "tool_result", { isError: true }),
    ]);
    expect(turns[0]?.hasError).toBe(true);
  });

  it("detects sivru.search tool use under the namespaced name", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "mcp__sivru__search" }),
      ev(2, "tool_result"),
    ]);
    expect(turns[0]?.usedSivruSearch).toBe(true);
  });

  it("collects distinct tool names per turn", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "Read" }),
      ev(2, "tool_result"),
      ev(3, "tool_use", { tool: "Edit" }),
      ev(4, "tool_result"),
      ev(5, "tool_use", { tool: "Read" }),
      ev(6, "tool_result"),
    ]);
    expect(new Set(turns[0]?.tools)).toEqual(new Set(["Read", "Edit"]));
  });

  // Regression test for the closure-capture pattern in computeTurns: the
  // working `tools` and `pendingToolUses` sets are reassigned on each new
  // turn. If pushTo ever destructures them at the top, per-turn isolation
  // breaks and turn 2's tools list ends up containing turn 1's tools.
  it("isolates tool sets between turns", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "first" }),
      ev(1, "tool_use", { tool: "Read" }),
      ev(2, "tool_result"),
      ev(3, "user_message", { text: "second" }),
      ev(4, "tool_use", { tool: "Edit" }),
      ev(5, "tool_result"),
    ]);
    expect(turns[0]?.tools).toEqual(["Read"]);
    expect(turns[1]?.tools).toEqual(["Edit"]);
    expect(turns[1]?.tools).not.toContain("Read");
  });

  // Regression test paired with the above: an unmatched tool_use in turn 1
  // must NOT cause turn 2 to be flagged as interrupted. The pendingToolUses
  // set has to reset on turn boundaries.
  it("isolates interrupted state between turns", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "first" }),
      ev(1, "tool_use", { tool: "Bash" }),
      // turn 1 ends without a tool_result — interrupted
      ev(2, "user_message", { text: "second" }),
      ev(3, "tool_use", { tool: "Edit" }),
      ev(4, "tool_result"),
    ]);
    expect(turns[0]?.interrupted).toBe(true);
    expect(turns[1]?.interrupted).toBe(false);
  });
});

describe("defaultExpansion", () => {
  it("expands only the latest turn", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "a" }),
      ev(1, "user_message", { text: "b" }),
      ev(2, "user_message", { text: "c" }),
    ]);
    const expansion = defaultExpansion(turns);
    expect(expansion.size).toBe(1);
    expect(expansion.has(turns.length - 1)).toBe(true);
  });

  it("returns empty set for empty input", () => {
    expect(defaultExpansion([]).size).toBe(0);
  });
});

describe("turn metrics — the per-turn coaching signal", () => {
  it("counts sivru.search calls and chunks returned", () => {
    const searchOutput = JSON.stringify({
      results: [
        { filePath: "a.ts", startLine: 1, endLine: 10, score: 0.9 },
        { filePath: "b.ts", startLine: 5, endLine: 20, score: 0.8 },
        { filePath: "c.ts", startLine: 1, endLine: 30, score: 0.7 },
      ],
    });
    const turns = computeTurns([
      ev(0, "user_message", { text: "find the auth flow" }),
      ev(1, "tool_use", { tool: "mcp__sivru__search", input: { query: "auth" } }),
      ev(2, "tool_result", { tool: "mcp__sivru__search", output: searchOutput }),
    ]);
    expect(turns[0]?.metrics.searchCalls).toBe(1);
    expect(turns[0]?.metrics.searchChunks).toBe(3);
    expect(turns[0]?.metrics.hasMissedOpportunity).toBe(false);
  });

  it("flags a missed opportunity when reads are big and no search fired", () => {
    const bigContent = "x".repeat(8_000); // 8k bytes ≈ 2k tokens — over threshold
    const turns = computeTurns([
      ev(0, "user_message", { text: "find the bug" }),
      ev(1, "tool_use", { tool: "Read", input: { file_path: "a.ts" } }),
      ev(2, "tool_result", { tool: "Read", output: bigContent }),
    ]);
    expect(turns[0]?.metrics.searchCalls).toBe(0);
    expect(turns[0]?.metrics.readBytes).toBeGreaterThanOrEqual(8_000);
    expect(turns[0]?.metrics.hasMissedOpportunity).toBe(true);
  });

  // The other half of the missed-opportunity case: `Bash grep -r ...` —
  // pre-fix the implementation only checked readBytes, leaving Bash
  // grep-heavy turns silently uncoached.
  it("flags missed opportunity when Bash output is big and no search fired", () => {
    const grepResults = "match\n".repeat(2_000); // 12k bytes ≈ 3k tokens
    const turns = computeTurns([
      ev(0, "user_message", { text: "find auth references" }),
      ev(1, "tool_use", { tool: "Bash", input: { command: "grep -r auth ." } }),
      ev(2, "tool_result", { tool: "Bash", output: grepResults }),
    ]);
    expect(turns[0]?.metrics.searchCalls).toBe(0);
    expect(turns[0]?.metrics.bashOutputBytes).toBeGreaterThanOrEqual(8_000);
    expect(turns[0]?.metrics.readBytes).toBe(0);
    expect(turns[0]?.metrics.hasMissedOpportunity).toBe(true);
  });

  // Combined heavy context: small Read + small Bash, both individually
  // under the threshold but together over it.
  it("trips the threshold on the SUM of read + bash bytes, not either alone", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "Read" }),
      ev(2, "tool_result", { tool: "Read", output: "x".repeat(3_000) }),
      ev(3, "tool_use", { tool: "Bash" }),
      ev(4, "tool_result", { tool: "Bash", output: "y".repeat(3_000) }),
    ]);
    expect(turns[0]?.metrics.readBytes).toBe(3_000);
    expect(turns[0]?.metrics.bashOutputBytes).toBe(3_000);
    // 3k + 3k = 6k >= 5k threshold
    expect(turns[0]?.metrics.hasMissedOpportunity).toBe(true);
  });

  it("does NOT flag missed opportunity for a turn with sivru.search", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "find the bug" }),
      ev(1, "tool_use", { tool: "mcp__sivru__search" }),
      ev(2, "tool_result", { tool: "mcp__sivru__search", output: '{"results":[]}' }),
      ev(3, "tool_use", { tool: "Read" }),
      ev(4, "tool_result", { tool: "Read", output: "x".repeat(100_000) }),
    ]);
    expect(turns[0]?.metrics.searchCalls).toBe(1);
    expect(turns[0]?.metrics.hasMissedOpportunity).toBe(false);
  });

  it("does NOT flag missed opportunity below the heavy-context threshold", () => {
    // 2k bytes ≈ 500 tokens — well under the threshold.
    const turns = computeTurns([
      ev(0, "user_message", { text: "small read" }),
      ev(1, "tool_use", { tool: "Read" }),
      ev(2, "tool_result", { tool: "Read", output: "x".repeat(2_000) }),
    ]);
    expect(turns[0]?.metrics.hasMissedOpportunity).toBe(false);
  });

  it("attributes tool_result to the most recent tool_use when result has no tool name", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "x" }),
      ev(1, "tool_use", { tool: "Read" }),
      ev(2, "tool_result", { output: "x".repeat(7_000) }),  // no tool field
    ]);
    expect(turns[0]?.metrics.readBytes).toBeGreaterThanOrEqual(7_000);
  });

  it("isolates metrics between turns", () => {
    const turns = computeTurns([
      ev(0, "user_message", { text: "first" }),
      ev(1, "tool_use", { tool: "Read" }),
      ev(2, "tool_result", { tool: "Read", output: "x".repeat(8_000) }),
      ev(3, "user_message", { text: "second" }),
      ev(4, "tool_use", { tool: "mcp__sivru__search" }),
      ev(5, "tool_result", {
        tool: "mcp__sivru__search",
        output: '{"results":[{"filePath":"a"}]}',
      }),
    ]);
    expect(turns[0]?.metrics.hasMissedOpportunity).toBe(true);
    expect(turns[1]?.metrics.hasMissedOpportunity).toBe(false);
    expect(turns[1]?.metrics.searchCalls).toBe(1);
    // Turn 2 didn't read anything large — its readBytes is 0.
    expect(turns[1]?.metrics.readBytes).toBe(0);
  });
});

describe("formatBytesAsTokens", () => {
  it.each([
    [0, "0"],
    [400, "100"],
    [4_000, "1.0k"],
    [40_000, "10k"],
    [120_000, "30k"],
  ])("formatBytesAsTokens(%i bytes) → %s", (bytes, expected) => {
    expect(formatBytesAsTokens(bytes)).toBe(expected);
  });
});

describe("formatTokenCount", () => {
  it.each([
    [0, "0"],
    [847, "847"],
    [1_500, "1.5k"],
    [11_400, "11k"],
    [80_000, "80k"],
  ])("formatTokenCount(%i) → %s", (tokens, expected) => {
    expect(formatTokenCount(tokens)).toBe(expected);
  });
});

describe("estimateTurnSavedTokens — proportional attribution", () => {
  function turnWith(searchChunks: number) {
    return {
      metrics: {
        searchCalls: 1,
        searchChunks,
        readBytes: 0,
        bashOutputBytes: 0,
        hasMissedOpportunity: false,
      },
    } as Parameters<typeof estimateTurnSavedTokens>[0];
  }

  it("returns null when session savings is unknown", () => {
    expect(estimateTurnSavedTokens(turnWith(5), null, 100)).toBeNull();
  });

  it("returns null when session savings is non-positive", () => {
    expect(estimateTurnSavedTokens(turnWith(5), 0, 100)).toBeNull();
    expect(estimateTurnSavedTokens(turnWith(5), -10, 100)).toBeNull();
  });

  it("returns null when total session chunks is zero", () => {
    expect(estimateTurnSavedTokens(turnWith(5), 1000, 0)).toBeNull();
  });

  it("returns null when this turn returned no chunks", () => {
    expect(estimateTurnSavedTokens(turnWith(0), 1000, 50)).toBeNull();
  });

  it("attributes proportionally by chunk share", () => {
    // turn returned 10 of 50 total chunks, total saved 1000 → 200
    expect(estimateTurnSavedTokens(turnWith(10), 1000, 50)).toBe(200);
  });

  it("rounds to the nearest token", () => {
    // turn returned 3 of 7, total saved 100 → 42.86 → 43
    expect(estimateTurnSavedTokens(turnWith(3), 100, 7)).toBe(43);
  });

  // Regression: client-side chunk count CAN exceed the server's
  // chunksReturnedTotal when the two parsers disagree. Without clamping,
  // we'd attribute more than the entire session's savings to one turn.
  it("clamps share to 1 when client/server chunk counts disagree", () => {
    // Client saw 10 chunks for this turn alone; server reports 5 across
    // the whole session. Without clamp this would return 2000; with clamp,
    // capped at sessionTokensSaved.
    expect(estimateTurnSavedTokens(turnWith(10), 1000, 5)).toBe(1000);
  });

  it("clamps even on near-miss drift", () => {
    // Client: 6 chunks; server: 5 → share would be 1.2. Clamp to 1.0.
    expect(estimateTurnSavedTokens(turnWith(6), 100, 5)).toBe(100);
  });
});

describe("formatDuration", () => {
  it.each([
    [null, ""],
    [-5, ""],
    [0, "0ms"],
    [840, "840ms"],
    [1500, "2s"], // rounds
    [47000, "47s"],
    [62000, "1m 2s"],
    [138000, "2m 18s"],
  ])("formats %s ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
