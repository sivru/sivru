// Per-language smoke + fence-edge tests for extractBlocks
// (DESIGN-0016 §3, T1, T2).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractBlocks, extractFences } from "./extract.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel: string): string =>
  resolve(here, "__fixtures__", rel);

describe("extractFences (line-based scan)", () => {
  it("returns empty when the text has no fence", () => {
    expect(extractFences("just a comment\n no fence here\n", 1)).toEqual([]);
  });

  it("extracts a single fence with YAML body", () => {
    const text = ["// @sivru", "// role: foo", "// @end"].join("\n");
    const out = extractFences(text, 10);
    expect(out).toHaveLength(1);
    expect(out[0]!.yamlText).toBe("role: foo");
    expect(out[0]!.startLine).toBe(10);
    expect(out[0]!.endLine).toBe(12);
  });

  it("preserves internal YAML indentation under `* ` prefix", () => {
    const text = [
      " * @sivru",
      " * decisions:",
      " *   - chose: x",
      " *     because: y",
      " * @end",
    ].join("\n");
    const out = extractFences(text, 1);
    expect(out).toHaveLength(1);
    // After stripping " * " (3 chars), the YAML content keeps its inner indent.
    expect(out[0]!.yamlText).toBe(
      ["decisions:", "  - chose: x", "    because: y"].join("\n"),
    );
  });

  it("marks an unclosed fence with `unclosed: true`", () => {
    const text = ["// @sivru", "// role: foo"].join("\n");
    const out = extractFences(text, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.unclosed).toBe(true);
  });

  it("extracts multiple fences in a single comment", () => {
    const text = [
      "// @sivru",
      "// role: a",
      "// @end",
      "//",
      "// @sivru",
      "// role: b",
      "// @end",
    ].join("\n");
    const out = extractFences(text, 1);
    expect(out).toHaveLength(2);
    expect(out[0]!.yamlText).toBe("role: a");
    expect(out[1]!.yamlText).toBe("role: b");
  });

  it("does not match `@end` when it appears mid-line (YAML string)", () => {
    const text = [
      " * @sivru",
      " * decisions:",
      " *   - revisit-if: 'token reaches @end of life'",
      " * @end",
    ].join("\n");
    const out = extractFences(text, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.yamlText).toContain("revisit-if: 'token reaches @end of life'");
  });
});

describe("extractBlocks — per-language smoke", () => {
  it("extracts a TS per-symbol block", async () => {
    const out = await extractBlocks(fixture("per-language/ts/symbol-block.ts"));
    expect(out).toHaveLength(1);
    const b = out[0]!;
    expect(b.kind).toBe("symbol");
    expect(b.symbolName).toBe("resolveRoute");
    expect(b.block?.role).toBe("routing-brain");
    expect(b.block?.maturity).toBe("stable");
    expect(b.block?.decisions).toHaveLength(1);
    expect(b.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("extracts a JS per-symbol block", async () => {
    const out = await extractBlocks(fixture("per-language/js/symbol-block.js"));
    expect(out).toHaveLength(1);
    expect(out[0]!.block?.role).toBe("routing-brain");
  });

  it("extracts a Java per-symbol block", async () => {
    const out = await extractBlocks(
      fixture("per-language/java/SymbolBlock.java"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.block?.role).toBe("routing-brain");
  });

  it("extracts a Go per-symbol block", async () => {
    const out = await extractBlocks(fixture("per-language/go/symbol_block.go"));
    expect(out).toHaveLength(1);
    expect(out[0]!.block?.role).toBe("routing-brain");
    expect(out[0]!.symbolName).toBe("ResolveRoute");
  });

  it("extracts a Python per-symbol docstring block", async () => {
    const out = await extractBlocks(
      fixture("per-language/python/symbol_block.py"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("symbol");
    expect(out[0]!.symbolName).toBe("resolve_route");
    expect(out[0]!.block?.role).toBe("routing-brain");
  });
});

describe("extractBlocks — module-level", () => {
  it("extracts a Python module docstring as kind:module", async () => {
    const out = await extractBlocks(
      fixture("module-level/python/__init__.py"),
    );
    const moduleBlocks = out.filter((b) => b.kind === "module");
    expect(moduleBlocks).toHaveLength(1);
    expect(moduleBlocks[0]!.block?.role).toBe("package-root");
  });

  it("extracts a TS top-of-file comment as kind:module", async () => {
    const out = await extractBlocks(
      fixture("module-level/typescript/src/index.ts"),
    );
    const moduleBlocks = out.filter((b) => b.kind === "module");
    expect(moduleBlocks).toHaveLength(1);
    expect(moduleBlocks[0]!.block?.role).toBe("package-root");
  });
});

describe("extractBlocks — fence edges (T1)", () => {
  it("an unclosed fence becomes SIVRU-E215 with block:null (not silently dropped)", async () => {
    const out = await extractBlocks(fixture("fence-edges/unclosed.ts"));
    expect(out).toHaveLength(1);
    expect(out[0]!.block).toBeNull();
    expect(out[0]!.diagnostics.map((d) => d.code)).toContain("SIVRU-E215");
  });

  it("multiple fences in one comment both extract", async () => {
    const out = await extractBlocks(fixture("fence-edges/multi.ts"));
    // Both should attach to the same following symbol.
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.block?.role).sort()).toEqual([
      "first-block",
      "second-block",
    ]);
  });

  it("`@end` inside a YAML string value does NOT close the fence early", async () => {
    const out = await extractBlocks(fixture("fence-edges/end-in-string.ts"));
    expect(out).toHaveLength(1);
    expect(out[0]!.block?.role).toBe("lifecycle-watcher");
    expect(out[0]!.block?.decisions?.[0]?.["revisit-if"]).toBe(
      "token reaches @end of life",
    );
  });

  it("whitespace-only-indented `@sivru`/`@end` after prefix strip still match", async () => {
    const out = await extractBlocks(fixture("fence-edges/whitespace.ts"));
    expect(out).toHaveLength(1);
    expect(out[0]!.block?.role).toBe("ws-tolerant");
  });
});

describe("extractBlocks — CRLF tolerance (Windows checkout)", () => {
  it("normalises CRLF content so the fence regex matches", async () => {
    const lf = [
      "/**",
      " * @sivru",
      " * schema: 1",
      " * role: crlf-tolerant",
      " * responsibility: parses cleanly even with windows line endings",
      " * @end",
      " */",
      "export function fn(): void {}",
    ].join("\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    const out = await extractBlocks("/tmp/crlf-test.ts", {
      content: crlf,
      language: "typescript",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.block?.role).toBe("crlf-tolerant");
    expect(out[0]!.symbolName).toBe("fn");
  });
});

describe("extractBlocks — non-chunkable file types", () => {
  it("returns empty for an unknown file extension", async () => {
    const out = await extractBlocks("/tmp/nonexistent.foobar", {
      content: "garbage",
      language: undefined,
    });
    expect(out).toEqual([]);
  });
});
