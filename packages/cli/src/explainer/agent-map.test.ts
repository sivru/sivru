import { describe, expect, it } from "vitest";

import {
  buildMapSlice,
  buildReverseDeps,
  mapByPath,
  mapByTask,
  rankCandidates,
  resolveTarget,
  MAP_NEIGHBOR_CAP,
} from "./agent-map.js";
import { buildModelHealth, emptyNodeHealth, type ModelHealth } from "./health.js";
import type { ResolveFn } from "./drift.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

// ── fixture ────────────────────────────────────────────────────────────────────

const sym = (
  filePath: string,
  name: string,
  opts: { block?: ExplainerNode["block"]; collaborators?: string[]; declLine?: number } = {},
): ExplainerNode => ({
  id: `symbol:${filePath}#${name}`,
  level: "symbol",
  name,
  path: filePath,
  children: [],
  derived: {
    exports: [name],
    importsResolved: [],
    churn: 0,
    depEdges: [],
    collaborators: opts.collaborators ?? [],
  },
  block: opts.block ?? null,
  ...(opts.declLine !== undefined ? { declLine: opts.declLine } : {}),
});

const pkg = (id: string, path: string, children: ExplainerNode[]): ExplainerNode => ({
  id,
  level: "package",
  name: path.split("/").pop()!,
  path,
  children,
  derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] },
  block: null,
});

const mod = (
  name: string,
  path: string,
  depEdges: string[],
  children: ExplainerNode[],
  opts: { block?: ExplainerNode["block"]; hotScore?: number; churn?: number } = {},
): ExplainerNode => ({
  id: `module:${path}`,
  level: "module",
  name,
  path,
  children,
  derived: {
    exports: [],
    importsResolved: [],
    churn: opts.churn ?? 0,
    depEdges,
    collaborators: [],
    ...(opts.hotScore !== undefined ? { hotScore: opts.hotScore } : {}),
  },
  block: opts.block ?? null,
});

const fooBlock = {
  schema: 1,
  invariantsV2: [
    { rule: "doThing stays pure", enforcedBy: "thing.test.ts::pure" },
    { rule: "no global state", enforcedBy: null },
  ],
} as unknown as ExplainerNode["block"];

const symFoo = sym("a/foo/thing.ts", "doThing", { block: fooBlock, collaborators: ["helperA", "helperB"], declLine: 10 });
const symBar = sym("a/foo/thing.ts", "bar"); // block: null
const symBaz = sym("b/x/baz.ts", "baz");

const modA = mod(
  "alpha",
  "a",
  ["module:b", "module:c"],
  [pkg("package:a:foo", "a/foo", [symFoo, symBar])],
  {
    block: { schema: 1, role: "core", responsibility: "the core engine" } as unknown as ExplainerNode["block"],
    hotScore: 100,
    churn: 50,
  },
);
const modB = mod("beta", "b", ["module:a"], [pkg("package:b:x", "b/x", [symBaz])]); // a<->b cycle
const modC = mod("gamma", "c", [], []);

const model: ExplainerModel = {
  schema: 1,
  repoPath: "/r",
  stateId: "s1",
  head: "abc1234",
  root: {
    id: "system",
    level: "system",
    name: "r",
    path: "",
    children: [modA, modB, modC],
    derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] },
    block: null,
  },
  stats: { files: 3, symbols: 3, modules: 3 },
};

const resolveMissing: ResolveFn = async () => ({ kind: "missing", reason: "test-deleted" });
const buildHealth = (): Promise<ModelHealth> => buildModelHealth(model, resolveMissing);

// ── resolveTarget ───────────────────────────────────────────────────────────────

describe("resolveTarget", () => {
  it("resolves path::symbol to the symbol node", () => {
    expect(resolveTarget(model, "a/foo/thing.ts::doThing")?.id).toBe("symbol:a/foo/thing.ts#doThing");
  });
  it("resolves a separate symbol param (explain parity)", () => {
    expect(resolveTarget(model, "a/foo/thing.ts", "bar")?.id).toBe("symbol:a/foo/thing.ts#bar");
  });
  it("a symbol-less file resolves to the deepest package node", () => {
    const t = resolveTarget(model, "a/foo/thing.ts");
    expect(t?.level).toBe("package");
    expect(t?.id).toBe("package:a:foo");
  });
  it("a bare module path resolves to the module node", () => {
    expect(resolveTarget(model, "a")?.id).toBe("module:a");
  });
  it("strips a leading ./", () => {
    expect(resolveTarget(model, "./a/foo/thing.ts::doThing")?.id).toBe("symbol:a/foo/thing.ts#doThing");
  });
  it("returns null for an unresolved path", () => {
    expect(resolveTarget(model, "a/foo/missing.ts::nope")).toBeNull();
  });

  it("a file with symbols resolves to its OWNING package (paths drop src/, so prefix-match would miss)", () => {
    // Package paths omit the `src/` segment; the real file lives deeper. Resolve
    // via the symbol's parent, not a path prefix.
    const t = resolveTarget(model, "a/foo/thing.ts");
    expect(t?.id).toBe("package:a:foo");
  });
});

describe("resolveTarget — single-package repo (module path === '')", () => {
  // A single-package repo collapses the module level onto a root module with
  // path "". A file-only target must still resolve (regression: the old
  // prefix-match skipped path==="" and returned null).
  const sp = (filePath: string, name: string): ExplainerNode => sym(filePath, name);
  const spPkg = pkg("package::root", "", [sp("src/server.ts", "start")]);
  const spMod: ExplainerNode = {
    id: "module:",
    level: "module",
    name: "myapp",
    path: "",
    children: [spPkg],
    derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] },
    block: null,
  };
  const spModel: ExplainerModel = {
    schema: 1,
    repoPath: "/r",
    stateId: "s",
    head: "h",
    root: {
      id: "system",
      level: "system",
      name: "r",
      path: "",
      children: [spMod],
      derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] },
      block: null,
    },
    stats: { files: 1, symbols: 1, modules: 1 },
  };

  it("resolves a top-level src file to its package even when module path is ''", () => {
    expect(resolveTarget(spModel, "src/server.ts")?.id).toBe("package::root");
  });
  it("resolves the symbol too", () => {
    expect(resolveTarget(spModel, "src/server.ts::start")?.id).toBe("symbol:src/server.ts#start");
  });
});

// ── buildReverseDeps ──────────────────────────────────────────────────────────

describe("buildReverseDeps", () => {
  it("inverts module dep edges", () => {
    const rev = buildReverseDeps(model);
    expect(rev.get("module:a")).toEqual(["module:b"]); // b depends on a
    expect(rev.get("module:b")).toEqual(["module:a"]); // a depends on b
    expect(rev.get("module:c")).toEqual(["module:a"]); // a depends on c
  });
});

// ── buildMapSlice ────────────────────────────────────────────────────────────

describe("buildMapSlice", () => {
  it("assembles a full symbol slice with module, neighbours, collaborators, health", async () => {
    const health = await buildHealth();
    const slice = buildMapSlice(model, health, symFoo);
    expect(slice.kind).toBe("slice");
    expect(slice.target.id).toBe("symbol:a/foo/thing.ts#doThing");
    expect(slice.target.declLine).toBe(10);
    expect(slice.module?.name).toBe("alpha");
    expect(slice.module?.role).toBe("core");
    expect(slice.module?.responsibility).toBe("the core engine");
    expect(slice.module?.rank).toBe(1); // hottest module
    expect(slice.dependsOn.map((r) => r.id).sort()).toEqual(["module:b", "module:c"]);
    expect(slice.dependedOnBy.map((r) => r.id)).toEqual(["module:b"]);
    expect(slice.collaborators).toEqual(["helperA", "helperB"]);
    // drift: one broken linkage + one unguardable invariant on doThing
    expect(slice.health.driftBroken).toHaveLength(1);
    expect(slice.health.driftBroken[0]!.rule).toBe("doThing stays pure");
    expect(slice.health.unguardable).toEqual([{ rule: "no global state" }]);
    expect(slice.authoring).toBeUndefined(); // has a block
  });

  it("surfaces the authoring gap (no stub) when the target has no @sivru block", async () => {
    const health = await buildHealth();
    const slice = buildMapSlice(model, health, symBar);
    expect(slice.authoring).toBeDefined();
    expect(slice.authoring!.stubHint).toMatch(/never drafts the block/i);
    expect(slice.authoring!.stubHint).not.toMatch(/@sivru\s*\n/); // not an actual fill-in stub
  });

  it("reports inCycle on a module that sits in a dependency cycle", async () => {
    const health = await buildHealth();
    const slice = buildMapSlice(model, health, modA);
    expect(slice.health.inCycle).not.toBeNull();
    expect(slice.health.inCycle!.render).toContain("module:a");
    expect(slice.health.inCycle!.render).toContain("module:b");
  });

  it("caps neighbours and reports the overflow in `truncated`", async () => {
    const health = await buildHealth();
    const slice = buildMapSlice(model, health, modA, { neighborCap: 1 });
    expect(slice.dependsOn).toHaveLength(1);
    expect(slice.truncated?.dependsOn).toBe(1);
  });

  it("the cap default is MAP_NEIGHBOR_CAP", () => {
    expect(MAP_NEIGHBOR_CAP).toBeGreaterThan(0);
  });
});

// ── rankCandidates / mapByTask / mapByPath ────────────────────────────────────

describe("rankCandidates", () => {
  it("ranks a name match highest", () => {
    const c = rankCandidates(model, "doThing");
    expect(c[0]!.ref.name).toBe("doThing");
    expect(c[0]!.score).toBeGreaterThan(0);
  });
  it("returns nothing for a garbage query", () => {
    expect(rankCandidates(model, "zzzqqq nonexistent xyzzy")).toEqual([]);
  });
});

describe("mapByTask", () => {
  it("returns candidates first, never a slice (no auto-orient)", () => {
    const r = mapByTask(model, "doThing");
    expect(r.kind).toBe("candidates");
    expect(r.candidates.length).toBeGreaterThan(0);
  });
  it("empty + hint when nothing clears the floor", () => {
    const r = mapByTask(model, "zzzqqq nonexistent xyzzy");
    expect(r.candidates).toEqual([]);
    expect(r.hint).toMatch(/no clear target/);
  });
  it("a natural-language task resolves past filler words (stopwords)", () => {
    // "where ... is handled" are all stopwords; ranking keys on "doThing".
    const r = mapByTask(model, "where is doThing handled");
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.some((c) => c.ref.name === "doThing")).toBe(true);
  });
});

describe("mapByPath did-you-mean", () => {
  it("a typo'd SYMBOL returns kind:error WITH candidates, not a dead end", async () => {
    const health = await buildHealth();
    const r = mapByPath(model, health, "a/foo/thing.ts::doThingX");
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.error).toMatch(/no such target/);
      expect(r.candidates && r.candidates.length).toBeGreaterThan(0);
      expect(r.candidates![0]!.ref.name).toBe("doThing");
    }
  });

  it("a file-only path in a known package orients to that package (not a miss)", async () => {
    // A fat-fingered filename in a real directory is still useful orientation:
    // map returns the package slice rather than a dead end.
    const health = await buildHealth();
    const r = mapByPath(model, health, "a/foo/whatever.ts");
    expect(r.kind).toBe("slice");
    if (r.kind === "slice") expect(r.target.id).toBe("package:a:foo");
  });

  it("a resolvable path returns the slice", async () => {
    const health = await buildHealth();
    const r = mapByPath(model, health, "a/foo/thing.ts::doThing");
    expect(r.kind).toBe("slice");
  });
});

describe("emptyNodeHealth", () => {
  it("is all-clear", () => {
    expect(emptyNodeHealth()).toEqual({ hot: null, inCycle: null, driftBroken: [], unguardable: [] });
  });
});
