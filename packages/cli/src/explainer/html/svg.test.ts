import { describe, expect, it } from "vitest";

import {
  barLayout,
  layeredDag,
  radialLayout,
  renderDepGraph,
} from "./svg.js";

const NODE_W = 150;
const NODE_H = 34;

describe("layeredDag", () => {
  // search depends on nothing; observe→search; cli→observe,search.
  const ids = ["cli", "observe", "search"];
  const edges = [
    { from: "cli", to: "observe" },
    { from: "cli", to: "search" },
    { from: "observe", to: "search" },
  ];

  it("sinks depended-upon nodes to layer 0 (longest-path layering)", () => {
    const l = layeredDag(ids, edges);
    const layerOf = (id: string) => l.boxes.find((b) => b.id === id)!.layer;
    expect(layerOf("search")).toBe(0);
    expect(layerOf("observe")).toBe(1);
    expect(layerOf("cli")).toBe(2);
  });

  it("keeps every box within the reported viewBox bounds", () => {
    const l = layeredDag(ids, edges);
    for (const b of l.boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + NODE_W).toBeLessThanOrEqual(l.width);
      expect(b.y + NODE_H).toBeLessThanOrEqual(l.height);
    }
  });

  it("is deterministic: same input → identical layout", () => {
    expect(layeredDag(ids, edges)).toEqual(layeredDag([...ids], [...edges]));
  });

  it("terminates on a cycle (A→B→A) without infinite recursion", () => {
    const l = layeredDag(
      ["a", "b"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    );
    expect(l.boxes).toHaveLength(2);
  });

  it("handles a single node and an empty graph", () => {
    expect(layeredDag(["solo"], []).boxes).toHaveLength(1);
    const empty = layeredDag([], []);
    expect(empty.boxes).toEqual([]);
    expect(empty.width).toBeGreaterThan(0);
    expect(empty.height).toBeGreaterThan(0);
  });

  it("ignores edges to unknown nodes and self-edges", () => {
    const l = layeredDag(["a"], [
      { from: "a", to: "ghost" },
      { from: "a", to: "a" },
    ]);
    expect(l.boxes[0]!.layer).toBe(0);
  });
});

describe("barLayout", () => {
  const items = [
    { label: "lib", value: 29 },
    { label: "commands", value: 34 },
    { label: "explainer", value: 15 },
  ];

  it("sorts descending by value", () => {
    expect(barLayout(items).bars.map((b) => b.label)).toEqual([
      "commands",
      "lib",
      "explainer",
    ]);
  });

  it("scales widths within [0, max] and stays in bounds", () => {
    const l = barLayout(items);
    expect(l.bars[0]!.width).toBeCloseTo(220); // max value → full width
    for (const b of l.bars) {
      expect(b.width).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(l.width);
    }
  });

  it("handles all-zero values (no divide-by-zero, widths 0)", () => {
    const l = barLayout([{ label: "a", value: 0 }, { label: "b", value: 0 }]);
    expect(l.bars.every((b) => b.width === 0)).toBe(true);
  });

  it("is deterministic", () => {
    expect(barLayout(items)).toEqual(barLayout([...items]));
  });
});

describe("radialLayout", () => {
  it("places every neighbour within the viewBox", () => {
    const l = radialLayout(["a", "b", "c", "d"]);
    for (const n of l.neighbors) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(l.width);
      expect(n.y).toBeLessThanOrEqual(l.height);
    }
    expect(l.center).toEqual({ x: l.width / 2, y: l.height / 2 });
  });

  it("handles zero, one, and many neighbours", () => {
    expect(radialLayout([]).neighbors).toEqual([]);
    expect(radialLayout(["only"]).neighbors).toHaveLength(1);
    expect(radialLayout(["a", "b", "c", "d", "e", "f"]).neighbors).toHaveLength(6);
  });

  it("is deterministic", () => {
    expect(radialLayout(["x", "y"])).toEqual(radialLayout(["x", "y"]));
  });
});

describe("renderDepGraph", () => {
  it("emits a viewBox'd <svg>, escapes labels, and links nodes", () => {
    const svg = renderDepGraph(
      ["a"],
      [],
      () => "<evil>",
      (id) => `#/module/${id}`,
    );
    expect(svg).toMatch(/^<svg class="diagram" viewBox="0 0 \d+ \d+"/);
    expect(svg).toContain("&lt;evil&gt;");
    expect(svg).not.toContain("<evil>");
    expect(svg).toContain('href="#/module/a"');
  });
});
