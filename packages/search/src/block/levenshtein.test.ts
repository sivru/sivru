import { describe, it, expect } from "vitest";

import { closestMatch, levenshtein } from "./levenshtein.js";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("foo", "foo")).toBe(0);
  });
  it("returns full length when one is empty", () => {
    expect(levenshtein("", "hello")).toBe(5);
    expect(levenshtein("hello", "")).toBe(5);
  });
  it("computes basic edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("beta", "experimental")).toBeLessThan(13);
    expect(levenshtein("beta", "stable")).toBeGreaterThan(2);
  });
});

describe("closestMatch", () => {
  const maturity = ["stable", "experimental", "deprecated", "wip"];

  it("returns the closest within maxDistance", () => {
    expect(closestMatch("stbale", maturity, 3)).toBe("stable");
    expect(closestMatch("wip", maturity, 3)).toBe("wip");
  });

  it("returns undefined when nothing is close enough", () => {
    expect(closestMatch("gold", maturity, 3)).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(closestMatch("STABLE", maturity, 0)).toBe("stable");
  });
});
