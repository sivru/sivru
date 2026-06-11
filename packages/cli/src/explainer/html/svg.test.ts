import { describe, expect, it } from "vitest";

import {
  barLayout,
  computeLayers,
  radialLayout,
  renderSystemMap,
  systemMapLayout,
} from "./svg.js";

const edges = [
  { from: "cli", to: "observe" },
  { from: "cli", to: "search" },
  { from: "observe", to: "search" },
];

describe("computeLayers", () => {
  it("sinks depended-upon nodes to layer 0 (longest-path)", () => {
    const l = computeLayers(["cli", "observe", "search"], edges);
    expect(l.get("search")).toBe(0);
    expect(l.get("observe")).toBe(1);
    expect(l.get("cli")).toBe(2);
  });

  it("terminates on a cycle and handles single/empty", () => {
    expect(
      computeLayers(["a", "b"], [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ]).size,
    ).toBe(2);
    expect(computeLayers(["solo"], []).get("solo")).toBe(0);
    expect(computeLayers([], []).size).toBe(0);
  });
});

describe("systemMapLayout", () => {
  const nodes = [
    { id: "cli", name: "@s/cli", sub: "30 sym", size: 30 },
    { id: "observe", name: "@s/observe", sub: "40 sym", size: 40 },
    { id: "search", name: "@s/search", sub: "120 sym", size: 120 },
  ];

  it("keeps every box within the viewBox bounds", () => {
    const l = systemMapLayout(nodes, edges);
    for (const b of l.boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(l.width);
      expect(b.y + b.h).toBeLessThanOrEqual(l.height);
    }
  });

  it("places the foundation (layer 0) left of its consumers", () => {
    const l = systemMapLayout(nodes, edges);
    const x = (id: string) => l.boxes.find((b) => b.id === id)!.x;
    expect(x("search")).toBeLessThan(x("observe"));
    expect(x("observe")).toBeLessThan(x("cli"));
  });

  it("sizes boxes by symbol count (bigger module → wider box)", () => {
    const l = systemMapLayout(nodes, edges);
    const w = (id: string) => l.boxes.find((b) => b.id === id)!.w;
    expect(w("search")).toBeGreaterThan(w("observe"));
    expect(w("observe")).toBeGreaterThan(w("cli"));
  });

  it("is deterministic and handles an empty system", () => {
    expect(systemMapLayout(nodes, edges)).toEqual(systemMapLayout([...nodes], [...edges]));
    const empty = systemMapLayout([], []);
    expect(empty.boxes).toEqual([]);
    expect(empty.width).toBeGreaterThan(0);
  });
});

describe("renderSystemMap", () => {
  it("emits a viewBox'd <svg>, escapes labels, links boxes", () => {
    const svg = renderSystemMap(
      [{ id: "a", name: "<x>", sub: "1 sym", size: 1 }],
      [],
      (id) => `#/module/${id}`,
    );
    expect(svg).toMatch(/^<svg class="diagram" viewBox="0 0 \d+ \d+"/);
    expect(svg).toContain("&lt;x&gt;");
    expect(svg).toContain('href="#/module/a"');
  });
});

describe("barLayout", () => {
  const items = [
    { label: "lib", value: 29 },
    { label: "commands", value: 34 },
    { label: "explainer", value: 15 },
  ];

  it("sorts descending and the value label always fits in the viewBox", () => {
    const l = barLayout(items);
    expect(l.bars.map((b) => b.label)).toEqual(["commands", "lib", "explainer"]);
    // The widest bar's value text starts at x+width+6; reserve room so it never clips.
    const widest = l.bars[0]!;
    expect(widest.x + widest.width + 40).toBeLessThanOrEqual(l.width);
  });

  it("handles all-zero values and is deterministic", () => {
    expect(barLayout([{ label: "a", value: 0 }]).bars[0]!.width).toBe(0);
    expect(barLayout(items)).toEqual(barLayout([...items]));
  });
});

describe("radialLayout", () => {
  it("keeps neighbours in bounds and grows the radius with count", () => {
    const few = radialLayout(["a", "b"]);
    const many = radialLayout(Array.from({ length: 12 }, (_, i) => `n${i}`));
    expect(many.radius).toBeGreaterThan(few.radius);
    for (const n of many.neighbors) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(many.width);
      expect(n.y).toBeLessThanOrEqual(many.height);
    }
  });

  it("caps rendered neighbours at the max", () => {
    const l = radialLayout(Array.from({ length: 40 }, (_, i) => `n${i}`));
    expect(l.neighbors.length).toBeLessThanOrEqual(16);
  });

  it("handles zero/one and is deterministic", () => {
    expect(radialLayout([]).neighbors).toEqual([]);
    expect(radialLayout(["only"]).neighbors).toHaveLength(1);
    expect(radialLayout(["x", "y"])).toEqual(radialLayout(["x", "y"]));
  });
});
