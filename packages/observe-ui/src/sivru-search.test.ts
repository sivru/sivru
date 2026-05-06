import { describe, expect, it } from "vitest";
import {
  describeSearchInput,
  getHits,
  getLatencyMs,
  getResultCount,
  parseSearchInput,
  parseSearchOutput,
} from "./sivru-search";

describe("parseSearchInput", () => {
  it("extracts query + hybrid + top + path when present", () => {
    expect(
      parseSearchInput({
        query: "auth flow",
        hybrid: true,
        top: 5,
        path: "/repo",
      }),
    ).toEqual({ query: "auth flow", hybrid: true, top: 5, path: "/repo" });
  });

  it("returns null when query is missing or non-string", () => {
    expect(parseSearchInput({ top: 5 })).toBeNull();
    expect(parseSearchInput({ query: 42 })).toBeNull();
    expect(parseSearchInput(null)).toBeNull();
    expect(parseSearchInput("not an object")).toBeNull();
  });

  it("omits optional fields rather than including undefined", () => {
    const result = parseSearchInput({ query: "x" });
    expect(result).toEqual({ query: "x" });
    // Critical: exactOptionalPropertyTypes makes `undefined` a type error,
    // so the result must NOT have `hybrid: undefined`.
    expect(Object.keys(result ?? {})).toEqual(["query"]);
  });
});

describe("parseSearchOutput", () => {
  it("accepts a plain object with results array", () => {
    const out = parseSearchOutput({
      results: [{ filePath: "a.ts" }],
    });
    expect(out?.results).toHaveLength(1);
  });

  it("accepts a plain object with hits array", () => {
    const out = parseSearchOutput({ hits: [{ filePath: "a.ts" }] });
    expect(out?.hits).toHaveLength(1);
  });

  it("unwraps a JSON-stringified body", () => {
    const out = parseSearchOutput(
      JSON.stringify({ results: [{ filePath: "a.ts" }] }),
    );
    expect(out?.results).toHaveLength(1);
  });

  it("unwraps the MCP {content:[{text:'<json>'}]} envelope", () => {
    const inner = JSON.stringify({ results: [{ filePath: "a.ts" }] });
    const out = parseSearchOutput({
      content: [{ type: "text", text: inner }],
    });
    expect(out?.results).toHaveLength(1);
  });

  it("returns null on malformed JSON", () => {
    expect(parseSearchOutput("not json {")).toBeNull();
  });

  it("returns null on shape mismatch", () => {
    expect(parseSearchOutput({ unrelated: 1 })).toBeNull();
    expect(parseSearchOutput(42)).toBeNull();
    expect(parseSearchOutput(null)).toBeNull();
    expect(parseSearchOutput(undefined)).toBeNull();
  });

  it("bounds recursion to 3 levels (depth-bombs return null instead of hanging)", () => {
    // Quadruple-stringified: parse, parse, parse, parse. Should hit cap.
    const inner = JSON.stringify({ results: [{ filePath: "a.ts" }] });
    const lvl2 = JSON.stringify(inner);
    const lvl3 = JSON.stringify(lvl2);
    const lvl4 = JSON.stringify(lvl3);
    // 4 layers of stringification — beyond our cap of 3.
    expect(parseSearchOutput(lvl4)).toBeNull();
  });
});

describe("getHits", () => {
  it("prefers `results` over `hits` when both present", () => {
    const out = getHits({
      results: [{ filePath: "a.ts" }],
      hits: [{ filePath: "b.ts" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.filePath).toBe("a.ts");
  });
  it("returns [] for null", () => {
    expect(getHits(null)).toEqual([]);
  });
});

describe("getResultCount + getLatencyMs", () => {
  it("counts hits and reads latency through the same envelope variants", () => {
    const inner = JSON.stringify({
      results: [{ filePath: "a.ts" }, { filePath: "b.ts" }],
      latencyMs: 1.4,
    });
    const envelope = { content: [{ type: "text", text: inner }] };
    expect(getResultCount(envelope)).toBe(2);
    expect(getLatencyMs(envelope)).toBe(1.4);
  });

  it("returns null when shape doesn't match", () => {
    expect(getResultCount({ unrelated: 1 })).toBeNull();
    expect(getLatencyMs({ unrelated: 1 })).toBeNull();
  });
});

describe("describeSearchInput", () => {
  it("formats query + mode + top", () => {
    expect(describeSearchInput({ query: "auth flow", top: 5 })).toBe(
      `"auth flow"  ·  hybrid  ·  top=5`,
    );
  });
  it("uses bm25 mode when hybrid=false", () => {
    expect(
      describeSearchInput({ query: "x", hybrid: false }),
    ).toContain("bm25");
  });
  it("defaults top=10 when not provided", () => {
    expect(describeSearchInput({ query: "x" })).toContain("top=10");
  });
  it("truncates long queries", () => {
    const long = "a".repeat(200);
    const result = describeSearchInput({ query: long });
    expect(result?.length).toBeLessThan(200);
    expect(result).toContain("…");
  });
  it("returns null on shape mismatch", () => {
    expect(describeSearchInput({ unrelated: 1 })).toBeNull();
  });
});
