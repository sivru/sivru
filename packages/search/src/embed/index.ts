// Barrel for the embed module — three pluggable EmbeddingProvider
// implementations ship today; users with bespoke models can implement the
// `EmbeddingProvider` contract directly (just `dim` + `embed(text)`).

export type { EmbeddingProvider } from "./provider.js";

export type { MockProviderOptions } from "./mock.js";
export { createMockEmbeddingProvider } from "./mock.js";

export type { TransformersProviderOptions } from "./transformers.js";
export { createTransformersProvider } from "./transformers.js";

export type { PotionProviderOptions } from "./potion.js";
export { createPotionProvider } from "./potion.js";

export type {
  HttpEmbeddingProviderOptions,
  HttpEmbeddingRequestShape,
} from "./http.js";
export { createHttpEmbeddingProvider } from "./http.js";
