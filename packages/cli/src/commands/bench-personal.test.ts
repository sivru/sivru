import { describe, expect, it } from "vitest";

import {
  _internal,
  extractQueriesFromEvents,
} from "./bench-personal.js";
import type { SivruEvent } from "@sivru/observe";

function ev(
  index: number,
  kind: SivruEvent["kind"],
  extra: Partial<SivruEvent> = {},
): SivruEvent {
  return {
    sessionId: "s",
    index,
    kind,
    raw: {},
    ts: `2026-05-05T00:00:${String(index).padStart(2, "0")}.000Z`,
    ...extra,
  };
}

describe("extractQueriesFromEvents", () => {
  it("returns user-message queries when no sivru.search calls present", () => {
    const queries = extractQueriesFromEvents([
      ev(0, "user_message", { text: "How do I add a new auth handler?" }),
      ev(1, "assistant_message", { text: "Sure, let me look." }),
      ev(2, "user_message", { text: "Find all places that use SessionTokenService" }),
    ]);
    expect(queries).toContain("How do I add a new auth handler?");
    expect(queries).toContain("Find all places that use SessionTokenService");
  });

  it("prefers sivru.search tool_use queries when present", () => {
    const queries = extractQueriesFromEvents([
      ev(0, "user_message", { text: "anything" }),
      ev(1, "tool_use", {
        tool: "mcp__sivru__search",
        input: { query: "auth middleware token validation" },
      }),
    ]);
    expect(queries[0]).toBe("auth middleware token validation");
  });

  it("dedupes case-insensitively across both sources", () => {
    const queries = extractQueriesFromEvents([
      ev(0, "user_message", { text: "auth flow" }),
      ev(1, "user_message", { text: "AUTH flow" }),
      ev(2, "tool_use", { tool: "sivru.search", input: { query: "auth flow" } }),
    ]);
    // Only one "auth flow" should survive (case-folded dedup).
    expect(
      queries.filter((q) => q.toLowerCase() === "auth flow").length,
    ).toBe(1);
  });

  it("trims to first sentence for long user messages", () => {
    const long =
      "Find the auth handler. Then refactor it to use the new pattern. Finally write tests.";
    const queries = extractQueriesFromEvents([
      ev(0, "user_message", { text: long }),
    ]);
    expect(queries[0]).toBe("Find the auth handler.");
  });

  it("skips system markers and short / empty messages", () => {
    const queries = extractQueriesFromEvents([
      ev(0, "user_message", { text: "[Request interrupted by user]" }),
      ev(1, "user_message", { text: "ok" }), // too short
      ev(2, "user_message", { text: "" }),
      ev(3, "user_message", { text: "find the auth helper" }), // valid
    ]);
    expect(queries.length).toBe(1);
    expect(queries[0]).toBe("find the auth helper");
  });

  it("ignores assistant messages and system events", () => {
    const queries = extractQueriesFromEvents([
      ev(0, "assistant_message", { text: "I'll help with that." }),
      ev(1, "system", { text: "permission-mode: bypass" }),
    ]);
    expect(queries).toEqual([]);
  });

  it("handles tool_use with non-string query field gracefully", () => {
    const queries = extractQueriesFromEvents([
      ev(0, "tool_use", {
        tool: "mcp__sivru__search",
        input: { query: 42 }, // wrong type
      }),
      ev(1, "user_message", { text: "fallback prompt" }),
    ]);
    expect(queries).toEqual(["fallback prompt"]);
  });

  it("recognizes various sivru.search tool-name spellings", () => {
    for (const tool of [
      "mcp__sivru__search",
      "sivru.search",
      "sivru_search",
      "SIVRU__SEARCH",
    ]) {
      const queries = extractQueriesFromEvents([
        ev(0, "tool_use", { tool, input: { query: `from ${tool}` } }),
      ]);
      expect(queries[0]).toBe(`from ${tool}`);
    }
  });
});

describe("parseArgs", () => {
  const parse = _internal.parseArgs;

  it("defaults: empty models (resolved later), n=10, no since, text mode", () => {
    const r = parse(["personal"]);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    // Empty models triggers either an interactive prompt or the
    // bm25,potion fallback depending on TTY/--json — both decided
    // inside runBenchPersonal, not here.
    expect(r.models).toEqual([]);
    expect(r.modelsExplicit).toBe(false);
    expect(r.n).toBe(10);
    expect(r.sinceDays).toBeNull();
    expect(r.json).toBe(false);
    expect(r.noHistory).toBe(false);
  });

  it("--models splits, trims, drops empties", () => {
    const r = parse(["personal", "--models", "bm25, potion ,minilm,"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.models).toEqual(["bm25", "potion", "minilm"]);
    expect(r.modelsExplicit).toBe(true);
  });

  it("--no-history sets noHistory", () => {
    const r = parse(["personal", "--no-history"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.noHistory).toBe(true);
  });

  it("rejects --n=0 and --n=-3", () => {
    expect("error" in parse(["personal", "--n=0"])).toBe(true);
    expect("error" in parse(["personal", "--n=-3"])).toBe(true);
  });

  it("--since=N parses positive integer", () => {
    const r = parse(["personal", "--since=30"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.sinceDays).toBe(30);
  });

  it("--json sets json mode", () => {
    const r = parse(["personal", "--json"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.json).toBe(true);
  });

  it("--repo resolves to absolute path", () => {
    const r = parse(["personal", "--repo", "."]);
    if ("error" in r) throw new Error(r.error);
    expect(r.repo).toMatch(/^\//);
  });

  it("rejects unknown flags", () => {
    expect("error" in parse(["personal", "--bogus"])).toBe(true);
  });
});

describe("resolveModel", () => {
  const r = _internal.resolveModel;

  it("returns null for unknown short names", () => {
    expect(r("not-a-model")).toBeNull();
  });

  it("returns the registered entry for built-in short names", () => {
    expect(r("bm25")?.metadata.label).toBe("bm25 (no embedder)");
    expect(r("potion")?.metadata.label).toContain("potion");
    expect(r("minilm")?.metadata.label).toContain("MiniLM");
    expect(r("bge-small")?.metadata.label).toContain("bge-small");
  });

  it("supports `hf:` short-form for arbitrary HF feature-extraction models", () => {
    const m = r("hf:custom-org/custom-model");
    expect(m).not.toBeNull();
    expect(m?.metadata.label).toBe("custom-org/custom-model");
    expect(m?.kind).toBe("embed");
  });
});

describe("bootstrapCI", () => {
  const ci = _internal.bootstrapCI;

  it("zero-input → all zeros", () => {
    expect(ci([])).toEqual({ p05: 0, p50: 0, p95: 0 });
  });

  it("constant input → CI bounds equal the constant", () => {
    expect(ci([42, 42, 42, 42, 42])).toEqual({ p05: 42, p50: 42, p95: 42 });
  });

  it("noisy input → p05 < p50 < p95", () => {
    const r = ci([0, 25, 50, 75, 100, 50, 50]);
    expect(r.p05).toBeLessThan(r.p50);
    expect(r.p50).toBeLessThan(r.p95);
  });

  it("is deterministic across calls (seeded PRNG)", () => {
    const xs = [10, 20, 30, 40, 50];
    expect(ci(xs)).toEqual(ci(xs));
  });
});
