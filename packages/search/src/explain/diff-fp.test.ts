// --diff false-positive rate gate (DESIGN-0004 §5 #2 / T17).
//
// Runs every fixture in DIFF_FP_FIXTURES through parseRemovedSymbols and
// computes the mean FP rate. The build fails when the corpus is smaller
// than 10 OR the mean FP rate exceeds 15%.

import { describe, expect, it } from "vitest";

import { DIFF_FP_FIXTURES } from "./__fixtures__/diff-fp/fixtures.js";
import { parseRemovedSymbols } from "./diff.js";

function fpRate(reported: readonly string[], truth: readonly string[]): number {
  if (reported.length === 0) return 0;
  const truthSet = new Set(truth);
  const fp = reported.filter((s) => !truthSet.has(s)).length;
  return fp / reported.length;
}

describe("--diff FP corpus", () => {
  it("has at least 10 fixtures (design §5 #2)", () => {
    expect(DIFF_FP_FIXTURES.length).toBeGreaterThanOrEqual(10);
  });

  it("mean false-positive rate is ≤ 15% across the corpus", () => {
    const perFixture: { id: string; reported: string[]; fpRate: number }[] = [];
    let sum = 0;
    for (const fixture of DIFF_FP_FIXTURES) {
      const reported = parseRemovedSymbols(fixture.diff);
      const rate = fpRate(reported, fixture.trueRemoved);
      perFixture.push({ id: fixture.id, reported, fpRate: rate });
      sum += rate;
    }
    const mean = sum / DIFF_FP_FIXTURES.length;
    // Surface every fixture's contribution on failure so the regression is
    // navigable from one stack trace.
    if (mean > 0.15) {
      const breakdown = perFixture
        .map(
          (p) =>
            `  ${p.id}: reported=[${p.reported.join(", ")}], fpRate=${p.fpRate.toFixed(2)}`,
        )
        .join("\n");
      throw new Error(
        `mean FP rate ${mean.toFixed(3)} exceeds 0.15 budget\n${breakdown}`,
      );
    }
    expect(mean).toBeLessThanOrEqual(0.15);
  });

  it("per-fixture recall (ground-truth removed symbols are all reported)", () => {
    for (const fixture of DIFF_FP_FIXTURES) {
      const reported = new Set(parseRemovedSymbols(fixture.diff));
      for (const name of fixture.trueRemoved) {
        expect(reported.has(name), `${fixture.id}: missing ${name}`).toBe(true);
      }
    }
  });
});
