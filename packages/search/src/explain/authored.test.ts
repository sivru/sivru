// `authored` field reconciliation gate
// (DESIGN-0004 A1 / T20 — extended at v0.6 per DESIGN-0016).
//
// v0.5 emitted `authored: []` unconditionally — a prepay slot for the
// v0.6 fill. v0.6 fills the slot from `@sivru` annotation blocks
// extracted from the target file. The on-the-wire contract stays
// stable: `Array.isArray(artifact.authored) === true` always holds;
// v0.6 just adds content when the file has blocks.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assembleArtifact } from "./artifact.js";
import { createSymbolIndexFromEntries } from "./cache.js";
import type { ExplainOptions, SymbolIndexEntry } from "./types.js";

function makeIndex(repoRoot: string, entries: SymbolIndexEntry[]) {
  const m = new Map<string, SymbolIndexEntry>();
  for (const e of entries) m.set(e.filePath, e);
  return createSymbolIndexFromEntries(repoRoot, "state-1", m);
}

const noopGit = async () => "";

const created: string[] = [];

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sivru-authored-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(abs.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("authored field — v0.6 fill (DESIGN-0016)", () => {
  it("file-level artifacts include every block in the file", async () => {
    const dir = mkRepo({
      "src/foo.ts": [
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: routing-brain",
        " * responsibility: route messages",
        " * @end",
        " */",
        "export function foo(): void {}",
      ].join("\n"),
    });
    const idx = makeIndex(dir, [
      {
        filePath: "src/foo.ts",
        language: "typescript",
        exports: [
          {
            name: "foo",
            kind: "function",
            startLine: 8,
            endLine: 8,
            signature: "export function foo()",
          },
        ],
        imports: [],
        commitCount: 0,
        mtimeMs: 1,
      },
    ]);
    const art = await assembleArtifact(
      { repoRoot: dir, target: "src/foo.ts" } as ExplainOptions,
      idx,
      {
        gitLog: noopGit,
        gitShortlog: noopGit,
        fileExists: () => false,
        readSyncOrUndef: () => undefined,
      },
    );
    expect(Array.isArray(art.authored)).toBe(true);
    expect(art.authored).toHaveLength(1);
    expect(art.authored[0]!.symbol).toBe("foo");
    expect(art.authored[0]!.block?.role).toBe("routing-brain");
    // A well-formed block produces no health diagnostics (DESIGN-0017 §2).
    expect(art.blocks_health).toEqual([]);
  });

  it("region-level artifacts filter to the region's symbol", async () => {
    const dir = mkRepo({
      "src/foo.ts": [
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: alpha-role",
        " * responsibility: a",
        " * @end",
        " */",
        "export function alpha(): void {}",
        "",
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: beta-role",
        " * responsibility: b",
        " * @end",
        " */",
        "export function beta(): void {}",
      ].join("\n"),
    });
    const idx = makeIndex(dir, [
      {
        filePath: "src/foo.ts",
        language: "typescript",
        exports: [
          {
            name: "alpha",
            kind: "function",
            startLine: 8,
            endLine: 8,
            signature: "export function alpha()",
          },
          {
            name: "beta",
            kind: "function",
            startLine: 17,
            endLine: 17,
            signature: "export function beta()",
          },
        ],
        imports: [],
        commitCount: 0,
        mtimeMs: 1,
      },
    ]);
    const art = await assembleArtifact(
      { repoRoot: dir, target: "src/foo.ts", symbol: "beta" } as ExplainOptions,
      idx,
      {
        gitLog: noopGit,
        gitShortlog: noopGit,
        fileExists: () => false,
        readSyncOrUndef: () => undefined,
      },
    );
    expect(art.authored).toHaveLength(1);
    expect(art.authored[0]!.symbol).toBe("beta");
    expect(art.authored[0]!.block?.role).toBe("beta-role");
  });

  it("returns [] when the file has no blocks (v0.5 invariant preserved)", async () => {
    const dir = mkRepo({
      "src/foo.ts": "export function foo(): void {}\n",
    });
    const idx = makeIndex(dir, [
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
    const art = await assembleArtifact(
      { repoRoot: dir, target: "src/foo.ts" } as ExplainOptions,
      idx,
      {
        gitLog: noopGit,
        gitShortlog: noopGit,
        fileExists: () => false,
        readSyncOrUndef: () => undefined,
      },
    );
    expect(art.authored).toEqual([]);
    expect(art.blocks_health).toEqual([]);
  });

  it("surfaces lint diagnostics for an incomplete block in blocks_health (DESIGN-0017 §2)", async () => {
    // `responsibility` is required; omitting it is a missing-required lint.
    // The block still parses, so it appears in `authored` — but the health
    // surface is what makes the gap visible instead of silently absent.
    const dir = mkRepo({
      "src/foo.ts": [
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: only-role",
        " * @end",
        " */",
        "export function foo(): void {}",
      ].join("\n"),
    });
    const idx = makeIndex(dir, [
      {
        filePath: "src/foo.ts",
        language: "typescript",
        exports: [
          {
            name: "foo",
            kind: "function",
            startLine: 7,
            endLine: 7,
            signature: "export function foo()",
          },
        ],
        imports: [],
        commitCount: 0,
        mtimeMs: 1,
      },
    ]);
    const art = await assembleArtifact(
      { repoRoot: dir, target: "src/foo.ts" } as ExplainOptions,
      idx,
      {
        gitLog: noopGit,
        gitShortlog: noopGit,
        fileExists: () => false,
        readSyncOrUndef: () => undefined,
      },
    );
    expect(art.blocks_health.length).toBeGreaterThan(0);
    expect(
      art.blocks_health.some((d) => d.message.includes("missing-required")),
    ).toBe(true);
  });

  it("region-level blocks_health is scoped to the region symbol (DESIGN-0017 §2)", async () => {
    // alpha carries a clean block; beta carries an incomplete one (missing
    // `responsibility`). A region explain on alpha must NOT leak beta's
    // diagnostic into blocks_health, and a region explain on beta must.
    const dir = mkRepo({
      "src/foo.ts": [
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: alpha-role",
        " * responsibility: a",
        " * @end",
        " */",
        "export function alpha(): void {}",
        "",
        "/**",
        " * @sivru",
        " * schema: 1",
        " * role: beta-role",
        " * @end",
        " */",
        "export function beta(): void {}",
      ].join("\n"),
    });
    const idx = makeIndex(dir, [
      {
        filePath: "src/foo.ts",
        language: "typescript",
        exports: [
          {
            name: "alpha",
            kind: "function",
            startLine: 8,
            endLine: 8,
            signature: "export function alpha()",
          },
          {
            name: "beta",
            kind: "function",
            startLine: 16,
            endLine: 16,
            signature: "export function beta()",
          },
        ],
        imports: [],
        commitCount: 0,
        mtimeMs: 1,
      },
    ]);
    const deps = {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: () => false,
      readSyncOrUndef: () => undefined,
    };

    const onAlpha = await assembleArtifact(
      { repoRoot: dir, target: "src/foo.ts", symbol: "alpha" } as ExplainOptions,
      idx,
      deps,
    );
    // alpha is clean and beta's diagnostic is out of region scope.
    expect(onAlpha.blocks_health).toEqual([]);

    const onBeta = await assembleArtifact(
      { repoRoot: dir, target: "src/foo.ts", symbol: "beta" } as ExplainOptions,
      idx,
      deps,
    );
    expect(
      onBeta.blocks_health.some((d) => d.message.includes("missing-required")),
    ).toBe(true);
  });
});
