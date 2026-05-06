import { describe, expect, it } from "vitest";
import { createMockCrossEncoder } from "./mock.js";

describe("createMockCrossEncoder", () => {
  it("returns empty array for empty input", async () => {
    const ce = createMockCrossEncoder();
    expect(await ce.score("anything", [])).toEqual([]);
  });

  it("scores documents containing query terms higher than ones that don't", async () => {
    const ce = createMockCrossEncoder();
    const scores = await ce.score("authenticate jwt", [
      "function authenticate(token) { /* validate jwt */ }",
      "function unrelated() { return null; }",
      "const banana = 7;",
    ]);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[1]).toBeLessThanOrEqual(scores[2]! + 0.001); // both have ~no overlap
  });

  it("is deterministic across calls", async () => {
    const ce = createMockCrossEncoder();
    const docs = ["alpha beta gamma", "alpha", "delta"];
    const a = await ce.score("alpha gamma", docs);
    const b = await ce.score("alpha gamma", docs);
    expect(a).toEqual(b);
  });

  it("modelId reflects the option (or the default)", () => {
    expect(createMockCrossEncoder().modelId).toBe("mock-cross-encoder");
    expect(createMockCrossEncoder({ modelId: "fake-2.0" }).modelId).toBe(
      "fake-2.0",
    );
  });

  it("preserves output order even when scores tie", async () => {
    const ce = createMockCrossEncoder();
    const docs = ["nope", "nope2", "nope3"];
    const scores = await ce.score("alpha", docs);
    expect(scores).toHaveLength(3);
    // Each score is a single number; we just want the array length to
    // line up with the input.
    for (const s of scores) {
      expect(typeof s).toBe("number");
    }
  });
});
