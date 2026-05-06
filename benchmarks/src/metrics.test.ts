import { describe, expect, test } from "vitest";
import { dcg, meanNdcgAtK, ndcgAtK } from "./metrics.js";

describe("dcg", () => {
  test("empty list = 0", () => {
    expect(dcg([])).toBe(0);
  });

  test("single relevant at rank 1 = 1", () => {
    // log2(0+2) = 1, so 1/1 = 1
    expect(dcg([1])).toBe(1);
  });

  test("relevant at rank 2 = 1/log2(3)", () => {
    expect(dcg([0, 1])).toBeCloseTo(1 / Math.log2(3), 10);
  });
});

describe("ndcgAtK", () => {
  test("nRelevant=0 → 0", () => {
    expect(ndcgAtK([], 0, 10)).toBe(0);
  });

  test("perfect retrieval (relevant items at top) = 1", () => {
    // 3 relevant items found at ranks 1, 2, 3 — perfect ordering
    expect(ndcgAtK([1, 2, 3], 3, 10)).toBeCloseTo(1, 10);
  });

  test("retrieval at the bottom of cutoff scores below perfect", () => {
    const score = ndcgAtK([8, 9, 10], 3, 10);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  test("relevant ranks beyond k are ignored", () => {
    // Only ranks 1..k are credited
    expect(ndcgAtK([15, 20], 2, 10)).toBe(0);
  });

  test("partial coverage (1 of 2 relevant items found at rank 1)", () => {
    // ideal = dcg([1, 1]) = 1 + 1/log2(3)
    // actual = dcg([1]) = 1
    const ideal = 1 + 1 / Math.log2(3);
    expect(ndcgAtK([1], 2, 10)).toBeCloseTo(1 / ideal, 10);
  });
});

describe("meanNdcgAtK", () => {
  test("skips queries with no relevant items", () => {
    const result = meanNdcgAtK(
      [
        { relevantRanks: [1], nRelevant: 1 },
        { relevantRanks: [], nRelevant: 0 }, // skipped
        { relevantRanks: [2], nRelevant: 1 },
      ],
      10,
    );
    expect(result.scored).toBe(2);
    expect(result.skipped).toBe(1);
    // mean of 1.0 and 1/log2(3) = (1 + 0.6309…) / 2
    expect(result.mean).toBeCloseTo((1 + 1 / Math.log2(3)) / 2, 10);
  });

  test("all-skipped → mean=0", () => {
    const result = meanNdcgAtK(
      [
        { relevantRanks: [], nRelevant: 0 },
        { relevantRanks: [], nRelevant: 0 },
      ],
      10,
    );
    expect(result.mean).toBe(0);
    expect(result.scored).toBe(0);
    expect(result.skipped).toBe(2);
  });
});
