import { describe, expect, it } from "vitest";

import { assembleArtifact, buildFooter } from "./artifact.js";
import { createSymbolIndexFromEntries } from "./cache.js";
import type {
  ExplainOptions,
  SymbolIndex,
  SymbolIndexEntry,
} from "./types.js";

function mkEntry(
  filePath: string,
  partial: Partial<SymbolIndexEntry> = {},
): SymbolIndexEntry {
  return {
    filePath,
    language: partial.language ?? "typescript",
    exports: partial.exports ?? [],
    imports: partial.imports ?? [],
    commitCount: partial.commitCount ?? 0,
    mtimeMs: partial.mtimeMs ?? 1,
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
const baseOpts = (overrides: Partial<ExplainOptions> = {}): ExplainOptions => ({
  repoRoot: "/fake/repo",
  target: "src/foo.ts",
  ...overrides,
});

describe("assembleArtifact: public_api", () => {
  it("copies the target's exports verbatim", async () => {
    const exports = [
      {
        name: "foo",
        kind: "function" as const,
        startLine: 1,
        endLine: 2,
        signature: "export function foo()",
      },
    ];
    const idx = mkIndex([mkEntry("src/foo.ts", { exports })]);
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.public_api).toEqual(exports);
  });

  it("returns an empty public_api when the target file is not indexed", async () => {
    const idx = mkIndex([]);
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.public_api).toEqual([]);
  });
});

describe("assembleArtifact: callees", () => {
  it("groups callees by resolved import path and dedupes identifiers", async () => {
    const idx = mkIndex([
      mkEntry("src/foo.ts", {
        imports: [
          {
            raw: `import { a } from "./bar"`,
            resolved: "src/bar.ts",
            identifiers: ["a"],
          },
          {
            raw: `import { b } from "./bar"`,
            resolved: "src/bar.ts",
            identifiers: ["b"],
          },
          {
            raw: `import { c } from "./baz"`,
            resolved: "src/baz.ts",
            identifiers: ["c"],
          },
        ],
      }),
      mkEntry("src/bar.ts"),
      mkEntry("src/baz.ts"),
    ]);
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.callees).toEqual([
      { filePath: "src/bar.ts", symbols: ["a", "b"] },
      { filePath: "src/baz.ts", symbols: ["c"] },
    ]);
  });

  it("drops unresolved imports and self-imports", async () => {
    const idx = mkIndex([
      mkEntry("src/foo.ts", {
        imports: [
          {
            raw: `import { x } from "react"`,
            resolved: null,
            identifiers: ["x"],
          },
          {
            raw: `import { y } from "./foo"`,
            resolved: "src/foo.ts",
            identifiers: ["y"],
          },
        ],
      }),
    ]);
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.callees).toEqual([]);
  });
});

describe("assembleArtifact: callers", () => {
  it("requires identifier overlap with the target's exports", async () => {
    const target = mkEntry("src/foo.ts", {
      exports: [
        {
          name: "doThing",
          kind: "function",
          startLine: 1,
          endLine: 1,
          signature: "export function doThing()",
        },
      ],
    });
    const idx = mkIndex([
      target,
      mkEntry("src/a.ts", {
        imports: [
          {
            raw: `import { doThing } from "./foo"`,
            resolved: "src/foo.ts",
            identifiers: ["doThing"],
          },
        ],
      }),
      mkEntry("src/b.ts", {
        imports: [
          {
            raw: `import { somethingElse } from "./foo"`,
            resolved: "src/foo.ts",
            identifiers: ["somethingElse"],
          },
        ],
      }),
    ]);
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.callers.map((c) => c.filePath)).toEqual(["src/a.ts"]);
    expect(art.callers[0]!.symbols).toEqual(["doThing"]);
  });

  it("sorts callers by commitCount ascending (D15)", async () => {
    const target = mkEntry("src/foo.ts", {
      exports: [
        {
          name: "doThing",
          kind: "function",
          startLine: 1,
          endLine: 1,
          signature: "export function doThing()",
        },
      ],
    });
    const callerHot = mkEntry("src/hot.ts", {
      commitCount: 50,
      imports: [
        {
          raw: `import { doThing } from "./foo"`,
          resolved: "src/foo.ts",
          identifiers: ["doThing"],
        },
      ],
    });
    const callerColder = mkEntry("src/cold.ts", {
      commitCount: 1,
      imports: [
        {
          raw: `import { doThing } from "./foo"`,
          resolved: "src/foo.ts",
          identifiers: ["doThing"],
        },
      ],
    });
    const idx = mkIndex([target, callerHot, callerColder]);
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.callers.map((c) => c.filePath)).toEqual([
      "src/cold.ts",
      "src/hot.ts",
    ]);
  });
});

describe("assembleArtifact: churn", () => {
  it("reads commit count + last commit ISO from `git log`", async () => {
    const idx = mkIndex([mkEntry("src/foo.ts", { commitCount: 99 })]);
    const gitLog = async () =>
      [
        "deadbeef 2026-05-01T12:00:00+00:00",
        "cafef00d 2026-04-30T10:00:00+00:00",
      ].join("\n");
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.churn.commitCount).toBe(2);
    expect(art.churn.lastCommitAt).toBe("2026-05-01T12:00:00+00:00");
    expect(art.churn.sinceDays).toBe(90);
  });

  it("falls back to the index's commitCount when git log returns nothing", async () => {
    const idx = mkIndex([mkEntry("src/foo.ts", { commitCount: 99 })]);
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.churn.commitCount).toBe(99);
    expect(art.churn.lastCommitAt).toBeNull();
  });
});

describe("assembleArtifact: ownership", () => {
  it("parses `git shortlog -ns` rows into percent + count", async () => {
    const idx = mkIndex([mkEntry("src/foo.ts")]);
    const gitShortlog = async () => "    5\tAlice\n    5\tBob\n";
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.ownership).toEqual([
      { author: "Alice", percent: 50, count: 5 },
      { author: "Bob", percent: 50, count: 5 },
    ]);
  });

  it("returns an empty list when git produces nothing", async () => {
    const idx = mkIndex([mkEntry("src/foo.ts")]);
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists: noTests,
      readSyncOrUndef: noRead,
    });
    expect(art.ownership).toEqual([]);
  });
});

describe("assembleArtifact: tests", () => {
  it("matches sibling `*.test.ts` and counts `it(` calls", async () => {
    const idx = mkIndex([
      mkEntry("src/foo.ts"),
      mkEntry("src/foo.test.ts"),
    ]);
    const fileExists = (absPath: string) =>
      absPath.endsWith("/foo.test.ts");
    const readSyncOrUndef = (absPath: string) =>
      absPath.endsWith("/foo.test.ts")
        ? `it("a", () => {});\nit("b", () => {});\ntest("c", () => {});`
        : undefined;
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists,
      readSyncOrUndef,
      isInsideRepoRealpath: () => true,
    });
    expect(art.tests).toEqual([{ filePath: "src/foo.test.ts", cases: 3 }]);
  });

  it("drops a candidate whose realpath escapes the repo (T13)", async () => {
    const idx = mkIndex([
      mkEntry("src/foo.ts"),
      mkEntry("src/foo.test.ts"),
    ]);
    const fileExists = (absPath: string) =>
      absPath.endsWith("/foo.test.ts");
    const readSyncOrUndef = () => "it('a', ()=>{});";
    const art = await assembleArtifact(baseOpts(), idx, {
      gitLog: noopGit,
      gitShortlog: noopGit,
      fileExists,
      readSyncOrUndef,
      // Force the realpath check to reject everything — simulates a symlink
      // pointing outside the repo.
      isInsideRepoRealpath: () => false,
    });
    expect(art.tests).toEqual([]);
  });
});

describe("assembleArtifact: precision floor (T12)", () => {
  it("nulls callers when a Go target's fan-out exceeds the scaled floor", async () => {
    const target = mkEntry("pkg/util/util.go", {
      language: "go",
      exports: [
        {
          name: "Helper",
          kind: "function",
          startLine: 1,
          endLine: 1,
          signature: "func Helper()",
        },
      ],
    });
    // Synthesise > 100 callers (the minimum floor) that all "import" Helper.
    const callers: SymbolIndexEntry[] = [];
    for (let i = 0; i < 110; i++) {
      callers.push(
        mkEntry(`svc/${i}/main.go`, {
          language: "go",
          imports: [
            {
              raw: `"example.com/m/pkg/util"`,
              resolved: "pkg/util/util.go",
              identifiers: ["Helper"],
            },
          ],
        }),
      );
    }
    const idx = mkIndex([target, ...callers]);
    const art = await assembleArtifact(
      baseOpts({ target: "pkg/util/util.go" }),
      idx,
      {
        gitLog: noopGit,
        gitShortlog: noopGit,
        fileExists: noTests,
        readSyncOrUndef: noRead,
      },
    );
    expect(art.callers).toBeNull();
    expect(art.callers_skipped_reason).toBe("precision-floor");
  });

  it("does NOT trigger for TS targets even with large fan-out", async () => {
    const target = mkEntry("src/util.ts", {
      language: "typescript",
      exports: [
        {
          name: "helper",
          kind: "function",
          startLine: 1,
          endLine: 1,
          signature: "export function helper()",
        },
      ],
    });
    const callers: SymbolIndexEntry[] = [];
    for (let i = 0; i < 110; i++) {
      callers.push(
        mkEntry(`src/use${i}.ts`, {
          imports: [
            {
              raw: `import { helper } from "./util"`,
              resolved: "src/util.ts",
              identifiers: ["helper"],
            },
          ],
        }),
      );
    }
    const idx = mkIndex([target, ...callers]);
    const art = await assembleArtifact(
      baseOpts({ target: "src/util.ts" }),
      idx,
      {
        gitLog: noopGit,
        gitShortlog: noopGit,
        fileExists: noTests,
        readSyncOrUndef: noRead,
      },
    );
    expect(art.callers).not.toBeNull();
    expect(art.callers_skipped_reason).toBeNull();
  });
});

describe("buildFooter", () => {
  it("scales the precision floor by repo size (min 100)", () => {
    expect(buildFooter({
      repoFileCount: 1000,
      language: "typescript",
      sinceDays: 90,
      isRegion: false,
    })).toContain("Precision floor at this repo size: 100.");
    expect(buildFooter({
      repoFileCount: 5000,
      language: "typescript",
      sinceDays: 90,
      isRegion: false,
    })).toContain("Precision floor at this repo size: 250.");
  });

  it("mentions Go / Java granularity when the language matches", () => {
    expect(buildFooter({
      repoFileCount: 100,
      language: "go",
      sinceDays: 90,
      isRegion: false,
    })).toMatch(/Go callers resolve at package granularity/);
    expect(buildFooter({
      repoFileCount: 100,
      language: "java",
      sinceDays: 90,
      isRegion: false,
    })).toMatch(/Java resolves at source-root \+ class granularity/);
  });

  it("flags the region-level performance disclosure when isRegion=true", () => {
    expect(buildFooter({
      repoFileCount: 100,
      language: "typescript",
      sinceDays: 90,
      isRegion: true,
    })).toMatch(/git log -L per call/);
  });
});
