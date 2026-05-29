// Pure-helper tests for BlockGraph (DESIGN-0021 slot 1). A full React mount is
// deferred — observe-ui declares no @testing-library/react and CLAUDE.md
// forbids adding deps without approval; graph rendering is covered by the PR's
// manual browser verification checklist.

import { describe, expect, it } from "vitest";

import { classifyEdge, computeForceLayout, nodeSeverity } from "./BlockGraph";
import type { BlockDiagnostic } from "../api";

const EDGES = [
  { from: "a", to: "b" },
  { from: "b", to: "c" },
  { from: "c", to: "a" },
];

describe("computeForceLayout", () => {
  it("places every node within bounds with finite coords", () => {
    const names = ["a", "b", "c", "d"];
    const pos = computeForceLayout(names, EDGES, { width: 800, height: 600, iterations: 50 });
    expect(pos.size).toBe(4);
    for (const name of names) {
      const p = pos.get(name)!;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(800);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(600);
    }
  });

  it("is deterministic (no Math.random) — same input, same output", () => {
    const names = ["x", "y", "z"];
    const a = computeForceLayout(names, [{ from: "x", to: "y" }], { iterations: 80 });
    const b = computeForceLayout(names, [{ from: "x", to: "y" }], { iterations: 80 });
    for (const n of names) {
      expect(a.get(n)).toEqual(b.get(n));
    }
  });

  it("handles the degenerate cases (0 and 1 node)", () => {
    expect(computeForceLayout([], []).size).toBe(0);
    const one = computeForceLayout(["solo"], []);
    expect(one.size).toBe(1);
    const p = one.get("solo")!;
    expect(Number.isFinite(p.x)).toBe(true);
  });
});

describe("classifyEdge", () => {
  const names = new Set(["a", "b"]);

  it("reciprocal when both endpoints resolve and edge is reciprocal", () => {
    expect(classifyEdge({ from: "a", to: "b", reciprocal: true }, names, new Set())).toBe(
      "reciprocal",
    );
  });
  it("asymmetric when resolved but one-sided", () => {
    expect(classifyEdge({ from: "a", to: "b", reciprocal: false }, names, new Set())).toBe(
      "asymmetric",
    );
  });
  it("broken when the target node is absent", () => {
    expect(classifyEdge({ from: "a", to: "ghost", reciprocal: false }, names, new Set())).toBe(
      "broken",
    );
  });
  it("rename-suspect when target absent and source flagged E235", () => {
    expect(
      classifyEdge({ from: "a", to: "ghost", reciprocal: false }, names, new Set(["a"])),
    ).toBe("rename-suspect");
  });
});

describe("nodeSeverity", () => {
  const err: BlockDiagnostic = { code: "SIVRU-E220", severity: "error", message: "x" };
  const warn: BlockDiagnostic = { code: "SIVRU-E234", severity: "warning", message: "y" };

  it("returns error when any diagnostic is an error", () => {
    expect(nodeSeverity([warn, err])).toBe("error");
  });
  it("returns warning when only warnings present", () => {
    expect(nodeSeverity([warn])).toBe("warning");
  });
  it("returns null when no diagnostics", () => {
    expect(nodeSeverity([])).toBeNull();
  });
});
