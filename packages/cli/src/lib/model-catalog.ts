// Model catalog — single source of truth for embedding models the CLI
// knows about by short name.
//
// Used by:
//   - `sivru bench personal --models bm25,potion,…`  (multi-sweep)
//   - `sivru search --embed=<name>`                  (one-off search)
//   - `sivru bench models`                           (list with metadata)
//   - `sivru config set embedder <name>`             (persistent default)
//   - The MCP server (reads config to pick the right provider)
//
// The metadata is best-effort and based on:
//   - HF model card / paper claims for params + dim + context window
//   - On-disk size measured via the on-first-use download (commodity macOS M-series)
//   - RAM / CPU figures sampled on commodity laptops (Apple M2 Pro / Linux x86_64)
//
// These are estimates — your mileage will vary. Run
// `sivru bench personal --models <name>` to get numbers for YOUR machine
// + corpus.

import {
  createPotionProvider,
  createTransformersCrossEncoder,
  createTransformersProvider,
  type CrossEncoder,
  type EmbeddingProvider,
} from "@sivrujs/search";

/** Stable identity for a registered model — what users type. */
export type ModelShortName = string;

/** Approximate resource bands. Bench it locally for real numbers. */
export type ModelMetadata = {
  /** What we tell the user; used in the catalog list and CLI output. */
  label: string;
  /** Param count or "n/a" for non-neural models. */
  params: string;
  /** Vector dimension. 0 for bm25 (no vectors). */
  dim: number;
  /** Max input length the model accepts. 0 for n/a. */
  contextTokens: number;
  /** On-disk model size in MB after download. 0 for bm25. */
  diskMB: number;
  /** Approximate idle RAM held by the loaded model (MB). 0 for bm25. */
  ramIdleMB: number;
  /** Approximate peak RAM during embedding a 16k-chunk corpus (MB). 0 for bm25. */
  ramPeakEmbedMB: number;
  /**
   * Approximate per-chunk inference time on a 2024-era CPU (Apple M-series
   * or modern x86). Lower bound; the cold first call is slower.
   */
  approxMsPerChunkCpu: number;
  /**
   * Approximate cold-start time on a 16k-chunk corpus (build the full
   * cosine matrix from scratch). For comparison shopping. Doesn't include
   * model download.
   */
  approxColdStartMin: number;
  /** SPDX identifier of the model's license. */
  license: string;
  /** True when the model was trained specifically on code. */
  codeOptimized: boolean;
  /** Why a user might pick this. One sentence. */
  recommended: string;
  /** Where the model lives — useful for users wanting to inspect the card. */
  url: string;
};

/** Either a non-neural mode (bm25) or an embedding factory. */
export type ModelEntry =
  | {
      kind: "bm25";
      shortName: ModelShortName;
      metadata: ModelMetadata;
    }
  | {
      kind: "embed";
      shortName: ModelShortName;
      metadata: ModelMetadata;
      build: () => EmbeddingProvider;
    };

export const MODEL_REGISTRY: Record<ModelShortName, ModelEntry> = {
  bm25: {
    kind: "bm25",
    shortName: "bm25",
    metadata: {
      label: "bm25 (no embedder)",
      params: "n/a",
      dim: 0,
      contextTokens: 0,
      diskMB: 0,
      ramIdleMB: 0,
      ramPeakEmbedMB: 0,
      approxMsPerChunkCpu: 0,
      approxColdStartMin: 0,
      license: "n/a",
      codeOptimized: false,
      recommended:
        "Fastest cold-start, no model download. Strong baseline for identifier-shaped queries; weakest on natural-language behavior queries.",
      url: "https://en.wikipedia.org/wiki/Okapi_BM25",
    },
  },
  potion: {
    kind: "embed",
    shortName: "potion",
    metadata: {
      label: "potion-retrieval-32M (Model2Vec)",
      params: "32M",
      dim: 512,
      contextTokens: 256,
      diskMB: 130,
      ramIdleMB: 150,
      ramPeakEmbedMB: 200,
      // Model2Vec is a tokenize → row-lookup → mean-pool, no transformer
      // inference — sub-millisecond per chunk in practice.
      approxMsPerChunkCpu: 0.5,
      approxColdStartMin: 0.5,
      license: "MIT",
      codeOptimized: false,
      recommended:
        "Default. ~1000× faster than transformer alternatives at modest quality loss. Best speed/quality balance for typical sessions.",
      url: "https://huggingface.co/minishlab/potion-retrieval-32M",
    },
    build: () => createPotionProvider(),
  },
  minilm: {
    kind: "embed",
    shortName: "minilm",
    metadata: {
      label: "all-MiniLM-L6-v2",
      params: "22M",
      dim: 384,
      contextTokens: 256,
      diskMB: 22,
      ramIdleMB: 120,
      ramPeakEmbedMB: 250,
      approxMsPerChunkCpu: 8,
      approxColdStartMin: 12,
      license: "Apache 2.0",
      codeOptimized: false,
      recommended:
        "Smallest transformer here. Fast download, decent retrieval. The classic SBERT default — well-understood.",
      url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2",
    },
    build: () =>
      createTransformersProvider({ model: "Xenova/all-MiniLM-L6-v2" }),
  },
  "bge-small": {
    kind: "embed",
    shortName: "bge-small",
    metadata: {
      label: "bge-small-en-v1.5",
      params: "33M",
      dim: 384,
      contextTokens: 512,
      diskMB: 33,
      ramIdleMB: 140,
      ramPeakEmbedMB: 280,
      approxMsPerChunkCpu: 15,
      approxColdStartMin: 18,
      license: "MIT",
      codeOptimized: false,
      recommended:
        "Often beats MiniLM on retrieval benchmarks at similar size. Good general default if you want to upgrade from MiniLM.",
      url: "https://huggingface.co/Xenova/bge-small-en-v1.5",
    },
    build: () =>
      createTransformersProvider({ model: "Xenova/bge-small-en-v1.5" }),
  },
  "jina-code": {
    kind: "embed",
    shortName: "jina-code",
    metadata: {
      label: "jina-embeddings-v2-base-code",
      params: "161M",
      dim: 768,
      contextTokens: 8192,
      diskMB: 320,
      ramIdleMB: 500,
      ramPeakEmbedMB: 1200,
      approxMsPerChunkCpu: 70,
      approxColdStartMin: 45,
      license: "Apache 2.0",
      codeOptimized: true,
      recommended:
        "Trained specifically on code + natural-language queries. The strongest open option for code-search use; pays for it in cold-start time and RAM.",
      url: "https://huggingface.co/Xenova/jina-embeddings-v2-base-code",
    },
    build: () =>
      createTransformersProvider({
        model: "Xenova/jina-embeddings-v2-base-code",
      }),
  },
  "nomic-embed": {
    kind: "embed",
    shortName: "nomic-embed",
    metadata: {
      label: "nomic-embed-text-v1.5",
      params: "137M",
      dim: 768,
      contextTokens: 8192,
      diskMB: 270,
      ramIdleMB: 450,
      ramPeakEmbedMB: 1000,
      approxMsPerChunkCpu: 60,
      approxColdStartMin: 35,
      license: "Apache 2.0",
      codeOptimized: false,
      recommended:
        "General retrieval, with Matryoshka representation (dims can be truncated for smaller indexes). Strong on natural-language queries.",
      url: "https://huggingface.co/Xenova/nomic-embed-text-v1.5",
    },
    build: () =>
      createTransformersProvider({ model: "Xenova/nomic-embed-text-v1.5" }),
  },
};

/**
 * Resolve a short name to a registered model entry. Supports the
 * `hf:owner/model` short-form for arbitrary HF feature-extraction
 * models the user wants to try without it being in the registry.
 */
export function resolveModel(name: string): ModelEntry | null {
  const direct = MODEL_REGISTRY[name];
  if (direct !== undefined) return direct;
  if (name.startsWith("hf:")) {
    const model = name.slice(3);
    if (model.length === 0) return null;
    return {
      kind: "embed",
      shortName: name,
      metadata: {
        label: model,
        params: "?",
        dim: 0,
        contextTokens: 0,
        diskMB: 0,
        ramIdleMB: 0,
        ramPeakEmbedMB: 0,
        approxMsPerChunkCpu: 0,
        approxColdStartMin: 0,
        license: "?",
        codeOptimized: false,
        recommended:
          "Custom HF feature-extraction model. Cost / quality not in our catalog — bench it locally.",
        url: `https://huggingface.co/${model}`,
      },
      build: () => createTransformersProvider({ model }),
    };
  }
  return null;
}

/** All registered models in stable display order. */
export function listModels(): ModelEntry[] {
  // bm25 first (cheap baseline), then by approxColdStartMin (fastest first).
  return Object.values(MODEL_REGISTRY).sort((a, b) => {
    if (a.kind === "bm25" && b.kind !== "bm25") return -1;
    if (b.kind === "bm25" && a.kind !== "bm25") return 1;
    return a.metadata.approxColdStartMin - b.metadata.approxColdStartMin;
  });
}

// ─────────────────────────── reranker catalog ─────────────────────────
//
// Cross-encoder rerankers are conceptually parallel to embedders but
// sit at a different stage of the pipeline (they re-score candidates
// AFTER the bi-encoder retrieves them). Kept in a separate registry so
// the embedder picker stays focused.

/** Approximate resource bands for a registered reranker. */
export type RerankerMetadata = {
  label: string;
  params: string;
  diskMB: number;
  /** Approximate wall-clock to score top-50 pairs on a 2024-era CPU. */
  approxMsPerQueryAt50: number;
  license: string;
  recommended: string;
  url: string;
};

export type RerankerEntry = {
  kind: "rerank";
  shortName: string;
  metadata: RerankerMetadata;
  build: () => CrossEncoder;
};

export const RERANKER_REGISTRY: Record<string, RerankerEntry> = {
  "ms-marco-minilm": {
    kind: "rerank",
    shortName: "ms-marco-minilm",
    metadata: {
      label: "ms-marco-MiniLM-L-6-v2 (cross-encoder)",
      params: "23M",
      diskMB: 90,
      approxMsPerQueryAt50: 100,
      license: "Apache 2.0",
      recommended:
        "Default reranker. Smallest cross-encoder; fast enough for interactive use. Lifts NDCG@10 5–15% over bi-encoder-only retrieval.",
      url: "https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2",
    },
    build: () =>
      createTransformersCrossEncoder({
        model: "Xenova/ms-marco-MiniLM-L-6-v2",
      }),
  },
  "bge-reranker-base": {
    kind: "rerank",
    shortName: "bge-reranker-base",
    metadata: {
      label: "bge-reranker-base (cross-encoder)",
      params: "278M",
      diskMB: 280,
      approxMsPerQueryAt50: 500,
      license: "MIT",
      recommended:
        "Stronger reranker; ~5× the latency of ms-marco-minilm. Worth it when retrieval quality is the bottleneck and you can spend the cycles.",
      url: "https://huggingface.co/Xenova/bge-reranker-base",
    },
    build: () =>
      createTransformersCrossEncoder({ model: "Xenova/bge-reranker-base" }),
  },
};

export function resolveReranker(name: string): RerankerEntry | null {
  const direct = RERANKER_REGISTRY[name];
  if (direct !== undefined) return direct;
  if (name.startsWith("hf:")) {
    const model = name.slice(3);
    if (model.length === 0) return null;
    return {
      kind: "rerank",
      shortName: name,
      metadata: {
        label: model,
        params: "?",
        diskMB: 0,
        approxMsPerQueryAt50: 0,
        license: "?",
        recommended:
          "Custom HF text-classification cross-encoder. Cost / quality not in our catalog — bench it locally.",
        url: `https://huggingface.co/${model}`,
      },
      build: () => createTransformersCrossEncoder({ model }),
    };
  }
  return null;
}

export function listRerankers(): RerankerEntry[] {
  return Object.values(RERANKER_REGISTRY).sort(
    (a, b) => a.metadata.approxMsPerQueryAt50 - b.metadata.approxMsPerQueryAt50,
  );
}
