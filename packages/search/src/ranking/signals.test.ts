import { describe, expect, it } from "vitest";
import type { Chunk } from "../types.js";
import type { RankedHit } from "./rrf.js";
import { applySignals, isSymbolLikeQuery } from "./signals.js";

function mkChunk(filePath: string, content: string): Chunk {
  return {
    filePath,
    startLine: 1,
    endLine: 1 + content.split("\n").length,
    language: filePath.endsWith(".py") ? "python" : "typescript",
    content,
    kind: "tree-sitter",
  };
}

describe("isSymbolLikeQuery", () => {
  const cases: Array<[string, boolean, string]> = [
    ["parseHTTPResponse", true, "single token, camelCase"],
    ["parse_response", true, "single token, snake_case"],
    ["parse-response", true, "single token, kebab-case"],
    ["foo", true, "single token, plain identifier"],
    ["", false, "empty string"],
    ["   ", false, "whitespace only"],
    ["how does http response parsing work", false, "long natural-language query"],
    ["hello world", false, "two plain words, no identifier markers"],
    ["parse_response func", true, "two tokens, one has underscore"],
    ["MyClass create", true, "two tokens, one is PascalCase"],
    ["foo.bar.baz", true, "single dotted token"],
    ["fooBar baz qux", false, "three tokens (>=3) even if one is camelCase"],
    ["A B", false, "two single-letter tokens, no boundaries"],
  ];

  it.each(cases)("isSymbolLikeQuery(%j) === %s (%s)", (input, expected, _label) => {
    expect(isSymbolLikeQuery(input)).toBe(expected);
  });
});

describe("applySignals — edge cases", () => {
  it("returns [] for empty hits", () => {
    expect(applySignals([], [], "anything")).toEqual([]);
  });

  it("skips hits whose id is out of range without throwing", () => {
    const chunks: Chunk[] = [mkChunk("src/a.ts", "function foo() {}")];
    const hits: RankedHit[] = [
      { id: 0, score: 1 },
      { id: 99, score: 0.5 },
    ];
    const out = applySignals(hits, chunks, "foo");
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(0);
  });

  it("preserves relative input order when all scores are zero", () => {
    const chunks: Chunk[] = [
      mkChunk("src/a.ts", "function foo() {}"),
      mkChunk("src/b.ts", "function bar() {}"),
      mkChunk("src/c.ts", "function baz() {}"),
    ];
    const hits: RankedHit[] = [
      { id: 2, score: 0 },
      { id: 0, score: 0 },
      { id: 1, score: 0 },
    ];
    const out = applySignals(hits, chunks, "foo");
    expect(out.map((h) => h.id)).toEqual([2, 0, 1]);
    for (const h of out) expect(h.score).toBe(0);
  });

  it("breaks ties on equal post-signal scores by lower id first", () => {
    const chunks: Chunk[] = [
      mkChunk("src/a.ts", "x"),
      mkChunk("src/b.ts", "x"),
    ];
    const hits: RankedHit[] = [
      { id: 1, score: 1 },
      { id: 0, score: 1 },
    ];
    // Disable everything to keep scores equal.
    const out = applySignals(hits, chunks, "no-match", {
      definitionBoost: false,
      multiChunkFileBoost: false,
      pathPenalty: false,
      identifierStemMatching: false,
    });
    expect(out.map((h) => h.id)).toEqual([0, 1]);
  });
});

describe("applySignals — definition boost in isolation", () => {
  const config = {
    definitionBoost: true,
    multiChunkFileBoost: false,
    pathPenalty: false,
    identifierStemMatching: false,
  };

  it("lifts a defining chunk above one that just mentions the symbol", () => {
    const chunks: Chunk[] = [
      mkChunk("src/a.ts", "// uses parseResponse here\nparseResponse();\n"),
      mkChunk("src/b.ts", "function parseResponse() { return 1; }\n"),
    ];
    const hits: RankedHit[] = [
      { id: 0, score: 1 },
      { id: 1, score: 1 },
    ];
    const out = applySignals(hits, chunks, "parseResponse", config);
    expect(out[0]?.id).toBe(1);
    expect(out[0]?.score).toBeCloseTo(1.25, 12);
    expect(out[1]?.id).toBe(0);
    expect(out[1]?.score).toBe(1);
  });

  it("does not boost when query is not symbol-like", () => {
    const chunks: Chunk[] = [
      mkChunk("src/a.ts", "function parseResponse() { return 1; }\n"),
    ];
    const hits: RankedHit[] = [{ id: 0, score: 1 }];
    const out = applySignals(hits, chunks, "how do I parse a response from the server", config);
    expect(out[0]?.score).toBe(1);
  });

  it("does not boost a defining chunk when the defined symbol is unrelated to the query", () => {
    const chunks: Chunk[] = [
      mkChunk("src/a.ts", "function unrelatedThing() { return 1; }\n"),
    ];
    const hits: RankedHit[] = [{ id: 0, score: 1 }];
    const out = applySignals(hits, chunks, "parseResponse", config);
    expect(out[0]?.score).toBe(1);
  });

  it("triggers on python `def ` keyword too", () => {
    const chunks: Chunk[] = [
      mkChunk("pkg/m.py", "def parse_response():\n    return 1\n"),
      mkChunk("pkg/n.py", "result = parse_response()\n"),
    ];
    const hits: RankedHit[] = [
      { id: 1, score: 1 },
      { id: 0, score: 1 },
    ];
    const out = applySignals(hits, chunks, "parse_response", config);
    expect(out[0]?.id).toBe(0);
    expect(out[0]?.score).toBeCloseTo(1.25, 12);
  });
});

describe("applySignals — multi-chunk file boost in isolation", () => {
  const config = {
    definitionBoost: false,
    multiChunkFileBoost: true,
    pathPenalty: false,
    identifierStemMatching: false,
  };

  it("a file with 3 hits beats two singleton-file hits at the same base score", () => {
    const chunks: Chunk[] = [
      mkChunk("src/big.ts", "alpha"),
      mkChunk("src/big.ts", "beta"),
      mkChunk("src/big.ts", "gamma"),
      mkChunk("src/lone1.ts", "x"),
      mkChunk("src/lone2.ts", "y"),
    ];
    const hits: RankedHit[] = [
      { id: 3, score: 1 },
      { id: 0, score: 1 },
      { id: 4, score: 1 },
      { id: 1, score: 1 },
      { id: 2, score: 1 },
    ];
    const out = applySignals(hits, chunks, "irrelevant", config);
    // Top three should be the big.ts chunks (factor = 1 + 0.05*2 = 1.10).
    const topIds = out.slice(0, 3).map((h) => h.id).sort();
    expect(topIds).toEqual([0, 1, 2]);
    for (const h of out.slice(0, 3)) expect(h.score).toBeCloseTo(1.1, 10);
    for (const h of out.slice(3)) expect(h.score).toBe(1);
  });

  it("boost is capped at 1.25 for very many chunks in one file", () => {
    const chunks: Chunk[] = Array.from({ length: 10 }, (_, i) => mkChunk("src/big.ts", `c${i}`));
    const hits: RankedHit[] = chunks.map((_, i) => ({ id: i, score: 1 }));
    const out = applySignals(hits, chunks, "irrelevant", config);
    // 1 + 0.05 * 9 = 1.45, capped at 1.25.
    for (const h of out) expect(h.score).toBeCloseTo(1.25, 10);
  });

  it("a singleton file is unaffected", () => {
    const chunks: Chunk[] = [mkChunk("src/a.ts", "x")];
    const hits: RankedHit[] = [{ id: 0, score: 1 }];
    const out = applySignals(hits, chunks, "irrelevant", config);
    expect(out[0]?.score).toBe(1);
  });
});

describe("applySignals — path penalty in isolation", () => {
  const config = {
    definitionBoost: false,
    multiChunkFileBoost: false,
    pathPenalty: true,
    identifierStemMatching: false,
  };

  it("src/foo.ts beats src/foo.test.ts even when test started with a higher base score", () => {
    // Test factor = 0.5. Test base 1.5 → 0.75. Regular base 1.0 → 1.0.
    const chunks: Chunk[] = [
      mkChunk("src/foo.ts", "content"),
      mkChunk("src/foo.test.ts", "content"),
    ];
    const hits: RankedHit[] = [
      { id: 1, score: 1.5 },
      { id: 0, score: 1.0 },
    ];
    const out = applySignals(hits, chunks, "irrelevant", config);
    expect(out[0]?.id).toBe(0);
    expect(out[0]?.score).toBeCloseTo(1.0, 12);
    expect(out[1]?.id).toBe(1);
    expect(out[1]?.score).toBeCloseTo(0.75, 12);
  });

  it(".d.ts is dampened vs .ts with the same base score", () => {
    const chunks: Chunk[] = [
      mkChunk("src/foo.ts", "x"),
      mkChunk("src/foo.d.ts", "x"),
    ];
    const hits: RankedHit[] = [
      { id: 0, score: 1 },
      { id: 1, score: 1 },
    ];
    const out = applySignals(hits, chunks, "irrelevant", config);
    expect(out[0]?.id).toBe(0);
    expect(out[0]?.score).toBe(1);
    expect(out[1]?.id).toBe(1);
    expect(out[1]?.score).toBeCloseTo(0.6, 12);
  });

  it("legacy path is dampened", () => {
    const chunks: Chunk[] = [
      mkChunk("src/foo.ts", "x"),
      mkChunk("src/legacy/foo.ts", "x"),
    ];
    const hits: RankedHit[] = [
      { id: 0, score: 1 },
      { id: 1, score: 1 },
    ];
    const out = applySignals(hits, chunks, "irrelevant", config);
    expect(out[0]?.id).toBe(0);
    expect(out[1]?.score).toBeCloseTo(0.6, 12);
  });

  it("examples path is dampened", () => {
    const chunks: Chunk[] = [
      mkChunk("src/foo.ts", "x"),
      mkChunk("src/examples/foo.ts", "x"),
    ];
    const hits: RankedHit[] = [
      { id: 0, score: 1 },
      { id: 1, score: 1 },
    ];
    const out = applySignals(hits, chunks, "irrelevant", config);
    expect(out[0]?.id).toBe(0);
    expect(out[1]?.score).toBeCloseTo(0.7, 12);
  });

  it("matches paths case-insensitively", () => {
    const chunks: Chunk[] = [mkChunk("Src/Tests/Foo.ts", "x")];
    const hits: RankedHit[] = [{ id: 0, score: 1 }];
    const out = applySignals(hits, chunks, "irrelevant", config);
    expect(out[0]?.score).toBeCloseTo(0.5, 12);
  });

  it("stacks multiple penalties multiplicatively", () => {
    // /legacy/ (×0.6) AND .d.ts (×0.6) → 0.36.
    const chunks: Chunk[] = [mkChunk("src/legacy/foo.d.ts", "x")];
    const hits: RankedHit[] = [{ id: 0, score: 1 }];
    const out = applySignals(hits, chunks, "irrelevant", config);
    expect(out[0]?.score).toBeCloseTo(0.36, 12);
  });
});

describe("applySignals — identifier stem matching in isolation", () => {
  const config = {
    definitionBoost: false,
    multiChunkFileBoost: false,
    pathPenalty: false,
    identifierStemMatching: true,
  };

  it("a chunk with all query tokens beats one with none, all else equal", () => {
    const chunks: Chunk[] = [
      mkChunk("src/a.ts", "completely unrelated text"),
      mkChunk("src/b.ts", "parse http response goes here"),
    ];
    const hits: RankedHit[] = [
      { id: 0, score: 1 },
      { id: 1, score: 1 },
    ];
    const out = applySignals(hits, chunks, "parseHTTPResponse", config);
    expect(out[0]?.id).toBe(1);
    // 3 tokens matched: parse, http, response → 1 + 0.03*3 = 1.09.
    expect(out[0]?.score).toBeCloseTo(1.09, 10);
    expect(out[1]?.id).toBe(0);
    expect(out[1]?.score).toBe(1);
  });

  it("stem-match boost is capped at 1.30", () => {
    const queryParts = Array.from({ length: 20 }, (_, i) => `tok${i}`);
    const chunks: Chunk[] = [mkChunk("src/a.ts", queryParts.join(" "))];
    const hits: RankedHit[] = [{ id: 0, score: 1 }];
    const out = applySignals(hits, chunks, queryParts.join(" "), config);
    expect(out[0]?.score).toBeCloseTo(1.3, 10);
  });
});

describe("applySignals — disabled flags do not affect the score", () => {
  const baseChunks: Chunk[] = [
    mkChunk("src/foo.test.ts", "function parseFoo() { return 1; }"),
  ];
  const baseHits: RankedHit[] = [{ id: 0, score: 1 }];

  it("definitionBoost: false leaves score untouched even when others might trigger", () => {
    const out = applySignals(baseHits, baseChunks, "parseFoo", {
      definitionBoost: false,
      multiChunkFileBoost: false,
      pathPenalty: false,
      identifierStemMatching: false,
    });
    expect(out[0]?.score).toBe(1);
  });

  it("multiChunkFileBoost: false leaves grouped chunks unboosted", () => {
    const chunks: Chunk[] = [
      mkChunk("src/big.ts", "a"),
      mkChunk("src/big.ts", "b"),
      mkChunk("src/big.ts", "c"),
    ];
    const hits: RankedHit[] = chunks.map((_, i) => ({ id: i, score: 1 }));
    const out = applySignals(hits, chunks, "irrelevant", {
      definitionBoost: false,
      multiChunkFileBoost: false,
      pathPenalty: false,
      identifierStemMatching: false,
    });
    for (const h of out) expect(h.score).toBe(1);
  });

  it("pathPenalty: false leaves test files unpenalized", () => {
    const out = applySignals(baseHits, baseChunks, "irrelevant", {
      definitionBoost: false,
      multiChunkFileBoost: false,
      pathPenalty: false,
      identifierStemMatching: false,
    });
    expect(out[0]?.score).toBe(1);
  });

  it("identifierStemMatching: false leaves matching chunks unboosted", () => {
    const chunks: Chunk[] = [mkChunk("src/a.ts", "parse http response")];
    const hits: RankedHit[] = [{ id: 0, score: 1 }];
    const out = applySignals(hits, chunks, "parseHTTPResponse", {
      definitionBoost: false,
      multiChunkFileBoost: false,
      pathPenalty: false,
      identifierStemMatching: false,
    });
    expect(out[0]?.score).toBe(1);
  });
});

describe("applySignals — all four signals together", () => {
  it("a mid-pack chunk that defines the queried symbol on a clean path rises to #1", () => {
    // Synthetic mini-corpus. Query: "parseHTTPResponse" (symbol-like).
    //
    // Chunk 0: src/legacy/old.ts — mentions parse http response, no def. (legacy ×0.6)
    // Chunk 1: src/foo.test.ts — defines parseHTTPResponse but in a test. (×0.5)
    // Chunk 2: src/parser.ts — DEFINES parseHTTPResponse. <-- target
    // Chunk 3: src/parser.ts — calls parseHTTPResponse. (multi-chunk pair with #2)
    // Chunk 4: src/examples/demo.ts — calls parseHTTPResponse. (×0.7)
    // Chunk 5: src/types.d.ts — type ParseHTTPResponse export. (.d.ts ×0.6)
    const chunks: Chunk[] = [
      mkChunk("src/legacy/old.ts", "// parse http response usage\nparseHTTPResponse();\n"),
      mkChunk(
        "src/foo.test.ts",
        "function parseHTTPResponse() { return mockParse(); }\n",
      ),
      mkChunk(
        "src/parser.ts",
        "export function parseHTTPResponse(input: string) {\n  return doParse(input);\n}\n",
      ),
      mkChunk("src/parser.ts", "// caller\nparseHTTPResponse(req);\n"),
      mkChunk("src/examples/demo.ts", "parseHTTPResponse('hello');\n"),
      mkChunk("src/types.d.ts", "export type ParseHTTPResponse = (s: string) => unknown;\n"),
    ];

    // Pre-signals ordering: the target (id=2) is mid-pack at score 1.0.
    const hits: RankedHit[] = [
      { id: 1, score: 1.4 }, // test file, highest base
      { id: 5, score: 1.2 }, // .d.ts
      { id: 2, score: 1.0 }, // target
      { id: 4, score: 0.9 }, // examples
      { id: 0, score: 0.8 }, // legacy
      { id: 3, score: 0.7 }, // sibling caller in src/parser.ts
    ];

    const out = applySignals(hits, chunks, "parseHTTPResponse");
    expect(out[0]?.id).toBe(2);

    // Sanity: the target's score is now larger than the others'.
    const targetScore = out[0]?.score ?? 0;
    for (let i = 1; i < out.length; i++) {
      expect(out[i]?.score).toBeLessThanOrEqual(targetScore);
    }
  });
});
