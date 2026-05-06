// Lucene-style BM25 over pre-tokenized documents.
//
// Sparse posting list: term -> [{docId, freq}, ...]. Per-doc length and the
// running average doc length are cached. Caller assigns dense integer ids;
// addDocuments accumulates across calls.

export type Bm25Options = {
  /** k1 — term-frequency saturation. Lucene default 1.2. */
  k1?: number;
  /** b — length normalization. Lucene default 0.75. */
  b?: number;
};

export type Bm25Document = {
  /** Caller-assigned dense integer id, returned by search. */
  id: number;
  /** Already-tokenized document terms. */
  tokens: readonly string[];
};

export type Bm25SearchHit = { id: number; score: number };

export type Bm25Index = {
  addDocuments(docs: readonly Bm25Document[]): void;
  search(queryTokens: readonly string[], k: number): Bm25SearchHit[];
  size(): number;
};

type Posting = { docId: number; freq: number };

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;

export function createBm25Index(options: Bm25Options = {}): Bm25Index {
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;

  const postings = new Map<string, Posting[]>();
  // docId -> doc length (|D|).
  const docLengths = new Map<number, number>();
  let totalLength = 0;

  function addDocuments(docs: readonly Bm25Document[]): void {
    for (const doc of docs) {
      const tf = new Map<string, number>();
      for (const term of doc.tokens) {
        tf.set(term, (tf.get(term) ?? 0) + 1);
      }
      for (const [term, freq] of tf) {
        let list = postings.get(term);
        if (list === undefined) {
          list = [];
          postings.set(term, list);
        }
        list.push({ docId: doc.id, freq });
      }
      docLengths.set(doc.id, doc.tokens.length);
      totalLength += doc.tokens.length;
    }
  }

  function search(queryTokens: readonly string[], k: number): Bm25SearchHit[] {
    const n = docLengths.size;
    if (n === 0 || k <= 0 || queryTokens.length === 0) return [];

    const avgDL = totalLength / n;
    // Dedupe query terms — repeated query terms shouldn't multiply IDF weight.
    const uniqueTerms = new Set(queryTokens);
    const scores = new Map<number, number>();

    for (const term of uniqueTerms) {
      const list = postings.get(term);
      if (list === undefined || list.length === 0) continue;
      const nq = list.length;
      const idf = Math.log((n - nq + 0.5) / (nq + 0.5) + 1);
      if (idf === 0) continue;
      for (const { docId, freq } of list) {
        const dl = docLengths.get(docId) ?? 0;
        const norm = avgDL === 0 ? 1 : 1 - b + (b * dl) / avgDL;
        const denom = freq + k1 * norm;
        const contribution = (idf * (freq * (k1 + 1))) / denom;
        scores.set(docId, (scores.get(docId) ?? 0) + contribution);
      }
    }

    const hits: Bm25SearchHit[] = [];
    for (const [id, score] of scores) {
      if (score > 0) hits.push({ id, score });
    }
    hits.sort((a, b2) => (b2.score - a.score) || (a.id - b2.id));
    return hits.length > k ? hits.slice(0, k) : hits;
  }

  function size(): number {
    return docLengths.size;
  }

  return { addDocuments, search, size };
}
