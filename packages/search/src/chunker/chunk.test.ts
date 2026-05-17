import { describe, expect, it } from "vitest";

import { chunkFile } from "./chunk.js";

describe("chunkFile — facade routing", () => {
  it("returns a Promise", () => {
    const result = chunkFile("a.ts", "const x = 1;\n");
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it("routes a covered language through the tree-sitter chunker", async () => {
    const src = "export function add(a, b) {\n  return a + b;\n}\n";
    const chunks = await chunkFile("src/math.ts", src);
    expect(chunks.some((c) => c.kind === "tree-sitter" && c.symbolName === "add")).toBe(true);
  });

  it("falls back to line chunks for an uncovered language", async () => {
    const src = "fn main() {\n    println!(\"hi\");\n}\n";
    const chunks = await chunkFile("src/main.rs", src);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.kind === "line")).toBe(true);
  });

  it("falls back to line chunks for a file with no detectable language", async () => {
    const chunks = await chunkFile("README", "plain text\nmore text\n");
    expect(chunks.every((c) => c.kind === "line")).toBe(true);
  });

  it("returns [] for empty content", async () => {
    expect(await chunkFile("a.ts", "")).toEqual([]);
    expect(await chunkFile("a.rs", "")).toEqual([]);
  });

  it("indexes a malformed covered file gracefully (no throw, full coverage)", async () => {
    const src = "function broken(( {\n  const x =\n}\nclass\n";
    const chunks = await chunkFile("bad.ts", src);
    expect(chunks.length).toBeGreaterThan(0);
    const covered = new Set<number>();
    for (const c of chunks) {
      for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
    }
    for (let l = 1; l <= 4; l++) expect(covered.has(l)).toBe(true);
  });

  it("serves repeated calls for the same language (grammar memoised)", async () => {
    const a = await chunkFile("one.py", "def one():\n    return 1\n");
    const b = await chunkFile("two.py", "def two():\n    return 2\n");
    expect(a.some((c) => c.symbolName === "one")).toBe(true);
    expect(b.some((c) => c.symbolName === "two")).toBe(true);
  });
});
