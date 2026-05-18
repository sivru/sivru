import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { instructionPrefixesFor } from "./instructions.js";
import type { EmbeddingProvider } from "./provider.js";

export type TransformersProviderOptions = {
  /**
   * HF Hub model id. Default: `Xenova/all-MiniLM-L6-v2` (384-dim,
   * well-tested sentence embedder, ~22 MB). Any HF model that supports the
   * `feature-extraction` pipeline works here.
   */
  model?: string;
  /**
   * Override the dim metadata exposed via `provider.dim`. If omitted, the
   * factory probes the model on first `embed()` and caches the dim.
   */
  dim?: number;
  /**
   * Where to cache model files. Default: `~/.cache/sivru/models/` (created
   * if missing). Forwarded to Transformers.js as the `env.cacheDir` option.
   */
  cacheDir?: string;
  /**
   * Quantization. `"q4"` / `"q8"` / `"fp16"` / `"fp32"`. Default: `"fp32"`
   * (most compatible). Forwarded to the pipeline `dtype` option.
   */
  dtype?: "fp32" | "fp16" | "q8" | "q4";
};

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DTYPE: "fp32" | "fp16" | "q8" | "q4" = "fp32";
const NORM_TOLERANCE = 1e-2;

// Some HF tokenizer configs report a sentinel-huge `model_max_length`
// (e.g. ~1e30) when no real window is set. Above this ceiling we treat the
// embedder as windowless rather than guess a budget (DESIGN-0002 §1).
const MAX_SANE_CONTEXT = 1_000_000;

/**
 * Effective per-chunk content-token budget for a loaded tokenizer: the raw
 * context window minus the fixed special-token overhead. Returns `undefined`
 * when the config carries no usable window — windowing is then skipped.
 */
function effectiveContextTokens(tok: TransformersTokenizer): number | undefined {
  const rawMax = tok.model_max_length;
  if (
    typeof rawMax !== "number" ||
    !Number.isFinite(rawMax) ||
    rawMax <= 0 ||
    rawMax > MAX_SANE_CONTEXT
  ) {
    return undefined;
  }
  // Counting the specials added to empty input gives the fixed
  // [CLS]/[SEP]-style overhead exactly (DESIGN-0002 D6).
  const specialOverhead = tok.encode("", { add_special_tokens: true }).length;
  const budget = rawMax - specialOverhead;
  return budget > 0 ? budget : undefined;
}

// Minimal structural typing for the bits of @huggingface/transformers we use,
// so we don't need a top-level static import (lazy load via dynamic import).
type FeatureExtractionOptions = {
  pooling?: "none" | "mean" | "cls" | "first_token" | "eos" | "last_token";
  normalize?: boolean;
};

type TransformersTensor = {
  readonly dims: number[];
  readonly data: ArrayLike<number> & Iterable<number>;
};

// The bits of the loaded tokenizer the windower needs. `encode` with
// `add_special_tokens: false` yields content tokens (DESIGN-0002 D6);
// `model_max_length` is the model's raw context window.
type TransformersTokenizer = {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[];
  model_max_length?: number;
};

// The feature-extraction pipeline is a callable that also exposes the
// tokenizer it loaded — reused here for token counting.
type FeatureExtractionPipelineFn = ((
  texts: string | string[],
  options?: FeatureExtractionOptions,
) => Promise<TransformersTensor>) & {
  tokenizer: TransformersTokenizer;
};

type TransformersModule = {
  pipeline: (
    task: "feature-extraction",
    model?: string,
    options?: { dtype?: "fp32" | "fp16" | "q8" | "q4" },
  ) => Promise<FeatureExtractionPipelineFn>;
  env: { cacheDir: string };
};

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "sivru", "models");
}

function toFloat32Array(data: ArrayLike<number> & Iterable<number>): Float32Array {
  if (data instanceof Float32Array) return data;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ?? 0;
  }
  return out;
}

function l2Norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    s += x * x;
  }
  return Math.sqrt(s);
}

/**
 * Create an `EmbeddingProvider` backed by `@huggingface/transformers`
 * running locally via ONNX. The factory itself is cheap — the model is
 * downloaded and the pipeline initialized lazily on the first `embed()`
 * (or `embedBatch()`) call. Subsequent calls reuse the cached pipeline.
 *
 * Note on `dim`: before the first embed call, `provider.dim` is the
 * user-supplied `options.dim` if provided, else `0`. After the first
 * embed call, `dim` is updated to the actual output length probed from
 * the model. Tests should not rely on `dim` before the first call.
 */
export function createTransformersProvider(
  options?: TransformersProviderOptions,
): EmbeddingProvider {
  const modelId = options?.model ?? DEFAULT_MODEL;
  const dtype = options?.dtype ?? DEFAULT_DTYPE;
  const cacheDir = options?.cacheDir ?? defaultCacheDir();
  const initialDim = options?.dim ?? 0;

  // Asymmetric prompt prefixes. Empty strings for symmetric encoders
  // (MiniLM, jina-code) — the prepend-then-embed call is then a no-op.
  const prefixes = instructionPrefixesFor(modelId);

  let currentDim = initialDim;
  let pipelinePromise: Promise<FeatureExtractionPipelineFn> | null = null;
  // Captured once the pipeline loads. The chunk-windower reads both; they
  // are `null` / `undefined` until the first embed() (or prime) call — see
  // `EmbeddingProvider.contextTokens` / `countTokens`.
  let tokenizer: TransformersTokenizer | null = null;
  let contextTokensValue: number | undefined;

  async function getPipeline(): Promise<FeatureExtractionPipelineFn> {
    if (pipelinePromise) return pipelinePromise;
    pipelinePromise = (async (): Promise<FeatureExtractionPipelineFn> => {
      mkdirSync(cacheDir, { recursive: true });
      const mod = (await import("@huggingface/transformers")) as unknown as TransformersModule;
      mod.env.cacheDir = cacheDir;
      const pipe = await mod.pipeline("feature-extraction", modelId, { dtype });
      tokenizer = pipe.tokenizer;
      contextTokensValue = effectiveContextTokens(pipe.tokenizer);
      return pipe;
    })();
    return pipelinePromise;
  }

  // Run a single-text encode and return a unit-norm Float32Array of
  // length `dim`. Shared by embed() and embedQuery() so prefix handling
  // is the only difference between them.
  async function encodeOne(text: string): Promise<Float32Array> {
    const pipe = await getPipeline();
    const tensor = await pipe(text, { pooling: "mean", normalize: true });
    const flat = toFloat32Array(tensor.data);
    const dims = tensor.dims;
    const lastDim = dims[dims.length - 1] ?? flat.length;
    const out = flat.length === lastDim ? flat : flat.slice(0, lastDim);
    if (currentDim === 0) currentDim = out.length;
    if (out.length > 0) {
      const n = l2Norm(out);
      if (!(Math.abs(n - 1) < NORM_TOLERANCE)) {
        throw new Error(
          `transformers embedding provider: expected unit-norm vector, got |v|=${String(n)}`,
        );
      }
    }
    return out;
  }

  return {
    id: modelId,
    get dim(): number {
      return currentDim;
    },
    get contextTokens(): number | undefined {
      return contextTokensValue;
    },
    countTokens(text: string): number {
      if (tokenizer === null) {
        throw new Error(
          "SIVRU-E1004: transformers provider countTokens() called before " +
            "the tokenizer loaded — embed() (or a prime call) must run first",
        );
      }
      return tokenizer.encode(text, { add_special_tokens: false }).length;
    },
    async embed(text: string): Promise<Float32Array> {
      // `embed` is the document-encoding path — used by buildIndex on
      // each chunk and by findRelated on the source chunk's content.
      // Apply the document prefix (empty for symmetric encoders).
      return encodeOne(prefixes.document + text);
    },
    async embedQuery(text: string): Promise<Float32Array> {
      // `embedQuery` is the asymmetric query path — used by searchHybrid.
      // Apply the query prefix (also empty for symmetric encoders, in
      // which case this method is equivalent to embed()).
      return encodeOne(prefixes.query + text);
    },
    async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const pipe = await getPipeline();
      // Pipeline expects a mutable string[]; copy + prefix from readonly input.
      const inputs = texts.map((t) => prefixes.document + t);
      const tensor = await pipe(inputs, { pooling: "mean", normalize: true });
      const flat = toFloat32Array(tensor.data);
      const dims = tensor.dims;
      // Expect shape [batch, dim] after mean pooling.
      const perVecLen =
        dims.length >= 2
          ? (dims[dims.length - 1] ?? Math.floor(flat.length / texts.length))
          : Math.floor(flat.length / texts.length);
      if (currentDim === 0 && perVecLen > 0) currentDim = perVecLen;
      const out: Float32Array[] = new Array<Float32Array>(texts.length);
      for (let i = 0; i < texts.length; i++) {
        const start = i * perVecLen;
        const slice = flat.slice(start, start + perVecLen);
        out[i] = slice;
      }
      return out;
    },
  };
}
