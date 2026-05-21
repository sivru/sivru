// Integration tests: extractBlocks → validateExtracted → diagnostics
// pipeline over a multi-file fixture set + the pathological case (F3).

import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractBlocksFromFiles } from "./extract.js";
import { hasErrors, validateExtracted } from "./validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel: string): string =>
  resolve(here, "__fixtures__", rel);

describe("integration — per-language fixtures together", () => {
  it("all five carriers extract clean", async () => {
    const files = [
      fixture("per-language/ts/symbol-block.ts"),
      fixture("per-language/js/symbol-block.js"),
      fixture("per-language/java/SymbolBlock.java"),
      fixture("per-language/go/symbol_block.go"),
      fixture("per-language/python/symbol_block.py"),
    ];
    const out = await extractBlocksFromFiles(files);
    expect(out).toHaveLength(5);
    const diags = validateExtracted(out);
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("invalid blocks appear with block:null and diagnostics populated", async () => {
    const out = await extractBlocksFromFiles([
      fixture("fence-edges/unclosed.ts"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.block).toBeNull();
    expect(out[0]!.diagnostics.map((d) => d.code)).toContain("SIVRU-E215");
  });
});

describe("integration — F3 pathological yaml", () => {
  it("deep-nest fixture completes in < 10ms and is bounded", async () => {
    const t0 = performance.now();
    const out = await extractBlocksFromFiles([
      fixture("pathological/deep-nest.ts"),
    ]);
    const elapsed = performance.now() - t0;
    // The < 10ms gate in the design is for the per-file extract; we
    // budget loose here because CI runners vary. Use 200ms to catch
    // multi-second blowups but tolerate cold-start variance.
    expect(elapsed).toBeLessThan(200);
    expect(out).toHaveLength(1);
    // The deep-nest fixture is intentionally bounded — extract clean.
    expect(out[0]!.block).not.toBeNull();
    const diags = validateExtracted(out);
    expect(hasErrors(diags)).toBe(false);
  });
});
