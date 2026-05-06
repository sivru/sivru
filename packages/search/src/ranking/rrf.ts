export type RankedHit = { id: number; score: number };
export type RankedList = readonly RankedHit[];

export type RrfOptions = {
  /** RRF_K constant from Cormack et al. Default 60. */
  k?: number;
  /** Cap output to top N. Default Infinity. */
  topN?: number;
};

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists into one.
 * Input scores are ignored; only ranks contribute.
 * Output: sorted by fused score desc, ties broken by lower id first.
 */
export function reciprocalRankFusion(
  lists: readonly RankedList[],
  options?: RrfOptions,
): RankedHit[] {
  const k = options?.k ?? 60;
  const topN = options?.topN ?? Number.POSITIVE_INFINITY;

  if (lists.length === 0) return [];

  const fused = new Map<number, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const hit = list[i];
      if (hit === undefined) continue;
      const rank = i + 1;
      const contribution = 1 / (k + rank);
      const prev = fused.get(hit.id) ?? 0;
      fused.set(hit.id, prev + contribution);
    }
  }

  if (fused.size === 0) return [];

  const out: RankedHit[] = [];
  for (const [id, score] of fused) {
    out.push({ id, score });
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id - b.id;
  });

  if (topN !== Number.POSITIVE_INFINITY && out.length > topN) {
    out.length = topN;
  }
  return out;
}
