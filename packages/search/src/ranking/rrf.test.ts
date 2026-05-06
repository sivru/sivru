import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./rrf.js";
import type { RankedList } from "./rrf.js";

describe("reciprocalRankFusion", () => {
  it("returns [] for empty lists input", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it("returns [] when all input lists are empty", () => {
    expect(reciprocalRankFusion([[], [], []])).toEqual([]);
  });

  it("preserves order and computes scores for a single list", () => {
    const list: RankedList = [
      { id: 1, score: 9 },
      { id: 2, score: 8 },
    ];
    const out = reciprocalRankFusion([list]);
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe(1);
    expect(out[1]?.id).toBe(2);
    expect(out[0]?.score).toBeCloseTo(1 / (60 + 1), 12);
    expect(out[1]?.score).toBeCloseTo(1 / (60 + 2), 12);
  });

  it("ignores input scores; only ranks contribute", () => {
    const list: RankedList = [
      { id: 7, score: 0.0001 },
      { id: 8, score: 9999 },
    ];
    const out = reciprocalRankFusion([list]);
    expect(out[0]?.id).toBe(7);
    expect(out[0]?.score).toBeCloseTo(1 / 61, 12);
    expect(out[1]?.id).toBe(8);
    expect(out[1]?.score).toBeCloseTo(1 / 62, 12);
  });

  it("sums disjoint lists correctly", () => {
    const a: RankedList = [
      { id: 1, score: 1 },
      { id: 2, score: 1 },
    ];
    const b: RankedList = [
      { id: 3, score: 1 },
      { id: 4, score: 1 },
    ];
    const out = reciprocalRankFusion([a, b]);
    expect(out).toHaveLength(4);
    const byId = new Map(out.map((h) => [h.id, h.score]));
    expect(byId.get(1)).toBeCloseTo(1 / 61, 12);
    expect(byId.get(2)).toBeCloseTo(1 / 62, 12);
    expect(byId.get(3)).toBeCloseTo(1 / 61, 12);
    expect(byId.get(4)).toBeCloseTo(1 / 62, 12);
  });

  it("ranks an id appearing at rank 1 in both lists highest", () => {
    const a: RankedList = [
      { id: 42, score: 0.9 },
      { id: 7, score: 0.5 },
      { id: 8, score: 0.4 },
    ];
    const b: RankedList = [
      { id: 42, score: 0.95 },
      { id: 99, score: 0.6 },
      { id: 100, score: 0.3 },
    ];
    const out = reciprocalRankFusion([a, b]);
    expect(out[0]?.id).toBe(42);
    expect(out[0]?.score).toBeCloseTo(2 / 61, 12);
    for (let i = 1; i < out.length; i++) {
      const hit = out[i];
      if (hit) {
        expect(hit.score).toBeLessThan(out[0]?.score ?? 0);
      }
    }
  });

  it("k=0 makes the rank-1 fused score exactly 1", () => {
    const list: RankedList = [
      { id: 1, score: 100 },
      { id: 2, score: 50 },
    ];
    const out = reciprocalRankFusion([list], { k: 0 });
    expect(out[0]?.id).toBe(1);
    expect(out[0]?.score).toBe(1);
    expect(out[1]?.score).toBeCloseTo(1 / 2, 12);
  });

  it("topN truncates the output", () => {
    const list: RankedList = [
      { id: 1, score: 1 },
      { id: 2, score: 1 },
      { id: 3, score: 1 },
      { id: 4, score: 1 },
    ];
    const out = reciprocalRankFusion([list], { topN: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe(1);
    expect(out[1]?.id).toBe(2);
  });

  it("breaks fused-score ties by lower id first", () => {
    const a: RankedList = [
      { id: 5, score: 0.9 },
      { id: 2, score: 0.8 },
    ];
    const b: RankedList = [
      { id: 2, score: 0.9 },
      { id: 5, score: 0.8 },
    ];
    const out = reciprocalRankFusion([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0]?.score).toBeCloseTo(out[1]?.score ?? -1, 12);
    expect(out[0]?.id).toBe(2);
    expect(out[1]?.id).toBe(5);
  });

  it("a duplicate id within one list contributes twice (caller bug behavior)", () => {
    const list: RankedList = [
      { id: 1, score: 1 },
      { id: 1, score: 1 },
    ];
    const out = reciprocalRankFusion([list]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(1);
    expect(out[0]?.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
  });

  it("default topN does not truncate", () => {
    const list: RankedList = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      score: 10 - i,
    }));
    const out = reciprocalRankFusion([list]);
    expect(out).toHaveLength(10);
  });
});
