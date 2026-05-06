// Transformers.js cross-encoder reranker. Lazy-loads the underlying
// model on first `score()` call, batches pairs internally, and is
// safe to share across queries (same pipeline reused).
//
// Two recommended models (both ported by Xenova for ONNX/Transformers.js):
//   - "Xenova/ms-marco-MiniLM-L-6-v2"    — ~90 MB, ~100 ms / 50 pairs CPU
//   - "Xenova/bge-reranker-base"         — ~280 MB, ~500 ms / 50 pairs CPU
// The first is the default — lower download bar, fast enough for
// interactive use. Switch to bge-reranker-base when you'd rather pay
// 5× the latency for ~5–10% better recall.
//
// API note: Transformers.js exposes cross-encoders via the
// `text-classification` pipeline. For these models the pipeline
// returns a single class per pair (the relevance score); we read
// `score` directly. `topk: 1` is fine because the model has only
// one output head.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CrossEncoder } from "./provider.js";

export type TransformersCrossEncoderOptions = {
  /** HF model id. Default `Xenova/ms-marco-MiniLM-L-6-v2`. */
  model?: string;
  /** Where Transformers.js caches downloaded models. */
  cacheDir?: string;
  /** Quantization. Default `fp32` (most compatible). */
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  /** Batch size for the underlying pipeline. Default 32. */
  batchSize?: number;
};

const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const DEFAULT_DTYPE: "fp32" | "fp16" | "q8" | "q4" = "fp32";
const DEFAULT_BATCH_SIZE = 32;

type TextClassificationResult = { label: string; score: number };

type TextClassificationPipelineFn = (
  inputs:
    | string
    | string[]
    | Array<{ text: string; text_pair: string }>,
  options?: { topk?: number },
) => Promise<TextClassificationResult | TextClassificationResult[]>;

type TransformersModule = {
  pipeline: (
    task: "text-classification",
    model?: string,
    options?: { dtype?: "fp32" | "fp16" | "q8" | "q4" },
  ) => Promise<TextClassificationPipelineFn>;
  env: { cacheDir: string };
};

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "sivru", "models");
}

export function createTransformersCrossEncoder(
  options?: TransformersCrossEncoderOptions,
): CrossEncoder {
  const modelId = options?.model ?? DEFAULT_MODEL;
  const dtype = options?.dtype ?? DEFAULT_DTYPE;
  const cacheDir = options?.cacheDir ?? defaultCacheDir();
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;

  let pipelinePromise: Promise<TextClassificationPipelineFn> | null = null;

  async function getPipeline(): Promise<TextClassificationPipelineFn> {
    if (pipelinePromise) return pipelinePromise;
    pipelinePromise = (async (): Promise<TextClassificationPipelineFn> => {
      mkdirSync(cacheDir, { recursive: true });
      const mod = (await import(
        "@huggingface/transformers"
      )) as unknown as TransformersModule;
      mod.env.cacheDir = cacheDir;
      return mod.pipeline("text-classification", modelId, { dtype });
    })();
    return pipelinePromise;
  }

  return {
    modelId,
    async score(query: string, documents: readonly string[]): Promise<number[]> {
      if (documents.length === 0) return [];
      const pipe = await getPipeline();
      const out = new Array<number>(documents.length);
      for (let i = 0; i < documents.length; i += batchSize) {
        const slice = documents.slice(i, i + batchSize);
        // Transformers.js convention for sentence-pair classification:
        // pass an array of { text, text_pair } objects. The pipeline
        // tokenizes them as a single concatenated input internally.
        const batchInput = slice.map((d) => ({ text: query, text_pair: d }));
        const result = await pipe(batchInput, { topk: 1 });
        const arr = Array.isArray(result) ? result : [result];
        for (let j = 0; j < arr.length; j++) {
          out[i + j] = arr[j]?.score ?? 0;
        }
      }
      return out;
    },
  };
}
