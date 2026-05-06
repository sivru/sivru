import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./provider.js";

export type MockProviderOptions = {
  /** Output dimension. Default 64. */
  dim?: number;
  /** Seed string mixed into the hash. Default `"sivru-mock-v1"`. */
  seed?: string;
};

const DEFAULT_DIM = 64;
const DEFAULT_SEED = "sivru-mock-v1";
const SHA256_BYTES = 32;
const INT32_SCALE = 2 ** 31;

function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

function fillBytes(seed: string, text: string, byteCount: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  let counter = 0;
  while (total < byteCount) {
    const key = counter === 0 ? `${seed}:${text}` : `${seed}:${text}:${counter}`;
    const digest = sha256(key);
    chunks.push(digest);
    total += SHA256_BYTES;
    counter++;
  }
  return Buffer.concat(chunks, total).subarray(0, byteCount);
}

function deriveVector(seed: string, text: string, dim: number): Float32Array {
  const bytes = fillBytes(seed, text, dim * 4);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const value = bytes.readInt32BE(i * 4);
    out[i] = value / INT32_SCALE;
  }
  let sumSq = 0;
  for (let i = 0; i < dim; i++) {
    const v = out[i] ?? 0;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      const v = out[i] ?? 0;
      out[i] = v / norm;
    }
  }
  return out;
}

export function createMockEmbeddingProvider(
  options?: MockProviderOptions,
): EmbeddingProvider {
  const dim = options?.dim ?? DEFAULT_DIM;
  const seed = options?.seed ?? DEFAULT_SEED;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`mock embedding provider: dim must be a positive integer (got ${String(dim)})`);
  }
  return {
    dim,
    async embed(text: string): Promise<Float32Array> {
      return deriveVector(seed, text, dim);
    },
    async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = new Array<Float32Array>(texts.length);
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i] ?? "";
        out[i] = deriveVector(seed, t, dim);
      }
      return out;
    },
  };
}
