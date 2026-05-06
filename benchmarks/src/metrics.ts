// NDCG@k for retrieval evaluation.
//
// Standard textbook DCG / NDCG. Used by ./runner.ts to score a retrieval
// adapter against the labeled corpus in ../annotations/.

/** Discounted Cumulative Gain for a list of binary relevances at positions 1..n. */
export function dcg(relevances: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < relevances.length; i++) {
    const rel = relevances[i] ?? 0;
    // log2(i+2) because ranks are 1-based; the +1 in log2(i+1) is the rank,
    // and the formula's denominator is log2(rank + 1) → log2(i + 2) when i is 0-based.
    total += rel / Math.log2(i + 2);
  }
  return total;
}

/**
 * NDCG@k given the 1-based ranks of relevant results and the total number of
 * relevant items. Returns 0 when no relevant items exist.
 *
 * - `relevantRanks` — for each relevant item that appeared in the result list,
 *   the 1-based rank it landed at. Items not in the result list are simply
 *   absent from the array (they contribute 0 to DCG).
 * - `nRelevant` — the total number of relevant items for this query (used to
 *   compute the ideal DCG for normalization).
 * - `k` — cutoff. NDCG@10 → k=10.
 */
export function ndcgAtK(
  relevantRanks: readonly number[],
  nRelevant: number,
  k: number,
): number {
  if (nRelevant === 0) return 0;

  const relevances = new Array<number>(k).fill(0);
  for (const rank of relevantRanks) {
    if (rank >= 1 && rank <= k) {
      relevances[rank - 1] = 1;
    }
  }

  const ideal = dcg(new Array<number>(Math.min(k, nRelevant)).fill(1));
  return ideal > 0 ? dcg(relevances) / ideal : 0;
}

/**
 * Aggregate NDCG@k across many queries. Returns the unweighted mean. Queries
 * with `nRelevant === 0` are skipped (cannot be scored) and reported separately.
 */
export function meanNdcgAtK(
  queries: ReadonlyArray<{ relevantRanks: readonly number[]; nRelevant: number }>,
  k: number,
): { mean: number; scored: number; skipped: number } {
  let sum = 0;
  let scored = 0;
  let skipped = 0;
  for (const q of queries) {
    if (q.nRelevant === 0) {
      skipped++;
      continue;
    }
    sum += ndcgAtK(q.relevantRanks, q.nRelevant, k);
    scored++;
  }
  return {
    mean: scored > 0 ? sum / scored : 0,
    scored,
    skipped,
  };
}
