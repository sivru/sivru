import { describe, expect, it } from "vitest";
import { lineFallbackChunks } from "./lineFallback.js";

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
