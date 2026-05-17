import { describe, expect, it } from "vitest";
import { lineFallbackChunks, windowLines } from "./lineFallback.js";

const filePath = "src/example.ts";

describe("lineFallbackChunks", () => {
  it("returns no chunks for empty content", () => {
    expect(lineFallbackChunks(filePath, "", "typescript")).toEqual([]);
  });

  it("returns no chunks for content that is just a trailing newline", () => {
    expect(lineFallbackChunks(filePath, "\n", "typescript")).toEqual([]);
  });

  it("emits one chunk for a file shorter than maxLines", () => {
    const content = "line1\nline2\nline3";
    const chunks = lineFallbackChunks(filePath, content, "typescript");
    expect(chunks).toEqual([
      {
        filePath,
        startLine: 1,
        endLine: 3,
        language: "typescript",
        content: "line1\nline2\nline3",
        kind: "line",
      },
    ]);
  });

  it("emits one chunk that is exactly maxLines long", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `l${i + 1}`);
    const content = lines.join("\n");
    const chunks = lineFallbackChunks(filePath, content, "typescript");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(50);
  });

  it("emits overlapping windows when content exceeds maxLines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `l${i + 1}`);
    const content = lines.join("\n");
    const chunks = lineFallbackChunks(filePath, content, "typescript");
    // step = 50 - 5 = 45 → starts at 1, 46, 91 → 3 chunks
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(50);
    expect(chunks[1]?.startLine).toBe(46);
    expect(chunks[1]?.endLine).toBe(95);
    expect(chunks[2]?.startLine).toBe(91);
    expect(chunks[2]?.endLine).toBe(100);
  });

  it("respects custom maxLines + overlap", () => {
    const lines = Array.from({ length: 11 }, (_, i) => `l${i + 1}`);
    const content = lines.join("\n");
    const chunks = lineFallbackChunks(filePath, content, null, {
      maxLines: 5,
      overlapLines: 1,
    });
    // step = 4 → starts at 1, 5, 9 → 3 chunks (1-5, 5-9, 9-11)
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(5);
    expect(chunks[1]?.startLine).toBe(5);
    expect(chunks[1]?.endLine).toBe(9);
    expect(chunks[2]?.startLine).toBe(9);
    expect(chunks[2]?.endLine).toBe(11);
  });

  it("rejects invalid window/overlap combinations", () => {
    expect(() => lineFallbackChunks(filePath, "x", null, { maxLines: 0 })).toThrow();
    expect(() =>
      lineFallbackChunks(filePath, "x", null, { maxLines: 5, overlapLines: 5 }),
    ).toThrow();
    expect(() =>
      lineFallbackChunks(filePath, "x", null, { maxLines: 5, overlapLines: -1 }),
    ).toThrow();
  });

  it("preserves the language label and chunk kind in every chunk", () => {
    const chunks = lineFallbackChunks(
      filePath,
      "a\nb\nc",
      "python",
    );
    for (const chunk of chunks) {
      expect(chunk.language).toBe("python");
      expect(chunk.kind).toBe("line");
    }
  });
});

describe("windowLines", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);

  it("windows a sub-range with absolute 1-based line numbers", () => {
    const chunks = windowLines(lines, filePath, "go", 10, 14, 50, 5);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startLine).toBe(10);
    expect(chunks[0]?.endLine).toBe(14);
    expect(chunks[0]?.content).toBe("l10\nl11\nl12\nl13\nl14");
    expect(chunks[0]?.kind).toBe("line");
    expect(chunks[0]?.language).toBe("go");
  });

  it("returns [] for an empty range (from > to)", () => {
    expect(windowLines(lines, filePath, null, 12, 11, 50, 5)).toEqual([]);
  });

  it("splits a sub-range longer than maxLines into overlapping windows", () => {
    // Range 1..30, maxLines 10, overlap 2 → step 8 → starts 1, 9, 17, 25.
    const chunks = windowLines(lines, filePath, null, 1, 30, 10, 2);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 10],
      [9, 18],
      [17, 26],
      [25, 30],
    ]);
  });

  it("covers every line of the windowed range", () => {
    const chunks = windowLines(lines, filePath, null, 4, 27, 7, 1);
    const covered = new Set<number>();
    for (const c of chunks) {
      for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
    }
    for (let l = 4; l <= 27; l++) expect(covered.has(l)).toBe(true);
  });

  it("rejects invalid window/overlap combinations", () => {
    expect(() => windowLines(lines, filePath, null, 1, 5, 0, 0)).toThrow();
    expect(() => windowLines(lines, filePath, null, 1, 5, 5, 5)).toThrow();
  });
});
