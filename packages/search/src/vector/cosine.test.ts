import { describe, it, expect } from 'vitest';
import { packMatrix, cosineTopK } from './cosine.js';

function normalize(v: number[]): Float32Array {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

describe('packMatrix', () => {
  it('returns empty matrix for empty input', () => {
    const m = packMatrix([]);
    expect(m.n).toBe(0);
    expect(m.d).toBe(0);
    expect(m.data.length).toBe(0);
  });

  it('packs vectors row-major', () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([4, 5, 6]);
    const m = packMatrix([a, b]);
    expect(m.n).toBe(2);
    expect(m.d).toBe(3);
    expect(Array.from(m.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('throws on dimension mismatch', () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([4, 5]);
    expect(() => packMatrix([a, b])).toThrow(/dimension mismatch/);
  });
});

describe('cosineTopK', () => {
  it('returns [] on empty matrix', () => {
    const m = packMatrix([]);
    const q = new Float32Array(3);
    expect(cosineTopK(m, q, 5)).toEqual([]);
  });

  it('single row identical to query scores 1', () => {
    const v = normalize([1, 2, 3]);
    const m = packMatrix([v]);
    const hits = cosineTopK(m, v, 1);
    expect(hits.length).toBe(1);
    expect(hits[0]!.index).toBe(0);
    expect(hits[0]!.score).toBeCloseTo(1, 6);
  });

  it('orthogonal vectors score 0', () => {
    const a = normalize([1, 0, 0]);
    const b = normalize([0, 1, 0]);
    const m = packMatrix([a]);
    const hits = cosineTopK(m, b, 1);
    expect(hits[0]!.score).toBeCloseTo(0, 6);
  });

  it('anti-parallel unit vectors score -1', () => {
    const a = normalize([1, 2, 3]);
    const b = normalize([-1, -2, -3]);
    const m = packMatrix([a]);
    const hits = cosineTopK(m, b, 1);
    expect(hits[0]!.score).toBeCloseTo(-1, 6);
  });

  it('hand-computed 4x3 correctness', () => {
    // Query roughly aligned with row 0; row 3 is anti-parallel to row 0.
    const r0 = normalize([1, 0, 0]);
    const r1 = normalize([1, 1, 0]);
    const r2 = normalize([0, 1, 0]);
    const r3 = normalize([-1, 0, 0]);
    const m = packMatrix([r0, r1, r2, r3]);
    const q = normalize([1, 0, 0]);

    const hits = cosineTopK(m, q, 4);
    expect(hits.map((h) => h.index)).toEqual([0, 1, 2, 3]);
    expect(hits[0]!.score).toBeCloseTo(1, 6);
    expect(hits[1]!.score).toBeCloseTo(Math.SQRT1_2, 6);
    expect(hits[2]!.score).toBeCloseTo(0, 6);
    expect(hits[3]!.score).toBeCloseTo(-1, 6);

    const top2 = cosineTopK(m, q, 2);
    expect(top2.length).toBe(2);
    expect(top2.map((h) => h.index)).toEqual([0, 1]);
  });

  it('all-zero query returns top-k rows with score 0 by ascending index', () => {
    const m = packMatrix([
      normalize([1, 0, 0]),
      normalize([0, 1, 0]),
      normalize([0, 0, 1]),
    ]);
    const q = new Float32Array(3); // all zeros
    const hits = cosineTopK(m, q, 2);
    expect(hits.map((h) => h.index)).toEqual([0, 1]);
    for (const h of hits) expect(h.score).toBeCloseTo(0, 6);
  });

  it('k > n returns all rows', () => {
    const m = packMatrix([
      normalize([1, 0]),
      normalize([0, 1]),
    ]);
    const q = normalize([1, 1]);
    const hits = cosineTopK(m, q, 100);
    expect(hits.length).toBe(2);
    // both have equal score; tie-break favors lower index
    expect(hits.map((h) => h.index)).toEqual([0, 1]);
    expect(hits[0]!.score).toBeCloseTo(Math.SQRT1_2, 6);
    expect(hits[1]!.score).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('stable tie-break: lower index first when scores tie', () => {
    const m = packMatrix([
      normalize([1, 0]),
      normalize([1, 0]),
      normalize([1, 0]),
    ]);
    const q = normalize([1, 0]);
    const hits = cosineTopK(m, q, 3);
    expect(hits.map((h) => h.index)).toEqual([0, 1, 2]);
  });
});
