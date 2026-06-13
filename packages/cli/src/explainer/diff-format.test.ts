import { describe, expect, it } from "vitest";

import type { ArchDelta, CycleDelta } from "./diff-types.js";
import type { DiffContext } from "./diff-context.js";
import { formatDeltaGithub, formatDeltaText, isEmptyDelta } from "./diff-format.js";

const empty = (): ArchDelta => ({
  baseRef: "main",
  nodes: { added: [], removed: [], changed: [] },
  edges: { added: [], removed: [] },
  cycles: { added: [] },
  blocks: { added: [], removed: [], changed: [] },
  churn: [],
});

const cycle = (members: string[]): CycleDelta => ({
  members,
  render: `${members.join(" → ")} → ${members[0]}`,
  closedBy: { from: members[members.length - 1]!, to: members[0]! },
});

describe("isEmptyDelta + clean signal", () => {
  it("reports an empty delta", () => {
    expect(isEmptyDelta(empty())).toBe(true);
    expect(formatDeltaText(empty())).toContain("No architectural change");
    expect(formatDeltaGithub(empty())).toContain("✅ **No architectural change**");
  });

  it("a delta with any structural change is not empty", () => {
    const d = empty();
    d.cycles.added.push(cycle(["a", "b"]));
    expect(isEmptyDelta(d)).toBe(false);
  });
});

describe("formatDeltaText — impact ordering + cycle truncation", () => {
  it("leads with the cycle and names the closing edge", () => {
    const d = empty();
    d.cycles.added.push(cycle(["module:a", "module:b"]));
    d.edges.added.push({ from: "module:a", to: "module:b" });
    const text = formatDeltaText(d);
    expect(text.indexOf("cycle")).toBeLessThan(text.indexOf("edges")); // impact order
    expect(text).toContain("closed by new edge: module:b → module:a");
  });

  it("truncates a long cycle render", () => {
    const d = empty();
    d.cycles.added.push(cycle(["a", "b", "c", "d", "e", "f", "g", "h"]));
    expect(formatDeltaText(d)).toMatch(/a → b → c → … \(\+5\) → a/);
  });
});

describe("formatDeltaGithub — marker + escaping", () => {
  it("starts with the hidden marker (CI finds + updates one comment)", () => {
    expect(formatDeltaGithub(empty()).startsWith("<!-- sivru-arch-delta -->")).toBe(true);
  });

  it("escapes a backtick in a node name so it can't break the markdown", () => {
    const d = empty();
    d.cycles.added.push(cycle(["a`b", "c"]));
    const md = formatDeltaGithub(d);
    expect(md).toContain("**⟳ New dependency cycle**");
    expect(md).not.toMatch(/`a`b`/); // the raw backtick is neutralized
  });
});

describe("surface-area + hot-spot enrichment (ctx)", () => {
  const ctx = (): DiffContext => ({
    surface: {
      addedModules: [{ id: "module:new", level: "module", name: "newmod", path: "newmod" }],
      addedPackages: [],
      addedSymbolsByModule: [
        { module: "gateway", count: 268 },
        { module: "intelligence", count: 34 },
      ],
      addedSymbolTotal: 302,
      changedCount: 154,
      removedCount: 1,
    },
    hotspots: [
      { ref: { id: "symbol:gw/AgentRunLoop#x", level: "symbol", name: "AgentRunLoop", path: "gw/x.ts" }, hotScore: 162, churn: 40, kind: "changed" },
    ],
  });

  it("text shows the footprint by module and the touched hot spots", () => {
    const d = empty();
    d.nodes.added = [{ id: "x", level: "symbol", name: "x", path: "gw/x.ts" }];
    const text = formatDeltaText(d, ctx());
    expect(text).toContain("surface");
    expect(text).toContain("gateway 268");
    expect(text).toContain("hot spots touched");
    expect(text).toContain("AgentRunLoop");
  });

  it("github renders New surface area + Touched hot spots sections", () => {
    const d = empty();
    d.nodes.added = [{ id: "x", level: "symbol", name: "x", path: "gw/x.ts" }];
    const md = formatDeltaGithub(d, ctx());
    expect(md).toContain("**New surface area**");
    expect(md).toContain("**Touched hot spots**");
    expect(md).toContain("gateway 268");
  });

  it("omits the enrichment entirely when no ctx is passed (Slice 1 behavior)", () => {
    const d = empty();
    d.edges.added.push({ from: "a", to: "b" });
    expect(formatDeltaText(d)).not.toContain("surface");
    expect(formatDeltaGithub(d)).not.toContain("New surface area");
  });
});
