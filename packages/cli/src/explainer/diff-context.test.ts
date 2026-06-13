import { describe, expect, it } from "vitest";

import { buildDiffContext } from "./diff-context.js";
import type { ArchDelta } from "./diff-types.js";
import type { ExplainerDerived, ExplainerModel, ExplainerNode } from "./types.js";

const der = (churn = 0, hotScore = 0): ExplainerDerived => ({
  exports: [],
  importsResolved: [],
  churn,
  depEdges: [],
  collaborators: [],
  hotScore,
});

const sym = (id: string, path: string, churn: number, hotScore: number): ExplainerNode => ({
  id,
  level: "symbol",
  name: id.split("#").pop() ?? id,
  path,
  children: [],
  derived: der(churn, hotScore),
  block: null,
});

// A model with two modules (gw, intel) so moduleOf can bucket by prefix.
const model = (symbols: ExplainerNode[]): ExplainerModel => ({
  schema: 1,
  repoPath: "/r",
  stateId: "s",
  head: "h",
  root: {
    id: "system",
    level: "system",
    name: "r",
    path: "",
    children: [
      { id: "module:gw", level: "module", name: "gateway", path: "gw", children: symbols.filter((n) => n.path.startsWith("gw/")), derived: der(), block: null },
      { id: "module:intel", level: "module", name: "intelligence", path: "intel", children: symbols.filter((n) => n.path.startsWith("intel/")), derived: der(), block: null },
    ],
    derived: der(),
    block: null,
  },
  stats: { files: 0, symbols: symbols.length, modules: 2 },
});

const ref = (id: string, path: string, level: "symbol" | "package" | "module" = "symbol") => ({
  id,
  level,
  name: (id.split("#").pop() ?? id).replace(/^(module|package|symbol):/, ""),
  path,
});

const baseDelta = (): ArchDelta => ({
  baseRef: "main",
  nodes: { added: [], removed: [], changed: [] },
  edges: { added: [], removed: [] },
  cycles: { added: [] },
  blocks: { added: [], removed: [], changed: [] },
  churn: [],
});

describe("buildDiffContext — surface area", () => {
  it("buckets added symbols by the module they live under, most first", () => {
    const m = model([]);
    const d = baseDelta();
    d.nodes.added = [
      ref("symbol:gw/a#a", "gw/src/a.ts"),
      ref("symbol:gw/b#b", "gw/src/b.ts"),
      ref("symbol:intel/c#c", "intel/src/c.ts"),
      ref("module:new", "newmod", "module"),
      ref("package:gw/pkg", "gw/pkg", "package"),
    ];
    const ctx = buildDiffContext(m, d);
    expect(ctx.surface.addedSymbolTotal).toBe(3);
    expect(ctx.surface.addedSymbolsByModule).toEqual([
      { module: "gateway", count: 2 },
      { module: "intelligence", count: 1 },
    ]);
    expect(ctx.surface.addedModules.map((r) => r.name)).toEqual(["new"]);
    expect(ctx.surface.addedPackages.map((r) => r.id)).toEqual(["package:gw/pkg"]);
  });
});

describe("buildDiffContext — touched hot spots", () => {
  it("ranks touched (added+changed) nodes by hotScore and drops cold ones", () => {
    const hot = sym("symbol:gw/hot#hot", "gw/hot.ts", 20, 140);
    const warm = sym("symbol:gw/warm#warm", "gw/warm.ts", 5, 30);
    const cold = sym("symbol:gw/cold#cold", "gw/cold.ts", 9, 0); // hotScore 0 → dropped
    const m = model([hot, warm, cold]);
    const d = baseDelta();
    d.nodes.changed = [
      { ref: ref("symbol:gw/hot#hot", "gw/hot.ts"), fields: ["collaborators"] },
      { ref: ref("symbol:gw/cold#cold", "gw/cold.ts"), fields: ["exports"] },
    ];
    d.nodes.added = [ref("symbol:gw/warm#warm", "gw/warm.ts")];
    const ctx = buildDiffContext(m, d);
    expect(ctx.hotspots.map((h) => h.ref.name)).toEqual(["hot", "warm"]);
    expect(ctx.hotspots[0]).toMatchObject({ hotScore: 140, churn: 20, kind: "changed" });
    expect(ctx.hotspots[1]).toMatchObject({ hotScore: 30, kind: "added" });
  });

  it("honors the hot limit", () => {
    const syms = Array.from({ length: 12 }, (_, i) => sym(`symbol:gw/s${i}#s${i}`, `gw/s${i}.ts`, 10, 100 - i));
    const m = model(syms);
    const d = baseDelta();
    d.nodes.changed = syms.map((sN) => ({ ref: ref(sN.id, sN.path), fields: ["collaborators"] }));
    expect(buildDiffContext(m, d, 4).hotspots).toHaveLength(4);
  });
});
