import { describe, expect, it } from "vitest";

import { createParseCache } from "./parse-cache.js";
import type { Chunk } from "../types.js";

function mkChunk(text: string): Chunk {
  return {
    filePath: "x.ts",
    startLine: 1,
    endLine: 1,
    language: "typescript",
    content: text,
    kind: "tree-sitter",
  };
}

describe("createParseCache", () => {
  it("returns undefined on miss and increments miss counter", () => {
    const cache = createParseCache();
    expect(cache.get("/a", 1)).toBeUndefined();
    expect(cache.misses()).toBe(1);
    expect(cache.hits()).toBe(0);
  });

  it("returns set value on hit and increments hit counter", () => {
    const cache = createParseCache();
    const v = [mkChunk("hello")];
    cache.set("/a", 1, v);
    expect(cache.get("/a", 1)).toBe(v);
    expect(cache.hits()).toBe(1);
  });

  it("treats different mtime as a different key", () => {
    const cache = createParseCache();
    cache.set("/a", 1, [mkChunk("v1")]);
    expect(cache.get("/a", 2)).toBeUndefined();
    expect(cache.get("/a", 1)?.[0]?.content).toBe("v1");
  });

  it("evicts oldest entries when capacity is exceeded (LRU)", () => {
    const cache = createParseCache(2);
    cache.set("/a", 1, [mkChunk("a")]);
    cache.set("/b", 1, [mkChunk("b")]);
    cache.set("/c", 1, [mkChunk("c")]);
    expect(cache.size()).toBe(2);
    expect(cache.get("/a", 1)).toBeUndefined();
    expect(cache.get("/b", 1)).toBeDefined();
    expect(cache.get("/c", 1)).toBeDefined();
  });

  it("promotes on hit so recently-used entries survive eviction", () => {
    const cache = createParseCache(2);
    cache.set("/a", 1, [mkChunk("a")]);
    cache.set("/b", 1, [mkChunk("b")]);
    // Touch /a — moves it to the most-recently-used end.
    cache.get("/a", 1);
    cache.set("/c", 1, [mkChunk("c")]);
    // /b should have been evicted, /a survived.
    expect(cache.get("/a", 1)).toBeDefined();
    expect(cache.get("/b", 1)).toBeUndefined();
    expect(cache.get("/c", 1)).toBeDefined();
  });

  it("overwrites on re-set without growing size", () => {
    const cache = createParseCache(2);
    cache.set("/a", 1, [mkChunk("v1")]);
    cache.set("/a", 1, [mkChunk("v2")]);
    expect(cache.size()).toBe(1);
    expect(cache.get("/a", 1)?.[0]?.content).toBe("v2");
  });
});
