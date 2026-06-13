import { describe, expect, it } from "vitest";

import { topHotNodes } from "./attention.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

const sym = (id: string, churn: number, collaborators: string[]): ExplainerNode => ({
  id,
  level: "symbol",
  name: id,
  path: `${id}.ts`,
  children: [],
  derived: { exports: [], importsResolved: [], churn, depEdges: [], collaborators },
  block: null,
});

const pkg = (id: string, churn: number, depEdges: string[], children: ExplainerNode[]): ExplainerNode => ({
  id,
  level: "package",
  name: id,
  path: id,
  children,
  derived: { exports: [], importsResolved: [], churn, depEdges, collaborators: [] },
  block: null,
});

const model = (children: ExplainerNode[]): ExplainerModel => ({
  schema: 1,
  repoPath: "/r",
  stateId: "s",
  head: "h",
  root: {
    id: "system",
    level: "system",
    name: "r",
    path: "",
    children,
    derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] },
    block: null,
  },
  stats: { files: 0, symbols: 0, modules: 0 },
});

describe("topHotNodes", () => {
  it("ranks by churn × coupling and drops cold (hotScore 0) nodes", () => {
    const hot = sym("hot", 10, ["a", "b", "c"]); // 10 × 3 = 30
    const warm = sym("warm", 4, ["a", "b"]); // 4 × 2 = 8
    const cold = sym("cold", 9, []); // 9 × 0 = 0 → dropped
    // package p is cold (churn 0 → hotScore 0 → dropped); cold sym → dropped.
    const hits = topHotNodes(model([pkg("p", 0, [], [hot, warm, cold])]));
    expect(hits.map((h) => h.ref.id)).toEqual(["hot", "warm"]);
    expect(hits[0]?.hotScore).toBe(30);
  });

  it("counts in-degree as coupling for a depended-on package", () => {
    // q has no out-edges but two packages depend on it → in-degree 2.
    const p1 = pkg("p1", 1, ["q"], []);
    const p2 = pkg("p2", 1, ["q"], []);
    const q = pkg("q", 5, [], []); // churn 5 × in-degree 2 = 10
    const hits = topHotNodes(model([p1, p2, q]));
    expect(hits[0]?.ref.id).toBe("q");
    expect(hits[0]?.hotScore).toBe(10);
    expect(hits[0]?.coupling).toBe(2);
  });

  it("honors the limit", () => {
    const syms = Array.from({ length: 20 }, (_, i) => sym(`s${i}`, 10 - (i % 5), ["a", "b"]));
    expect(topHotNodes(model([pkg("p", 0, [], syms)]), 3)).toHaveLength(3);
  });
});
