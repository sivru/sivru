import { describe, expect, it } from "vitest";
import type { SymbolIndex, SymbolIndexEntry } from "@sivru/search";

import { buildExplainerModel, type ExtractedForFile } from "./model.js";
import type { ExplainerNode } from "./types.js";

// ── fixture builders (no real git/fs — the index + deps are injected) ─────────

function entry(over: Partial<SymbolIndexEntry> & { filePath: string }): SymbolIndexEntry {
  return {
    language: "typescript",
    exports: [],
    imports: [],
    commitCount: 0,
    mtimeMs: 1,
    ...over,
  } as SymbolIndexEntry;
}

function exp(name: string) {
  return { name, kind: "function" as const, startLine: 1, endLine: 1, signature: "" };
}

function imp(raw: string, resolved: string | null, identifiers: string[] = []) {
  return { raw, resolved, identifiers };
}

function fakeIndex(entries: SymbolIndexEntry[]): SymbolIndex {
  const byPath = new Map(entries.map((e) => [e.filePath, e]));
  return {
    repoPath: "/repo",
    stateId: "state-1",
    size: () => entries.length,
    get: (p) => byPath.get(p),
    entries: () => entries,
  };
}

const NO_BLOCKS = async (): Promise<ExtractedForFile[]> => [];
const STUB_NARRATIVE = { read: async (): Promise<string | null> => null };

function build(
  entries: SymbolIndexEntry[],
  opts: {
    packageDirs: string[];
    names?: Record<string, string>;
    blocks?: Record<string, ExtractedForFile[]>;
  },
) {
  return buildExplainerModel("/repo", {
    index: fakeIndex(entries),
    packageDirs: opts.packageDirs,
    packageName: async (_r, dir) => opts.names?.[dir] ?? (dir === "" ? "." : dir),
    extractFor: async (_r, rel) => opts.blocks?.[rel] ?? [],
    narrative: STUB_NARRATIVE,
  });
}

const findChild = (n: ExplainerNode, name: string) =>
  n.children.find((c) => c.name === name)!;

// ── tests ─────────────────────────────────────────────────────────────────────

describe("buildExplainerModel — monorepo shape", () => {
  const entries = [
    entry({
      filePath: "packages/cli/src/commands/explain.ts",
      exports: [exp("runExplain")],
      imports: [
        imp('} from "@sivru/search";', null, ["assembleArtifact"]),
        imp('} from "../lib/x.js";', "packages/cli/src/lib/x.ts", ["helper"]),
      ],
      commitCount: 10,
    }),
    entry({
      filePath: "packages/cli/src/lib/x.ts",
      exports: [exp("helper")],
      commitCount: 3,
    }),
    entry({
      filePath: "packages/search/src/index.ts",
      exports: [exp("assembleArtifact")],
      commitCount: 5,
    }),
  ];
  const opts = {
    packageDirs: ["", "packages/cli", "packages/search"],
    names: { "packages/cli": "@sivru/cli", "packages/search": "@sivru/search" },
  };

  it("builds System → Module → Package → Symbol", async () => {
    const m = await build(entries, opts);
    expect(m.schema).toBe(1);
    expect(m.root.level).toBe("system");
    expect(m.root.children.map((c) => c.name)).toEqual(["@sivru/cli", "@sivru/search"]);
    const cli = findChild(m.root, "@sivru/cli");
    expect(cli.level).toBe("module");
    const commands = findChild(cli, "commands");
    expect(commands.level).toBe("package");
    expect(commands.children.map((s) => s.name)).toEqual(["runExplain"]);
    expect(commands.children[0]!.level).toBe("symbol");
  });

  it("derives a module dep-edge from a cross-package import (by package name)", async () => {
    const m = await build(entries, opts);
    expect(findChild(m.root, "@sivru/cli").derived.depEdges).toEqual([
      "module:packages/search",
    ]);
    // search depends on nothing internal.
    expect(findChild(m.root, "@sivru/search").derived.depEdges).toEqual([]);
  });

  it("derives a package dep-edge from a resolved relative import (no self-edges)", async () => {
    const m = await build(entries, opts);
    const commands = findChild(findChild(m.root, "@sivru/cli"), "commands");
    expect(commands.derived.depEdges).toEqual(["package:packages/cli/lib"]);
  });

  it("symbol collaborators = import callees ∪ block.collaborators", async () => {
    const m = await build(entries, {
      ...opts,
      blocks: {
        "packages/cli/src/commands/explain.ts": [
          { kind: "symbol", symbolName: "runExplain", blockJSON: { role: "cli", collaborators: ["parseArgs"] } },
        ],
      },
    });
    const sym = findChild(findChild(findChild(m.root, "@sivru/cli"), "commands"), "runExplain");
    expect(sym.derived.collaborators).toEqual(["assembleArtifact", "helper", "parseArgs"]);
    expect((sym.block as { role: string }).role).toBe("cli");
  });

  it("sums churn over DISTINCT files, never per-symbol", async () => {
    // A file with two exports must not double-count its churn at the package level.
    const two = [
      entry({ filePath: "packages/cli/src/lib/two.ts", exports: [exp("a"), exp("b")], commitCount: 7 }),
    ];
    const m = await build(two, { packageDirs: ["", "packages/cli"], names: { "packages/cli": "@sivru/cli" } });
    const lib = findChild(findChild(m.root, "@sivru/cli"), "lib");
    expect(lib.children).toHaveLength(2); // two symbols
    expect(lib.derived.churn).toBe(7); // but churn counted once
    expect(findChild(m.root, "@sivru/cli").derived.churn).toBe(7);
  });
});

describe("buildExplainerModel — single package collapses module/package", () => {
  it("maps every file to one root module, packages = src subdirs", async () => {
    const entries = [
      entry({ filePath: "src/commands/foo.ts", exports: [exp("foo")] }),
      entry({ filePath: "src/index.ts", exports: [exp("main")] }),
    ];
    const m = await build(entries, { packageDirs: [""], names: { "": "my-tool" } });
    expect(m.root.children).toHaveLength(1);
    const mod = m.root.children[0]!;
    expect(mod.name).toBe("my-tool");
    expect(mod.children.map((p) => p.name).sort()).toEqual(["(root)", "commands"]);
  });
});

describe("buildExplainerModel — load-bearing cap + blocks", () => {
  it("excludes files with no export and no @sivru block", async () => {
    const entries = [
      entry({ filePath: "src/internal/helper.ts", exports: [], imports: [] }), // not load-bearing
      entry({ filePath: "src/api.ts", exports: [exp("api")] }),
    ];
    const m = await build(entries, { packageDirs: [""] });
    const allSymbols = collectSymbols(m.root);
    expect(allSymbols.map((s) => s.name)).toEqual(["api"]);
    expect(m.stats.symbols).toBe(1);
  });

  it("includes a non-exported symbol that carries a @sivru block", async () => {
    const entries = [entry({ filePath: "src/x.ts", exports: [] })];
    const m = await build(entries, {
      packageDirs: [""],
      blocks: {
        "src/x.ts": [{ kind: "symbol", symbolName: "internalThing", blockJSON: { role: "r" } }],
      },
    });
    expect(collectSymbols(m.root).map((s) => s.name)).toEqual(["internalThing"]);
  });

  it("gives a module-level (top-of-file) block its own symbol node", async () => {
    const entries = [entry({ filePath: "src/mod.ts", exports: [] })];
    const m = await build(entries, {
      packageDirs: [""],
      blocks: { "src/mod.ts": [{ kind: "module", blockJSON: { role: "module-role" } }] },
    });
    const sym = collectSymbols(m.root)[0]!;
    expect(sym.name).toBe("(module) mod.ts");
    expect((sym.block as { role: string }).role).toBe("module-role");
  });
});

describe("buildExplainerModel — degenerate", () => {
  it("an empty repo yields a system node with no modules", async () => {
    const m = await build([], { packageDirs: [""] });
    expect(m.root.level).toBe("system");
    expect(m.root.children).toEqual([]);
    expect(m.stats).toEqual({ files: 0, symbols: 0, modules: 0 });
  });

  it("uses the resolved narrative for the system node", async () => {
    const m = await buildExplainerModel("/repo", {
      index: fakeIndex([]),
      packageDirs: [""],
      extractFor: NO_BLOCKS,
      narrative: { read: async (_r, rel) => (rel === "README.md" ? "the readme" : null) },
    });
    expect(m.root.narrative).toBe("the readme");
  });
});

function collectSymbols(n: ExplainerNode): ExplainerNode[] {
  if (n.level === "symbol") return [n];
  return n.children.flatMap(collectSymbols);
}
