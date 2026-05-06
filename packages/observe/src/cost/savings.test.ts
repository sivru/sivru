// Tests for the Layer 1 savings estimator (DESIGN.md §20.1).

import { describe, expect, it } from "vitest";

import type { SivruEvent } from "../types.js";
import { estimateSavings, summarizeEvents } from "./savings.js";

const SESSION_ID = "test-session";

let nextIndex = 0;
function evt(partial: Omit<SivruEvent, "sessionId" | "index" | "raw"> & {
  raw?: unknown;
}): SivruEvent {
  const { raw, ...rest } = partial;
  return {
    sessionId: SESSION_ID,
    index: nextIndex++,
    raw: raw ?? rest,
    ...rest,
  };
}

function reset(): void {
  nextIndex = 0;
}

describe("summarizeEvents", () => {
  it("reports zero counts and hasSivruSearch=false on empty session", async () => {
    reset();
    const summary = await summarizeEvents([]);
    expect(summary).toEqual({
      totalEvents: 0,
      byKind: {},
      hasSivruSearch: false,
    });
  });

  it("counts events by kind and flags sivru.search tool_use", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "user_message", text: "hi" }),
      evt({ kind: "assistant_message", text: "hello" }),
      evt({ kind: "tool_use", tool: "sivru.search", input: { query: "auth" } }),
      evt({ kind: "tool_result", tool: "sivru.search", output: "## a\n" }),
    ];
    const summary = await summarizeEvents(events);
    expect(summary.totalEvents).toBe(4);
    expect(summary.byKind).toEqual({
      user_message: 1,
      assistant_message: 1,
      tool_use: 1,
      tool_result: 1,
    });
    expect(summary.hasSivruSearch).toBe(true);
  });

  it("hasSivruSearch=false when only Bash tool_use is present", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "Bash", input: { command: "grep -r foo" } }),
    ];
    const summary = await summarizeEvents(events);
    expect(summary.hasSivruSearch).toBe(false);
  });
});

describe("estimateSavings — empty + zero-search sessions", () => {
  it("returns all zeros for an empty session", async () => {
    reset();
    const result = await estimateSavings([]);
    expect(result.tokensSaved).toBe(0);
    expect(result.tokensConsumed).toBe(0);
    expect(result.percentSaved).toBe(0);
    expect(result.searchCallCount).toBe(0);
    expect(result.chunksReturnedTotal).toBe(0);
    expect(result.config).toEqual({
      baselineFilesPerSearch: 5,
      avgFileTokens: 1500,
      avgChunkTokens: 300,
    });
  });

  it("zero-search session with assistant text → tokensSaved=0, percentSaved=0", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "assistant_message", text: "x".repeat(4000) }),
    ];
    const result = await estimateSavings(events);
    expect(result.tokensSaved).toBe(0);
    expect(result.searchCallCount).toBe(0);
    // 4000 / 4 = 1000.
    expect(result.tokensConsumed).toBe(1000);
    expect(result.percentSaved).toBe(0);
  });
});

describe("estimateSavings — single sivru.search call", () => {
  it("computes 6600 tokens saved for a 3-chunk markdown result with no assistant messages", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: { query: "auth" } }),
      evt({
        kind: "tool_result",
        tool: "sivru.search",
        output: "## chunk one\nbody\n## chunk two\nbody\n## chunk three\nbody\n",
      }),
    ];
    const result = await estimateSavings(events);
    // 5 * 1500 - 3 * 300 = 7500 - 900 = 6600.
    expect(result.tokensSaved).toBe(6600);
    expect(result.searchCallCount).toBe(1);
    expect(result.chunksReturnedTotal).toBe(3);
    expect(result.tokensConsumed).toBe(0);
    expect(result.percentSaved).toBe(1);
  });

  it("combines a sivru.search call with an assistant message for percentSaved", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: { query: "auth" } }),
      evt({
        kind: "tool_result",
        tool: "sivru.search",
        output: "## one\nbody\n## two\nbody\n## three\nbody\n",
      }),
      evt({ kind: "assistant_message", text: "y".repeat(4000) }),
    ];
    const result = await estimateSavings(events);
    expect(result.tokensSaved).toBe(6600);
    expect(result.tokensConsumed).toBe(1000);
    // 6600 / 7600 ≈ 0.8684
    expect(result.percentSaved).toBeGreaterThan(0.86);
    expect(result.percentSaved).toBeLessThan(0.87);
  });
});

describe("estimateSavings — config overrides", () => {
  it("respects custom baselineFilesPerSearch and avgFileTokens", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: { query: "x" } }),
      evt({
        kind: "tool_result",
        tool: "sivru.search",
        output: "## a\n## b\n",
      }),
    ];
    const result = await estimateSavings(events, {
      baselineFilesPerSearch: 10,
      avgFileTokens: 2000,
    });
    // 10 * 2000 - 2 * 300 = 20000 - 600 = 19400.
    expect(result.tokensSaved).toBe(19400);
    expect(result.config).toEqual({
      baselineFilesPerSearch: 10,
      avgFileTokens: 2000,
      avgChunkTokens: 300,
    });
  });
});

describe("estimateSavings — tool name aliases", () => {
  it("counts sivru_search and sivru.search the same way", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru_search", input: {} }),
      evt({ kind: "tool_result", tool: "sivru_search", output: "## one\n" }),
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      evt({ kind: "tool_result", tool: "sivru.search", output: "## one\n" }),
    ];
    const result = await estimateSavings(events);
    expect(result.searchCallCount).toBe(2);
    // (5*1500 - 1*300) * 2 = 7200 * 2 = 14400.
    expect(result.tokensSaved).toBe(14400);
  });

  it("respects a custom searchToolNames list", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "search", input: {} }),
      evt({ kind: "tool_result", tool: "search", output: "## a\n" }),
    ];
    const noneMatched = await estimateSavings(events);
    expect(noneMatched.searchCallCount).toBe(0);
    reset();
    const events2: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "search", input: {} }),
      evt({ kind: "tool_result", tool: "search", output: "## a\n" }),
    ];
    const matched = await estimateSavings(events2, {
      searchToolNames: ["search"],
    });
    expect(matched.searchCallCount).toBe(1);
  });
});

describe("estimateSavings — tool_result output shapes", () => {
  it("treats array output as chunk count", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      evt({
        kind: "tool_result",
        tool: "sivru.search",
        output: [{ id: "a" }, { id: "b" }],
      }),
    ];
    const result = await estimateSavings(events);
    expect(result.chunksReturnedTotal).toBe(2);
    // 5*1500 - 2*300 = 6900.
    expect(result.tokensSaved).toBe(6900);
  });

  it("uses inner array when output is { chunks: [...] }", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      evt({
        kind: "tool_result",
        tool: "sivru.search",
        output: { chunks: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }] },
      }),
    ];
    const result = await estimateSavings(events);
    expect(result.chunksReturnedTotal).toBe(4);
    // 5*1500 - 4*300 = 7500 - 1200 = 6300.
    expect(result.tokensSaved).toBe(6300);
  });

  it("falls back to 1 chunk when output shape is unrecognized", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      evt({ kind: "tool_result", tool: "sivru.search", output: 42 }),
    ];
    const result = await estimateSavings(events);
    expect(result.chunksReturnedTotal).toBe(1);
    expect(result.tokensSaved).toBe(7200);
  });

  it("caps chunk count at baselineFilesPerSearch so savings never goes negative", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      evt({
        kind: "tool_result",
        tool: "sivru.search",
        output: Array.from({ length: 50 }, (_, i) => ({ i })),
      }),
    ];
    const result = await estimateSavings(events);
    // Cap at 5 chunks: 5*1500 - 5*300 = 7500 - 1500 = 6000.
    expect(result.chunksReturnedTotal).toBe(5);
    expect(result.tokensSaved).toBe(6000);
  });
});

describe("estimateSavings — interrupted calls", () => {
  it("treats a tool_use without matching tool_result as 0 chunks → full baseline saved", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      // stream ends mid-call
    ];
    const result = await estimateSavings(events);
    expect(result.searchCallCount).toBe(1);
    expect(result.chunksReturnedTotal).toBe(0);
    // 5*1500 - 0 = 7500.
    expect(result.tokensSaved).toBe(7500);
  });

  it("flushes a prior pending search when a new search tool_use arrives", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      evt({ kind: "tool_result", tool: "sivru.search", output: "## one\n" }),
    ];
    const result = await estimateSavings(events);
    expect(result.searchCallCount).toBe(2);
    // first: 7500, second: 5*1500 - 1*300 = 7200; total = 14700.
    expect(result.tokensSaved).toBe(14700);
  });
});

describe("estimateSavings — usage tokens on assistant messages", () => {
  it("prefers tokensIn + tokensOut from raw event when present", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({
        kind: "assistant_message",
        text: "ignored for usage math",
        raw: { tokensIn: 250, tokensOut: 750 },
      }),
    ];
    const result = await estimateSavings(events);
    expect(result.tokensConsumed).toBe(1000);
  });

  it("reads usage from message.usage.{input_tokens,output_tokens}", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({
        kind: "assistant_message",
        text: "ignored",
        raw: { message: { usage: { input_tokens: 100, output_tokens: 200 } } },
      }),
    ];
    const result = await estimateSavings(events);
    expect(result.tokensConsumed).toBe(300);
  });
});

describe("estimateSavings — async iterable input", () => {
  it("accepts an AsyncIterable<SivruEvent>", async () => {
    reset();
    const inner: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      evt({ kind: "tool_result", tool: "sivru.search", output: "## a\n" }),
    ];
    async function* gen(): AsyncIterable<SivruEvent> {
      for (const e of inner) yield e;
    }
    const result = await estimateSavings(gen());
    expect(result.searchCallCount).toBe(1);
    expect(result.tokensSaved).toBe(7200);
  });
});

describe("estimateSavings — dollar fields (DESIGN.md §22.2)", () => {
  it("computes dollarsConsumed and dollarsSaved for a sonnet-4-6 turn alongside a sivru.search call", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: { query: "auth" } }),
      evt({
        kind: "tool_result",
        tool: "sivru.search",
        output: "## one\n## two\n## three\n",
      }),
      evt({
        kind: "assistant_message",
        text: "ignored for usage math",
        raw: {
          message: {
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1000, output_tokens: 500 },
          },
        },
      }),
    ];
    const result = await estimateSavings(events);
    // 5*1500 - 3*300 = 6600 tokens saved.
    expect(result.tokensSaved).toBe(6600);
    expect(result.tokensConsumed).toBe(1500);
    // Cost = (1000*3 + 500*15)/1e6 = 0.0105.
    expect(result.dollarsConsumed).toBeCloseTo(0.0105, 10);
    // Blended rate for the lone turn = 0.0105 / 1500 * 1e6 = 7 $/Mtok.
    // dollarsSaved = 6600 * 7 / 1e6 = 0.0462.
    expect(result.dollarsSaved).not.toBeNull();
    expect(result.dollarsSaved!).toBeCloseTo(0.0462, 10);
    // percentDollars finite and in (0, 1).
    expect(result.percentDollars).not.toBeNull();
    expect(result.percentDollars!).toBeGreaterThan(0);
    expect(result.percentDollars!).toBeLessThan(1);
    expect(Number.isFinite(result.percentDollars!)).toBe(true);
  });

  it("yields dollarsConsumed=0, dollarsSaved=null, percentDollars=null for an unknown model", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      evt({
        kind: "tool_result",
        tool: "sivru.search",
        output: "## a\n## b\n## c\n",
      }),
      evt({
        kind: "assistant_message",
        text: "x",
        raw: {
          message: {
            model: "unknown-model",
            usage: { input_tokens: 1000, output_tokens: 500 },
          },
        },
      }),
    ];
    const result = await estimateSavings(events);
    expect(result.dollarsConsumed).toBe(0);
    expect(result.dollarsSaved).toBeNull();
    expect(result.percentDollars).toBeNull();
    // Existing fields untouched.
    expect(result.tokensSaved).toBe(6600);
    expect(result.tokensConsumed).toBe(1500);
    expect(result.percentSaved).toBeGreaterThan(0);
    expect(Number.isNaN(result.dollarsConsumed)).toBe(false);
  });

  it("turns[] length matches the count of assistant_messages with usage info", async () => {
    reset();
    const events: SivruEvent[] = [
      // priceable
      evt({
        kind: "assistant_message",
        text: "a",
        raw: {
          message: {
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      }),
      // priceable, different model
      evt({
        kind: "assistant_message",
        text: "b",
        raw: {
          model: "claude-haiku-4-5",
          tokensIn: 200,
          tokensOut: 100,
        },
      }),
      // no usage info → should NOT appear in turns[]
      evt({ kind: "assistant_message", text: "c".repeat(40) }),
      // unknown model BUT has usage → still appears in turns[] with usd=null
      evt({
        kind: "assistant_message",
        text: "d",
        raw: {
          message: {
            model: "unknown-model",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      }),
    ];
    const result = await estimateSavings(events);
    expect(result.turns).toHaveLength(3);
    expect(result.turns[0]?.model).toBe("claude-sonnet-4-6");
    expect(result.turns[0]?.usd).not.toBeNull();
    expect(result.turns[1]?.model).toBe("claude-haiku-4-5");
    expect(result.turns[1]?.usd).not.toBeNull();
    expect(result.turns[2]?.model).toBe("unknown-model");
    expect(result.turns[2]?.usd).toBeNull();
    // dollarsConsumed sums only the priceable two.
    // sonnet: (100*3 + 50*15)/1e6 = (300+750)/1e6 = 0.00105
    // haiku: (200*1 + 100*5)/1e6 = (200+500)/1e6 = 0.0007
    expect(result.dollarsConsumed).toBeCloseTo(0.00105 + 0.0007, 12);
  });

  it("does not fake a price when usage data is missing AND model is missing", async () => {
    reset();
    const events: SivruEvent[] = [
      evt({ kind: "tool_use", tool: "sivru.search", input: {} }),
      evt({
        kind: "tool_result",
        tool: "sivru.search",
        output: "## one\n",
      }),
      // No usage, no model — should fall back to text.length / 4 for tokensConsumed
      // but contribute NOTHING to the dollar layer.
      evt({ kind: "assistant_message", text: "y".repeat(4000) }),
    ];
    const result = await estimateSavings(events);
    // Existing fallback still works for tokensConsumed.
    expect(result.tokensConsumed).toBe(1000);
    // Dollar layer stays null/zero — we don't fake a price.
    expect(result.dollarsConsumed).toBe(0);
    expect(result.dollarsSaved).toBeNull();
    expect(result.percentDollars).toBeNull();
    // turns[] has no entry for the unstructured assistant message.
    expect(result.turns).toHaveLength(0);
  });
});
