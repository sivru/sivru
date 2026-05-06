import { describe, expect, it } from "vitest";

import {
  bootstrapCIMean,
  mean,
  median,
  mrr,
  percentile,
  recallAtK,
  type SearchHitLike,
} from "./metrics.js";

function hits(...paths: string[]): SearchHitLike[] {
  return paths.map((p) => ({ chunk: { filePath: p } }));
}

describe("recallAtK", () => {
  it("returns 0 when relevant set is empty", () => {
    expect(recallAtK(hits("a.ts"), [], 5)).toBe(0);
  });

  it("returns 1.0 when all relevant files are in top-k", () => {
    expect(
      recallAtK(hits("a.ts", "b.ts", "c.ts"), ["a.ts", "b.ts"], 5),
    ).toBe(1);
  });

  it("returns partial recall when some are missed", () => {
    expect(
      recallAtK(hits("a.ts", "b.ts"), ["a.ts", "c.ts"], 5),
    ).toBeCloseTo(0.5);
  });

  it("only counts files within the top-k window", () => {
    // Relevant = {a.ts, c.ts}. Top-2 retrieves [noise, a]; only a is
    // in the window, so recall = 1/2.
    expect(
      recallAtK(
        hits("noise.ts", "a.ts", "b.ts", "c.ts"),
        ["a.ts", "c.ts"],
        2,
      ),
    ).toBeCloseTo(0.5);
  });

  it("k clamps to hits.length when smaller", () => {
    expect(recallAtK(hits("a.ts"), ["a.ts", "b.ts"], 100)).toBeCloseTo(0.5);
  });

  it("returns 0 for k <= 0", () => {
    expect(recallAtK(hits("a.ts"), ["a.ts"], 0)).toBe(0);
  });
});

// One of the cases above intentionally has a tricky window — let me
// add a clearer regression test:
describe("recallAtK — window semantics", () => {
  it("includes only the top-k retrieved files in the intersection", () => {
    // Relevant = {a, c}. Top-2 = [noise, a]. a ∈ relevant, c ∉ top-2.
    // Recall = 1/2 = 0.5.
    expect(
      recallAtK(
        hits("noise.ts", "a.ts", "b.ts", "c.ts"),
        ["a.ts", "c.ts"],
        2,
      ),
    ).toBeCloseTo(0.5);
    // Top-3 = [noise, a, b]. Still only a hits. Recall = 1/2.
    expect(
      recallAtK(
        hits("noise.ts", "a.ts", "b.ts", "c.ts"),
        ["a.ts", "c.ts"],
        3,
      ),
    ).toBeCloseTo(0.5);
    // Top-4 = [noise, a, b, c]. Both hit. Recall = 2/2 = 1.
    expect(
      recallAtK(
        hits("noise.ts", "a.ts", "b.ts", "c.ts"),
        ["a.ts", "c.ts"],
        4,
      ),
    ).toBe(1);
  });
});

describe("mrr", () => {
  it("returns 0 when no relevant file in hits", () => {
    expect(mrr(hits("a.ts", "b.ts"), ["c.ts"])).toBe(0);
  });

  it("returns 1 / (rank + 1) for first hit at rank N", () => {
    expect(mrr(hits("a.ts", "b.ts", "target.ts"), ["target.ts"])).toBeCloseTo(
      1 / 3,
    );
    expect(mrr(hits("target.ts", "x.ts"), ["target.ts"])).toBe(1);
  });

  it("respects k cutoff", () => {
    // target is at rank 3 (0-indexed 2). With k=2, target is outside → 0.
    expect(
      mrr(hits("a.ts", "b.ts", "target.ts"), ["target.ts"], 2),
    ).toBe(0);
  });

  it("returns 0 when relevant set is empty", () => {
    expect(mrr(hits("a.ts"), [])).toBe(0);
  });
});

describe("mean / median / percentile", () => {
  it("mean of empty = 0", () => {
    expect(mean([])).toBe(0);
  });

  it("median odd / even", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("percentile 0 / 50 / 100 round-trip", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 0.5)).toBe(3);
    expect(percentile(xs, 1)).toBe(5);
    // p25 of [1..5] interpolated = 2.0 (R-7 method)
    expect(percentile(xs, 0.25)).toBeCloseTo(2);
    expect(percentile(xs, 0.75)).toBeCloseTo(4);
  });
});

describe("bootstrapCIMean", () => {
  it("returns zeroes for empty input", () => {
    expect(bootstrapCIMean([])).toEqual({ p05: 0, p50: 0, p95: 0 });
  });

  it("CI is deterministic given the same seed", () => {
    const xs = [10, 20, 30, 40, 50];
    const a = bootstrapCIMean(xs, 500, 0xdead);
    const b = bootstrapCIMean(xs, 500, 0xdead);
    expect(a).toEqual(b);
  });

  it("p05 <= p50 <= p95", () => {
    const xs = [1, 5, 10, 15, 20, 25, 30];
    const ci = bootstrapCIMean(xs, 200);
    expect(ci.p05).toBeLessThanOrEqual(ci.p50);
    expect(ci.p50).toBeLessThanOrEqual(ci.p95);
  });
});
