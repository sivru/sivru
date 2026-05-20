import { describe, expect, it } from "vitest";

import { assembleDiffArtifact, parseRemovedSymbols } from "./diff.js";
import { createSymbolIndexFromEntries } from "./cache.js";
import type {
  ExplainOptions,
  SymbolIndex,
  SymbolIndexEntry,
} from "./types.js";

function mkExport(name: string, startLine = 1, endLine = 5) {
  return {
    name,
    kind: "function" as const,
    startLine,
    endLine,
    signature: `export function ${name}()`,
  };
}

function mkIndex(entries: SymbolIndexEntry[]): SymbolIndex {
  const m = new Map<string, SymbolIndexEntry>();
  for (const e of entries) m.set(e.filePath, e);
  return createSymbolIndexFromEntries("/fake/repo", "state-1", m);
}

const noopGit = async () => "";
const noTests = () => false;
const noRead = () => undefined;

describe("parseRemovedSymbols", () => {
  it("detects a removed function declaration", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,1 @@",
      "-export function alpha() { return 1; }",
      "-export function beta() { return 2; }",
      " export function gamma() { return 3; }",
    ].join("\n");
    const out = parseRemovedSymbols(diff);
    expect(out.sort()).toEqual(["alpha", "beta"]);
  });

  it("does not detect a symbol appearing only in an added line", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-const x = 1;",
      "+export function newSym() { return 1; }",
    ].join("\n");
    // newSym was added, not removed — must not appear in the report.
    const out = parseRemovedSymbols(diff);
    expect(out).not.toContain("newSym");
  });

  it("does not flag identifier appearances inside string literals (heuristic-bounded)", () => {
    // A removed `console.log("alpha")` line doesn't match the declaration
    // regex, so `alpha` stays unflagged even though the literal mentions it.
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      `-console.log("alpha");`,
    ].join("\n");
    const out = parseRemovedSymbols(diff);
    expect(out).toEqual([]);
  });

  it("detects a removed const-arrow style declaration", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,0 @@",
      "-export const helper = () => 1;",
    ].join("\n");
    const out = parseRemovedSymbols(diff);
    expect(out).toEqual(["helper"]);
  });

  it("ignores the symbol when only header/context lines mention it", () => {
    const diff = [
      "--- a/src/alpha.ts", // path contains 'alpha' — must NOT trigger
      "+++ b/src/alpha.ts",
      "@@ -10,1 +10,1 @@",
      "-const unrelated = 1;",
      "+const unrelated = 2;",
    ].join("\n");
    const out = parseRemovedSymbols(diff);
    expect(out).toEqual([]);
  });

  it("does not flag a symbol that is re-declared on the plus side (rewrite case)", () => {
    // git diff for a full-file rewrite where beta survives but alpha is dropped.
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,1 @@",
      "-export function alpha() { return 1; }",
      "-export function beta() { return 2; }",
      "+export function beta() { return 2; }",
    ].join("\n");
    const out = parseRemovedSymbols(diff);
    expect(out).toEqual(["alpha"]);
  });

  it("respects the optional `candidateNames` filter", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,0 @@",
      "-export function alpha() {}",
      "-export function beta() {}",
    ].join("\n");
    const out = parseRemovedSymbols(diff, [mkExport("alpha")]);
    expect(out).toEqual(["alpha"]);
  });
});

describe("assembleDiffArtifact", () => {
  function baseOpts(over: Partial<ExplainOptions> = {}): ExplainOptions {
    return { repoRoot: "/fake/repo", target: "src/foo.ts", ...over };
  }

  it("emits diff_mode + removed_symbols with caller analysis per removal", async () => {
    const target: SymbolIndexEntry = {
      filePath: "src/foo.ts",
      language: "typescript",
      exports: [mkExport("alpha"), mkExport("beta")],
      imports: [],
      commitCount: 0,
      mtimeMs: 1,
    };
    const caller: SymbolIndexEntry = {
      filePath: "src/uses.ts",
      language: "typescript",
      exports: [],
      imports: [
        {
          raw: `import { alpha } from "./foo"`,
          resolved: "src/foo.ts",
          identifiers: ["alpha"],
        },
      ],
      commitCount: 0,
      mtimeMs: 1,
    };
    const idx = mkIndex([target, caller]);
    const gitDiff = async () =>
      [
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1,3 +1,1 @@",
        "-export function alpha() { return 1; }",
        " export function beta() { return 2; }",
      ].join("\n");
    const art = await assembleDiffArtifact(baseOpts(), idx, {
      gitDiff,
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.diff_mode).toBe(true);
    expect(art.removed_symbols).toHaveLength(1);
    const removed = art.removed_symbols![0]!;
    expect(removed.symbol).toBe("alpha");
    expect(removed.callers.map((c) => c.filePath)).toEqual(["src/uses.ts"]);
    // File-level fields still present.
    expect(art.public_api.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("returns an empty removed_symbols list when the diff is clean", async () => {
    const target: SymbolIndexEntry = {
      filePath: "src/foo.ts",
      language: "typescript",
      exports: [mkExport("alpha")],
      imports: [],
      commitCount: 0,
      mtimeMs: 1,
    };
    const idx = mkIndex([target]);
    const art = await assembleDiffArtifact(baseOpts(), idx, {
      gitDiff: async () => "",
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.diff_mode).toBe(true);
    expect(art.removed_symbols).toEqual([]);
  });
});
