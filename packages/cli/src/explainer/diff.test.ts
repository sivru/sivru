import { describe, expect, it } from "vitest";

import { diffModels } from "./diff.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

function node(over: Partial<ExplainerNode> & Pick<ExplainerNode, "id" | "level" | "name">): ExplainerNode {
  return {
    path: ".",
    children: [],
    derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] },
    block: null,
    ...over,
  };
}

function model(modules: ExplainerNode[]): ExplainerModel {
  return {
    schema: 1,
    repoPath: "/r",
    stateId: "s",
    head: "h",
    root: node({ id: "system:r", level: "system", name: "r", children: modules }),
    stats: { files: 0, symbols: 0, modules: modules.length },
  };
}

const mod = (name: string, depEdges: string[] = [], over: Partial<ExplainerNode> = {}): ExplainerNode =>
  node({ id: `module:${name}`, level: "module", name, path: name, derived: { exports: [], importsResolved: [], churn: 0, depEdges, collaborators: [] }, ...over });

describe("diffModels — nodes", () => {
  it("detects added and removed nodes", () => {
    const base = model([mod("a")]);
    const head = model([mod("a"), mod("b")]);
    const d = diffModels(base, head, "base");
    expect(d.nodes.added.map((n) => n.id)).toEqual(["module:b"]);
    expect(d.nodes.removed).toEqual([]);
    expect(diffModels(head, base, "base").nodes.removed.map((n) => n.id)).toEqual(["module:b"]);
  });

  it("flags a STRUCTURAL change (depEdges) but NOT a churn-only change", () => {
    const base = model([mod("a", [])]);
    const headStruct = model([mod("a", ["module:b"]), mod("b")]);
    const ds = diffModels(base, headStruct, "base");
    expect(ds.nodes.changed.find((c) => c.ref.id === "module:a")?.fields).toEqual(["depEdges"]);

    // churn-only: same structure, different churn → NOT a change, but in churn[]
    const headChurn = model([mod("a", [], { derived: { exports: [], importsResolved: [], churn: 9, depEdges: [], collaborators: [] } })]);
    const dc = diffModels(base, headChurn, "base");
    expect(dc.nodes.changed).toEqual([]);
    expect(dc.churn).toEqual([{ ref: expect.objectContaining({ id: "module:a" }), base: 0, head: 9 }]);
  });
});

describe("diffModels — edges + cycles", () => {
  it("reports a new dependency edge", () => {
    const base = model([mod("a"), mod("b")]);
    const head = model([mod("a", ["module:b"]), mod("b")]);
    const d = diffModels(base, head, "base");
    expect(d.edges.added).toEqual([{ from: "module:a", to: "module:b" }]);
    expect(d.edges.removed).toEqual([]);
  });

  it("reports a NEW cycle the change introduced, naming the closing edge", () => {
    const base = model([mod("a", ["module:b"]), mod("b")]); // a→b, acyclic
    const head = model([mod("a", ["module:b"]), mod("b", ["module:a"])]); // b→a closes it
    const d = diffModels(base, head, "base");
    expect(d.cycles.added).toHaveLength(1);
    expect(d.cycles.added[0]!.members).toEqual(["module:a", "module:b"]);
    expect(d.cycles.added[0]!.closedBy).toEqual({ from: "module:b", to: "module:a" });
  });

  it("does NOT re-report a pre-existing cycle", () => {
    const cyclic = model([mod("a", ["module:b"]), mod("b", ["module:a"])]);
    expect(diffModels(cyclic, cyclic, "base").cycles.added).toEqual([]);
  });
});

describe("diffModels — blocks", () => {
  const sym = (name: string, block: object | null, hash?: string): ExplainerNode =>
    node({ id: `symbol:x#${name}`, level: "symbol", name, path: "x.ts", block: block as ExplainerNode["block"], ...(hash ? { blockHash: hash } : {}) });

  it("detects a block added, removed, and content-changed (by blockHash)", () => {
    const base = model([node({ id: "module:m", level: "module", name: "m", children: [sym("annotated", { role: "x" }, "h1"), sym("bare", null)] })]);
    const head = model([node({ id: "module:m", level: "module", name: "m", children: [sym("annotated", { role: "y" }, "h2"), sym("bare", { role: "z" }, "h3")] })]);
    const d = diffModels(base, head, "base");
    expect(d.blocks.added.map((n) => n.name)).toEqual(["bare"]);
    expect(d.blocks.changed.map((n) => n.name)).toEqual(["annotated"]);
    expect(d.blocks.removed).toEqual([]);
  });
});
