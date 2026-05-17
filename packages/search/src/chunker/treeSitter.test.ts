import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Chunk } from "../types.js";
import { buildIndex } from "../search.js";
import { treeSitterChunks } from "./treeSitter.js";

const fixturesDir = fileURLToPath(new URL("./__fixtures__", import.meta.url));

function fixture(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url)), "utf8");
}

/** Line count the chunker sees (trailing newline dropped, as the chunker does). */
function lineCount(content: string): number {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** Every source line must be covered by at least one chunk — no silent drops. */
function expectFullCoverage(chunks: Chunk[], content: string): void {
  const total = lineCount(content);
  const covered = new Set<number>();
  for (const c of chunks) {
    for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
  }
  for (let l = 1; l <= total; l++) {
    expect(covered.has(l), `line ${l} of ${total} is not covered by any chunk`).toBe(true);
  }
}

/** Node chunks for distinct symbols must not overlap each other. */
function expectNoNodeOverlap(chunks: Chunk[]): void {
  const nodeChunks = chunks
    .filter((c) => c.kind === "tree-sitter")
    .sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < nodeChunks.length; i++) {
    const prev = nodeChunks[i - 1]!;
    const cur = nodeChunks[i]!;
    // Sub-chunks of one oversized node share a symbolName and may abut;
    // only flag overlap between chunks of *different* symbols.
    if (prev.symbolName !== undefined && prev.symbolName === cur.symbolName) continue;
    expect(
      cur.startLine,
      `node chunks overlap: ${prev.symbolName ?? "?"} ends ${prev.endLine}, ${cur.symbolName ?? "?"} starts ${cur.startLine}`,
    ).toBeGreaterThan(prev.endLine);
  }
}

function symbols(chunks: Chunk[]): Array<{ name: string; type: string }> {
  return chunks
    .filter((c) => c.kind === "tree-sitter" && c.symbolName !== undefined)
    .map((c) => ({ name: c.symbolName!, type: c.nodeType ?? "" }));
}

describe("treeSitterChunks — per-grammar fixtures", () => {
  it("typescript: functions, interfaces, methods, arrow consts", async () => {
    const src = fixture("typescript/sample.ts");
    const chunks = await treeSitterChunks("sample.ts", src, "typescript");
    const syms = symbols(chunks);
    expect(syms).toContainEqual({ name: "fetchUser", type: "function_declaration" });
    expect(syms).toContainEqual({ name: "User", type: "interface_declaration" });
    expect(syms).toContainEqual({ name: "get", type: "method_definition" });
    expect(syms).toContainEqual({ name: "set", type: "method_definition" });
    expect(syms).toContainEqual({ name: "makeHandler", type: "lexical_declaration" });
    // `const DEFAULT_LIMIT = 10` is not a function — never its own node chunk.
    expect(syms.find((s) => s.name === "DEFAULT_LIMIT")).toBeUndefined();
    // The container class itself is not a chunk — its methods are.
    expect(syms.find((s) => s.type === "class_declaration")).toBeUndefined();
    expectFullCoverage(chunks, src);
    expectNoNodeOverlap(chunks);
  });

  it("javascript: functions, arrow consts, class methods", async () => {
    const src = fixture("javascript/sample.js");
    const chunks = await treeSitterChunks("sample.js", src, "javascript");
    const syms = symbols(chunks);
    expect(syms).toContainEqual({ name: "area", type: "function_declaration" });
    expect(syms).toContainEqual({ name: "square", type: "lexical_declaration" });
    expect(syms.some((s) => s.name === "describe" && s.type === "method_definition")).toBe(true);
    expect(syms.find((s) => s.name === "PI")).toBeUndefined();
    expectFullCoverage(chunks, src);
    expectNoNodeOverlap(chunks);
  });

  it("python: functions and class methods", async () => {
    const src = fixture("python/sample.py");
    const chunks = await treeSitterChunks("sample.py", src, "python");
    const syms = symbols(chunks);
    expect(syms).toContainEqual({ name: "fetch_user", type: "function_definition" });
    expect(syms.some((s) => s.name === "get" && s.type === "function_definition")).toBe(true);
    expect(syms.some((s) => s.name === "__init__")).toBe(true);
    expect(syms.find((s) => s.type === "class_definition")).toBeUndefined();
    expectFullCoverage(chunks, src);
    expectNoNodeOverlap(chunks);
  });

  it("go: functions, methods, type declarations", async () => {
    const src = fixture("go/sample.go");
    const chunks = await treeSitterChunks("sample.go", src, "go");
    const syms = symbols(chunks);
    expect(syms).toContainEqual({ name: "FetchUser", type: "function_declaration" });
    expect(syms).toContainEqual({ name: "Greet", type: "method_declaration" });
    expect(syms.some((s) => s.name === "User" && s.type === "type_declaration")).toBe(true);
    expectFullCoverage(chunks, src);
    expectNoNodeOverlap(chunks);
  });

  it("java: constructors and methods inside a container class", async () => {
    const src = fixture("java/Sample.java");
    const chunks = await treeSitterChunks("Sample.java", src, "java");
    const syms = symbols(chunks);
    expect(syms.some((s) => s.type === "method_declaration" && s.name === "get")).toBe(true);
    expect(syms.some((s) => s.type === "method_declaration" && s.name === "set")).toBe(true);
    expect(syms.some((s) => s.type === "constructor_declaration")).toBe(true);
    // The class is a container — descended into, not chunked whole.
    expect(syms.find((s) => s.type === "class_declaration")).toBeUndefined();
    expectFullCoverage(chunks, src);
    expectNoNodeOverlap(chunks);
  });
});

describe("treeSitterChunks — doc-comment attachment", () => {
  it("includes a leading block comment in the symbol's chunk", async () => {
    const src = [
      "const x = 1;", // 1
      "", // 2
      "/**", // 3
      " * Doubles n.", // 4
      " */", // 5
      "function double(n) {", // 6
      "  return n * 2;", // 7
      "}", // 8
    ].join("\n");
    const chunks = await treeSitterChunks("d.ts", src, "typescript");
    const fn = chunks.find((c) => c.symbolName === "double");
    expect(fn).toBeDefined();
    expect(fn!.startLine).toBe(3); // pulled up to the start of the comment
    expect(fn!.endLine).toBe(8);
    expect(fn!.content).toContain("Doubles n.");
  });

  it("includes contiguous line comments above the symbol", async () => {
    const src = [
      "// first line", // 1
      "// second line", // 2
      "function f() {", // 3
      "  return 1;", // 4
      "}", // 5
    ].join("\n");
    const chunks = await treeSitterChunks("d.ts", src, "typescript");
    const fn = chunks.find((c) => c.symbolName === "f");
    expect(fn!.startLine).toBe(1);
  });

  it("does NOT attach a license header separated by a blank line", async () => {
    const src = [
      "// Copyright 2026 Example Corp.", // 1
      "// SPDX-License-Identifier: MIT", // 2
      "", // 3  <- blank line detaches the header
      "function f() {", // 4
      "  return 1;", // 5
      "}", // 6
    ].join("\n");
    const chunks = await treeSitterChunks("d.ts", src, "typescript");
    const fn = chunks.find((c) => c.symbolName === "f");
    expect(fn!.startLine).toBe(4); // header is NOT pulled in
    expect(fn!.content).not.toContain("Copyright");
  });
});

describe("treeSitterChunks — lexical_declaration predicate", () => {
  it("chunks arrow/function consts but not value consts", async () => {
    const src = [
      "const NUMBER = 42;",
      "const re = /abc/;",
      "const arrow = () => 1;",
      "const fn = function () { return 2; };",
    ].join("\n");
    const chunks = await treeSitterChunks("p.ts", src, "typescript");
    const syms = symbols(chunks).map((s) => s.name);
    expect(syms).toContain("arrow");
    expect(syms).toContain("fn");
    expect(syms).not.toContain("NUMBER");
    expect(syms).not.toContain("re");
  });
});

describe("treeSitterChunks — gap-fill coverage", () => {
  it("covers a file that is mostly top-level code", async () => {
    const src = [
      'import os', // 1
      'import sys', // 2
      'CONFIG = {"a": 1}', // 3
      'PATHS = []', // 4
      'for p in sys.argv:', // 5
      '    PATHS.append(p)', // 6
      'print(CONFIG)', // 7
    ].join("\n");
    const chunks = await treeSitterChunks("script.py", src, "python");
    // No functions or classes — every line is gap-filled, none dropped.
    expect(chunks.every((c) => c.kind === "line")).toBe(true);
    expectFullCoverage(chunks, src);
  });

  it("covers the blank lines and statements around definitions", async () => {
    const src = fixture("typescript/sample.ts");
    const chunks = await treeSitterChunks("sample.ts", src, "typescript");
    expect(chunks.some((c) => c.kind === "line")).toBe(true);
    expect(chunks.some((c) => c.kind === "tree-sitter")).toBe(true);
    expectFullCoverage(chunks, src);
  });
});

describe("treeSitterChunks — oversized node cap", () => {
  it("splits a node longer than the cap, preserving symbol identity", async () => {
    const body = Array.from({ length: 320 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const src = `function huge() {\n${body}\n  return 0;\n}\n`;
    const chunks = await treeSitterChunks("big.ts", src, "typescript");
    const hugeChunks = chunks.filter((c) => c.symbolName === "huge");
    expect(hugeChunks.length).toBeGreaterThan(1); // it was split
    for (const c of hugeChunks) {
      expect(c.kind).toBe("tree-sitter");
      expect(c.nodeType).toBe("function_declaration");
      expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(200);
    }
    expectFullCoverage(chunks, src);
  });
});

describe("treeSitterChunks — edge cases", () => {
  it("returns [] for empty content", async () => {
    expect(await treeSitterChunks("e.ts", "", "typescript")).toEqual([]);
  });

  it("returns [] for whitespace-only content", async () => {
    expect(await treeSitterChunks("e.ts", "\n\n\n", "typescript")).toEqual([]);
  });

  it("parses tsx without error", async () => {
    const src = "export const App = () => <div className=\"x\">hi</div>;\n";
    const chunks = await treeSitterChunks("App.tsx", src, "tsx");
    expect(chunks.some((c) => c.symbolName === "App")).toBe(true);
  });

  it("parses jsx (via the JavaScript grammar)", async () => {
    const src = [
      "function Button(props) {", // 1
      "  const label = props.label;", // 2
      "  return <button onClick={props.onClick}>{label}</button>;", // 3
      "}", // 4
    ].join("\n");
    const chunks = await treeSitterChunks("Button.jsx", src, "jsx");
    expect(
      chunks.some(
        (c) => c.kind === "tree-sitter" && c.symbolName === "Button" &&
          c.nodeType === "function_declaration",
      ),
    ).toBe(true);
  });
});

describe("buildIndex integration — tree-sitter chunks reach search results", () => {
  it("indexes the mixed-language fixture tree end to end", async () => {
    const index = await buildIndex(fixturesDir);
    const hits = await index.searchBM25("fetch a user record by id", 10);
    expect(hits.length).toBeGreaterThan(0);
    // A tree-sitter node chunk, carrying its symbol identity, ranks for the query.
    expect(
      hits.some((h) => h.chunk.kind === "tree-sitter" && h.chunk.symbolName === "fetchUser"),
    ).toBe(true);
  });

  it("carries nodeType + symbolName through to Python and Go results", async () => {
    const index = await buildIndex(fixturesDir);
    const py = await index.searchBM25("fetch_user store get", 10);
    expect(
      py.some((h) => h.chunk.language === "python" && h.chunk.symbolName === "fetch_user"),
    ).toBe(true);
    const go = await index.searchBM25("FetchUser Greet user", 10);
    expect(
      go.some(
        (h) =>
          h.chunk.language === "go" &&
          h.chunk.kind === "tree-sitter" &&
          h.chunk.nodeType !== undefined,
      ),
    ).toBe(true);
  });
});
