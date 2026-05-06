/**
 * Row-major flat-matrix layout: data[i*d + j] is component j of vector i.
 * Used for the hot path so V8 can keep everything in cache (DESIGN.md §4.3).
 */
export type CosineMatrix = {
  readonly data: Float32Array;
  /** Number of rows (vectors). */
  readonly n: number;
  /** Number of dimensions per vector. */
  readonly d: number;
};

export type CosineHit = {
  /** Row index into the matrix; the caller maps it back to a docId. */
  index: number;
  /** Cosine similarity in [-1, 1]. */
  score: number;
};

/** Pack same-dim vectors into a CosineMatrix. Throws if any vector's length != the first vector's. */
export function packMatrix(vectors: readonly Float32Array[]): CosineMatrix {
  const n = vectors.length;
  if (n === 0) {
    return { data: new Float32Array(0), n: 0, d: 0 };
  }
  const first = vectors[0]!;
  const d = first.length;
  const data = new Float32Array(n * d);
  for (let i = 0; i < n; i++) {
    const v = vectors[i]!;
    if (v.length !== d) {
      throw new Error(
        `packMatrix: dimension mismatch at index ${i} (expected ${d}, got ${v.length})`,
      );
    }
    data.set(v, i * d);
  }
  return { data, n, d };
}

/**
 * Top-k cosine similarity. Assumes both matrix rows AND `query` are already
 * L2-normalized — when both are unit vectors, dot product == cosine. The
 * caller is responsible for normalization.
 */
export function cosineTopK(
  matrix: CosineMatrix,
  query: Float32Array,
  k: number,
): CosineHit[] {
  const { data, n, d } = matrix;
  if (n === 0 || k <= 0) return [];

  const scores = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const off = i * d;
    let s = 0;
    // Hand-rolled scalar dot product; V8 auto-vectorizes this loop.
    for (let j = 0; j < d; j++) {
      s += data[off + j]! * query[j]!;
    }
    scores[i] = s;
  }

  const hits: CosineHit[] = new Array(n);
  for (let i = 0; i < n; i++) {
    hits[i] = { index: i, score: scores[i]! };
  }

  // v1: full sort. Replace with a min-heap of size k once N grows past ~10k.
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return k >= n ? hits : hits.slice(0, k);
}
