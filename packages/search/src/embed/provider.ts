export type EmbeddingProvider = {
  /** Vector dimension this provider produces. */
  readonly dim: number;
  /** Embed a single text into a Float32Array of length `dim`. The result MUST be L2-normalized. */
  embed(text: string): Promise<Float32Array>;
  /** Optional batched form. The default impl in factory functions just maps `embed`. */
  embedBatch?(texts: readonly string[]): Promise<Float32Array[]>;
  /**
   * Optional asymmetric query encoder. Used by `searchHybrid` to encode
   * the search query when the provider needs a different prompt /
   * instruction prefix for queries vs. documents.
   *
   * BGE-family, Nomic, and E5 models require this for correct retrieval
   * — without it they're encoded as documents and recall drops 5–15%.
   * For symmetric providers (potion, MiniLM, jina-code) `embed` and
   * `embedQuery` are equivalent and this method can be omitted.
   *
   * `embed`-only callers (e.g. cache rehydration, `findRelated` against
   * a chunk's content) intentionally bypass this — that path encodes a
   * document, not a query.
   */
  embedQuery?(text: string): Promise<Float32Array>;
};
