import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([3, 1, 2], 3, async (n) => {
      await new Promise((r) => setTimeout(r, n)); // longer items finish later
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("returns [] for an empty input", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return 0;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("passes the index to the mapper", async () => {
    const out = await mapWithConcurrency(["a", "b", "c"], 2, async (x, i) => `${x}${i}`);
    expect(out).toEqual(["a0", "b1", "c2"]);
  });

  it("clamps a limit larger than the item count", async () => {
    const out = await mapWithConcurrency([1, 2], 100, async (n) => n + 1);
    expect(out).toEqual([2, 3]);
  });
});
