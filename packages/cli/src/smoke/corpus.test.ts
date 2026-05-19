import { describe, expect, it } from "vitest";

import {
  type ExpectedTool,
  type QueryShape,
  ROUTING_CORPUS,
} from "./corpus.js";

// Guards for the routing testbench (DESIGN-0003 §5). These keep the corpus
// internally consistent and let it only grow — shrinking it below the
// minimums fails CI. See src/smoke/TESTBENCH.md for how to add cases.

// The canonical shape -> expected-tool mapping. A behavioural query should
// route to sivru.search, an identifier query to grep, an after-edit query to
// find_related. Every corpus entry must obey it.
const SHAPE_TO_TOOL: Record<QueryShape, ExpectedTool> = {
  behavioural: "sivru-search",
  identifier: "grep",
  "after-edit": "find-related",
};

// Minimum examples per shape. Raise these as the testbench grows; never lower.
const MIN_PER_SHAPE = 4;

describe("routing corpus — testbench guards", () => {
  it("has a meaningful number of examples", () => {
    expect(ROUTING_CORPUS.length).toBeGreaterThanOrEqual(12);
  });

  it("covers every query shape with at least the minimum examples", () => {
    for (const shape of Object.keys(SHAPE_TO_TOOL) as QueryShape[]) {
      const count = ROUTING_CORPUS.filter((p) => p.shape === shape).length;
      expect(
        count,
        `shape "${shape}" has ${count} examples, need >= ${MIN_PER_SHAPE}`,
      ).toBeGreaterThanOrEqual(MIN_PER_SHAPE);
    }
  });

  it("every prompt's expected tool matches its shape", () => {
    for (const p of ROUTING_CORPUS) {
      expect(
        p.expected,
        `prompt "${p.id}" is shape "${p.shape}" but expects "${p.expected}"`,
      ).toBe(SHAPE_TO_TOOL[p.shape]);
    }
  });

  it("every prompt id is unique", () => {
    const ids = ROUTING_CORPUS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every prompt has non-empty text", () => {
    for (const p of ROUTING_CORPUS) {
      expect(p.prompt.trim().length, `prompt "${p.id}" is empty`).toBeGreaterThan(
        0,
      );
    }
  });
});
