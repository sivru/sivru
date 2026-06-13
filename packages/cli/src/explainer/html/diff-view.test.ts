import { describe, expect, it } from "vitest";

import type { ArchDelta } from "../diff-types.js";
import type { ExplainerModel, ExplainerNode } from "../types.js";
import { renderDiffHtml } from "./render.js";

const mod = (name: string, depEdges: string[], symbols: number): ExplainerNode => ({
  id: `module:${name}`,
  level: "module",
  name,
  path: name,
  children: [
    {
      id: `package:${name}/src`,
      level: "package",
      name: "src",
      path: `${name}/src`,
      children: Array.from({ length: symbols }, (_, i) => ({
        id: `symbol:${name}/src/f${i}.ts#s${i}`,
        level: "symbol" as const,
        name: `s${i}`,
        path: `${name}/src/f${i}.ts`,
        children: [],
        derived: { exports: [], importsResolved: [], churn: 1, depEdges: [], collaborators: [] },
        block: null,
      })),
      derived: { exports: [], importsResolved: [], churn: 1, depEdges: [], collaborators: [] },
      block: null,
    },
  ],
  derived: { exports: [], importsResolved: [], churn: 3, depEdges, collaborators: [] },
  block: null,
});

const head: ExplainerModel = {
  schema: 1,
  repoPath: "/r",
  stateId: "s",
  head: "h",
  root: {
    id: "system",
    level: "system",
    name: "r",
    path: "",
    children: [mod("a", ["module:b"], 3), mod("b", [], 2)],
    derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] },
    block: null,
  },
  stats: { files: 5, symbols: 5, modules: 2 },
};

const emptyDelta = (): ArchDelta => ({
  baseRef: "main",
  nodes: { added: [], removed: [], changed: [] },
  edges: { added: [], removed: [] },
  cycles: { added: [] },
  blocks: { added: [], removed: [], changed: [] },
  churn: [],
});

describe("renderDiffHtml", () => {
  it("renders the structurally-inert signal when the delta is empty", () => {
    const html = renderDiffHtml(head, emptyDelta());
    expect(html).toContain("No architectural change");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("tags a new cycle with text (not color alone) and highlights the closing edge", () => {
    const d = emptyDelta();
    d.cycles.added.push({
      members: ["module:a", "module:b"],
      render: "module:a → module:b → module:a",
      closedBy: { from: "module:b", to: "module:a" },
    });
    d.edges.added.push({ from: "module:b", to: "module:a" });
    const html = renderDiffHtml(head, d);
    expect(html).toContain("⟳ CYCLE"); // text tag — WCAG 1.4.1
    expect(html).toContain("cycle-edge"); // the closing edge is styled in the SVG
    expect(html).toContain("delta-legend"); // legend present
  });

  it("marks an affected module box as changed when a symbol under it changed", () => {
    const d = emptyDelta();
    d.blocks.changed.push({ id: "symbol:a/src/f0.ts#s0", level: "symbol", name: "s0", path: "a/src/f0.ts" });
    const html = renderDiffHtml(head, d);
    // module:a's box carries the "changed" class because a/src/f0.ts is under a/.
    expect(html).toMatch(/map-box changed/);
    expect(html).toContain("CHG");
  });

  it("escapes a hostile base ref", () => {
    const d = emptyDelta();
    d.baseRef = "<script>x</script>";
    const html = renderDiffHtml(head, d);
    expect(html).not.toContain("<script>x</script>");
  });

  it("reduces the map to the changed slice + neighbors on a multi-module repo", () => {
    // 3 isolated modules; the change touches only module x → map shows x (+ its
    // neighbors, none here), not the untouched y/z.
    const m3 = (name: string): ExplainerNode => mod(name, [], 2);
    const big: ExplainerModel = {
      ...head,
      root: { ...head.root, children: [m3("x"), m3("y"), m3("z")] },
    };
    const d = emptyDelta();
    d.blocks.changed.push({ id: "symbol:x/src/f0.ts#s0", level: "symbol", name: "s0", path: "x/src/f0.ts" });
    const html = renderDiffHtml(big, d);
    expect(html).toContain("changed slice + neighbors");
    expect(html).toMatch(/map-name[^>]*>x</); // x is on the map
    expect(html).not.toMatch(/map-name[^>]*>y</); // y is not (untouched, no edge)
  });

  it("renders the New surface area + Touched hot spots sections for a sizeable change", () => {
    const d = emptyDelta();
    // add symbols under module a; mark one existing hot symbol as changed.
    d.nodes.added = [
      { id: "symbol:a/src/n1.ts#n1", level: "symbol", name: "n1", path: "a/src/n1.ts" },
      { id: "symbol:a/src/n2.ts#n2", level: "symbol", name: "n2", path: "a/src/n2.ts" },
      { id: "module:c", level: "module", name: "c", path: "c" },
    ];
    // s0 in module a is hot (give it a hotScore) and is changed.
    head.root.children[0]!.children[0]!.children[0]!.derived.hotScore = 99;
    head.root.children[0]!.children[0]!.children[0]!.derived.churn = 12;
    d.nodes.changed = [{ ref: { id: "symbol:a/src/f0.ts#s0", level: "symbol", name: "s0", path: "a/src/f0.ts" }, fields: ["collaborators"] }];
    const html = renderDiffHtml(head, d);
    expect(html).toContain("New surface area");
    expect(html).toContain("Touched hot spots");
    expect(html).toContain("surface-bars");
    expect(html).toContain(">a<"); // module 'a' labelled in the footprint bar
    expect(html).toContain("99"); // the hot-spot score
  });
});
