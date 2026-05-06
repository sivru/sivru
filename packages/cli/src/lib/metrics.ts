// Retrieval-quality metrics for `sivru bench personal`. Pure helpers
// — kept here (not in `@sivrujs/search`) because they're CLI-specific:
// tied to the bench's per-query loop, not the search package's runtime.
//
// recall@k and MRR are file-level, not chunk-level. Rationale: agent
// ground truth is a set of files (Edit/Write/Read targets); whether
// the right CHUNK of the right file ranks first matters less than
// whether ANY chunk of the right file appears in the top-k.

export type SearchHitLike = {
  chunk: { filePath: string };
};

/**
 * Recall@k = |relevant ∩ retrieved_top_k_files| / |relevant|.
 * Returns 0 when the relevant set is empty (caller should filter
 * those queries out of recall reporting; we don't conflate
 * "missing ground truth" with "perfect zero recall").
 */
export function recallAtK(
  hits: readonly SearchHitLike[],
  relevantFiles: readonly string[],
  k: number,
): number {
  if (relevantFiles.length === 0) return 0;
  if (k <= 0) return 0;
  const top = hits.slice(0, k);
  const retrieved = new Set(top.map((h) => h.chunk.filePath));
  let intersect = 0;
  for (const f of relevantFiles) {
    if (retrieved.has(f)) intersect++;
  }
  return intersect / relevantFiles.length;
}

/**
 * MRR = 1 / (1-indexed rank of the first relevant file in `hits`).
 * 0 when no relevant file appears in the top-k.
 */
export function mrr(
  hits: readonly SearchHitLike[],
  relevantFiles: readonly string[],
  k = Number.POSITIVE_INFINITY,
): number {
  if (relevantFiles.length === 0) return 0;
  const relevant = new Set(relevantFiles);
  const limit = Math.min(hits.length, k);
  for (let i = 0; i < limit; i++) {
    const h = hits[i];
    if (h !== undefined && relevant.has(h.chunk.filePath)) return 1 / (i + 1);
  }
  return 0;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[m - 1] ?? 0) + (sorted[m] ?? 0)) / 2;
  }
  return sorted[m] ?? 0;
}

/**
 * Linearly-interpolated percentile (R-7 / Excel-style). Matches
 * vitest snapshots produced by Math libraries; sufficient for our
 * report quality.
 */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? 0;
  const h = clamped * (sorted.length - 1);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo] ?? 0;
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * (h - lo);
}

/**
 * Bootstrap percentile CI on the mean. Same algorithm as the bench
 * uses elsewhere — re-exposed here so all metrics flow through one
 * helper.
 */
export function bootstrapCIMean(
  values: readonly number[],
  iterations = 2000,
  seed = 0xb7c8d9e1,
): { p05: number; p50: number; p95: number } {
  if (values.length === 0) return { p05: 0, p50: 0, p95: 0 };
  const rng = makeMulberry32(seed);
  const stats = new Array<number>(iterations);
  const buf = new Array<number>(values.length);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < values.length; j++) {
      buf[j] = values[Math.floor(rng() * values.length)] ?? 0;
    }
    stats[i] = mean(buf);
  }
  stats.sort((a, b) => a - b);
  return {
    p05: stats[Math.floor(iterations * 0.05)] ?? 0,
    p50: stats[Math.floor(iterations * 0.5)] ?? 0,
    p95: stats[Math.floor(iterations * 0.95)] ?? 0,
  };
}

function makeMulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
