// `authored` field reconciliation gate (DESIGN-0004 A1 / T20).
//
// v0.5 emits `authored: []` unconditionally — the field is a prepay slot
// for v0.6 (DESIGN-0016), which will reconcile `@sivru`-block annotations
// with the resolver-derived call graph. Locking the v0.5 invariant here
// keeps the on-the-wire contract stable: downstream consumers can already
// destructure `artifact.authored` without crashing on missing field, and
// the eventual v0.6 fill won't be a breaking schema change.

import { describe, expect, it } from "vitest";

import { assembleArtifact } from "./artifact.js";
import { createSymbolIndexFromEntries } from "./cache.js";
import type { ExplainOptions, SymbolIndexEntry } from "./types.js";

function makeIndex(entries: SymbolIndexEntry[]) {
  const m = new Map<string, SymbolIndexEntry>();
  for (const e of entries) m.set(e.filePath, e);
  return createSymbolIndexFromEntries("/fake/repo", "state-1", m);
}

function baseOpts(over: Partial<ExplainOptions> = {}): ExplainOptions {
  return { repoRoot: "/fake/repo", target: "src/foo.ts", ...over };
}

const noopGit = async () => "";

describe("authored field reconciliation gate (v0.5)", () => {
  it("file-level artifacts emit `authored: []`", async () => {
    const idx = makeIndex([
      {
        filePath: "src/foo.ts",
        language: "typescript",
        exports: [
          {
            name: "foo",
            kind: "function",
            startLine: 1,
            endLine: 1,
            signature: "export function foo()",
          },
        ],
        imports: [],
        commitCount: 0,
        mtimeMs: 1,
      },
    ]);
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: () => false,
      readSyncOrUndef: () => undefined,
    });
    expect(art.authored).toEqual([]);
  });

  it("region-level artifacts also emit `authored: []`", async () => {
    const idx = makeIndex([
      {
        filePath: "src/foo.ts",
        language: "typescript",
        exports: [
          {
            name: "foo",
            kind: "function",
            startLine: 10,
            endLine: 20,
            signature: "export function foo()",
          },
        ],
        imports: [],
        commitCount: 0,
        mtimeMs: 1,
      },
    ]);
    const art = await assembleArtifact(baseOpts({ symbol: "foo" }), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: () => false,
      readSyncOrUndef: () => undefined,
    });
    expect(art.authored).toEqual([]);
  });
});
