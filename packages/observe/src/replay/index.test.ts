import { describe, expect, it } from "vitest";
import type { SivruEvent } from "../types.js";
import { aggregateReplay, replaySession } from "./index.js";

function ev(partial: Partial<SivruEvent>): SivruEvent {
  return {
    kind: "system",
    sessionId: "s",
    index: 0,
    raw: null,
    ...partial,
  } as SivruEvent;
}

describe("replaySession (offline counterfactual)", () => {
  it("returns zeros for an empty session", async () => {
    const r = await replaySession([]);
    expect(r.events).toEqual([]);
    expect(r.totals).toEqual({
      actualTokens: 0,
      counterfactualTokens: 0,
      tokensSaved: 0,
      percentSaved: 0,
      replaceableCallCount: 0,
    });
  });

  it("flags Read tool_use as replaceable and substitutes counterfactual chunks", async () => {
    const events: SivruEvent[] = [
      ev({ kind: "tool_use", index: 0, tool: "Read", input: { file_path: "/x.ts" } }),
      ev({
        kind: "tool_result",
        index: 1,
        tool: "Read",
        text: "x".repeat(20000), // ~5000 tokens (heuristic = chars/4)
      }),
    ];
    const r = await replaySession(events);
    expect(r.totals.replaceableCallCount).toBe(1);
    expect(r.events[0]?.replaceableBySivru).toBe(true);
    expect(r.events[1]?.replaceableBySivru).toBe(true);
    expect(r.events[1]?.counterfactualTokens).toBe(5 * 300); // K * AVG_CHUNK
    expect(r.totals.tokensSaved).toBeGreaterThan(0);
    expect(r.totals.percentSaved).toBeGreaterThan(0);
  });

  it("treats Grep / Glob tool_use as replaceable", async () => {
    const events: SivruEvent[] = [
      ev({ kind: "tool_use", index: 0, tool: "Grep", input: { pattern: "auth" } }),
      ev({ kind: "tool_result", index: 1, tool: "Grep", text: "x".repeat(8000) }),
      ev({ kind: "tool_use", index: 2, tool: "Glob", input: { pattern: "**/*.ts" } }),
      ev({ kind: "tool_result", index: 3, tool: "Glob", text: "x".repeat(4000) }),
    ];
    const r = await replaySession(events);
    expect(r.totals.replaceableCallCount).toBe(2);
    expect(r.events[0]?.replaceableBySivru).toBe(true);
    expect(r.events[2]?.replaceableBySivru).toBe(true);
  });

  it("matches Bash invocations of grep / find / cat / head / tail / rg via the regex list", async () => {
    const cases = [
      "grep -r foo .",
      "rg foo",
      "find . -name '*.ts'",
      "fd auth",
      "cat src/foo.ts",
      "head -n 200 src/x.ts",
      "tail -n 50 logs/app.log",
      "sed -n '10,20p' file.ts",
    ];
    for (const cmd of cases) {
      const events: SivruEvent[] = [
        ev({ kind: "tool_use", index: 0, tool: "Bash", input: { command: cmd } }),
        ev({ kind: "tool_result", index: 1, tool: "Bash", text: "out" }),
      ];
      const r = await replaySession(events);
      expect(r.totals.replaceableCallCount, `expected replaceable: ${cmd}`).toBe(1);
    }
  });

  it("does not flag bash commands like `ls` or `pnpm test`", async () => {
    const cases = ["ls -la", "pnpm test", "git status", "node --version"];
    for (const cmd of cases) {
      const events: SivruEvent[] = [
        ev({ kind: "tool_use", index: 0, tool: "Bash", input: { command: cmd } }),
        ev({ kind: "tool_result", index: 1, tool: "Bash", text: "out" }),
      ];
      const r = await replaySession(events);
      expect(r.totals.replaceableCallCount, `should NOT replace: ${cmd}`).toBe(0);
    }
  });

  it("uses tokensIn/tokensOut from assistant_message when available", async () => {
    const events: SivruEvent[] = [
      ev({
        kind: "assistant_message",
        index: 0,
        text: "hi",
        // simulated usage fields the normalizer puts on the event
      }),
    ];
    const withUsage: SivruEvent[] = [
      Object.assign(ev({ kind: "assistant_message", index: 0, text: "hi" }), {
        tokensIn: 1000,
        tokensOut: 500,
      }) as SivruEvent,
    ];
    const r1 = await replaySession(events);
    const r2 = await replaySession(withUsage);
    // Without usage, falls back to ceil("hi".length / 4) = 1.
    expect(r1.totals.actualTokens).toBe(1);
    // With usage, uses 1000 + 500 = 1500.
    expect(r2.totals.actualTokens).toBe(1500);
  });

  it("supports custom search-replaceable tools", async () => {
    const events: SivruEvent[] = [
      ev({ kind: "tool_use", index: 0, tool: "MyCustomReader", input: {} }),
      ev({ kind: "tool_result", index: 1, tool: "MyCustomReader", text: "x".repeat(10000) }),
    ];
    const defaultR = await replaySession(events);
    expect(defaultR.totals.replaceableCallCount).toBe(0);
    const customR = await replaySession(events, {
      searchReplaceableTools: ["MyCustomReader"],
    });
    expect(customR.totals.replaceableCallCount).toBe(1);
  });

  it("AsyncIterable input works the same as Iterable", async () => {
    async function* gen(): AsyncGenerator<SivruEvent> {
      yield ev({ kind: "tool_use", index: 0, tool: "Read", input: {} });
      yield ev({ kind: "tool_result", index: 1, tool: "Read", text: "x".repeat(8000) });
    }
    const r = await replaySession(gen());
    expect(r.totals.replaceableCallCount).toBe(1);
  });
});

describe("aggregateReplay", () => {
  it("rolls up totals across many sessions (signed savings)", async () => {
    const sessions = [
      {
        id: "a",
        events: [
          ev({ kind: "tool_use", index: 0, tool: "Read", input: {} }),
          // ~16000 chars / 4 = 4000 tokens actual; counterfactual = 5 * 300 = 1500
          ev({ kind: "tool_result", index: 1, tool: "Read", text: "x".repeat(16000) }),
        ],
      },
      {
        id: "b",
        events: [
          ev({ kind: "tool_use", index: 0, tool: "Bash", input: { command: "grep auth ." } }),
          // 8000 / 4 = 2000 tokens actual; counterfactual = 1500
          ev({ kind: "tool_result", index: 1, tool: "Bash", text: "x".repeat(8000) }),
        ],
      },
    ];
    const r = await aggregateReplay(sessions);
    expect(r.totals.sessionCount).toBe(2);
    expect(r.totals.replaceableCallCount).toBe(2);
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[0]?.id).toBe("a");
    expect(r.sessions[1]?.id).toBe("b");
    // a: 4000 - 1500 = 2500, b: 2000 - 1500 = 500, total = 3000
    expect(r.totals.tokensSaved).toBe(3000);
    expect(r.totals.actualTokens).toBe(6000);
    expect(r.totals.counterfactualTokens).toBe(3000);
  });

  it("aggregate tokensSaved can be negative when sivru would underperform", async () => {
    const sessions = [
      {
        id: "tiny-grep",
        events: [
          ev({ kind: "tool_use", index: 0, tool: "Bash", input: { command: "grep x ." } }),
          // Only 100 chars / 4 = 25 tokens actual; counterfactual = 5 * 300 = 1500.
          ev({ kind: "tool_result", index: 1, tool: "Bash", text: "x".repeat(100) }),
        ],
      },
    ];
    const r = await aggregateReplay(sessions);
    expect(r.totals.tokensSaved).toBeLessThan(0);
    expect(r.totals.percentSaved).toBeLessThan(0);
  });

  it("returns zeros for no input sessions", async () => {
    const r = await aggregateReplay([]);
    expect(r.totals.sessionCount).toBe(0);
    expect(r.totals.tokensSaved).toBe(0);
    expect(r.totals.percentSaved).toBe(0);
  });
});
