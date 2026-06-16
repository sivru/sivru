import { describe, expect, it } from "vitest";

import { buildDepGraph, cycleMemberIds, cycleRenders, findCycleGroups, newCycles, type DepGraph } from "./cycles.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

const g = (edges: Record<string, string[]>): DepGraph => new Map(Object.entries(edges));

const modNode = (id: string, depEdges: string[]): ExplainerNode => ({
  id,
  level: "module",
  name: id,
  path: id,
  children: [],
  derived: { exports: [], importsResolved: [], churn: 0, depEdges, collaborators: [] },
  block: null,
});
const modelOf = (mods: ExplainerNode[]): ExplainerModel => ({
  schema: 1,
  repoPath: "/r",
  stateId: "s",
  head: "h",
  root: { id: "system", level: "system", name: "r", path: "", children: mods, derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] }, block: null },
  stats: { files: 0, symbols: 0, modules: mods.length },
});

describe("findCycleGroups (Tarjan)", () => {
  it("a DAG has no cycles", () => {
    expect(findCycleGroups(g({ a: ["b"], b: ["c"], c: [] }))).toEqual([]);
  });

  it("a 2-cycle is one SCC", () => {
    expect(findCycleGroups(g({ a: ["b"], b: ["a"] }))).toEqual([["a", "b"]]);
  });

  it("a 3-cycle is one SCC", () => {
    expect(findCycleGroups(g({ a: ["b"], b: ["c"], c: ["a"] }))).toEqual([["a", "b", "c"]]);
  });

  it("a self-loop counts; a lone node does not", () => {
    expect(findCycleGroups(g({ a: ["a"], b: [] }))).toEqual([["a"]]);
  });

  it("does not overflow on a long chain (iterative)", () => {
    const chain: Record<string, string[]> = {};
    for (let i = 0; i < 5000; i++) chain[`n${i}`] = i < 4999 ? [`n${i + 1}`] : [];
    expect(findCycleGroups(g(chain))).toEqual([]); // a chain is acyclic
  });
});

describe("buildDepGraph", () => {
  it("keeps only edges to known nodes and drops self-edges", () => {
    const graph = buildDepGraph([
      { id: "a", depEdges: ["b", "external", "a"] }, // external not a node; a is self
      { id: "b", depEdges: ["a"] },
    ]);
    expect(graph.get("a")).toEqual(["b"]);
    expect(graph.get("b")).toEqual(["a"]);
  });
});

describe("newCycles", () => {
  it("reports a cycle introduced at head, naming the closing edge", () => {
    const base = g({ a: ["b"], b: [] }); // acyclic
    const head = g({ a: ["b"], b: ["a"] }); // b→a closes the cycle
    const out = newCycles(base, head);
    expect(out).toHaveLength(1);
    expect(out[0]!.members).toEqual(["a", "b"]);
    expect(out[0]!.closedBy).toEqual({ from: "b", to: "a" });
    expect(out[0]!.render).toBe("a → b → a");
  });

  it("does NOT re-report a cycle that already existed at base", () => {
    const base = g({ a: ["b"], b: ["a"] });
    const head = g({ a: ["b"], b: ["a"], c: [] }); // same cycle, plus an unrelated node
    expect(newCycles(base, head)).toEqual([]);
  });

  it("is deterministic: same graphs → same render + closedBy", () => {
    const base = g({ x: [], y: [], z: [] });
    const head = g({ x: ["y"], y: ["z"], z: ["x"] });
    const a = newCycles(base, head);
    const b = newCycles(base, head);
    expect(a).toEqual(b);
    expect(a[0]!.render).toBe("x → y → z → x");
  });
});

describe("cycleMemberIds (static badge source)", () => {
  it("returns the ids of every node in some cycle, none for a DAG", () => {
    const cyclic = modelOf([modNode("module:a", ["module:b"]), modNode("module:b", ["module:a"]), modNode("module:c", ["module:a"])]);
    expect([...cycleMemberIds(cyclic)].sort()).toEqual(["module:a", "module:b"]); // c depends in but isn't in the cycle
    const dag = modelOf([modNode("module:a", ["module:b"]), modNode("module:b", [])]);
    expect(cycleMemberIds(dag).size).toBe(0);
  });
});

describe("cycleRenders (DESIGN-0024 — render per member for the map slice)", () => {
  it("maps each cycle member to the canonical render of its cycle", () => {
    const cyclic = modelOf([modNode("module:a", ["module:b"]), modNode("module:b", ["module:a"])]);
    const renders = cycleRenders(cyclic);
    expect([...renders.keys()].sort()).toEqual(["module:a", "module:b"]);
    expect(renders.get("module:a")).toBe("module:a → module:b → module:a");
    expect(renders.get("module:a")).toBe(renders.get("module:b")); // same cycle, same render
  });
  it("a DAG has no renders", () => {
    const dag = modelOf([modNode("module:a", ["module:b"]), modNode("module:b", [])]);
    expect(cycleRenders(dag).size).toBe(0);
  });
});
