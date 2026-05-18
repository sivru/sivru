// Unit tests for the per-model chunk-windowing post-pass (DESIGN-0002 §3).
//
// The windower is exercised with a deterministic test `countTokens` —
// whitespace-delimited word count. A newline is whitespace, so the count is
// additive across a line join, matching the content-token contract (D6).

import { describe, expect, it } from "vitest";

import { rewindowForBudget, byteHeuristicTokenCount } from "./rewindow.js";
import type { Chunk } from "../types.js";

/** Additive test token counter: whitespace-delimited word count. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Build a chunk from line strings; `startLine` is 1-based. */
function chunkOf(
  lines: readonly string[],
  startLine = 1,
  extra: Partial<Pick<Chunk, "kind" | "nodeType" | "symbolName">> = {},
): Chunk {
  return {
    filePath: "src/fixture.ts",
    startLine,
    endLine: startLine + lines.length - 1,
    language: "typescript",
    content: lines.join("\n"),
    kind: extra.kind ?? "line",
    ...(extra.nodeType !== undefined ? { nodeType: extra.nodeType } : {}),
    ...(extra.symbolName !== undefined ? { symbolName: extra.symbolName } : {}),
  };
}

describe("rewindowForBudget", () => {
  it("passes a chunk through unchanged (same object) when it already fits", () => {
    const chunk = chunkOf(["one two", "three four"]);
    const out = rewindowForBudget([chunk], 100, wordCount);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(chunk);
  });

  it("returns an empty set for empty input", () => {
    expect(rewindowForBudget([], 100, wordCount)).toEqual([]);
  });

  it("rejects a non-positive budget with SIVRU-E1004", () => {
    expect(() => rewindowForBudget([], 0, wordCount)).toThrow(/SIVRU-E1004/);
    expect(() => rewindowForBudget([], -5, wordCount)).toThrow(/SIVRU-E1004/);
  });

  it("splits a dense over-budget chunk so every sub-chunk is within budget", () => {
    // 30 lines, 3 tokens each = 90 tokens; budget 20.
    const lines = Array.from({ length: 30 }, () => "alpha beta gamma");
    const out = rewindowForBudget([chunkOf(lines)], 20, wordCount);

    expect(out.length).toBeGreaterThan(1);
    for (const sub of out) {
      expect(wordCount(sub.content)).toBeLessThanOrEqual(20);
      expect(sub.content.length).toBeGreaterThan(0);
    }
  });

  it("preserves kind / nodeType / symbolName on every split sub-chunk", () => {
    const lines = Array.from({ length: 24 }, () => "tok tok tok tok");
    const out = rewindowForBudget(
      [
        chunkOf(lines, 1, {
          kind: "tree-sitter",
          nodeType: "function_declaration",
          symbolName: "processPayment",
        }),
      ],
      18,
      wordCount,
    );
    expect(out.length).toBeGreaterThan(1);
    for (const sub of out) {
      expect(sub.kind).toBe("tree-sitter");
      expect(sub.nodeType).toBe("function_declaration");
      expect(sub.symbolName).toBe("processPayment");
      expect(sub.filePath).toBe("src/fixture.ts");
      expect(sub.language).toBe("typescript");
    }
  });

  it("keeps full line coverage across the split sub-chunks", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i)} body`);
    const startLine = 7;
    const out = rewindowForBudget([chunkOf(lines, startLine)], 15, wordCount);

    const covered = new Set<number>();
    for (const sub of out) {
      expect(sub.startLine).toBeGreaterThanOrEqual(startLine);
      expect(sub.endLine).toBeLessThanOrEqual(startLine + lines.length - 1);
      for (let ln = sub.startLine; ln <= sub.endLine; ln++) covered.add(ln);
    }
    for (let ln = startLine; ln < startLine + lines.length; ln++) {
      expect(covered.has(ln)).toBe(true);
    }
  });

  it("char-splits an un-splittable single over-budget line (CRITICAL)", () => {
    // One physical line whose own token count alone exceeds the budget.
    const longLine = Array.from({ length: 100 }, () => "word").join(" ");
    const chunk = chunkOf([longLine], 12);
    const out = rewindowForBudget([chunk], 20, wordCount);

    // Forward progress: more than one piece, no stall, no empty chunk.
    expect(out.length).toBeGreaterThan(1);
    for (const sub of out) {
      // A char-split sub-chunk spans exactly one source line.
      expect(sub.startLine).toBe(12);
      expect(sub.endLine).toBe(12);
      expect(sub.content.length).toBeGreaterThan(0);
      expect(wordCount(sub.content)).toBeLessThanOrEqual(20);
    }
  });

  it("does not loop forever when several lines are individually over budget", () => {
    const huge = Array.from({ length: 60 }, () => "x").join(" ");
    const lines = [huge, "small", huge, "tiny line", huge];
    const out = rewindowForBudget([chunkOf(lines)], 10, wordCount);
    expect(out.length).toBeGreaterThan(0);
    for (const sub of out) {
      expect(wordCount(sub.content)).toBeLessThanOrEqual(10);
      expect(sub.content.length).toBeGreaterThan(0);
    }
  });

  it("seeds each window with trailing overlap lines within ~12% of the budget", () => {
    // 120 one-token lines, budget 50 → 12% overlap budget = 6 tokens.
    const lines = Array.from({ length: 120 }, () => "t");
    const budget = 50;
    const out = rewindowForBudget([chunkOf(lines)], budget, wordCount);
    const overlapBudget = Math.floor(budget * 0.12);

    expect(out.length).toBeGreaterThan(1);
    for (const sub of out) {
      // No window exceeds the budget — overlap included.
      expect(wordCount(sub.content)).toBeLessThanOrEqual(budget);
    }
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]!;
      const cur = out[i]!;
      // Adjacent windows overlap (or at worst abut); the shared trailing
      // lines never sum past the overlap budget.
      const sharedStart = cur.startLine;
      const sharedEnd = Math.min(prev.endLine, cur.endLine);
      if (sharedEnd >= sharedStart) {
        const overlapLineCount = sharedEnd - sharedStart + 1;
        // Each shared line is one token here.
        expect(overlapLineCount).toBeLessThanOrEqual(overlapBudget);
      }
      // The windower always advances — no two windows start at the same line.
      expect(cur.startLine).toBeGreaterThan(prev.startLine);
    }
  });
});

describe("byteHeuristicTokenCount", () => {
  it("is ceil(utf8Bytes / 3.5)", () => {
    expect(byteHeuristicTokenCount("")).toBe(0);
    expect(byteHeuristicTokenCount("xxxxxxx")).toBe(2); // 7 / 3.5
    expect(byteHeuristicTokenCount("x".repeat(35))).toBe(10);
  });

  it("counts utf8 bytes, not code units", () => {
    // "é" is 2 bytes in UTF-8 → ceil(2 / 3.5) = 1.
    expect(byteHeuristicTokenCount("é")).toBe(1);
  });

  it("drives windowing as the heuristic fallback counter", () => {
    const lines = Array.from({ length: 30 }, () => "x".repeat(40));
    const budget = 20;
    const out = rewindowForBudget([chunkOf(lines)], budget, byteHeuristicTokenCount);
    expect(out.length).toBeGreaterThan(1);
    for (const sub of out) {
      expect(byteHeuristicTokenCount(sub.content)).toBeLessThanOrEqual(budget);
    }
  });
});
