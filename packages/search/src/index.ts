// Public API of `@sivru/search`. W2 Pass 1 lights up the BM25-backed
// `buildIndex` + `SivruIndex.searchBM25` flow over the W1 walker + chunker;
// embeddings, cosine, and RRF land in Pass 2 behind the same facade.

export const SIVRU_SEARCH_VERSION = "0.1.0";

export type {
  Chunk,
  ChunkKind,
  ChunkOptions,
  SearchResult,
  SkipReason,
  WalkEntry,
  WalkOptions,
} from "./types.js";

export { walk } from "./walker/walk.js";
export { chunkFile } from "./chunker/chunk.js";
export { detectLanguage } from "./chunker/language.js";
export { lineFallbackChunks } from "./chunker/lineFallback.js";

export { tokenize } from "./bm25/tokenizer.js";
export type { TokenizeOptions } from "./bm25/tokenizer.js";

export { createBm25Index } from "./bm25/index.js";
export type {
  Bm25Document,
  Bm25Index,
  Bm25Options,
  Bm25SearchHit,
} from "./bm25/index.js";

export { packMatrix, cosineTopK } from "./vector/cosine.js";
export type { CosineHit, CosineMatrix } from "./vector/cosine.js";

export { reciprocalRankFusion } from "./ranking/rrf.js";
export type { RankedHit, RankedList, RrfOptions } from "./ranking/rrf.js";

export { applySignals, isSymbolLikeQuery } from "./ranking/signals.js";
export type { SignalConfig } from "./ranking/signals.js";

export { createIndexCache, CACHE_FORMAT_VERSION } from "./cache/index.js";
export { computeStateId } from "./cache/state-id.js";
export type {
  CacheKey,
  CachedIndex,
  IndexCache,
  IndexCacheOptions,
} from "./cache/index.js";

export type { EmbeddingProvider } from "./embed/provider.js";
export {
  createMockEmbeddingProvider,
  createTransformersProvider,
  createPotionProvider,
  createHttpEmbeddingProvider,
} from "./embed/index.js";
export type {
  MockProviderOptions,
  TransformersProviderOptions,
  PotionProviderOptions,
  HttpEmbeddingProviderOptions,
  HttpEmbeddingRequestShape,
} from "./embed/index.js";

export { buildIndex, defaultEmbedFilter } from "./search.js";
export type {
  BuildIndexEmbedOptions,
  BuildIndexOptions,
  BuildIndexProgress,
  RerankOptions,
  SearchHit,
  SivruIndex,
} from "./search.js";

export type { CrossEncoder } from "./rerank/index.js";
export {
  createMockCrossEncoder,
  createTransformersCrossEncoder,
} from "./rerank/index.js";
export type {
  MockCrossEncoderOptions,
  TransformersCrossEncoderOptions,
} from "./rerank/index.js";
