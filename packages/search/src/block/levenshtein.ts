// Tiny Levenshtein edit-distance helper (DESIGN-0019 §9c). Used to
// power the "did you mean" suggestion on SIVRU-E213 maturity-invalid
// — typos like `beta` should suggest `experimental` (distance 3).
//
// O(m*n) DP, no early-termination tricks needed at this scale (the
// inputs are short identifier-like strings).

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/**
 * Return the closest candidate within `maxDistance` (inclusive), or
 * undefined when nothing is close enough. Used for E213's "did you
 * mean" message.
 */
export function closestMatch(
  target: string,
  candidates: readonly string[],
  maxDistance = 3,
): string | undefined {
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const cand of candidates) {
    const d = levenshtein(target.toLowerCase(), cand.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = cand;
    }
  }
  return best;
}
