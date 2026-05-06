import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _internal,
  createPotionProvider,
  parseSafetensors,
} from "./potion.js";

const RUN_NETWORK = process.env["RUN_NETWORK_TESTS"] === "1";
const NETWORK_TIMEOUT_MS = 240_000;
const NORM_TOLERANCE = 1e-5;

function l2Norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    s += x * x;
  }
  return Math.sqrt(s);
}

function arraysEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

/**
 * Build a tiny safetensors buffer in memory: one F32 2D tensor of shape
 * [vocabSize, dim] called `embeddings`, with deterministic row data.
 */
function buildSafetensorsBuffer(
  rows: readonly (readonly number[])[],
  tensorName = "embeddings",
): Uint8Array {
  if (rows.length === 0) throw new Error("rows must be non-empty for the test fixture");
  const firstRow = rows[0];
  if (!firstRow) throw new Error("first row missing");
  const vocab = rows.length;
  const dim = firstRow.length;
  const flat = new Float32Array(vocab * dim);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    for (let j = 0; j < dim; j++) {
      flat[i * dim + j] = row[j] ?? 0;
    }
  }
  const body = new Uint8Array(flat.buffer, flat.byteOffset, flat.byteLength);
  const header = JSON.stringify({
    [tensorName]: {
      dtype: "F32",
      shape: [vocab, dim],
      data_offsets: [0, body.byteLength],
    },
    __metadata__: { format: "pt" },
  });
  // Pad header to 8-byte alignment (real safetensors files do this).
  const headerBytesRaw = new TextEncoder().encode(header);
  const padding = (8 - (headerBytesRaw.byteLength % 8)) % 8;
  const headerBytes = new Uint8Array(headerBytesRaw.byteLength + padding);
  headerBytes.set(headerBytesRaw, 0);
  for (let i = 0; i < padding; i++) headerBytes[headerBytesRaw.byteLength + i] = 0x20; // space pad
  const headerLen = BigInt(headerBytes.byteLength);
  const out = new Uint8Array(8 + headerBytes.byteLength + body.byteLength);
  new DataView(out.buffer).setBigUint64(0, headerLen, true);
  out.set(headerBytes, 8);
  out.set(body, 8 + headerBytes.byteLength);
  return out;
}

describe("createPotionProvider (offline shape)", () => {
  it("returns an EmbeddingProvider-shaped object without loading the model", () => {
    const p = createPotionProvider();
    expect(typeof p.embed).toBe("function");
    expect(typeof p.embedBatch).toBe("function");
    expect(p.dim).toBe(0);
  });

  it("accepts custom model and cacheDir without doing any I/O", () => {
    const p = createPotionProvider({
      model: "minishlab/potion-base-8M",
      cacheDir: "/tmp/sivru-test-noop",
      userAgent: "sivru-test/0.0.0",
    });
    expect(p.dim).toBe(0);
  });
});

describe("parseSafetensors", () => {
  it("parses a hand-built 4x3 F32 tensor named 'embeddings'", () => {
    const rows = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10, 11, 12],
    ];
    const buf = buildSafetensorsBuffer(rows);
    const tensors = parseSafetensors(buf);
    expect(tensors.size).toBe(1);
    const t = tensors.get("embeddings");
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.dtype).toBe("F32");
    expect(t.shape).toEqual([4, 3]);
    const view = new Float32Array(t.data);
    expect(view.length).toBe(12);
    expect(Array.from(view)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("ignores __metadata__ and surfaces tensors only", () => {
    const buf = buildSafetensorsBuffer([[1, 2]], "embedding_weights");
    const tensors = parseSafetensors(buf);
    expect(tensors.has("__metadata__")).toBe(false);
    expect(tensors.has("embedding_weights")).toBe(true);
  });

  it("throws on a too-small buffer", () => {
    expect(() => parseSafetensors(new Uint8Array(4))).toThrow(/too small/i);
  });

  it("throws on a header length larger than the buffer", () => {
    const buf = new Uint8Array(16);
    new DataView(buf.buffer).setBigUint64(0, 9999n, true);
    expect(() => parseSafetensors(buf)).toThrow(/invalid header length|too small/i);
  });
});

describe("createPotionProvider (cache reuse with stub fetcher)", () => {
  let tmpDir: string;
  let originalFetch: typeof _internal.fetchToCache;
  let fetchCount: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sivru-potion-"));
    originalFetch = _internal.fetchToCache;
    fetchCount = 0;
  });

  afterEach(() => {
    _internal.fetchToCache = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses the network on first load and the cache on the second", async () => {
    // Build a tiny model: 5-token vocab, 4-dim embeddings.
    const rows = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
      [0.5, 0.5, 0.5, 0.5],
    ];
    const safetensorsBytes = buildSafetensorsBuffer(rows);
    const modelId = "stub/test-model";
    const modelDir = join(tmpDir, modelId);
    await mkdir(modelDir, { recursive: true });

    // A minimal tokenizer.json that the Transformers.js AutoTokenizer can load:
    // BPE-like with a tiny vocab; it expects this exact shape.
    const tokenizerJson = {
      version: "1.0",
      truncation: null,
      padding: null,
      added_tokens: [],
      normalizer: null,
      pre_tokenizer: { type: "Whitespace" },
      post_processor: null,
      decoder: null,
      model: {
        type: "WordLevel",
        vocab: { a: 0, b: 1, c: 2, d: 3, "[UNK]": 4 },
        unk_token: "[UNK]",
      },
    };
    const tokenizerConfig = {
      tokenizer_class: "PreTrainedTokenizerFast",
      unk_token: "[UNK]",
    };
    const config = { model_type: "model2vec" };

    // Stub fetchToCache: write fixtures to disk on the first call, count calls,
    // then defer to the disk on subsequent calls (so cache reuse is exercised).
    _internal.fetchToCache = async (args) => {
      const dest = join(args.cacheDir, args.modelId, args.filename);
      // Mirror the real fetcher's "skip if cached" behavior to verify caching.
      const fs = await import("node:fs/promises");
      try {
        await fs.stat(dest);
        return dest; // cache hit — no count bump
      } catch {
        // miss: bump count and write fixture
      }
      fetchCount++;
      await mkdir(join(args.cacheDir, args.modelId), { recursive: true });
      if (args.filename === "model.safetensors") {
        await writeFile(dest, safetensorsBytes);
      } else if (args.filename === "tokenizer.json") {
        await writeFile(dest, JSON.stringify(tokenizerJson));
      } else if (args.filename === "tokenizer_config.json") {
        await writeFile(dest, JSON.stringify(tokenizerConfig));
      } else if (args.filename === "config.json") {
        await writeFile(dest, JSON.stringify(config));
      } else {
        await writeFile(dest, "");
      }
      return dest;
    };

    const p1 = createPotionProvider({ model: modelId, cacheDir: tmpDir });
    const v1 = await p1.embed("a b c");
    expect(p1.dim).toBe(4);
    expect(v1).toBeInstanceOf(Float32Array);
    expect(v1.length).toBe(4);
    // Vector should be unit-norm (mean of three orthogonal unit vectors,
    // then normalized).
    expect(Math.abs(l2Norm(v1) - 1)).toBeLessThan(NORM_TOLERANCE);
    const firstFetchCount = fetchCount;
    expect(firstFetchCount).toBeGreaterThan(0);

    // Second provider: same cacheDir, same modelId. fetchToCache should
    // hit the disk cache and NOT bump fetchCount.
    const p2 = createPotionProvider({ model: modelId, cacheDir: tmpDir });
    const v2 = await p2.embed("a b c");
    expect(fetchCount).toBe(firstFetchCount);
    expect(arraysEqual(v1, v2)).toBe(true);
  });
});

describe.skipIf(!RUN_NETWORK)("createPotionProvider (network)", () => {
  it(
    "produces deterministic, unit-norm vectors and updates dim after first embed",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "sivru-potion-net-"));
      try {
        const p = createPotionProvider({ cacheDir: tmp });
        expect(p.dim).toBe(0);
        const a = await p.embed("authentication");
        const b = await p.embed("authentication");
        expect(p.dim).toBeGreaterThan(0);
        expect(a.length).toBe(p.dim);
        expect(arraysEqual(a, b)).toBe(true);
        expect(Math.abs(l2Norm(a) - 1)).toBeLessThan(1e-5);

        // Semantic sanity: "auth" should sit closer to "authentication"
        // than to "blue".
        const auth = await p.embed("auth");
        const blue = await p.embed("blue");
        const simAuth = cosine(a, auth);
        const simBlue = cosine(a, blue);
        // Don't be too aggressive — Model2Vec is a static lossy projection.
        expect(simAuth).toBeGreaterThan(simBlue);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    NETWORK_TIMEOUT_MS,
  );

  it(
    "embeds 1000 short strings under 5 seconds (the headline win)",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "sivru-potion-bench-"));
      try {
        const p = createPotionProvider({ cacheDir: tmp });
        // Warm up the cache + tokenizer.
        await p.embed("warmup");

        const N = 1000;
        const inputs: string[] = new Array<string>(N);
        for (let i = 0; i < N; i++) {
          inputs[i] = `chunk number ${String(i)} talks about authentication and database queries`;
        }
        const start = Date.now();
        for (let i = 0; i < N; i++) {
          await p.embed(inputs[i] ?? "");
        }
        const elapsed = Date.now() - start;
        // Surface the number even on success so the report can quote it.
        // eslint-disable-next-line no-console
        console.log(`[potion bench] 1000 sequential embeds: ${String(elapsed)} ms`);
        expect(elapsed).toBeLessThan(5000);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    NETWORK_TIMEOUT_MS,
  );

  it(
    "embedBatch returns vectors in input order with consistent dims",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "sivru-potion-batch-"));
      try {
        const p = createPotionProvider({ cacheDir: tmp });
        const texts = ["one", "two", "three", "four"];
        const batch = await p.embedBatch?.(texts);
        expect(batch).toBeDefined();
        if (!batch) return;
        expect(batch.length).toBe(texts.length);
        const expectedDim = p.dim;
        expect(expectedDim).toBeGreaterThan(0);
        for (let i = 0; i < batch.length; i++) {
          const v = batch[i];
          expect(v).toBeDefined();
          if (!v) continue;
          expect(v).toBeInstanceOf(Float32Array);
          expect(v.length).toBe(expectedDim);
          expect(Math.abs(l2Norm(v) - 1)).toBeLessThan(1e-5);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    NETWORK_TIMEOUT_MS,
  );
});
