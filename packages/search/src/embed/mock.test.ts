import { describe, expect, it } from "vitest";
import { createMockEmbeddingProvider } from "./mock.js";

const EPS = 1e-6;

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

describe("createMockEmbeddingProvider", () => {
  it("produces identical vectors for the same input (determinism)", async () => {
    const p = createMockEmbeddingProvider();
    const a = await p.embed("hello world");
    const b = await p.embed("hello world");
    expect(arraysEqual(a, b)).toBe(true);
  });

  it("produces different vectors for different inputs", async () => {
    const p = createMockEmbeddingProvider();
    const a = await p.embed("hello world");
    const b = await p.embed("hello world!");
    expect(arraysEqual(a, b)).toBe(false);
  });

  it("returns L2-normalized vectors (norm ~= 1) for non-trivial inputs", async () => {
    const p = createMockEmbeddingProvider();
    for (const text of ["alpha", "beta gamma", "function foo() { return 1; }"]) {
      const v = await p.embed(text);
      expect(Math.abs(l2Norm(v) - 1)).toBeLessThan(EPS);
    }
  });

  it("default dim is 64 and matches output length", async () => {
    const p = createMockEmbeddingProvider();
    expect(p.dim).toBe(64);
    const v = await p.embed("anything");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(64);
  });

  it("honors custom dim (32 and 128)", async () => {
    const p32 = createMockEmbeddingProvider({ dim: 32 });
    const p128 = createMockEmbeddingProvider({ dim: 128 });
    const v32 = await p32.embed("text");
    const v128 = await p128.embed("text");
    expect(p32.dim).toBe(32);
    expect(v32.length).toBe(32);
    expect(p128.dim).toBe(128);
    expect(v128.length).toBe(128);
    expect(Math.abs(l2Norm(v32) - 1)).toBeLessThan(EPS);
    expect(Math.abs(l2Norm(v128) - 1)).toBeLessThan(EPS);
  });

  it("custom seed yields a different vector for the same text", async () => {
    const a = createMockEmbeddingProvider({ seed: "seed-a" });
    const b = createMockEmbeddingProvider({ seed: "seed-b" });
    const va = await a.embed("same text");
    const vb = await b.embed("same text");
    expect(arraysEqual(va, vb)).toBe(false);
  });

  it("empty string produces a valid vector with correct length", async () => {
    const p = createMockEmbeddingProvider({ dim: 48 });
    const v = await p.embed("");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(48);
    expect(Number.isFinite(l2Norm(v))).toBe(true);
  });

  it("embedBatch returns vectors in the same order as inputs and matches embed()", async () => {
    const p = createMockEmbeddingProvider();
    const texts = ["one", "two", "three", "four"];
    const batch = await p.embedBatch?.(texts);
    expect(batch).toBeDefined();
    if (!batch) return;
    expect(batch.length).toBe(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i] ?? "";
      const single = await p.embed(text);
      const fromBatch = batch[i];
      expect(fromBatch).toBeDefined();
      if (!fromBatch) continue;
      expect(arraysEqual(fromBatch, single)).toBe(true);
    }
  });

  it("rejects invalid dim values", () => {
    expect(() => createMockEmbeddingProvider({ dim: 0 })).toThrow();
    expect(() => createMockEmbeddingProvider({ dim: -4 })).toThrow();
    expect(() => createMockEmbeddingProvider({ dim: 1.5 })).toThrow();
  });
});
