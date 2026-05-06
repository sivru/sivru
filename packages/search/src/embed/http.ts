import type { EmbeddingProvider } from "./provider.js";

export type HttpEmbeddingRequestShape =
  /**
   * OpenAI-compatible: POST { model, input } → { data: [{ embedding: number[] }] }.
   * Works with: OpenAI, Voyage, vLLM `/v1/embeddings`, LM Studio, etc.
   */
  | "openai"
  /**
   * Ollama: POST { model, prompt } → { embedding: number[] }.
   * Works with `ollama serve` on localhost.
   */
  | "ollama";

export type HttpEmbeddingProviderOptions = {
  /**
   * Full URL of the embeddings endpoint, including scheme and path.
   * Examples: "https://api.openai.com/v1/embeddings",
   * "http://localhost:11434/api/embeddings",
   * "http://localhost:8000/v1/embeddings".
   */
  url: string;
  /** Model identifier sent in the request body. */
  model: string;
  /** Output dimension of the model. Required — no probe call. */
  dim: number;
  /** Wire shape for request and response. Default: "openai". */
  shape?: HttpEmbeddingRequestShape;
  /** Extra headers (typically Authorization). */
  headers?: Record<string, string>;
  /** Per-request timeout in ms. Default: 30_000. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const NORM_EPSILON = 1e-6;
const NORM_TOLERANCE = 1e-3;

type OpenAiResponse = {
  data?: Array<{ embedding?: unknown } | undefined> | undefined;
};

type OllamaResponse = {
  embedding?: unknown;
};

function normalizeInPlace(vec: Float32Array): void {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] ?? 0;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm <= NORM_EPSILON) {
    // All-zero (or near-zero): return as-is.
    return;
  }
  if (Math.abs(norm - 1) <= NORM_TOLERANCE) {
    // Already unit-norm within tolerance — skip to avoid mangling.
    return;
  }
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] ?? 0;
    vec[i] = v / norm;
  }
}

function toFloat32(arr: readonly number[]): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    out[i] = typeof v === "number" ? v : 0;
  }
  return out;
}

function isNumberArray(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  for (const v of value) {
    if (typeof v !== "number") return false;
  }
  return true;
}

async function readJson(response: Response, url: string): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `HTTP embedding provider: failed to parse JSON response from ${url}: ${message}`,
    );
  }
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `HTTP embedding provider: request to ${url} timed out after ${timeoutMs}ms`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`HTTP embedding provider: request to ${url} failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let snippet = "";
    try {
      const text = await response.text();
      if (text.length > 0 && text.length <= 512) {
        snippet = `: ${text}`;
      }
    } catch {
      // ignore
    }
    throw new Error(
      `HTTP embedding provider: ${url} returned status ${response.status}${snippet}`,
    );
  }
  return readJson(response, url);
}

function extractOpenAiEmbeddings(
  payload: unknown,
  url: string,
  expectedCount: number,
): number[][] {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(
      `HTTP embedding provider: unexpected response shape from ${url} (expected object)`,
    );
  }
  const data = (payload as OpenAiResponse).data;
  if (!Array.isArray(data)) {
    throw new Error(
      `HTTP embedding provider: response from ${url} missing "data" array`,
    );
  }
  if (data.length !== expectedCount) {
    throw new Error(
      `HTTP embedding provider: ${url} returned ${data.length} embeddings but expected ${expectedCount}`,
    );
  }
  const out: number[][] = new Array<number[]>(data.length);
  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    const embedding = entry?.embedding;
    if (!isNumberArray(embedding)) {
      throw new Error(
        `HTTP embedding provider: response from ${url} has invalid embedding at index ${i}`,
      );
    }
    out[i] = embedding;
  }
  return out;
}

function extractOllamaEmbedding(payload: unknown, url: string): number[] {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(
      `HTTP embedding provider: unexpected response shape from ${url} (expected object)`,
    );
  }
  const embedding = (payload as OllamaResponse).embedding;
  if (!isNumberArray(embedding)) {
    throw new Error(
      `HTTP embedding provider: response from ${url} missing valid "embedding" array`,
    );
  }
  return embedding;
}

function verifyAndPrepare(
  raw: number[],
  dim: number,
  url: string,
): Float32Array {
  if (raw.length !== dim) {
    throw new Error(
      `HTTP embedding provider expected dim ${dim} but got ${raw.length} (url: ${url})`,
    );
  }
  const out = toFloat32(raw);
  normalizeInPlace(out);
  return out;
}

export function createHttpEmbeddingProvider(
  options: HttpEmbeddingProviderOptions,
): EmbeddingProvider {
  if (typeof options.url !== "string" || options.url.length === 0) {
    throw new Error("HTTP embedding provider: `url` is required");
  }
  if (typeof options.model !== "string" || options.model.length === 0) {
    throw new Error("HTTP embedding provider: `model` is required");
  }
  if (
    typeof options.dim !== "number" ||
    !Number.isInteger(options.dim) ||
    options.dim <= 0
  ) {
    throw new Error(
      `HTTP embedding provider: \`dim\` must be a positive integer (got ${String(options.dim)})`,
    );
  }

  const url = options.url;
  const model = options.model;
  const dim = options.dim;
  const shape: HttpEmbeddingRequestShape = options.shape ?? "openai";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };

  async function embedOpenAi(texts: readonly string[]): Promise<Float32Array[]> {
    const body = { model, input: texts };
    const payload = await postJson(url, body, headers, timeoutMs);
    const raws = extractOpenAiEmbeddings(payload, url, texts.length);
    const out: Float32Array[] = new Array<Float32Array>(raws.length);
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i] ?? [];
      out[i] = verifyAndPrepare(raw, dim, url);
    }
    return out;
  }

  async function embedOllamaSingle(text: string): Promise<Float32Array> {
    const body = { model, prompt: text };
    const payload = await postJson(url, body, headers, timeoutMs);
    const raw = extractOllamaEmbedding(payload, url);
    return verifyAndPrepare(raw, dim, url);
  }

  const provider: EmbeddingProvider = {
    dim,
    async embed(text: string): Promise<Float32Array> {
      if (shape === "ollama") {
        return embedOllamaSingle(text);
      }
      const out = await embedOpenAi([text]);
      const first = out[0];
      if (!first) {
        throw new Error(
          `HTTP embedding provider: ${url} returned no embedding for single input`,
        );
      }
      return first;
    },
    async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) {
        return [];
      }
      if (shape === "ollama") {
        const out: Float32Array[] = new Array<Float32Array>(texts.length);
        for (let i = 0; i < texts.length; i++) {
          const t = texts[i] ?? "";
          out[i] = await embedOllamaSingle(t);
        }
        return out;
      }
      return embedOpenAi(texts);
    },
  };
  return provider;
}
