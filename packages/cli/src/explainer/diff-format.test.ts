import { describe, expect, it } from "vitest";

import type { ArchDelta, CycleDelta } from "./diff-types.js";
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
