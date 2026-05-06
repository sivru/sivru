import { describe, expect, it } from "vitest";
import { createTransformersProvider } from "./transformers.js";

const RUN_NETWORK = process.env["RUN_NETWORK_TESTS"] === "1";
const NETWORK_TIMEOUT_MS = 120_000;
const NORM_TOLERANCE = 1e-2;

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

describe("createTransformersProvider (offline shape)", () => {
  it("returns an EmbeddingProvider-shaped object without loading the model", () => {
    const p = createTransformersProvider();
    expect(typeof p.embed).toBe("function");
    expect(typeof p.embedBatch).toBe("function");
    // dim is 0 before the first embed() call (no probe yet).
    expect(p.dim).toBe(0);
  });

  it("honors a user-supplied dim hint before any embed call", () => {
    const p = createTransformersProvider({ dim: 384 });
    expect(p.dim).toBe(384);
  });
});

describe.skipIf(!RUN_NETWORK)("createTransformersProvider (network)", () => {
  it(
    "produces deterministic, unit-norm vectors and updates dim after first embed",
    async () => {
      const p = createTransformersProvider();
      expect(p.dim).toBe(0);
      const a = await p.embed("hello world");
      const b = await p.embed("hello world");
      expect(p.dim).toBeGreaterThan(0);
      expect(a.length).toBe(p.dim);
      expect(arraysEqual(a, b)).toBe(true);
      expect(Math.abs(l2Norm(a) - 1)).toBeLessThan(NORM_TOLERANCE);
    },
    NETWORK_TIMEOUT_MS,
  );

  it(
    "different texts produce different vectors",
    async () => {
      const p = createTransformersProvider();
      const a = await p.embed("the quick brown fox");
      const b = await p.embed("a totally unrelated sentence about databases");
      expect(arraysEqual(a, b)).toBe(false);
    },
    NETWORK_TIMEOUT_MS,
  );

  it(
    "embedBatch returns vectors in input order with consistent dims",
    async () => {
      const p = createTransformersProvider();
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
        expect(Math.abs(l2Norm(v) - 1)).toBeLessThan(NORM_TOLERANCE);
      }
      // The first batch entry should match a single embed() call (modulo
      // floating-point determinism — Transformers.js batches deterministically
      // for the same input on the same backend).
      const single = await p.embed(texts[0] ?? "");
      const fromBatch = batch[0];
      expect(fromBatch).toBeDefined();
      if (!fromBatch) return;
      // Allow tiny numerical drift; check cosine ~= 1 instead of exact equality.
      let dot = 0;
      for (let i = 0; i < fromBatch.length; i++) {
        dot += (fromBatch[i] ?? 0) * (single[i] ?? 0);
      }
      expect(Math.abs(dot - 1)).toBeLessThan(1e-3);
    },
    NETWORK_TIMEOUT_MS,
  );
});
