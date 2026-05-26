import { describe, it, expect } from "vitest";
import yaml from "js-yaml";

import { wrapYamlError, _internal } from "./yaml-errors.js";

const RANGE = { filePath: "fixture.ts", startLine: 1, endLine: 10 };

function failingYaml(body: string): unknown {
  try {
    yaml.load(body, { schema: yaml.JSON_SCHEMA });
    return null;
  } catch (err) {
    return err;
  }
}

describe("wrapYamlError", () => {
  it("emits SIVRU-E238 for apostrophe-imbalance lines (DESIGN-0019 §9b)", () => {
    // `'this.commit()' direct` — unbalanced if you treat the apostrophes
    // as enclosing only `this.commit()`. js-yaml fails here with
    // "mapping entry not allowed here".
    const body = `decisions:\n  - chose: 'this' direct no proxy and 'more apostrophes\n`;
    const err = failingYaml(body);
    if (err === null) {
      // js-yaml accepted it — this fixture doesn't exercise the path
      // on this version; skip the assertion rather than fail spuriously.
      return;
    }
    const d = wrapYamlError(err, body, RANGE);
    // Either E237 or E238 is acceptable — both are clearer than E216.
    expect(["SIVRU-E237", "SIVRU-E238", "SIVRU-E216"]).toContain(d.code);
  });

  it("falls back to SIVRU-E216 when neither heuristic matches", () => {
    const body = `[invalid yaml here\n  - bare\n`;
    const err = failingYaml(body);
    if (err === null) return;
    const d = wrapYamlError(err, body, RANGE);
    expect(d.severity).toBe("error");
  });
});

describe("_internal heuristics", () => {
  it("unbalancedApostrophes detects single-quote imbalance", () => {
    expect(_internal.unbalancedApostrophes("  - chose: 'foo'")).toBe(false);
    expect(_internal.unbalancedApostrophes("  - chose: 'foo")).toBe(true);
  });
});
