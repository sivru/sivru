import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EmbeddingProvider } from "./provider.js";

export type PotionProviderOptions = {
  /**
   * HF Hub model id. Default: `minishlab/potion-retrieval-32M` — Minish Lab's
   * Model2Vec retrieval-tuned model (512-dim, ~129 MB safetensors). It scores
   * highest on retrieval tasks among the public Potion models and is the most
   * code-friendly default we have today. Verified to 200 on HF Hub at the time
   * of writing; falls back gracefully via override.
   *
   * Other Minish Lab options that work with this provider:
   *  - `minishlab/potion-base-32M` (512-dim, general)
   *  - `minishlab/potion-base-8M`  (256-dim, smallest)
   */
  model?: string;
  /**
   * Local cache root for downloaded model files. Default: `~/.cache/sivru/models/`.
   * Per-model files live in `<cacheDir>/<model_id>/<filename>`.
   */
  cacheDir?: string;
  /**
   * Override the User-Agent on download requests. Default: `sivru/0.1.0`.
   */
  userAgent?: string;
};

const DEFAULT_MODEL = "minishlab/potion-retrieval-32M";
const DEFAULT_USER_AGENT = "sivru/0.1.0";
const SAFETENSORS_FILE = "model.safetensors";
const TOKENIZER_FILE = "tokenizer.json";
const CONFIG_FILE = "config.json";
const TOKENIZER_CONFIG_FILE = "tokenizer_config.json";
const HF_HUB_BASE = "https://huggingface.co";
const NORM_EPS = 1e-9;

// --------------------------------------------------------------------------
// Safetensors parser
// --------------------------------------------------------------------------

export type SafetensorsTensor = {
  dtype: string;
  shape: number[];
  data: ArrayBuffer;
};

type SafetensorsHeaderEntry = {
  dtype: string;
  shape: number[];
  data_offsets: [number, number];
};

function isHeaderEntry(value: unknown): value is SafetensorsHeaderEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["dtype"] !== "string") return false;
  if (!Array.isArray(v["shape"])) return false;
  for (const dim of v["shape"]) {
    if (typeof dim !== "number") return false;
  }
  if (!Array.isArray(v["data_offsets"]) || v["data_offsets"].length !== 2) return false;
  if (typeof v["data_offsets"][0] !== "number" || typeof v["data_offsets"][1] !== "number") {
    return false;
  }
  return true;
}

/**
 * Parse a safetensors file buffer. Returns a map of tensor name -> tensor.
 * The `__metadata__` JSON entry is excluded (it's not a tensor).
 *
 * Format:
 *  - bytes 0..7: little-endian uint64 N (header byte length)
 *  - bytes 8..8+N-1: UTF-8 JSON header
 *  - bytes 8+N..end: raw tensor bodies, contiguous
 */
export function parseSafetensors(buf: Uint8Array): Map<string, SafetensorsTensor> {
  if (buf.byteLength < 8) {
    throw new Error(`safetensors: buffer too small (${String(buf.byteLength)} bytes)`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = Number(view.getBigUint64(0, true));
  if (headerLen <= 0 || 8 + headerLen > buf.byteLength) {
    throw new Error(`safetensors: invalid header length ${String(headerLen)}`);
  }
  const headerBytes = buf.subarray(8, 8 + headerLen);
  const headerText = new TextDecoder("utf-8").decode(headerBytes);
  let header: unknown;
  try {
    header = JSON.parse(headerText);
  } catch (err) {
    throw new Error(
      `safetensors: header is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof header !== "object" || header === null) {
    throw new Error("safetensors: header JSON is not an object");
  }
  const bodyStart = 8 + headerLen;
  const tensors = new Map<string, SafetensorsTensor>();
  for (const [name, entry] of Object.entries(header as Record<string, unknown>)) {
    if (name === "__metadata__") continue;
    if (!isHeaderEntry(entry)) {
      // Skip unparseable entries rather than throwing — tolerate format drift.
      continue;
    }
    const [start, end] = entry.data_offsets;
    const absStart = bodyStart + start;
    const absEnd = bodyStart + end;
    if (absEnd > buf.byteLength) {
      throw new Error(
        `safetensors: tensor "${name}" data_offsets [${String(start)},${String(end)}] exceed buffer`,
      );
    }
    // Slice into a fresh ArrayBuffer so the caller can use it independently.
    const slice = buf.slice(absStart, absEnd);
    tensors.set(name, {
      dtype: entry.dtype,
      shape: entry.shape.slice(),
      data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    });
  }
  return tensors;
}

/**
 * Find the embedding tensor in a parsed safetensors map. Real Model2Vec
 * exports use the key `embeddings`; some forks may use `embedding_weights`.
 * Pick the unique F32 2D tensor by structural search to be robust.
 */
function pickEmbeddingTensor(tensors: Map<string, SafetensorsTensor>): SafetensorsTensor {
  // Prefer well-known names, but fall back to "the only F32 2D tensor".
  const preferred = ["embeddings", "embedding_weights", "weight"];
  for (const key of preferred) {
    const t = tensors.get(key);
    if (t && t.shape.length === 2) {
      if (t.dtype !== "F32") {
        throw new Error(
          `embedding tensor dtype must be F32, got ${t.dtype} for tensor "${key}"`,
        );
      }
      return t;
    }
  }
  let candidate: SafetensorsTensor | undefined;
  let candidateName: string | undefined;
  for (const [name, t] of tensors) {
    if (t.shape.length === 2 && t.dtype === "F32") {
      if (candidate) {
        // Multiple 2D F32 tensors — ambiguous.
        throw new Error(
          `embedding tensor ambiguous: multiple F32 2D tensors found ("${candidateName ?? ""}", "${name}")`,
        );
      }
      candidate = t;
      candidateName = name;
    }
  }
  if (!candidate) {
    throw new Error("embedding tensor not found in safetensors header");
  }
  return candidate;
}

// --------------------------------------------------------------------------
// HF Hub fetcher with on-disk cache
// --------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download `https://huggingface.co/<modelId>/resolve/main/<filename>` to
 * `<cacheDir>/<modelId>/<filename>` if it isn't already there. Returns the
 * absolute local path.
 *
 * TODO(streaming): the safetensors blob is 5-30 MB; we currently read the
 * full response into memory via `arrayBuffer()`. If we ever ship a model
 * larger than ~100 MB this should switch to a streamed write.
 */
async function fetchToCache(args: {
  modelId: string;
  filename: string;
  cacheDir: string;
  userAgent: string;
}): Promise<string> {
  const { modelId, filename, cacheDir, userAgent } = args;
  const modelDir = join(cacheDir, modelId);
  const localPath = join(modelDir, filename);
  if (await pathExists(localPath)) {
    return localPath;
  }
  await mkdir(dirname(localPath), { recursive: true });
  const url = `${HF_HUB_BASE}/${modelId}/resolve/main/${filename}`;
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "*/*" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(
      `potion provider: HF Hub fetch failed ${String(res.status)} for ${url}`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  await writeFile(localPath, buf);
  return localPath;
}

// --------------------------------------------------------------------------
// Tokenizer (lazy)
// --------------------------------------------------------------------------

type TransformersTokenizer = {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[];
};

type TransformersTokenizerModule = {
  AutoTokenizer: {
    from_pretrained(
      modelId: string,
      options?: { cache_dir?: string; local_files_only?: boolean },
    ): Promise<TransformersTokenizer>;
  };
  env: { cacheDir: string };
};

// --------------------------------------------------------------------------
// Provider state assembled at init time
// --------------------------------------------------------------------------

type LoadedModel = {
  embeddings: Float32Array;
  vocabSize: number;
  dim: number;
  tokenizer: TransformersTokenizer;
};

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "sivru", "models");
}

function meanPoolEmbed(
  ids: readonly number[],
  embeddings: Float32Array,
  vocabSize: number,
  dim: number,
): Float32Array {
  const out = new Float32Array(dim);
  if (ids.length === 0) return out;
  let counted = 0;
  for (const rawId of ids) {
    // Tokenizers shouldn't emit OOV ids — but clamp defensively to avoid OOB.
    const id = rawId < 0 ? 0 : rawId >= vocabSize ? vocabSize - 1 : rawId;
    const base = id * dim;
    // Hot loop: in-place add of one row into the accumulator.
    for (let j = 0; j < dim; j++) {
      out[j] = (out[j] ?? 0) + (embeddings[base + j] ?? 0);
    }
    counted++;
  }
  if (counted > 0) {
    const inv = 1 / counted;
    for (let j = 0; j < dim; j++) {
      out[j] = (out[j] ?? 0) * inv;
    }
  }
  // L2-normalize.
  let sumSq = 0;
  for (let j = 0; j < dim; j++) {
    const v = out[j] ?? 0;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > NORM_EPS) {
    const inv = 1 / norm;
    for (let j = 0; j < dim; j++) {
      out[j] = (out[j] ?? 0) * inv;
    }
  }
  return out;
}

/**
 * Create an `EmbeddingProvider` backed by a Minish Lab Model2Vec model
 * (e.g. `minishlab/potion-retrieval-32M`). The factory itself is cheap;
 * the model files are downloaded and parsed lazily on the first `embed()`
 * (or `embedBatch()`) call. Subsequent calls reuse the loaded matrix.
 *
 * Inference is purely:
 *   tokenize -> gather embedding rows -> mean-pool -> L2-normalize.
 * No transformer layers, no ONNX runtime — runs in milliseconds per chunk
 * on CPU and is dominantly memory-bandwidth bound.
 *
 * Note on `dim`: before the first embed call, `provider.dim` is `0`. After
 * the first embed call, it reflects the loaded matrix's column count.
 */
export function createPotionProvider(
  options?: PotionProviderOptions,
): EmbeddingProvider {
  const modelId = options?.model ?? DEFAULT_MODEL;
  const cacheDir = options?.cacheDir ?? defaultCacheDir();
  const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;

  let currentDim = 0;
  let loadPromise: Promise<LoadedModel> | null = null;

  async function load(): Promise<LoadedModel> {
    if (loadPromise) return loadPromise;
    loadPromise = (async (): Promise<LoadedModel> => {
      // Ensure the cache dir exists so HF tokenizer + our fetcher land there.
      await mkdir(join(cacheDir, modelId), { recursive: true });

      // Download (or read from cache) the three files we need.
      // tokenizer_config.json is needed by AutoTokenizer.from_pretrained;
      // we fetch it eagerly so the tokenizer init is offline-capable.
      await Promise.all([
        _internal.fetchToCache({
          modelId,
          filename: CONFIG_FILE,
          cacheDir,
          userAgent,
        }),
        _internal.fetchToCache({
          modelId,
          filename: TOKENIZER_FILE,
          cacheDir,
          userAgent,
        }),
        _internal.fetchToCache({
          modelId,
          filename: TOKENIZER_CONFIG_FILE,
          cacheDir,
          userAgent,
        }),
      ]);
      const safetensorsPath = await _internal.fetchToCache({
        modelId,
        filename: SAFETENSORS_FILE,
        cacheDir,
        userAgent,
      });

      // Parse the safetensors blob and pull out the embedding matrix.
      const raw = await readFile(safetensorsPath);
      const tensors = parseSafetensors(
        new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
      );
      const tensor = pickEmbeddingTensor(tensors);
      if (tensor.dtype !== "F32") {
        throw new Error(`embedding tensor dtype must be F32, got ${tensor.dtype}`);
      }
      const shape = tensor.shape;
      if (shape.length !== 2) {
        throw new Error(
          `embedding tensor must be 2D, got shape [${shape.join(",")}]`,
        );
      }
      const vocabSize = shape[0] ?? 0;
      const dim = shape[1] ?? 0;
      if (vocabSize <= 0 || dim <= 0) {
        throw new Error(
          `embedding tensor has invalid shape [${shape.join(",")}]`,
        );
      }
      const embeddings = new Float32Array(tensor.data);
      if (embeddings.length !== vocabSize * dim) {
        throw new Error(
          `embedding tensor body size mismatch: shape=${vocabSize}x${dim} (${String(vocabSize * dim)} floats) vs body=${String(embeddings.length)} floats`,
        );
      }

      // Lazy-load the HF tokenizer. Point its cache at our cache dir so it
      // reuses the tokenizer.json + tokenizer_config.json we already fetched
      // (Transformers.js mirrors HF Hub's `<modelId>/<filename>` layout).
      const mod = (await import(
        "@huggingface/transformers"
      )) as unknown as TransformersTokenizerModule;
      mod.env.cacheDir = cacheDir;
      const tokenizer = await mod.AutoTokenizer.from_pretrained(modelId, {
        cache_dir: cacheDir,
      });

      currentDim = dim;
      return { embeddings, vocabSize, dim, tokenizer };
    })();
    return loadPromise;
  }

  async function embedOne(text: string): Promise<Float32Array> {
    const { embeddings, vocabSize, dim, tokenizer } = await load();
    const ids = tokenizer.encode(text);
    if (!Array.isArray(ids) || ids.length === 0) {
      // "tokenizer produced no token ids for input" — return a zero vector
      // (treat as "match anything") rather than throwing. Empty chunks happen
      // for whitespace-only files; we'd rather not fail an entire indexing run.
      return new Float32Array(dim);
    }
    return meanPoolEmbed(ids, embeddings, vocabSize, dim);
  }

  return {
    get dim(): number {
      return currentDim;
    },
    async embed(text: string): Promise<Float32Array> {
      return embedOne(text);
    },
    async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      // Static embeddings are microseconds per text — there's no batching
      // speedup like with transformers. Promise.all keeps the API consistent.
      return Promise.all(texts.map((t) => embedOne(t)));
    },
  };
}

// --------------------------------------------------------------------------
// Test seam — internal, do not use from app code.
// --------------------------------------------------------------------------

export const _internal: {
  fetchToCache: typeof fetchToCache;
} = { fetchToCache };
