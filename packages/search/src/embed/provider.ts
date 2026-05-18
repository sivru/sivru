export type EmbeddingProvider = {
  /** Vector dimension this provider produces. */
  readonly dim: number;
  /**
   * Stable identifier for this provider + model pair. Used as the
   * embedder component of the on-disk cache key (DESIGN-0002 §4): chunk
   * boundaries now depend on the embedder, so two embedders must never
   * share a cache entry. Conventionally the HF model id. Omit for ad-hoc
   * providers — `buildIndex` then falls back to a generic `"embed"` tag.
   */
  readonly id?: string;
  /**
   * Effective per-chunk content-token budget: the model's real context
   * window minus its fixed special-token overhead (`[CLS]`/`[SEP]` etc.).
   * Read by the provider from the loaded tokenizer config — NOT a
   * hand-maintained catalog number, so it stays correct for fine-tunes.
   * Omit for windowless embedders (Model2Vec / potion); chunk-windowing
   * is then skipped and behaviour matches v0.2 (DESIGN-0002 §1).
   *
   * Only meaningful after the provider has loaded its tokenizer (the
   * first `embed()` call, or an explicit prime); `undefined` before then.
   * Typed `| undefined` so a getter-backed implementation can report the
   * not-yet-loaded state under `exactOptionalPropertyTypes`.
   */
  readonly contextTokens?: number | undefined;
  /**
   * Count of CONTENT tokens in `text` — tokenized with
   * `add_special_tokens: false`. Content tokens are additive across a
   * newline join, so the windower can sum per-line counts (DESIGN-0002
   * D4/D6). Omit to fall back to a byte heuristic.
   *
   * Requires the tokenizer to be loaded; call after the provider's first
   * `embed()` (or prime). `buildIndex` primes before it windows.
   */
  countTokens?(text: string): number;
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
