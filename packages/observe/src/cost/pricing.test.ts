// Tests for the model pricing table + helpers (DESIGN.md §22.2).

import { describe, expect, it } from "vitest";

import {
  blendedRateUsdPerMTok,
  lookupPricing,
  MODEL_PRICING,
  turnCostUsd,
} from "./pricing.js";

describe("lookupPricing", () => {
  it("returns the entry for a known model", () => {
    const pricing = lookupPricing("claude-sonnet-4-6");
    expect(pricing).toEqual({ inUsdPerMTok: 3, outUsdPerMTok: 15 });
  });

  it("returns null for an unknown model", () => {
    expect(lookupPricing("gpt-9000-turbo")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(lookupPricing(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(lookupPricing("")).toBeNull();
  });

  it("does not match by regex / version suffix", () => {
    // Loud-failure design: a literal model ID NOT in the table must miss,
    // even if it looks like a Claude variant.
    expect(lookupPricing("claude-sonnet-4-6-20260101")).toBeNull();
    expect(lookupPricing("anthropic/claude-sonnet-4-6")).toBeNull();
  });

  it("table includes the documented Jan 2026 cohort", () => {
    expect(Object.keys(MODEL_PRICING)).toEqual(
      expect.arrayContaining([
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
      ]),
    );
  });
});

describe("turnCostUsd", () => {
  it("computes (in*$3 + out*$15) / 1e6 for sonnet-4-6", () => {
    const result = turnCostUsd({
      model: "claude-sonnet-4-6",
      tokensIn: 1000,
      tokensOut: 500,
    });
    expect(result).not.toBeNull();
    // (1000 * 3 + 500 * 15) / 1e6 = (3000 + 7500) / 1e6 = 0.0105
    expect(result?.usd).toBeCloseTo(0.0105, 10);
    expect(result?.pricing).toEqual({ inUsdPerMTok: 3, outUsdPerMTok: 15 });
  });

  it("returns null for an unknown model", () => {
    expect(
      turnCostUsd({ model: "unknown-model", tokensIn: 1000, tokensOut: 500 }),
    ).toBeNull();
  });

  it("returns null when model is undefined", () => {
    expect(
      turnCostUsd({ model: undefined, tokensIn: 1000, tokensOut: 500 }),
    ).toBeNull();
  });

  it("treats negative / non-finite token counts as 0", () => {
    const result = turnCostUsd({
      model: "claude-sonnet-4-6",
      tokensIn: -5,
      tokensOut: Number.NaN,
    });
    expect(result).not.toBeNull();
    expect(result?.usd).toBe(0);
  });
});

describe("blendedRateUsdPerMTok", () => {
  it("returns null for an empty array", () => {
    expect(blendedRateUsdPerMTok([])).toBeNull();
  });

  it("is volume-weighted across two priceable turns of different models", () => {
    // Turn A: opus-4-7, in=10_000, out=10_000. tokens=20_000.
    //   usd = (10_000*15 + 10_000*75) / 1e6 = 900_000 / 1e6 = 0.9
    // Turn B: haiku-4-5, in=10_000, out=10_000. tokens=20_000.
    //   usd = (10_000*1 + 10_000*5) / 1e6 = 60_000 / 1e6 = 0.06
    // totalUsd = 0.96, totalTokens = 40_000.
    // blended $/Mtok = 0.96 / 40_000 * 1e6 = 24.
    const blended = blendedRateUsdPerMTok([
      { model: "claude-opus-4-7", tokensIn: 10_000, tokensOut: 10_000 },
      { model: "claude-haiku-4-5", tokensIn: 10_000, tokensOut: 10_000 },
    ]);
    expect(blended).not.toBeNull();
    expect(blended).toBeCloseTo(24, 10);

    // Sanity: the unweighted average of (per-turn $/Mtok) would be different.
    // Turn A per-turn rate = 0.9 / 20_000 * 1e6 = 45.
    // Turn B per-turn rate = 0.06 / 20_000 * 1e6 = 3.
    // Unweighted mean = (45 + 3) / 2 = 24. Equal here only because tokens
    // are equal. Re-run with skewed volumes to actually distinguish — when
    // the cheap model dominates volume, the blended rate should slide
    // toward 3, not the unweighted 24.
    //   Turn A: opus  in=1k,  out=1k  → usd=0.09,  tokens=2_000
    //   Turn B: haiku in=99k, out=99k → usd=0.594, tokens=198_000
    //   totalUsd=0.684, totalTokens=200_000
    //   blended = 0.684 / 200_000 * 1e6 = 3.42
    const skewed = blendedRateUsdPerMTok([
      { model: "claude-opus-4-7", tokensIn: 1_000, tokensOut: 1_000 },
      { model: "claude-haiku-4-5", tokensIn: 99_000, tokensOut: 99_000 },
    ]);
    expect(skewed).not.toBeNull();
    expect(skewed).toBeCloseTo(3.42, 6);
    // Confirm we are NOT computing the unweighted mean of per-turn rates (24).
    expect(skewed).not.toBeCloseTo(24, 0);
  });

  it("skips unpriceable turns and uses only known-model turns", () => {
    const blended = blendedRateUsdPerMTok([
      { model: "unknown-model", tokensIn: 10_000, tokensOut: 10_000 },
      { model: "claude-sonnet-4-6", tokensIn: 1_000, tokensOut: 500 },
    ]);
    expect(blended).not.toBeNull();
    // Only the sonnet turn counts. usd = 0.0105. tokens = 1500.
    // blended = 0.0105 / 1500 * 1e6 = 7.
    expect(blended).toBeCloseTo(7, 10);
  });

  it("returns null when all turns are unpriceable", () => {
    const blended = blendedRateUsdPerMTok([
      { model: "unknown-a", tokensIn: 100, tokensOut: 200 },
      { model: undefined, tokensIn: 500, tokensOut: 500 },
    ]);
    expect(blended).toBeNull();
  });

  it("returns null when all priceable turns have zero tokens", () => {
    const blended = blendedRateUsdPerMTok([
      { model: "claude-sonnet-4-6", tokensIn: 0, tokensOut: 0 },
    ]);
    expect(blended).toBeNull();
  });
});
