// CrossEncoder — pluggable reranker contract.
//
// Why this exists: bi-encoder retrieval (BM25 + embedding cosine) is
// fast but coarse. Cross-encoders score (query, document) PAIRS in a
// single transformer pass — much more accurate, much slower. Standard
// pattern: BM25⊕cosine retrieves top-N candidates → cross-encoder
// rescores them → return top-K. Usually +10–20% NDCG@10 on retrieval
// benchmarks at the cost of ~50 transformer forward passes per query.
//
// We deliberately keep the interface tiny: one method, batch-aware,
// no side channels. Score scale is implementation-defined — only
// relative order matters. Implementations live alongside this file
// (see `transformers.ts`, `mock.ts`).

export type CrossEncoder = {
  /** Identifier for diagnostics (e.g. the HF model id). */
  readonly modelId: string;
  /**
   * Score `documents` against `query`. Higher score = more relevant.
   * Returns an array of length `documents.length`, in the same order.
   * Empty input → empty output, never throws.
   *
   * Latency: O(documents.length / batch_size) transformer passes.
   * Implementations are responsible for batching internally so the
   * caller only awaits one Promise per `score()` call.
   */
  score(query: string, documents: readonly string[]): Promise<number[]>;
};
