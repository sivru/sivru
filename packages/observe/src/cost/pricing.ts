// Layer 1 cost analytics — model pricing table and helpers.
// See DESIGN.md §22.2.
//
// PRIVACY GUARANTEE (DESIGN.md §5.5): observe never makes network calls.
// This file is a pure pricing lookup — no fetches, no fs, no env reads.

/** USD per million tokens. */
export type ModelPricing = {
  /** Input tokens, $/1M. */
  inUsdPerMTok: number;
  /** Output tokens, $/1M. */
  outUsdPerMTok: number;
};

/**
 * Best-effort pricing table for known Claude model IDs as of Jan 2026.
 * Numbers are publicly listed Anthropic API prices. Update as Anthropic
 * publishes new tiers; mismatched / unknown model IDs return null and the
 * UI surfaces an "unknown model" badge per DESIGN.md §22.2.
 *
 * Lookup is LITERAL — we do not regex-match version suffixes. The table is
 * hand-maintained so unrecognized models fail loudly instead of silently
 * inheriting a default rate.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Frontier
  "claude-opus-4-7":   { inUsdPerMTok: 15, outUsdPerMTok: 75 },
  "claude-opus-4-6":   { inUsdPerMTok: 15, outUsdPerMTok: 75 },
  "claude-opus-4":     { inUsdPerMTok: 15, outUsdPerMTok: 75 },
  // Workhorse
  "claude-sonnet-4-6": { inUsdPerMTok: 3,  outUsdPerMTok: 15 },
  "claude-sonnet-4-5": { inUsdPerMTok: 3,  outUsdPerMTok: 15 },
  "claude-sonnet-4":   { inUsdPerMTok: 3,  outUsdPerMTok: 15 },
  // Cheap
  "claude-haiku-4-5":  { inUsdPerMTok: 1,  outUsdPerMTok: 5 },
  "claude-haiku-4":    { inUsdPerMTok: 1,  outUsdPerMTok: 5 },
};

/** Return the pricing for `modelId`, OR null when not in the table. */
export function lookupPricing(modelId: string | undefined): ModelPricing | null {
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  return MODEL_PRICING[modelId] ?? null;
}

/** Compute USD cost for one assistant turn, or null when the model is unknown. */
export function turnCostUsd(args: {
  model: string | undefined;
  tokensIn: number;
  tokensOut: number;
}): { usd: number; pricing: ModelPricing } | null {
  const pricing = lookupPricing(args.model);
  if (pricing === null) return null;
  const inTokens = Number.isFinite(args.tokensIn) ? Math.max(0, args.tokensIn) : 0;
  const outTokens = Number.isFinite(args.tokensOut) ? Math.max(0, args.tokensOut) : 0;
  const usd =
    (inTokens * pricing.inUsdPerMTok + outTokens * pricing.outUsdPerMTok) / 1_000_000;
  return { usd, pricing };
}

/**
 * Average $/Mtok blended across all turns in a session, weighted by token
 * volume. Used to convert sivru's token-savings estimate into a dollar
 * estimate. Returns null when the session has no priceable assistant turns.
 *
 * Volume weighting: each turn contributes `tokensIn + tokensOut` weight at
 * its blended single-turn $/Mtok rate. Equivalent to:
 *   totalUsd / totalTokens * 1e6
 * over all priceable turns.
 */
export function blendedRateUsdPerMTok(
  turns: ReadonlyArray<{
    model: string | undefined;
    tokensIn: number;
    tokensOut: number;
  }>,
): number | null {
  let totalUsd = 0;
  let totalTokens = 0;
  let priceableCount = 0;
  for (const turn of turns) {
    const cost = turnCostUsd(turn);
    if (cost === null) continue;
    const inTokens = Number.isFinite(turn.tokensIn) ? Math.max(0, turn.tokensIn) : 0;
    const outTokens = Number.isFinite(turn.tokensOut) ? Math.max(0, turn.tokensOut) : 0;
    const tokens = inTokens + outTokens;
    if (tokens <= 0) continue;
    totalUsd += cost.usd;
    totalTokens += tokens;
    priceableCount += 1;
  }
  if (priceableCount === 0 || totalTokens === 0) return null;
  return (totalUsd / totalTokens) * 1_000_000;
}
