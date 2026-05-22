// Threat-model tests (DESIGN-0016 F2 / acceptance criteria).
//
// js-yaml.load() with the default safe schema MUST NOT deserialize
// custom JS types — no method execution, no functions, no prototype
// pollution attacks. Loading is performed exclusively via `yaml.load`
// (never `loadAll` or `DEFAULT_FULL_SCHEMA`). These tests assert the
// library's behaviour AND that sivru's own extractBlocks pipeline
// refuses to instantiate a hostile YAML payload — the latter is what
// the design's F2 acceptance criterion specifically asks for.

import { describe, expect, it } from "vitest";

import { extractBlocks, extractFences } from "./extract.js";

import yaml from "js-yaml";

const HOSTILE_YAML = `
!!js/function "function () { throw new Error('pwned') }"
`;

describe("js-yaml safe-load (F2)", () => {
  it("default load() rejects !!js/function (no method execution)", () => {
    expect(() => yaml.load(HOSTILE_YAML)).toThrow();
  });

  it("explicit JSON_SCHEMA also rejects !!js/function", () => {
    expect(() =>
      yaml.load(HOSTILE_YAML, { schema: yaml.JSON_SCHEMA }),
    ).toThrow();
  });

  it("the fence scanner doesn't crash on hostile body", () => {
    // The scanner doesn't execute YAML at all — it only tokenizes lines.
    // This guards against future regressions that try to do otherwise.
    const text = ["// @sivru", `// ${HOSTILE_YAML.trim()}`, "// @end"].join(
      "\n",
    );
    const out = extractFences(text, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.yamlText.includes("!!js/function")).toBe(true);
  });

  it("extractBlocks against a hostile fixture: block:null + SIVRU-E216, never instantiates the function", async () => {
    // The design's F2 acceptance criterion: "v0.6 PR confirms via a unit
    // test that loads a hostile fixture and asserts the result is just a
    // plain object, no method execution." This test exercises sivru's
    // OWN pipeline (extractBlocks → parseFenceBody → yaml.load with
    // JSON_SCHEMA) against the hostile payload, not the bare library.
    // A future regression that swapped JSON_SCHEMA for the unsafe
    // DEFAULT_FULL_SCHEMA inside parseFenceBody would fail this test.
    const fixture = [
      "/**",
      " * @sivru",
      ` * !!js/function "function () { throw new Error('pwned') }"`,
      " * @end",
      " */",
      "export function hostile(): void {}",
    ].join("\n");
    const out = await extractBlocks("/tmp/hostile-test.ts", {
      content: fixture,
      language: "typescript",
    });
    expect(out).toHaveLength(1);
    const [eb] = out;
    expect(eb!.block).toBeNull();
    // The diagnostic must be SIVRU-E216 yaml-malformed — js-yaml's
    // JSON_SCHEMA rejects the unknown !!js/function tag.
    const codes = eb!.diagnostics.map((d) => d.code);
    expect(codes).toContain("SIVRU-E216");
    // And block stays null — no instantiated object, no method
    // execution, no prototype pollution.
    expect(eb!.block).toBeNull();
  });
});
