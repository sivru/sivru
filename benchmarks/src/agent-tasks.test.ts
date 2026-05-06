import { describe, expect, it } from "vitest";

import { extractKeywords, pickAgentTasks } from "./agent-tasks.js";
import type { Annotation } from "./types.js";

describe("extractKeywords", () => {
  it("prefers identifier-shaped tokens over generic English", () => {
    const kws = extractKeywords(
      "where are all the schema types like ZodString, ZodObject, ZodArray defined",
    );
    // CamelCase tokens should outrank "schema" / "types" / "defined".
    expect(kws[0]).toMatch(/Zod/);
  });

  it("drops stopwords + short tokens", () => {
    const kws = extractKeywords("how do I get a list of all the things");
    // No stopwords (how/do/i/a/of/all/the) and no <3-char words.
    expect(kws).not.toContain("how");
    expect(kws).not.toContain("a");
    expect(kws).not.toContain("of");
  });

  it("dedupes case-insensitively", () => {
    const kws = extractKeywords("Session session SESSION request");
    const seen = new Set(kws.map((k) => k.toLowerCase()));
    expect(seen.size).toBe(kws.length);
  });

  it("respects the max cap", () => {
    const kws = extractKeywords(
      "ZodString ZodObject ZodArray ZodUnion ZodLiteral ZodTuple",
      3,
    );
    expect(kws.length).toBeLessThanOrEqual(3);
  });

  it("treats dotted names as identifier-ish", () => {
    const kws = extractKeywords("how does requests.get work in the session");
    expect(kws.some((k) => k.includes("requests.get"))).toBe(true);
  });

  it("returns at most max but at least one for normal queries", () => {
    const kws = extractKeywords("HttpAdapter sends a request");
    expect(kws.length).toBeGreaterThanOrEqual(1);
    expect(kws[0]).toBe("HttpAdapter");
  });
});

function ann(query: string): Annotation {
  return { query, relevant: [], secondary: [], category: "test" };
}

describe("pickAgentTasks", () => {
  it("round-robins across repos", () => {
    const map = new Map<string, Annotation[]>([
      ["a", [ann("a-q1"), ann("a-q2"), ann("a-q3")]],
      ["b", [ann("b-q1"), ann("b-q2"), ann("b-q3")]],
      ["c", [ann("c-q1"), ann("c-q2"), ann("c-q3")]],
    ]);
    const picked = pickAgentTasks(map, 6);
    expect(picked.map((p) => p.repo)).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("doesn't exceed available annotations", () => {
    const map = new Map<string, Annotation[]>([
      ["a", [ann("a-q1")]],
      ["b", [ann("b-q1"), ann("b-q2")]],
    ]);
    const picked = pickAgentTasks(map, 10);
    // Only 3 annotations exist in total — should stop at 3.
    expect(picked.length).toBe(3);
  });

  it("is deterministic — same input → same selection", () => {
    const map = new Map<string, Annotation[]>([
      ["zod", [ann("z1"), ann("z2"), ann("z3")]],
      ["requests", [ann("r1"), ann("r2")]],
    ]);
    const a = pickAgentTasks(map, 4);
    const b = pickAgentTasks(map, 4);
    expect(a.map((x) => x.annotation.query)).toEqual(
      b.map((x) => x.annotation.query),
    );
  });

  it("indexes are 0-based and consistent within each repo", () => {
    const map = new Map<string, Annotation[]>([
      ["a", [ann("a1"), ann("a2"), ann("a3")]],
      ["b", [ann("b1"), ann("b2"), ann("b3")]],
    ]);
    const picked = pickAgentTasks(map, 4);
    const aPicks = picked.filter((p) => p.repo === "a");
    expect(aPicks.map((p) => p.index)).toEqual([0, 1]);
  });

  it("handles n=0 gracefully", () => {
    const map = new Map<string, Annotation[]>([["a", [ann("a1")]]]);
    expect(pickAgentTasks(map, 0)).toEqual([]);
  });
});
