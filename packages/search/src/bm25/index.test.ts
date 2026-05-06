import { describe, expect, it } from "vitest";
import { createBm25Index } from "./index.js";
import { tokenize } from "./tokenizer.js";

describe("createBm25Index", () => {
  it("returns [] from an empty index", () => {
    const idx = createBm25Index();
    expect(idx.search(["anything"], 10)).toEqual([]);
    expect(idx.size()).toBe(0);
  });

  it("scores a single matching doc above zero", () => {
    const idx = createBm25Index();
    idx.addDocuments([{ id: 0, tokens: ["alpha", "beta"] }]);
    const hits = idx.search(["alpha"], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe(0);
    expect((hits[0]?.score ?? 0) > 0).toBe(true);
  });

  it("excludes docs that no query term hit", () => {
    const idx = createBm25Index();
    idx.addDocuments([
      { id: 0, tokens: ["alpha", "beta"] },
      { id: 1, tokens: ["gamma", "delta"] },
    ]);
    const hits = idx.search(["alpha"], 10);
    expect(hits.map((h) => h.id)).toEqual([0]);
  });

  it("scores higher when a query term appears more times in a doc", () => {
    const idx = createBm25Index();
    // Same length so length-norm cancels out.
    idx.addDocuments([
      { id: 0, tokens: ["alpha", "alpha", "beta"] },
      { id: 1, tokens: ["alpha", "beta", "beta"] },
    ]);
    const hits = idx.search(["alpha"], 10);
    expect(hits[0]?.id).toBe(0);
    expect(hits[1]?.id).toBe(1);
    expect((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0)).toBe(true);
  });

  it("applies length normalization (b > 0): shorter doc scores higher for same freq", () => {
    const idx = createBm25Index();
    const longTokens: string[] = [];
    longTokens.push("alpha");
    for (let i = 0; i < 99; i++) longTokens.push(`filler${i}`);
    idx.addDocuments([
      { id: 0, tokens: ["alpha", "x", "y", "z", "w"] },
      { id: 1, tokens: longTokens },
    ]);
    const hits = idx.search(["alpha"], 10);
    expect(hits[0]?.id).toBe(0);
    expect(hits[1]?.id).toBe(1);
    expect((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0)).toBe(true);
  });

  it("b=0 disables length normalization (equal freq -> equal score)", () => {
    const idx = createBm25Index({ b: 0 });
    const longTokens: string[] = ["alpha"];
    for (let i = 0; i < 50; i++) longTokens.push(`filler${i}`);
    idx.addDocuments([
      { id: 0, tokens: ["alpha", "x"] },
      { id: 1, tokens: longTokens },
    ]);
    const hits = idx.search(["alpha"], 10);
    const a = hits.find((h) => h.id === 0)?.score ?? 0;
    const c = hits.find((h) => h.id === 1)?.score ?? 0;
    expect(a).toBeCloseTo(c, 12);
  });

  it("rare term outscores common term (IDF effect)", () => {
    const idx = createBm25Index();
    idx.addDocuments([
      { id: 0, tokens: ["common", "rare"] },
      { id: 1, tokens: ["common", "filler"] },
      { id: 2, tokens: ["common", "other"] },
    ]);
    const rareHits = idx.search(["rare"], 10);
    const commonHits = idx.search(["common"], 10);
    // Doc 0 contains both; rare-term score should beat common-term score on that doc.
    const rareScore = rareHits.find((h) => h.id === 0)?.score ?? 0;
    const commonScoreOnDoc0 = commonHits.find((h) => h.id === 0)?.score ?? 0;
    expect(rareScore > commonScoreOnDoc0).toBe(true);
    // Common term hits all 3 docs; rare term hits only one.
    expect(commonHits).toHaveLength(3);
    expect(rareHits).toHaveLength(1);
  });

  it("k truncates results", () => {
    const idx = createBm25Index();
    for (let i = 0; i < 5; i++) {
      idx.addDocuments([{ id: i, tokens: ["alpha", `tag${i}`] }]);
    }
    const hits = idx.search(["alpha"], 2);
    expect(hits).toHaveLength(2);
  });

  it("k > N returns all matched docs", () => {
    const idx = createBm25Index();
    for (let i = 0; i < 3; i++) {
      idx.addDocuments([{ id: i, tokens: ["alpha"] }]);
    }
    const hits = idx.search(["alpha"], 100);
    expect(hits).toHaveLength(3);
  });

  it("breaks ties by ascending docId", () => {
    const idx = createBm25Index();
    idx.addDocuments([
      { id: 7, tokens: ["alpha", "beta"] },
      { id: 2, tokens: ["alpha", "beta"] },
      { id: 5, tokens: ["alpha", "beta"] },
    ]);
    const hits = idx.search(["alpha"], 10);
    expect(hits.map((h) => h.id)).toEqual([2, 5, 7]);
  });

  it("addDocuments accumulates across calls", () => {
    const idx = createBm25Index();
    idx.addDocuments([{ id: 0, tokens: ["alpha"] }]);
    idx.addDocuments([{ id: 1, tokens: ["alpha", "beta"] }]);
    expect(idx.size()).toBe(2);
    const hits = idx.search(["alpha"], 10);
    expect(hits).toHaveLength(2);
  });

  it("respects custom k1", () => {
    const idx1 = createBm25Index({ k1: 1.2 });
    const idx2 = createBm25Index({ k1: 0 });
    const docs = [
      { id: 0, tokens: ["alpha", "alpha", "alpha", "beta"] },
      { id: 1, tokens: ["alpha", "beta", "gamma", "delta"] },
    ];
    idx1.addDocuments(docs);
    idx2.addDocuments(docs);
    // With k1 = 0 the saturation collapses to a constant — both docs score equal IDF.
    const h2 = idx2.search(["alpha"], 10);
    const a = h2.find((h) => h.id === 0)?.score ?? 0;
    const b = h2.find((h) => h.id === 1)?.score ?? 0;
    expect(a).toBeCloseTo(b, 12);
    // With k1 = 1.2 the higher-freq doc wins.
    const h1 = idx1.search(["alpha"], 10);
    expect(h1[0]?.id).toBe(0);
  });

  it("matches a hand-computed BM25 score within 1e-6", () => {
    // Corpus: 3 docs, k1=1.2, b=0.75.
    // doc 0: ["alpha","beta","alpha"]   |D|=3
    // doc 1: ["beta","gamma"]           |D|=2
    // doc 2: ["alpha","gamma","delta"]  |D|=3
    // avgDL = 8/3
    //
    // Query ["alpha"]. n=3, n(alpha)=2.
    // IDF = ln((3 - 2 + 0.5)/(2 + 0.5) + 1) = ln(1.6)
    //
    // Doc 0: f=2, norm = 1 - 0.75 + 0.75 * 3 / (8/3) = 0.25 + 27/32 = 35/32
    //   denom = 2 + 1.2 * 35/32 = 2 + 42/32 = 106/32 = 53/16
    //   contribution = ln(1.6) * (2 * 2.2) / (53/16) = ln(1.6) * 4.4 * 16 / 53
    //
    // Doc 2: f=1, norm = 35/32 (same |D| and avgDL)
    //   denom = 1 + 1.2 * 35/32 = 1 + 42/32 = 74/32 = 37/16
    //   contribution = ln(1.6) * (1 * 2.2) / (37/16) = ln(1.6) * 2.2 * 16 / 37
    const idx = createBm25Index({ k1: 1.2, b: 0.75 });
    idx.addDocuments([
      { id: 0, tokens: ["alpha", "beta", "alpha"] },
      { id: 1, tokens: ["beta", "gamma"] },
      { id: 2, tokens: ["alpha", "gamma", "delta"] },
    ]);
    const hits = idx.search(["alpha"], 10);
    const ln16 = Math.log(1.6);
    const expectedDoc0 = (ln16 * 4.4 * 16) / 53;
    const expectedDoc2 = (ln16 * 2.2 * 16) / 37;
    const got0 = hits.find((h) => h.id === 0)?.score;
    const got2 = hits.find((h) => h.id === 2)?.score;
    expect(got0).toBeDefined();
    expect(got2).toBeDefined();
    expect(Math.abs((got0 ?? 0) - expectedDoc0) < 1e-6).toBe(true);
    expect(Math.abs((got2 ?? 0) - expectedDoc2) < 1e-6).toBe(true);
    // Doc 1 has no "alpha" — must not appear.
    expect(hits.find((h) => h.id === 1)).toBeUndefined();
  });

  it("works with the project tokenizer for realistic input", () => {
    const idx = createBm25Index();
    idx.addDocuments([
      { id: 0, tokens: tokenize("function parseFooBar(input) {}") },
      { id: 1, tokens: tokenize("class Baz { qux() {} }") },
    ]);
    const hits = idx.search(tokenize("foo"), 5);
    expect(hits[0]?.id).toBe(0);
  });
});
